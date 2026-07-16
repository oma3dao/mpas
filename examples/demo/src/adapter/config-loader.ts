import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalize } from "json-canonicalize";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { loadPlugin, type MpasApplicationPlugin } from "../core/plugin-loader.js";
import type { Did } from "../core/types.js";
import type { PolicyConfig } from "../core/policy-engine.js";
import type { McpHttpTarget } from "./dispatch/mcp-http.js";
import type { McpStdioTarget } from "./dispatch/mcp-stdio.js";
import { canTrust, type TrustContext, type TrustVerdict } from "./trust.js";
import { promptOperator, displayTrusted, promptNetworkUnavailable } from "./trust-prompt.js";

import type { JWK } from "jose";

export interface SignerKey {
  did: Did;
  label?: string;
  publicJwk: JWK;
}

export interface MpasApplicationPolicy {
  version: "1";
  type: "MpasApplicationPolicy";
  policyProfileUrl: string;
  applicationDid: Did;
  executionProfile: {
    id: Did;
    format?: string;
  };
  defaultRequirement: PolicyConfig["defaultRequirement"];
  signerGroups: Record<string, Did[]>;
  policies?: Record<string, Array<{
    description?: string;
    match?: {
      conditions?: Array<{
        source: string;
        path: string;
        op: string;
        value?: unknown;
      }>;
    };
    requirements: PolicyConfig["defaultRequirement"];
  }>>;
  context?: unknown;
}

export interface DeploymentConfig {
  version: "1";
  type: "MpasAdapterDeploymentConfig";
  name: string;
  target: {
    applicationDid: Did;
  };
  plugin: {
    pluginDid: Did;
    pluginVersion: string;
    artifactDid: string;
    path: string;
  };
  credentialBindings: Array<{
    credentialHandle: string;
    provider: "file" | "macos-keychain";
  }>;
  executionTarget: McpStdioTarget | McpHttpTarget;
  policy: MpasApplicationPolicy;
  signerKeys: SignerKey[];
}

export interface LoadedDeploymentConfig {
  filePath: string;
  config: DeploymentConfig;
  plugin: MpasApplicationPlugin;
}

export interface DeploymentConfigLoadError {
  kind: "DeploymentConfigLoadError";
  code:
    | "CONFIG_DIR_READ_FAILED"
    | "CONFIG_INVALID_JSON"
    | "CONFIG_SCHEMA_INVALID"
    | "PLUGIN_LOAD_FAILED"
    | "PLUGIN_REFERENCE_MISMATCH"
    | "PLUGIN_HASH_MISMATCH"
    | "PLUGIN_TRUST_REJECTED";
  message: string;
  path: string;
  details?: unknown;
}

export type LoadDeploymentConfigsResult =
  | {
      ok: true;
      configsByApplicationDid: Map<Did, LoadedDeploymentConfig>;
      configs: LoadedDeploymentConfig[];
    }
  | {
      ok: false;
      error: DeploymentConfigLoadError;
    };

const deploymentConfigSchema = {
  type: "object",
  required: [
    "version",
    "type",
    "name",
    "target",
    "plugin",
    "credentialBindings",
    "executionTarget",
    "policy",
    "signerKeys",
  ],
  properties: {
    version: { const: "1" },
    type: { const: "MpasAdapterDeploymentConfig" },
    name: { type: "string", minLength: 1 },
    target: {
      type: "object",
      required: ["applicationDid"],
      properties: {
        applicationDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
      },
      additionalProperties: false,
    },
    plugin: {
      type: "object",
      required: ["pluginDid", "pluginVersion", "artifactDid", "path"],
      properties: {
        pluginDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
        pluginVersion: { type: "string", minLength: 1 },
        artifactDid: { type: "string", pattern: "^did:artifact:[a-z2-7]+" },
        path: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    credentialBindings: {
      type: "array",
      items: {
        type: "object",
        required: ["credentialHandle", "provider"],
        properties: {
          credentialHandle: { type: "string", minLength: 1 },
          provider: { enum: ["file", "macos-keychain"] },
        },
        additionalProperties: false,
      },
      minItems: 1,
    },
    executionTarget: { type: "object", required: ["type"] },
    policy: {
      type: "object",
      required: ["version", "type", "applicationDid", "executionProfile", "defaultRequirement", "signerGroups"],
      properties: {
        version: { const: "1" },
        type: { const: "MpasApplicationPolicy" },
        policyProfileUrl: { type: "string" },
        applicationDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
        executionProfile: { type: "object", required: ["id"] },
        defaultRequirement: { type: "object", required: ["type"] },
        signerGroups: {
          type: "object",
          required: ["all"],
          additionalProperties: { type: "array", items: { type: "string", pattern: "^did:[a-z0-9]+:.+" } },
        },
        policies: { type: "object" },
        context: {},
      },
    },
    signerKeys: {
      type: "array",
      items: {
        type: "object",
        required: ["did", "publicJwk"],
        properties: {
          did: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
          label: { type: "string" },
          publicJwk: { type: "object" },
        },
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  additionalProperties: false,
};

const ajv = new Ajv2020({ strict: false });
const validateDeploymentConfig = ajv.compile(deploymentConfigSchema);

export async function loadDeploymentConfigs(configDir: string, trustContext?: TrustContext | null): Promise<LoadDeploymentConfigsResult> {
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch (error) {
    return loadError("CONFIG_DIR_READ_FAILED", `Unable to read config directory: ${configDir}`, configDir, error);
  }

  const loadedConfigs: LoadedDeploymentConfig[] = [];
  const configsByApplicationDid = new Map<Did, LoadedDeploymentConfig>();

  for (const entry of entries.filter((file) => file.endsWith(".json")).sort()) {
    const filePath = join(configDir, entry);
    const loaded = await loadDeploymentConfigFile(filePath, configDir, trustContext);
    if (!loaded.ok) {
      return loaded;
    }

    loadedConfigs.push(loaded.config);
    configsByApplicationDid.set(loaded.config.config.target.applicationDid, loaded.config);
  }

  return {
    ok: true,
    configsByApplicationDid,
    configs: loadedConfigs,
  };
}

async function loadDeploymentConfigFile(
  filePath: string,
  configDir: string,
  trustContext?: TrustContext | null,
): Promise<
  | {
      ok: true;
      config: LoadedDeploymentConfig;
    }
  | {
      ok: false;
      error: DeploymentConfigLoadError;
    }
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    return loadError("CONFIG_INVALID_JSON", `Deployment config is not valid JSON: ${filePath}`, filePath, error);
  }

  if (!validateDeploymentConfig(parsed)) {
    const errors = validateDeploymentConfig.errors ?? [];
    const details = errors
      .map((e) => {
        const path = e.instancePath ? e.instancePath.slice(1).replace(/\//g, ".") : "(root)";
        return `  ${path}: ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`;
      })
      .join("\n");
    return loadError(
      "CONFIG_SCHEMA_INVALID",
      `${filePath} does not conform to the schema:\n${details}`,
      filePath,
      errors,
    );
  }

  const config = parsed as unknown as DeploymentConfig;
  const pluginPath = resolve(configDir, config.plugin.path);
  const pluginResult = await loadPlugin(pluginPath);
  if (!pluginResult.ok) {
    return loadError("PLUGIN_LOAD_FAILED", pluginResult.error.message, pluginPath, pluginResult.error);
  }

  if (
    pluginResult.plugin.pluginDid !== config.plugin.pluginDid ||
    pluginResult.plugin.pluginVersion !== config.plugin.pluginVersion ||
    pluginResult.plugin.applicationDid !== config.target.applicationDid
  ) {
    return loadError("PLUGIN_REFERENCE_MISMATCH", "Deployment config plugin reference does not match plugin.", filePath);
  }

  const actualArtifactDid = await computeArtifactDid(pluginResult.plugin);
  if (actualArtifactDid !== config.plugin.artifactDid) {
    return loadError(
      "PLUGIN_HASH_MISMATCH",
      "Deployment config plugin artifactDid does not match plugin contents.",
      filePath,
      { expected: config.plugin.artifactDid, actual: actualArtifactDid },
    );
  }

  // OMATrust: evaluate plugin trustworthiness after integrity is confirmed.
  if (trustContext) {
    let verdict: TrustVerdict;
    try {
      verdict = await canTrust(pluginResult.plugin, config, trustContext);
    } catch {
      // Network failure or SDK error — treat as untrusted, prompt operator.
      const confirmed = await promptNetworkUnavailable(config);
      if (!confirmed) {
        return loadError("PLUGIN_TRUST_REJECTED", "Operator declined to load plugin (trust check unavailable).", filePath);
      }
      return { ok: true, config: { filePath, config, plugin: pluginResult.plugin } };
    }

    if (verdict.trusted) {
      displayTrusted(config, verdict);
    } else {
      const confirmed = await promptOperator(verdict, config);
      if (!confirmed) {
        return loadError("PLUGIN_TRUST_REJECTED", "Operator declined to load untrusted plugin.", filePath);
      }
    }
  }

  return {
    ok: true,
    config: {
      filePath,
      config,
      plugin: pluginResult.plugin,
    },
  };
}

export async function computeArtifactDid(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const hash = await sha256.digest(bytes);
  const cid = CID.createV1(raw.code, hash);
  return `did:artifact:${cid.toString(base32)}`;
}

function loadError(
  code: DeploymentConfigLoadError["code"],
  message: string,
  path: string,
  details?: unknown,
): { ok: false; error: DeploymentConfigLoadError } {
  return {
    ok: false,
    error: {
      kind: "DeploymentConfigLoadError",
      code,
      message,
      path,
      details,
    },
  };
}
