import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { JWK } from "jose";
import { loadDeploymentConfigs, type LoadedDeploymentConfig } from "./config-loader.js";
import { FileCredentialProvider } from "./credential-provider.js";
import { createAdapterApiServer } from "./adapter-api-server.js";
import { DispatchLedger, FileDispatchJournal } from "./dispatch-ledger.js";
import { TraceLogger, TraceWriter } from "../core/trace.js";
import type { Did } from "../core/types.js";
import type { OmaTrustConfig } from "./trust.js";
import { buildTrustContext } from "./trust-backend.js";
import type { ConfirmPluginUse } from "./trust-prompt.js";

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
  omaTrust?: OmaTrustConfig;
  omaTrustConfigPath?: string;
  confirmPluginUse?: ConfirmPluginUse;
}

export interface StartedDaemon {
  app: FastifyInstance;
  address: string;
  loadedConfigs: LoadedDeploymentConfig[];
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

export async function startDaemon(options: DaemonOptions = {}): Promise<StartedDaemon> {
  const configDir = options.configDir ?? defaultConfigDir();
  const omaTrustConfigPath = options.omaTrustConfigPath ?? process.env.MPAS_OMATRUST_CONFIG;
  const omaTrust = options.omaTrust ?? (omaTrustConfigPath ? await loadOmaTrustConfig(omaTrustConfigPath) : undefined);

  // Build OMATrust context if configured (fetches approved issuers from backend).
  let trustContext = null;
  let trustContextError: string | undefined;
  if (omaTrust && !omaTrust.disabled) {
    try {
      trustContext = await buildTrustContext(omaTrust);
    } catch (error) {
      trustContextError = error instanceof Error ? error.message : String(error);
    }
  }

  const loaded = await loadDeploymentConfigs(configDir, {
    trustContext,
    trustContextError,
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

  const address = await app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 7544,
  });

  return {
    app,
    address,
    loadedConfigs: loaded.configs,
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

export async function loadOmaTrustConfig(path: string): Promise<OmaTrustConfig> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<OmaTrustConfig>;
  const schemas = parsed.schemas;
  if (
    typeof parsed.rpcUrl !== "string" ||
    typeof parsed.easContractAddress !== "string" ||
    typeof parsed.backendUrl !== "string" ||
    !schemas ||
    typeof schemas.securityAssessment !== "string" ||
    typeof schemas.certification !== "string" ||
    typeof schemas.userReview !== "string" ||
    typeof schemas.linkedIdentifier !== "string" ||
    typeof schemas.controllerWitness !== "string"
  ) {
    throw new Error(`OMATrust configuration is invalid: ${path}`);
  }
  return parsed as OmaTrustConfig;
}
