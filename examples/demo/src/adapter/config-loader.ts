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
import type { PolicyConfig, PolicyEntry } from "../core/policy-engine.js";
import type { McpHttpTarget } from "./dispatch/mcp-http.js";
import type { McpStdioTarget } from "./dispatch/mcp-stdio.js";
import { buildTrustReport, type TrustContext } from "./trust.js";
import {
  promptPluginUse,
  type ConfirmPluginUse,
  type PluginTrustAssessment,
} from "./trust-prompt.js";

import type { JWK } from "jose";
import { didJwkToJwk, isDidJwk } from "@oma3/mpas";

export interface SignerKey {
  did: Did;
  label?: string;
  /** Optional when `did` is a did:jwk — the DID embeds the key and is the source of truth. */
  publicJwk?: JWK;
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
  policies?: Record<string, PolicyEntry[]>;
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
  /**
   * Routing for operations absent from both the plugin and the policy.
   * "allow" (default) proxies them with the adapter credential on the
   * proposer's signature alone; "deny" rejects them (fail closed).
   */
  passThrough?: "allow" | "deny";
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

export interface LoadDeploymentConfigsOptions {
  trustContext?: TrustContext | null;
  trustContextError?: string;
  confirmPluginUse?: ConfirmPluginUse;
}

const policyEntrySchema = {
  type: "object",
  properties: {
    reject: { type: "boolean", default: false },
    requirements: { type: "object", required: ["type"] },
  },
  oneOf: [
    {
      required: ["requirements"],
      properties: { reject: { const: false } },
    },
    {
      required: ["reject"],
      not: { required: ["requirements"] },
      properties: { reject: { const: true } },
    },
  ],
} as const;

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
        policies: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: policyEntrySchema,
          },
        },
        context: {},
      },
    },
    signerKeys: {
      type: "array",
      items: {
        type: "object",
        required: ["did"],
        properties: {
          did: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
          label: { type: "string" },
          publicJwk: { type: "object" },
        },
        additionalProperties: false,
      },
      minItems: 1,
    },
    passThrough: { enum: ["allow", "deny"] },
  },
  additionalProperties: false,
};

const ajv = new Ajv2020({ strict: false });
const validateDeploymentConfig = ajv.compile(deploymentConfigSchema);

export async function loadDeploymentConfigs(
  configDir: string,
  options: LoadDeploymentConfigsOptions = {},
): Promise<LoadDeploymentConfigsResult> {
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
    const loaded = await loadDeploymentConfigFile(filePath, configDir, options);
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
  options: LoadDeploymentConfigsOptions,
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

  // Signer key validation. For did:jwk identities the DID is the source of
  // truth: a configured publicJwk must match the key embedded in the DID.
  // For other DID methods a publicJwk is required.
  for (const signer of config.signerKeys) {
    if (isDidJwk(signer.did)) {
      let embedded: JWK;
      try {
        embedded = didJwkToJwk(signer.did);
      } catch (error) {
        return loadError("CONFIG_SCHEMA_INVALID", `signerKeys: invalid did:jwk for ${signer.label ?? signer.did}: ${error instanceof Error ? error.message : String(error)}`, filePath);
      }
      if (signer.publicJwk && signer.publicJwk.x !== embedded.x) {
        return loadError(
          "CONFIG_SCHEMA_INVALID",
          `signerKeys: publicJwk does not match the key embedded in did:jwk for ${signer.label ?? signer.did}. The DID is the source of truth; remove or correct publicJwk.`,
          filePath,
        );
      }
    } else if (!signer.publicJwk) {
      return loadError(
        "CONFIG_SCHEMA_INVALID",
        `signerKeys: publicJwk is required for non-did:jwk DID ${signer.did}.`,
        filePath,
      );
    }
  }

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

  // Report the available trust information and require an explicit operator
  // decision after the did:artifact integrity check succeeds.
  let assessment: PluginTrustAssessment;
  if (options.trustContext) {
    try {
      assessment = {
        status: "checked",
        report: await buildTrustReport(pluginResult.plugin, config, options.trustContext),
      };
    } catch (error) {
      assessment = {
        status: "notChecked",
        reason: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    assessment = options.trustContextError
      ? { status: "notChecked", reason: "unavailable", detail: options.trustContextError }
      : { status: "notChecked", reason: "notConfigured" };
  }

  const confirmed = await (options.confirmPluginUse ?? promptPluginUse)(assessment, config);
  if (!confirmed) {
    return loadError(
      "PLUGIN_TRUST_REJECTED",
      "Operator declined to use the plugin after reviewing its trust information.",
      filePath,
    );
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
