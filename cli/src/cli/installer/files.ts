import { readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { exists, type HomePaths, readJsonFile, timestamp, writeJsonAtomic } from "./account.js";
import type { InstallerDependencies } from "./deps.js";

export async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export function listBridgeConfigs(paths: HomePaths): Promise<string[]> {
  return listFiles(paths.mcpConfigs, "-mcp-bridge-config.json");
}

/** Reads a JSON file, applies a change, and writes it back atomically with its original mode. */
export async function updateJsonFile<T>(path: string, mutate: (value: T) => void): Promise<void> {
  const value = await readJsonFile<T>(path);
  mutate(value);
  const mode = (await stat(path)).mode & 0o777;
  await writeJsonAtomic(path, value, mode);
}

/** Renames a file to `<name>.<timestamp><ext>` in the same folder. Returns the new path, if the file existed. */
export async function moveAside(path: string, deps: InstallerDependencies): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  const ext = extname(path);
  const target = join(dirname(path), `${basename(path, ext)}.${timestamp(deps)}${ext}`);
  await rename(path, target);
  return target;
}

/** A template value the operator still has to replace. */
export function isPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return true;
  return !/^did:[a-z0-9]+:.+/.test(value) || value.startsWith("did:example:");
}

/** Every string in a config that looks like an unfilled template value, with its JSON path. */
export function findPlaceholders(value: unknown, path = ""): Array<{ path: string; value: string }> {
  if (typeof value === "string") {
    return /^REPLACE_WITH_/.test(value) || value.startsWith("did:example:") || value.startsWith("/absolute/path/")
      ? [{ path, value }]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findPlaceholders(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => findPlaceholders(item, path ? `${path}.${key}` : key));
  }
  return [];
}
