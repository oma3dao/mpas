import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProposerBridge } from "./bridges/proposer-bridge.js";
import { KeyManager } from "./lib/key-manager.js";
import type { MpasApplicationPlugin } from "./types/mpas.js";
import type { ProposerConfig } from "./types/config.js";

interface CliConfig {
  mode: "proposer" | "maintainer";
  plugin?: string;
  adapter?: {
    url: string;
  };
  coordination?: {
    url: string;
  };
  agent: {
    did?: `did:${string}:${string}`;
    keyFile: string;
  };
  target?: {
    applicationDid: `did:${string}:${string}`;
  };
  approvalStrategy?: "return" | "coordinate" | "wait";
  approvalTimeoutMs?: number;
}

export async function createBridgeFromConfig(configPath: string): Promise<ProposerBridge> {
  const absoluteConfigPath = resolve(configPath);
  const configDir = dirname(absoluteConfigPath);
  const config = JSON.parse(await readFile(absoluteConfigPath, "utf8")) as CliConfig;
  await validateCliConfig(config, configDir);
  const agentKey = resolve(configDir, config.agent.keyFile);

  if (config.mode === "proposer") {
    return new ProposerBridge(toProposerConfig(config, configDir, agentKey));
  }
  if (config.mode === "maintainer") {
    throw new Error(
      'Maintainer/signer mode has been extracted from the SDK. ' +
      'Use the standalone Signer Server at examples/demo/src/signer-server/ instead.',
    );
  }

  throw new Error(`Unsupported bridge mode: ${String(config.mode)}`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const configPath = configPathFromArgs(argv);
  const bridge = await createBridgeFromConfig(configPath);
  const server = bridge.buildMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

function toProposerConfig(config: CliConfig, configDir: string, agentKey: string): ProposerConfig {
  if (!config.plugin || !config.adapter || !config.target) {
    throw new Error("Proposer mode requires plugin, adapter.url, and target.applicationDid.");
  }

  return {
    plugin: resolve(configDir, config.plugin),
    applicationDid: config.target.applicationDid,
    adapterUrl: config.adapter.url,
    agentKey,
    approvalStrategy: config.approvalStrategy,
    coordinationUrl: config.coordination?.url,
    approvalTimeoutMs: config.approvalTimeoutMs,
  };
}

function configPathFromArgs(argv: string[]): string {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  if (!configPath) {
    throw new Error("Usage: mpas-bridge --config <path>");
  }

  return configPath;
}

async function validateCliConfig(config: CliConfig, configDir: string): Promise<void> {
  if (!["proposer", "maintainer"].includes(config.mode)) {
    throw new Error('Config field "mode" must be one of: proposer, maintainer.');
  }
  if (!config.agent?.keyFile) {
    throw new Error('Config field "agent.keyFile" is required.');
  }

  await validateKey(resolve(configDir, config.agent.keyFile), config.agent.did, "agent");

  if (config.mode === "proposer") {
    if (!config.plugin) {
      throw new Error('Proposer mode requires config field "plugin".');
    }
    if (!config.adapter?.url) {
      throw new Error('Proposer mode requires config field "adapter.url".');
    }
    if (!config.target?.applicationDid) {
      throw new Error('Proposer mode requires config field "target.applicationDid".');
    }

    const plugin = await readJsonFile<MpasApplicationPlugin>(resolve(configDir, config.plugin), "plugin");
    if (!plugin.operations || typeof plugin.operations !== "object" || Object.keys(plugin.operations).length === 0) {
      throw new Error("Plugin must define at least one operation.");
    }
    if (plugin.applicationDid !== config.target.applicationDid) {
      throw new Error(
        `Config target.applicationDid ${config.target.applicationDid} does not match plugin applicationDid ${plugin.applicationDid}.`,
      );
    }
  }

  if (config.mode === "maintainer") {
    throw new Error(
      'Maintainer/signer mode has been extracted from the SDK. ' +
      'Use the standalone Signer Server at examples/demo/src/signer-server/ instead.',
    );
  }
}

async function validateKey(path: string, expectedDid: `did:${string}:${string}` | undefined, label: string): Promise<void> {
  let keyManager: KeyManager;
  try {
    keyManager = await KeyManager.fromFile(path);
  } catch (error) {
    throw new Error(`Config ${label}.keyFile is not a valid Ed25519 key: ${errorMessage(error)}`);
  }

  if (expectedDid && expectedDid !== keyManager.did) {
    throw new Error(`Config ${label}.did ${expectedDid} does not match derived DID ${keyManager.did}.`);
  }
}

async function readJsonFile<T>(path: string, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`Could not load ${label} file ${path}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(import.meta.url)) : undefined;
if (invokedPath && resolve(process.argv[1]) === invokedPath) {
  await runCli();
}
