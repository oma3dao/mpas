import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Digest {
  alg: "sha-256";
  value: string;
}

export interface RegistryEntryFile {
  version: string;
  application: { name: string; description?: string; applicationDid: string };
  native?: boolean;
  protocol?: string;
  plugin: { repository?: string; pluginDid?: string; artifactDid?: string };
  publisher: { name?: string; githubOrg: string; publisherDid?: string; repository?: string };
  status?: string;
  install?: { manifestUrl: string; manifestDigest: Digest };
}

export interface RegistryEntry {
  /** Registry file name without `.json`, for example `github-wivity`. */
  name: string;
  /** The name without the `-<publisher.githubOrg>` suffix, for example `github`. */
  applicationPart: string;
  entry: RegistryEntryFile;
}

const base64url = /^[A-Za-z0-9_-]+$/;

export function isDigest(value: unknown): value is Digest {
  const digest = value as Partial<Digest> | undefined;
  return digest?.alg === "sha-256" && typeof digest.value === "string" && base64url.test(digest.value);
}

export async function loadRegistry(registryDir: string): Promise<RegistryEntry[]> {
  const names = (await readdir(registryDir)).filter((file) => file.endsWith(".json")).sort();
  const entries: RegistryEntry[] = [];
  for (const file of names) {
    const entry = JSON.parse(await readFile(join(registryDir, file), "utf8")) as RegistryEntryFile;
    if (typeof entry.application?.applicationDid !== "string" || typeof entry.publisher?.githubOrg !== "string") {
      throw new Error(`${file}: registry entry needs application.applicationDid and publisher.githubOrg.`);
    }
    if (entry.install !== undefined) {
      if (typeof entry.install.manifestUrl !== "string" || !entry.install.manifestUrl.startsWith("https://")) {
        throw new Error(`${file}: install.manifestUrl must be an https URL.`);
      }
      if (!isDigest(entry.install.manifestDigest)) {
        throw new Error(`${file}: install.manifestDigest must be { "alg": "sha-256", "value": "<base64url>" }.`);
      }
    }
    const name = file.slice(0, -".json".length);
    const suffix = `-${entry.publisher.githubOrg}`;
    entries.push({
      name,
      applicationPart: name.endsWith(suffix) ? name.slice(0, -suffix.length) : name,
      entry,
    });
  }
  return entries;
}

/** Resolves `--app` by full registry name, or by application part when exactly one entry has it. */
export function resolveApplication(registry: RegistryEntry[], app: string): RegistryEntry {
  const exact = registry.find((entry) => entry.name === app);
  if (exact) return exact;
  const matches = registry.filter((entry) => entry.applicationPart === app);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Application "${app}" matches more than one registry entry: ${matches.map((entry) => entry.name).join(", ")}. Use the full name.`);
  }
  throw new Error(`Unknown application "${app}". It is not in the bundled registry.`);
}
