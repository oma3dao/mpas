import { samePublicKey, validatePublicJwk } from "@oma3/mpas";
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
import { validatePolicyConfig, type PolicyConfig, type PolicyEntry, type Requirement } from "../core/policy-engine.js";
import type { McpHttpTarget } from "./dispatch/mcp-http.js";
import type { McpStdioTarget } from "./dispatch/mcp-stdio.js";
import type {
  OAuthClientConfiguration,
  OAuthRefreshPolicy,
  OAuthSharingPolicy,
} from "./oauth-operator.js";
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
  executionTarget: McpStdioTarget | ManagedOAuthHttpTarget | McpHttpTarget;
  policy: MpasApplicationPolicy;
  signerKeys: SignerKey[];
  /**
   * Routing for operations absent from both the plugin and the policy.
   * Omitted or "deny" rejects them before credential access. Explicit "allow"
   * proxies them with the adapter credential on the proposer's signature alone.
   */
  passThrough?: "allow" | "deny";
}

export interface ManagedOAuthConfiguration {
  type: "oauth2";
  session: string;
  scopes?: string[];
  scopePolicy?: "fixed";
  issuer?: string;
  client?: OAuthClientConfiguration;
  owner?: string;
  sharing?: Partial<OAuthSharingPolicy>;
  refresh?: Partial<OAuthRefreshPolicy>;
}

export interface ManagedOAuthHttpTarget extends Omit<McpHttpTarget, "auth"> {
  auth: ManagedOAuthConfiguration;
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
    | "PLUGIN_TRUST_REJECTED"
    | "CREDENTIAL_PROVIDER_UNSUPPORTED"
    | "POLICY_REFERENCE_MISMATCH"
    | "DEFAULT_REQUIREMENT_UNSATISFIABLE"
    | "DUPLICATE_APPLICATION_DID";
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
      required: ["version", "type", "policyProfileUrl", "applicationDid", "executionProfile", "defaultRequirement", "signerGroups"],
      properties: {
        version: { const: "1" },
        type: { const: "MpasApplicationPolicy" },
        policyProfileUrl: { const: "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md" },
        applicationDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
        executionProfile: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
            format: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
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
        context: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
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

    // Two configs claiming one applicationDid cannot both be routed to: the
    // adapter dispatches solely by target.applicationDid. Silently keeping the
    // last one loaded would send actions to the wrong upstream with no error,
    // so refuse to start instead.
    const applicationDid = loaded.config.config.target.applicationDid;
    const existing = configsByApplicationDid.get(applicationDid);
    if (existing) {
      return loadError(
        "DUPLICATE_APPLICATION_DID",
        `Deployment configs "${existing.config.name}" and "${loaded.config.config.name}" both target ${applicationDid}. ` +
          "Each application DID must be served by exactly one config.",
        filePath,
      );
    }

    loadedConfigs.push(loaded.config);
    configsByApplicationDid.set(applicationDid, loaded.config);
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
  const unsupportedProvider = config.credentialBindings.find((binding) => binding.provider !== "file");
  if (unsupportedProvider) {
    return loadError(
      "CREDENTIAL_PROVIDER_UNSUPPORTED",
      `Credential provider "${unsupportedProvider.provider}" is not implemented. Use provider "file" or implement "${unsupportedProvider.provider}" explicitly. The adapter will not silently read credentials from disk.`,
      filePath,
    );
  }
  const oauthAuth = config.executionTarget.type === "mcp.http" && config.executionTarget.auth?.type === "oauth2"
    ? config.executionTarget.auth
    : undefined;
  const usesManagedOAuth = oauthAuth !== undefined;
  if (oauthAuth && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(oauthAuth.session ?? "")) {
    return loadError(
      "CONFIG_SCHEMA_INVALID",
      "executionTarget.auth.session must identify the configured OAuth token session.",
      filePath,
    );
  }
  if (usesManagedOAuth) {
    const oauthConfigurationError = validateManagedOAuthConfiguration(config, filePath);
    if (oauthConfigurationError) return oauthConfigurationError;
  }
  const policyValidation = validatePolicyConfig(config.policy);
  if (!policyValidation.ok) {
    return loadError("CONFIG_SCHEMA_INVALID", `Policy does not conform to the MPAS JSON Verifier Policy Profile: ${policyValidation.message}`, filePath);
  }

  const defaultRequirementError = validateDefaultRequirement(config, filePath);
  if (defaultRequirementError) return defaultRequirementError;

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
      let matches = true;
      try {
        if (signer.publicJwk) {
          validatePublicJwk(signer.publicJwk, "verify");
          matches = samePublicKey(signer.publicJwk, embedded);
        }
      } catch { matches = false; }
      if (!matches) {
        return loadError(
          "CONFIG_SCHEMA_INVALID",
          `signerKeys: publicJwk does not match the key embedded in did:jwk for ${signer.label ?? signer.did}. The DID is the source of truth; remove or correct publicJwk.`,
          filePath,
        );
      }
    } else if (!signer.publicJwk) {
      return loadError("CONFIG_SCHEMA_INVALID", `signerKeys: publicJwk is required for non-did:jwk DID ${signer.did}.`, filePath);
    } else {
      try { validatePublicJwk(signer.publicJwk, "verify"); }
      catch { return loadError("CONFIG_SCHEMA_INVALID", "signerKeys: invalid public JWK.", filePath); }
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

  if (config.policy.applicationDid !== config.target.applicationDid) {
    return loadError(
      "POLICY_REFERENCE_MISMATCH",
      "Policy applicationDid does not match the deployment target applicationDid.",
      filePath,
    );
  }

  if (
    config.policy.executionProfile.id !== pluginResult.plugin.executionProfile.id ||
    (config.policy.executionProfile.format !== undefined &&
      config.policy.executionProfile.format !== pluginResult.plugin.executionProfile.format)
  ) {
    return loadError(
      "POLICY_REFERENCE_MISMATCH",
      "Policy executionProfile does not match the Application Plugin executionProfile.",
      filePath,
    );
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

  // Load trust information after the did:artifact integrity check succeeds.
  // The prompt always shows the evidence for operator judgment, but it uses
  // warning language only when neither primary signal exists or the lookup
  // could not be completed.
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
    assessment = {
      status: "notChecked",
      reason: "unavailable",
      detail: "Artifact trust lookup was not requested by this caller.",
    };
  }

  const confirmed =
    await (options.confirmPluginUse ?? promptPluginUse)(assessment, config);
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

function validateManagedOAuthConfiguration(
  config: DeploymentConfig,
  filePath: string,
): { ok: false; error: DeploymentConfigLoadError } | null {
  if (config.executionTarget.type !== "mcp.http" || config.executionTarget.auth?.type !== "oauth2") return null;
  const auth = config.executionTarget.auth as ManagedOAuthConfiguration;
  if (config.credentialBindings.length !== 1 || config.credentialBindings[0]?.provider !== "file") {
    return loadError(
      "CONFIG_SCHEMA_INVALID",
      "Managed OAuth requires exactly one file-backed OAuth session binding.",
      filePath,
    );
  }
  if (auth.scopePolicy !== undefined && auth.scopePolicy !== "fixed") {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth scopePolicy currently supports only fixed.", filePath);
  }
  if (auth.scopes !== undefined && (!Array.isArray(auth.scopes) ||
      !auth.scopes.every((scope) => typeof scope === "string" && scope.length > 0))) {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth scopes must be non-empty strings.", filePath);
  }
  if (auth.issuer !== undefined) {
    try {
      if (new URL(auth.issuer).protocol !== "https:") throw new Error("not HTTPS");
    } catch {
      return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth issuer must be an HTTPS URL.", filePath);
    }
  }
  const client = auth.client ?? { type: "auto" };
  if (!["auto", "static", "cimd", "dynamic"].includes(client.type)) {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth client mode is invalid.", filePath);
  }
  if ((client.type === "static" || (client.type === "auto" && client.clientId !== undefined)) &&
      (typeof client.clientId !== "string" || client.clientId.length === 0)) {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth static client mode requires clientId.", filePath);
  }
  const clientSecret = client.type === "static" || client.type === "auto" ? client.clientSecret : undefined;
  if (clientSecret !== undefined && !/^\{\{credential:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\}\}$/.test(clientSecret)) {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth clientSecret must be an exact credential reference.", filePath);
  }
  const cimd = client.type === "cimd" || client.type === "auto" ? client.clientIdMetadataDocument : undefined;
  if (client.type === "cimd" && typeof cimd !== "string") {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth CIMD mode requires clientIdMetadataDocument.", filePath);
  }
  if (cimd !== undefined) {
    try {
      const url = new URL(cimd);
      if (url.protocol !== "https:" || url.pathname === "/") throw new Error("invalid CIMD URL");
    } catch {
      return loadError(
        "CONFIG_SCHEMA_INVALID",
        "Managed OAuth clientIdMetadataDocument must use HTTPS and contain a non-root path.",
        filePath,
      );
    }
  }
  if (auth.owner !== undefined && (typeof auth.owner !== "string" || auth.owner.length === 0)) {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth owner must be a non-empty operator principal.", filePath);
  }
  for (const [field, values] of Object.entries(auth.sharing ?? {})) {
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string" && value.length > 0)) {
      return loadError("CONFIG_SCHEMA_INVALID", `Managed OAuth sharing.${field} must contain non-empty strings.`, filePath);
    }
  }
  if (auth.sharing?.applicationDids && !auth.sharing.applicationDids.includes(config.target.applicationDid)) {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth sharing must authorize the deployment Application DID.", filePath);
  }
  const safetyWindowMs = auth.refresh?.safetyWindowMs;
  const jitterMaxMs = auth.refresh?.jitterMaxMs;
  if (safetyWindowMs !== undefined && (!Number.isInteger(safetyWindowMs) || safetyWindowMs < 0 || safetyWindowMs > 300_000)) {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth refresh safetyWindowMs must be from 0 to 300000.", filePath);
  }
  if (jitterMaxMs !== undefined && (!Number.isInteger(jitterMaxMs) || jitterMaxMs < 0 || jitterMaxMs > 60_000)) {
    return loadError("CONFIG_SCHEMA_INVALID", "Managed OAuth refresh jitterMaxMs must be from 0 to 60000.", filePath);
  }
  return null;
}

export async function computeArtifactDid(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const hash = await sha256.digest(bytes);
  const cid = CID.createV1(raw.code, hash);
  return `did:artifact:${cid.toString(base32)}`;
}

/**
 * Threshold requirements are checked here so a daemon cannot start with an
 * approval rule that no permitted proposer can ever satisfy because
 * self-approval is excluded. `proposerOnly` is already an explicit choice in a
 * required field and needs no second acknowledgement.
 */
function validateDefaultRequirement(
  config: DeploymentConfig,
  filePath: string,
): { ok: false; error: DeploymentConfigLoadError } | null {
  const requirement = config.policy.defaultRequirement;

  const proposers = config.policy.signerGroups.proposers ?? config.policy.signerGroups.all;
  const unsatisfiedProposer = proposers.find(
    (proposerDid) => !isRequirementSatisfiableForProposer(requirement, config.policy, proposerDid),
  );
  if (unsatisfiedProposer) {
    return loadError(
      "DEFAULT_REQUIREMENT_UNSATISFIABLE",
      `policy.defaultRequirement cannot be satisfied for permitted proposer ${unsatisfiedProposer}. ` +
        "Check threshold signer groups and account for self-approval exclusion.",
      filePath,
    );
  }

  return null;
}

/**
 * Mirrors threshold eligibility at configuration load time. It does not
 * authorize an action; it only rejects a default that is impossible to meet.
 */
function isRequirementSatisfiableForProposer(
  requirement: Requirement,
  policy: MpasApplicationPolicy,
  proposerDid: Did,
): boolean {
  switch (requirement.type) {
    case "proposerOnly":
      return true;
    case "threshold": {
      if (!Number.isInteger(requirement.threshold) || requirement.threshold < 1) return false;
      const eligibleSigners = requirement.eligibleSigners ??
        (requirement.eligibleSignerGroup ? policy.signerGroups[requirement.eligibleSignerGroup] : undefined);
      if (!eligibleSigners) return false;
      return eligibleSigners.filter((signerDid) => signerDid !== proposerDid).length >= requirement.threshold;
    }
    case "allOf":
      return requirement.requirements.every((nested) =>
        isRequirementSatisfiableForProposer(nested, policy, proposerDid),
      );
    case "anyOf":
      return requirement.requirements.some((nested) =>
        isRequirementSatisfiableForProposer(nested, policy, proposerDid),
      );
    default:
      return false;
  }
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
