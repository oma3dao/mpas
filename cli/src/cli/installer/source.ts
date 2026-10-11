import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeArtifactDid } from "../../adapter/config-loader.js";
import type { InstallerContext } from "./context.js";
import { InstallerError, usageError } from "./errors.js";

/** One application's folder, given to `mpas mcp add` as a URL (spec §9.5). */
export interface ApplicationSource {
  /** The URL as the user gave it, without a trailing slash. */
  url: string;
  /** The last folder name in the URL, the default application name. */
  defaultName: string;
  /** The URL a file in the folder is downloaded from. */
  fileUrl: (file: string) => string;
  /** The URL a person opens to read the folder's README. */
  readmeUrl: string;
}

const GITHUB_TREE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Reads a source URL: a GitHub folder URL is read as raw files at its ref, and any other https URL is the folder. */
export function parseSourceUrl(input: string): ApplicationSource {
  const url = input.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw usageError(`${input} is not a URL. Pass the URL of the application's folder, for example https://github.com/<owner>/<repo>/tree/<ref>/<path>.`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) {
    throw usageError(`${input} must use https:// (http:// is accepted only for a loopback host).`);
  }
  const github = GITHUB_TREE.exec(url);
  if (github) {
    const [, owner, repo, ref, path = ""] = github;
    const folder = path ? `/${path}` : "";
    return {
      url,
      defaultName: (path.split("/").pop() || repo),
      fileUrl: (file) => `https://raw.githubusercontent.com/${owner}/${repo}/${ref}${folder}/${file}`,
      readmeUrl: `https://github.com/${owner}/${repo}/blob/${ref}${folder}/README.md`,
    };
  }
  if (parsed.hostname === "github.com") {
    throw usageError(`${input} is not a GitHub folder URL. Open the application's folder on GitHub and copy its URL, which has the form https://github.com/<owner>/<repo>/tree/<ref>/<path>.`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  return {
    url,
    defaultName: segments.pop() ?? parsed.hostname,
    fileUrl: (file) => `${url}/${file}`,
    readmeUrl: `${url}/README.md`,
  };
}

export function checkApplicationName(name: string): string {
  if (!NAME.test(name)) {
    throw usageError(`"${name}" is not a valid application name. Use lowercase letters, digits, and hyphens, for example --name github-work.`);
  }
  return name;
}

function parseJson<T>(bytes: Uint8Array, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new InstallerError(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Downloads one file from the folder, or reads the operator's local replacement for it. */
async function sourceFile(ctx: InstallerContext, source: ApplicationSource, file: string, localFlag?: string): Promise<{ bytes: Uint8Array; from: string }> {
  if (localFlag) return { bytes: new Uint8Array(await readFile(resolve(localFlag))), from: resolve(localFlag) };
  const from = source.fileUrl(file);
  try {
    return { bytes: await ctx.deps.fetchBytes(from), from };
  } catch (error) {
    throw new InstallerError(
      `Could not download ${file} from the application's folder (${from}): ${error instanceof Error ? error.message : String(error)}. Check that the URL names the folder that holds ${file}.`,
    );
  }
}

export interface SourcePlugin {
  bytes: Uint8Array;
  from: string;
  artifactDid: string;
  applicationDid: string;
}

export async function loadSourcePlugin(ctx: InstallerContext, source: ApplicationSource, pluginFlag: string | undefined): Promise<SourcePlugin> {
  const { bytes, from } = await sourceFile(ctx, source, "plugin.json", pluginFlag);
  const plugin = parseJson<Record<string, any>>(bytes, `plugin.json (${from})`);
  if (typeof plugin.applicationDid !== "string") {
    throw new InstallerError(`plugin.json (${from}) has no applicationDid.`);
  }
  return { bytes, from, artifactDid: await computeArtifactDid(plugin), applicationDid: plugin.applicationDid };
}

/** The Verifier's deployment config template, which must pin the same plugin and application. */
export async function loadSourceTemplate(
  ctx: InstallerContext,
  source: ApplicationSource,
  templateFlag: string | undefined,
  plugin: SourcePlugin,
): Promise<{ config: Record<string, any>; from: string }> {
  const { bytes, from } = await sourceFile(ctx, source, "adapter-config.example.json", templateFlag);
  const config = parseJson<Record<string, any>>(bytes, `adapter-config.example.json (${from})`);
  if (config.plugin?.artifactDid !== plugin.artifactDid) {
    throw new InstallerError(
      `The deployment config template's plugin.artifactDid (${config.plugin?.artifactDid}) does not match the plugin's artifactDid (${plugin.artifactDid}). The folder's files disagree.`,
    );
  }
  if (config.target?.applicationDid !== plugin.applicationDid) {
    throw new InstallerError(
      `The deployment config template's target.applicationDid (${config.target?.applicationDid}) does not match the plugin's applicationDid (${plugin.applicationDid}).`,
    );
  }
  return { config, from };
}

/** The Proposer's bridge package, from `bridge/package.json`, pinned to an exact version. */
export async function loadSourceBridge(ctx: InstallerContext, source: ApplicationSource): Promise<{ packageName: string; version: string; from: string }> {
  const { bytes, from } = await sourceFile(ctx, source, "bridge/package.json");
  const pkg = parseJson<Record<string, any>>(bytes, `bridge/package.json (${from})`);
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw new InstallerError(`bridge/package.json (${from}) has no package name.`);
  }
  if (typeof pkg.version !== "string" || !EXACT_VERSION.test(pkg.version)) {
    throw new InstallerError(`bridge/package.json (${from}) must have an exact version, not "${pkg.version ?? ""}".`);
  }
  return { packageName: pkg.name, version: pkg.version, from };
}
