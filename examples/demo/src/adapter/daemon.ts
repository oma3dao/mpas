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
import {
  DEFAULT_TRUST_CONTEXT,
  type TrustContext,
} from "./trust.js";
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
  /** Internal injection point for tests and embedded deployments. */
  trustContext?: TrustContext | null;
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
