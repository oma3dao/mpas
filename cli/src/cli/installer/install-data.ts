import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeArtifactDid } from "../../adapter/config-loader.js";
import type { InstallerContext } from "./context.js";
import { InstallerError } from "./errors.js";
import { type Digest, isDigest, loadRegistry, type RegistryEntry, resolveApplication } from "./registry.js";

/** `install.json` in the implementation's repository. */
export interface InstallManifest {
  version: string;
  type: "MpasInstallManifest";
  applicationDid: string;
  bridge?: { package: string; version: string };
  plugin: { url: string };
  adapterConfigTemplate?: { url: string; digest: Digest };
  readme?: string;
}

export interface ResolvedInstall {
  entry: RegistryEntry;
  manifest: InstallManifest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function parseJsonBytes<T>(bytes: Uint8Array, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new InstallerError(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resolves `--app` in the bundled registry and downloads its manifest, checked against the registry digest. */
export async function resolveInstall(ctx: InstallerContext, app: string): Promise<ResolvedInstall> {
  const entry = resolveApplication(await loadRegistry(ctx.deps.registryDir), app);
  const install = entry.entry.install;
  if (!install) {
    throw new InstallerError(`${entry.name} has no install data in the registry yet, so mpas mcp add cannot install it.`);
  }
  const bytes = await ctx.deps.fetchBytes(install.manifestUrl);
  if (sha256(bytes) !== install.manifestDigest.value) {
    throw new InstallerError(`The install manifest for ${entry.name} does not match the registry's manifestDigest: ${install.manifestUrl}`);
  }
  const manifest = parseJsonBytes<InstallManifest>(bytes, `The install manifest for ${entry.name}`);
  if (manifest.applicationDid !== entry.entry.application.applicationDid) {
    throw new InstallerError(`The install manifest for ${entry.name} names ${manifest.applicationDid}, not ${entry.entry.application.applicationDid}.`);
  }
  if (typeof manifest.plugin?.url !== "string") {
    throw new InstallerError(`The install manifest for ${entry.name} has no plugin.url.`);
  }
  return { entry, manifest };
}

/** The plugin bytes from `--plugin` or the manifest URL, checked against the registry `artifactDid`. */
export async function fetchVerifiedPlugin(ctx: InstallerContext, resolved: ResolvedInstall, pluginFlag: string | undefined): Promise<Uint8Array> {
  const expected = resolved.entry.entry.plugin.artifactDid;
  if (!expected) {
    throw new InstallerError(`${resolved.entry.name} has no plugin.artifactDid in the registry, so its plugin cannot be verified.`);
  }
  const bytes = pluginFlag ? new Uint8Array(await readFile(resolve(pluginFlag))) : await ctx.deps.fetchBytes(resolved.manifest.plugin.url);
  const actual = await computeArtifactDid(parseJsonBytes(bytes, "The plugin"));
  if (actual !== expected) {
    throw new InstallerError(`The plugin for ${resolved.entry.name} does not match the registry artifactDid (expected ${expected}, got ${actual}).`);
  }
  return bytes;
}

/**
 * The deployment config template from `--config-template` or the manifest.
 * A downloaded template must match its digest; a local one is the operator's
 * choice and skips that check. Both must name the registry's application and plugin.
 */
export async function fetchVerifiedTemplate(
  ctx: InstallerContext,
  resolved: ResolvedInstall,
  templateFlag: string | undefined,
): Promise<Record<string, any> | undefined> {
  let bytes: Uint8Array;
  if (templateFlag) {
    bytes = new Uint8Array(await readFile(resolve(templateFlag)));
  } else {
    const template = resolved.manifest.adapterConfigTemplate;
    if (!template) return undefined;
    if (!isDigest(template.digest)) throw new InstallerError(`The install manifest for ${resolved.entry.name} has an invalid template digest.`);
    bytes = await ctx.deps.fetchBytes(template.url);
    if (sha256(bytes) !== template.digest.value) {
      throw new InstallerError(`The deployment config template for ${resolved.entry.name} does not match the manifest digest: ${template.url}`);
    }
  }
  const config = parseJsonBytes<Record<string, any>>(bytes, "The deployment config template");
  if (config.target?.applicationDid !== resolved.entry.entry.application.applicationDid) {
    throw new InstallerError(`The deployment config template names ${config.target?.applicationDid}, not ${resolved.entry.entry.application.applicationDid}.`);
  }
  if (config.plugin?.artifactDid !== resolved.entry.entry.plugin.artifactDid) {
    throw new InstallerError("The deployment config template's plugin.artifactDid does not match the registry.");
  }
  return config;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function requireBridge(resolved: ResolvedInstall): { packageName: string; version: string } {
  const bridge = resolved.manifest.bridge;
  if (!bridge?.package) {
    throw new InstallerError(`The install manifest for ${resolved.entry.name} names no bridge package.`);
  }
  if (!EXACT_VERSION.test(bridge.version ?? "")) {
    throw new InstallerError(`The install manifest for ${resolved.entry.name} must pin an exact bridge version, not "${bridge.version}".`);
  }
  return { packageName: bridge.package, version: bridge.version };
}
