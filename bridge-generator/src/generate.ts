/**
 * `bridge-generator generate` — application packaging orchestrator (spec.md §2, §3, §5).
 *
 * Runs discovery once and writes the full applications/<name>/ layout.
 * Regeneration semantics: generated surface overwritten; CHANGELOG.md created
 * once; harness-config and classification merged; .generator-keep respected.
 * plugin.json is merged, not rebuilt: membership = (old plugin ∩ new upstream)
 * ∪ tools new since the old snapshot, so operations a reviewer removed from
 * the plugin stay removed (spec.md §5). Identity fields and reviewed impacts
 * in the old plugin are preserved; descriptions/schemas refresh from discovery.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalize } from "json-canonicalize";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { base32 } from "multiformats/bases/base32";
import {
  buildClassificationDraft,
  buildDiscoveryMetadata,
  buildHarnessConfig,
  buildToolsListSnapshot,
  mergeClassificationDraft,
  mergeHarnessConfig,
  type ClassificationDraft,
  type HarnessConfig,
} from "./artifacts.js";
import { generateBridge, generateToolsJson, generateWorkflowStore } from "./bridge-codegen.js";
import { generatePlugin } from "./plugin-codegen.js";
import { discoverUpstream } from "./discovery.js";
import type { GeneratedPlugin, McpToolDefinition, UpstreamInfo } from "./types.js";

export const GENERATOR_VERSION = "0.2.0";

export interface OrgConfig {
  publisher: {
    name: string;
    githubOrg: string;
    publisherDid?: string;
    repository?: string;
  };
  application: {
    name: string;
    description: string;
    applicationDid: string;
    website?: string;
  };
}

export interface GenerateOptions {
  appName: string;
  outDir: string;
  orgConfigPath?: string;
  applicationDid?: string;
  upstreamCommand: string;
  upstreamArgs: string[];
  /** Injectable for deterministic tests. */
  capturedAt?: string;
  /** Injectable for tests; defaults to real discovery. */
  discover?: (command: string, args: string[]) => Promise<UpstreamInfo>;
  log?: (message: string) => void;
}

export class GenerateError extends Error {
  readonly exitCode = 5;
}

const APP_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export async function runGenerate(options: GenerateOptions): Promise<void> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  if (!APP_NAME_PATTERN.test(options.appName)) {
    throw new GenerateError(`Invalid --app name "${options.appName}" (lowercase, hyphenated).`);
  }

  const orgConfig = options.orgConfigPath ? await loadOrgConfig(options.orgConfigPath) : undefined;
  const discover = options.discover ?? discoverUpstream;
  const upstream = await discover(options.upstreamCommand, options.upstreamArgs);

  const appDir = resolve(options.outDir, options.appName);
  await mkdir(join(appDir, "build-artifacts"), { recursive: true });
  await mkdir(join(appDir, "bridge", "src"), { recursive: true });

  const keep = await loadKeepList(appDir);
  const writeGenerated = async (relativePath: string, contents: string): Promise<void> => {
    if (keep.has(relativePath)) {
      log(`Preserved (in .generator-keep): ${relativePath}`);
      return;
    }
    const path = join(appDir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
    log(`Wrote: ${relativePath}`);
  };

  // Prior state must be read before the generated surface is overwritten:
  // regeneration membership is derived from old snapshot − old plugin.
  const previousSnapshot = await readJsonIfExists<{ tools?: Array<{ name: string }> }>(
    join(appDir, "build-artifacts", "tools-list.snapshot.json"),
  );
  const previousPlugin = await readJsonIfExists<Partial<GeneratedPlugin>>(join(appDir, "plugin.json"));

  // --- build-artifacts ---
  const snapshot = buildToolsListSnapshot(upstream.tools);
  await writeGenerated("build-artifacts/tools-list.snapshot.json", jsonFile(snapshot));

  const metadata = buildDiscoveryMetadata(upstream, {
    protocolVersion: upstream.protocolVersion,
    generatorVersion: GENERATOR_VERSION,
    capturedAt: options.capturedAt,
  });
  await writeGenerated("build-artifacts/metadata.json", jsonFile(metadata));

  const classification = await mergedClassification(appDir, upstream);
  await writeGenerated("build-artifacts/classification.json", jsonFile(classification));

  // --- plugin.json ---
  // Membership in plugin.operations is the governance control (Application
  // Plugin profile): tools the reviewer deleted from an existing plugin are
  // intentional pass-through and must not be re-added. classification.json is
  // advisory only and never drives membership.
  const governedTools = selectGovernedTools(snapshot.tools, previousPlugin, previousSnapshot, log);
  const plugin = JSON.parse(generatePlugin(governedTools, upstream.protocolVersion)) as GeneratedPlugin;
  if (previousPlugin) {
    plugin.pluginDid = previousPlugin.pluginDid ?? plugin.pluginDid;
    plugin.pluginVersion = previousPlugin.pluginVersion ?? plugin.pluginVersion;
    plugin.publisherDid = previousPlugin.publisherDid ?? plugin.publisherDid;
    plugin.applicationDid = previousPlugin.applicationDid ?? plugin.applicationDid;
    plugin.credentialRequirements = previousPlugin.credentialRequirements ?? plugin.credentialRequirements;
  }
  if (options.applicationDid ?? orgConfig?.application.applicationDid) {
    plugin.applicationDid = options.applicationDid ?? orgConfig!.application.applicationDid;
  }
  for (const [name, operation] of Object.entries(plugin.operations)) {
    const previousOperation = previousPlugin?.operations?.[name];
    if (previousOperation?.impact) {
      operation.impact = previousOperation.impact;
    } else if (classification.operations[name]) {
      operation.impact = classification.operations[name].impact;
    }
  }
  await writeGenerated("plugin.json", jsonFile(plugin));

  // --- harness-config.json (merge preserves manual edits) ---
  const harnessConfig = await mergedHarnessConfig(appDir, upstream);
  await writeGenerated("harness-config.json", jsonFile(harnessConfig));

  // --- registry-entry.json ---
  const registryEntry = buildRegistryEntry(options.appName, upstream, plugin, snapshot.toolSurface, orgConfig);
  validateRegistryEntry(registryEntry);
  registryEntry.plugin.artifactDid = await computeArtifactDid(plugin);
  await writeGenerated("registry-entry.json", jsonFile(registryEntry));

  // --- bridge/ ---
  await writeGenerated("bridge/src/index.ts", generateBridge(upstream));
  await writeGenerated("bridge/src/tools.json", generateToolsJson(upstream.tools));
  await writeGenerated("bridge/src/sqlite-workflow-store.ts", generateWorkflowStore());
  await writeGenerated("bridge/package.json", jsonFile(bridgePackageJson(options.appName)));
  await writeGenerated("bridge/tsconfig.json", jsonFile(bridgeTsconfig()));
  await writeGenerated("bridge/README.md", bridgeReadme(options.appName, upstream));

  // --- CHANGELOG.md (create once, never overwrite) ---
  const changelogPath = join(appDir, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    await writeFile(changelogPath, `# Changelog — ${options.appName}\n\nRecord manual review decisions and regenerations here.\n`, "utf8");
    log("Wrote: CHANGELOG.md");
  } else {
    log("Preserved: CHANGELOG.md");
  }

  log(`Application packaged: ${appDir}`);
}

/** Same construction as the demo adapter's plugin integrity check. */
export async function computeArtifactDid(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const hash = await sha256.digest(bytes);
  const cid = CID.createV1(raw.code, hash);
  return `did:artifact:${cid.toString(base32)}`;
}

export interface RegistryEntry {
  version: "1";
  application: { name: string; description: string; applicationDid: string; website?: string };
  native: false;
  protocol: "mcp";
  upstream: { name: string; protocolVersion: string; toolSurface: { alg: string; value: string } };
  plugin: { repository: string; pluginDid?: string; artifactDid?: string };
  publisher: { name: string; githubOrg: string; publisherDid?: string; repository?: string };
  status: "beta";
}

function buildRegistryEntry(
  appName: string,
  upstream: UpstreamInfo,
  plugin: { applicationDid: string },
  toolSurface: { alg: "sha-256"; value: string },
  orgConfig?: OrgConfig,
): RegistryEntry {
  return {
    version: "1",
    application: orgConfig
      ? { ...orgConfig.application }
      : {
          name: appName,
          description: `MPAS-protected ${appName} via ${upstream.serverName}. PLACEHOLDER: review before submitting.`,
          applicationDid: plugin.applicationDid,
        },
    native: false,
    protocol: "mcp",
    upstream: {
      name: upstream.serverName,
      protocolVersion: upstream.protocolVersion,
      toolSurface,
    },
    plugin: {
      repository: "PLACEHOLDER: URL to the published plugin.json",
    },
    publisher: orgConfig
      ? { ...orgConfig.publisher }
      : { name: "PLACEHOLDER", githubOrg: "PLACEHOLDER" },
    status: "beta",
  };
}

/** Minimal validation against application-registry/README.md schema v1. */
function validateRegistryEntry(entry: RegistryEntry): void {
  const missing: string[] = [];
  if (!entry.application.name) missing.push("application.name");
  if (!entry.application.description) missing.push("application.description");
  if (!entry.application.applicationDid) missing.push("application.applicationDid");
  if (!entry.plugin.repository) missing.push("plugin.repository");
  if (!entry.publisher.name) missing.push("publisher.name");
  if (!entry.publisher.githubOrg) missing.push("publisher.githubOrg");
  if (missing.length > 0) {
    throw new GenerateError(`Registry entry is missing required fields: ${missing.join(", ")}`);
  }
}

async function loadOrgConfig(path: string): Promise<OrgConfig> {
  let parsed: OrgConfig;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as OrgConfig;
  } catch (error) {
    throw new GenerateError(`Unable to read org config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed.publisher?.name || !parsed.publisher?.githubOrg || !parsed.application?.applicationDid) {
    throw new GenerateError(`Org config ${path} must define publisher.name, publisher.githubOrg, and application.applicationDid.`);
  }
  return parsed;
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    throw new GenerateError(`Unable to parse existing ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Regeneration membership (spec.md §5). A discovered tool is governed iff:
 * - there is no previous plugin (first generate → all tools), or
 * - it appears in the previous plugin's operations (still governed), or
 * - it is absent from the previous snapshot (new upstream tool — included so
 *   reviewers can't silently miss it).
 * A tool in the previous snapshot but not the previous plugin was reviewed
 * out (intentional pass-through) and stays out. Without a previous snapshot,
 * new and reviewed-out tools are indistinguishable; the previous plugin is
 * treated as authoritative and skipped tools are logged for review.
 */
function selectGovernedTools(
  tools: McpToolDefinition[],
  previousPlugin: Partial<GeneratedPlugin> | undefined,
  previousSnapshot: { tools?: Array<{ name: string }> } | undefined,
  log: (message: string) => void,
): McpToolDefinition[] {
  if (!previousPlugin) {
    return tools;
  }
  const previousOperations = new Set(Object.keys(previousPlugin.operations ?? {}));
  if (!previousSnapshot?.tools) {
    const skipped = tools.filter((tool) => !previousOperations.has(tool.name)).map((tool) => tool.name);
    if (skipped.length > 0) {
      log(
        `Warning: no previous tools-list.snapshot.json; kept the existing plugin's operations and left out: ${skipped.join(", ")}. Add any of these to plugin.json manually if they should be governed.`,
      );
    }
    return tools.filter((tool) => previousOperations.has(tool.name));
  }
  const previousSurface = new Set(previousSnapshot.tools.map((tool) => tool.name));
  return tools.filter((tool) => previousOperations.has(tool.name) || !previousSurface.has(tool.name));
}

async function loadKeepList(appDir: string): Promise<Set<string>> {
  const path = join(appDir, ".generator-keep");
  if (!existsSync(path)) {
    return new Set();
  }
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return new Set(lines);
}

async function mergedClassification(appDir: string, upstream: UpstreamInfo): Promise<ClassificationDraft> {
  const path = join(appDir, "build-artifacts", "classification.json");
  if (!existsSync(path)) {
    return buildClassificationDraft(upstream.tools);
  }
  const existing = JSON.parse(await readFile(path, "utf8")) as ClassificationDraft;
  return mergeClassificationDraft(existing, upstream.tools);
}

async function mergedHarnessConfig(appDir: string, upstream: UpstreamInfo): Promise<HarnessConfig> {
  const path = join(appDir, "harness-config.json");
  if (!existsSync(path)) {
    return buildHarnessConfig(upstream);
  }
  const existing = JSON.parse(await readFile(path, "utf8")) as HarnessConfig;
  return mergeHarnessConfig(existing, upstream);
}

function bridgePackageJson(appName: string): object {
  return {
    name: `mpas-bridge-${appName}`,
    version: "0.1.0",
    description: `MPAS bridge MCP server for ${appName} (generated by bridge-generator)`,
    type: "module",
    bin: { [`mpas-bridge-${appName}`]: "./dist/index.js" },
    scripts: {
      build: "rm -rf dist && tsc -p tsconfig.json && node -e \"require('node:fs').copyFileSync('src/tools.json', 'dist/tools.json')\"",
      start: "node dist/index.js",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.13.0",
      "@oma3/mpas": "^0.1.0-alpha.1",
    },
    devDependencies: {
      "@types/node": "^22.15.29",
      typescript: "^5.8.3",
    },
    engines: { node: ">=22" },
  };
}

function bridgeTsconfig(): object {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      declaration: true,
      sourceMap: true,
      outDir: "dist",
      rootDir: "src",
      skipLibCheck: true,
    },
    include: ["src/**/*.ts"],
  };
}

function bridgeReadme(appName: string, upstream: UpstreamInfo): string {
  const toolNames = upstream.tools.map((tool) => tool.name).join(", ");
  return `# mpas-bridge-${appName}

MPAS bridge MCP server for **${appName}**, generated by \`bridge-generator\` from upstream \`${upstream.serverName}\`.

Tools: ${toolNames}

The runtime in \`src/index.ts\` loads the verbatim discovered tool surface from \`src/tools.json\`. The build copies both into \`dist/\`; keep \`dist/index.js\` and \`dist/tools.json\` together when packaging or deploying the bridge.

## Usage

\`\`\`sh
npm install
npm run build
node dist/index.js --config <path-to-bridge-config.json>
\`\`\`

The bridge config format matches the MPAS demo proposer bridge (plugin path, adapter URL, agent key, coordination URL, approval strategy). All tool calls are routed through the MPAS protocol: the bridge signs an Action Package and submits it to the configured Credential Adapter; nothing is proxied directly to the upstream server.

This file is generated then checked in. Edit freely; regeneration preserves files listed in \`.generator-keep\`.
`;
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
