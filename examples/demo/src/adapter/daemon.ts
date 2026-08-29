import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { JWK } from "jose";
import { WebSocket } from "ws";
import {
  CoordinationResponseError,
  CoordinationServiceClient,
  CoordinationUnavailableError,
  KeyManager,
  parseActionResponse,
  type CoordinationWebSocket,
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
  FileVerifierCoordinationStateStore,
  VerifierCoordinationWorker,
  type VerifierCoordinationClient,
  type VerifierCoordinationStateStore,
  type VerifierCoordinationWorkerEvent,
} from "./verifier-coordination-worker.js";

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
  /** Hosted Coordination Service used for outbound Verifier delivery polling. */
  verifierCoordinationUrl?: string;
  /** Durable cursor and cached-response state for outbound Verifier delivery. */
  verifierCoordinationStatePath?: string;
  /** Recovery poll cadence used in addition to WebSocket notifications. */
  verifierPollIntervalMs?: number;
  /** Internal injection point for tests and embedded deployments. */
  trustContext?: TrustContext | null;
  confirmPluginUse?: ConfirmPluginUse;
  verifierCoordinationClient?: VerifierCoordinationClient;
  verifierCoordinationStateStore?: VerifierCoordinationStateStore;
  verifierCoordinationEventSink?: (event: VerifierCoordinationWorkerEvent) => void;
}

export interface StartedDaemon {
  app: FastifyInstance;
  address: string;
  loadedConfigs: LoadedDeploymentConfig[];
  verifierCoordinationWorker?: VerifierCoordinationWorker;
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

export function defaultVerifierCoordinationStatePath(): string {
  return process.env.MPAS_VERIFIER_COORDINATION_STATE ??
    join(homedir(), ".mpas", "journal", "verifier-coordination.json");
}

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

  let verifierCoordinationWorker: VerifierCoordinationWorker | undefined;
  if (options.verifierCoordinationUrl) {
    const keyManager = KeyManager.fromJwk(adapterKey.privateJwk);
    if (keyManager.did !== adapterKey.did) {
      throw new Error(
        `Adapter key DID ${adapterKey.did} does not match the DID derived from its private key ${keyManager.did}.`,
      );
    }
    const coordinationClient = options.verifierCoordinationClient ?? new CoordinationServiceClient({
      url: options.verifierCoordinationUrl,
      signer: keyManager,
      webSocketFactory: ({ url, headers }) => new WebSocket(url, {
        headers: { Authorization: headers.Authorization },
      }) as unknown as CoordinationWebSocket,
    });
    const stateStore = options.verifierCoordinationStateStore ?? new FileVerifierCoordinationStateStore(
      options.verifierCoordinationStatePath ?? defaultVerifierCoordinationStatePath(),
    );
    verifierCoordinationWorker = await VerifierCoordinationWorker.create({
      coordinationUrl: options.verifierCoordinationUrl,
      verifierDid: adapterKey.did,
      client: coordinationClient,
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
          url: "/mpas/v1/action",
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
            throw new CoordinationUnavailableError(
              `Credential Adapter temporarily failed a polled Action envelope with HTTP ${response.statusCode}.`,
            );
          }
          throw new CoordinationResponseError(
            `Credential Adapter rejected a polled Action envelope with HTTP ${response.statusCode}.`,
          );
        }
        try {
          const parsed = parseActionResponse(JSON.parse(response.body) as unknown);
          if (parsed.result === "pending") {
            throw new CoordinationUnavailableError(
              "Credential Adapter is still processing the polled Action envelope.",
            );
          }
          if (
            parsed.result === "rejected" &&
            (parsed.error?.code === "REPLAY_DETECTED" || parsed.error?.code === "ACTION_ID_HASH_MISMATCH")
          ) {
            throw new CoordinationResponseError(
              `Credential Adapter cannot recover the original response (${parsed.error.code}).`,
            );
          }
          return parsed;
        } catch (error) {
          if (error instanceof CoordinationResponseError || error instanceof CoordinationUnavailableError) {
            throw error;
          }
          throw new CoordinationResponseError("Credential Adapter returned an invalid ActionResponse.", {
            cause: error,
          });
        }
      },
      ...(options.verifierPollIntervalMs !== undefined
        ? { fallbackPollIntervalMs: options.verifierPollIntervalMs }
        : {}),
      onEvent: options.verifierCoordinationEventSink ?? logVerifierCoordinationEvent,
    });
    app.addHook("onClose", async () => verifierCoordinationWorker?.stop());
  }

  const address = await app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 7544,
  });
  verifierCoordinationWorker?.start();

  return {
    app,
    address,
    loadedConfigs: loaded.configs,
    ...(verifierCoordinationWorker ? { verifierCoordinationWorker } : {}),
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

function logVerifierCoordinationEvent(event: VerifierCoordinationWorkerEvent): void {
  process.stderr.write(`[mpas-adapter] ${JSON.stringify(event)}\n`);
}
