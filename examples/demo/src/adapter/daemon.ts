import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { JWK } from "jose";
import { WebSocket } from "ws";
import {
  ActionRelayClient,
  ActionRelayResponseError,
  ActionRelayUnavailableError,
  KeyManager,
  parseActionResponse,
  type ActionRelayWebSocket,
} from "@oma3/mpas";
import { loadDeploymentConfigs, type LoadedDeploymentConfig } from "./config-loader.js";
import { FileCredentialProvider } from "./credential-provider.js";
import {
  buildIndeterminateRecoveryResponse,
  createAdapterApiServer,
} from "./adapter-api-server.js";
import { DispatchLedger, FileDispatchJournal } from "./dispatch-ledger.js";
import { TraceLogger, TraceWriter } from "../core/trace.js";
import type { Did } from "../core/types.js";
import { computeJsonHash } from "../core/verification.js";
import {
  DEFAULT_TRUST_CONTEXT,
  type TrustContext,
} from "./trust.js";
import type { ConfirmPluginUse } from "./trust-prompt.js";
import {
  FileVerifierRelayStateStore,
  VerifierRelayWorker,
  type VerifierRelayClient,
  type VerifierRelayStateStore,
  type VerifierRelayWorkerEvent,
} from "./verifier-relay-worker.js";

export interface AdapterKeyFile {
  did: Did;
  privateJwk: JWK;
  publicJwk?: JWK;
}

export interface DaemonOptions {
  configDir?: string;
  credentialDir?: string;
  adapterKeyPath?: string;
  host?: string;
  port?: number;
  maxEnvelopeValidityMs?: number;
  journalPath?: string;
  tracePath?: string;
  /** Hosted Action Relay used for outbound Verifier delivery polling. */
  verifierRelayUrl?: string;
  /** @deprecated Use verifierRelayUrl. */
  verifierCoordinationUrl?: string;
  /** Durable cursor and cached-response state for outbound Verifier delivery. */
  verifierRelayStatePath?: string;
  /** @deprecated Use verifierRelayStatePath. */
  verifierCoordinationStatePath?: string;
  /** Recovery poll cadence used in addition to WebSocket notifications. */
  verifierPollIntervalMs?: number;
  /** Internal injection point for tests and embedded deployments. */
  trustContext?: TrustContext | null;
  confirmPluginUse?: ConfirmPluginUse;
  verifierRelayClient?: VerifierRelayClient;
  /** @deprecated Use verifierRelayClient. */
  verifierCoordinationClient?: VerifierRelayClient;
  verifierRelayStateStore?: VerifierRelayStateStore;
  /** @deprecated Use verifierRelayStateStore. */
  verifierCoordinationStateStore?: VerifierRelayStateStore;
  verifierRelayEventSink?: (event: VerifierRelayWorkerEvent) => void;
  /** @deprecated Use verifierRelayEventSink. */
  verifierCoordinationEventSink?: (event: VerifierRelayWorkerEvent) => void;
}

export interface StartedDaemon {
  app: FastifyInstance;
  address: string;
  loadedConfigs: LoadedDeploymentConfig[];
  verifierRelayWorker?: VerifierRelayWorker;
  /** @deprecated Use verifierRelayWorker. */
  verifierCoordinationWorker?: VerifierRelayWorker;
}

export function defaultConfigDir(): string {
  return process.env.MPAS_CONFIG_DIR ?? join(homedir(), ".mpas", "config");
}

export function defaultCredentialDir(): string {
  return process.env.MPAS_CREDENTIAL_DIR ?? join(homedir(), ".mpas", "credentials");
}

export function defaultAdapterKeyPath(): string {
  return process.env.MPAS_ADAPTER_KEY ?? join(homedir(), ".mpas", "keys", "adapter.json");
}

export function defaultJournalPath(): string {
  return process.env.MPAS_JOURNAL_PATH ?? join(homedir(), ".mpas", "journal", "dispatch-ledger.jsonl");
}

export function defaultVerifierRelayStatePath(): string {
  const configured = process.env.MPAS_VERIFIER_RELAY_STATE ?? process.env.MPAS_VERIFIER_COORDINATION_STATE;
  if (configured) return configured;
  const journalDir = join(homedir(), ".mpas", "journal");
  const legacyPath = join(journalDir, "verifier-coordination.json");
  return existsSync(legacyPath) ? legacyPath : join(journalDir, "verifier-relay.json");
}

/** @deprecated Use defaultVerifierRelayStatePath. */
export const defaultVerifierCoordinationStatePath = defaultVerifierRelayStatePath;

export async function startDaemon(options: DaemonOptions = {}): Promise<StartedDaemon> {
  const configDir = options.configDir ?? defaultConfigDir();
  const trustContext =
    options.trustContext === undefined
      ? DEFAULT_TRUST_CONTEXT
      : options.trustContext;

  const loaded = await loadDeploymentConfigs(configDir, {
    trustContext,
    confirmPluginUse: options.confirmPluginUse,
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }

  const adapterKey = await loadAdapterKey(options.adapterKeyPath ?? defaultAdapterKeyPath());
  const ledger = new DispatchLedger(new FileDispatchJournal(options.journalPath ?? defaultJournalPath()));
  const traceWriter = options.tracePath ? new TraceWriter(options.tracePath) : undefined;
  const traceLogger = new TraceLogger("adapter", traceWriter);
  const app = createAdapterApiServer({
    configsByApplicationDid: loaded.configsByApplicationDid,
    credentialProvider: new FileCredentialProvider(options.credentialDir ?? defaultCredentialDir()),
    adapterDid: adapterKey.did,
    adapterSigningKey: adapterKey.privateJwk,
    maxEnvelopeValidityMs: options.maxEnvelopeValidityMs,
    ledger,
    traceLogger,
  });

  let verifierRelayWorker: VerifierRelayWorker | undefined;
  const verifierRelayUrl = options.verifierRelayUrl ?? options.verifierCoordinationUrl;
  if (verifierRelayUrl) {
    const keyManager = KeyManager.fromJwk(adapterKey.privateJwk);
    if (keyManager.did !== adapterKey.did) {
      throw new Error(
        `Adapter key DID ${adapterKey.did} does not match the DID derived from its private key ${keyManager.did}.`,
      );
    }
    const relayClient = options.verifierRelayClient ?? options.verifierCoordinationClient ?? new ActionRelayClient({
      url: verifierRelayUrl,
      signer: keyManager,
      webSocketFactory: ({ url, headers }) => new WebSocket(url, {
        headers: { Authorization: headers.Authorization },
      }) as unknown as ActionRelayWebSocket,
    });
    const stateStore = options.verifierRelayStateStore ?? options.verifierCoordinationStateStore ??
      new FileVerifierRelayStateStore(
        options.verifierRelayStatePath ?? options.verifierCoordinationStatePath ?? defaultVerifierRelayStatePath(),
      );
    verifierRelayWorker = await VerifierRelayWorker.create({
      relayUrl: verifierRelayUrl,
      verifierDid: adapterKey.did,
      client: relayClient,
      stateStore,
      processAction: async (envelope) => {
        const actionPackage = envelope.payload.actionPackage;
        const actionId = actionPackage.actionEnvelope.actionId;
        const envelopeHash = computeJsonHash(actionPackage.actionEnvelope).value;
        const recovery = ledger.recoveryFor(actionId, envelopeHash);
        if (recovery?.response) return recovery.response;
        if (recovery?.resolution === "indeterminate") {
          const response = await buildIndeterminateRecoveryResponse(actionPackage, {
            adapterDid: adapterKey.did,
            adapterSigningKey: adapterKey.privateJwk,
          });
          ledger.resolve(actionId, "indeterminate", response);
          return response;
        }

        const response = await app.inject({
          method: "POST",
          url: "/mpas/v1/verifier/action",
          headers: { "content-type": "application/mpas+json" },
          payload: JSON.stringify(envelope),
        });
        if (response.statusCode < 200 || response.statusCode >= 300) {
          if (
            response.statusCode === 408 ||
            response.statusCode === 425 ||
            response.statusCode === 429 ||
            response.statusCode >= 500
          ) {
            throw new ActionRelayUnavailableError(
              `Credential Adapter temporarily failed a polled Action envelope with HTTP ${response.statusCode}.`,
            );
          }
          throw new ActionRelayResponseError(
            `Credential Adapter rejected a polled Action envelope with HTTP ${response.statusCode}.`,
          );
        }
        try {
          const parsed = parseActionResponse(JSON.parse(response.body) as unknown);
          if (parsed.result === "pending") {
            throw new ActionRelayUnavailableError(
              "Credential Adapter is still processing the polled Action envelope.",
            );
          }
          if (
            parsed.result === "rejected" &&
            (parsed.error?.code === "REPLAY_DETECTED" || parsed.error?.code === "ACTION_ID_HASH_MISMATCH")
          ) {
            throw new ActionRelayResponseError(
              `Credential Adapter cannot recover the original response (${parsed.error.code}).`,
            );
          }
          return parsed;
        } catch (error) {
          if (error instanceof ActionRelayResponseError || error instanceof ActionRelayUnavailableError) {
            throw error;
          }
          throw new ActionRelayResponseError("Credential Adapter returned an invalid ActionResponse.", {
            cause: error,
          });
        }
      },
      ...(options.verifierPollIntervalMs !== undefined
        ? { fallbackPollIntervalMs: options.verifierPollIntervalMs }
        : {}),
      onEvent: options.verifierRelayEventSink ?? options.verifierCoordinationEventSink ?? logVerifierRelayEvent,
    });
    app.addHook("onClose", async () => verifierRelayWorker?.stop());
  }

  const address = await app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 7544,
  });
  verifierRelayWorker?.start();

  return {
    app,
    address,
    loadedConfigs: loaded.configs,
    ...(verifierRelayWorker
      ? { verifierRelayWorker, verifierCoordinationWorker: verifierRelayWorker }
      : {}),
  };
}

export async function daemonStatus(options: Pick<DaemonOptions, "configDir" | "host" | "port"> = {}) {
  const configDir = options.configDir ?? defaultConfigDir();
  const loaded = await loadDeploymentConfigs(configDir, {
    // Status inspects configuration but does not ingest plugins for execution.
    confirmPluginUse: async () => true,
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }

  return {
    listen: {
      address: options.host ?? "127.0.0.1",
      port: options.port ?? 7544,
    },
    configDir,
    loadedConfigs: loaded.configs.map((entry) => ({
      name: entry.config.name,
      applicationDid: entry.config.target.applicationDid,
      pluginDid: entry.config.plugin.pluginDid,
    })),
  };
}

export async function loadAdapterKey(path: string): Promise<AdapterKeyFile> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AdapterKeyFile>;
  if (!parsed.did || !parsed.privateJwk) {
    throw new Error(`Adapter key file is invalid: ${path}`);
  }

  return {
    did: parsed.did,
    privateJwk: parsed.privateJwk,
    publicJwk: parsed.publicJwk,
  };
}

function logVerifierRelayEvent(event: VerifierRelayWorkerEvent): void {
  process.stderr.write(`[mpas-adapter] ${JSON.stringify(event)}\n`);
}
