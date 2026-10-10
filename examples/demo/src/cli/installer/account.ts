import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { KeyManager } from "@oma3/mpas/key-manager";
import { didJwkToJwk, generateMpasKey, isDidJwk } from "../../core/did-jwk.js";
import type { Did } from "../../core/types.js";
import type { InstallerDependencies } from "./deps.js";
import { InstallerError } from "./errors.js";

export const ROLES = ["proposer", "maintainer", "verifier"] as const;
export type Role = (typeof ROLES)[number];
export type Suite = "Ed25519" | "P-256";
/** How a Verifier's Action URL is used: Proposers submit to this adapter directly, or the adapter polls a relay. */
export type VerifierMode = "direct" | "relay";

export function isRole(value: string | undefined): value is Role {
  return ROLES.includes(value as Role);
}

export function roleTitle(role: Role): string {
  return role === "proposer" ? "Proposer" : role === "maintainer" ? "Maintainer" : "Verifier";
}

/** `account.json`: the roles and saved settings of one MPAS home. */
export interface Account {
  version: "1";
  type: "MpasAccount";
  did: Did;
  roles: Role[];
  coordinationUrl?: string;
  actionUrl?: string;
  verifierMode?: VerifierMode;
  /** The Proposer's designated Verifier DID. */
  verifierDid?: string;
}

export interface KeyFile {
  did: Did;
  kid: string;
  privateJwk: Record<string, unknown>;
  publicJwk: { crv?: string; [key: string]: unknown };
}

export function homePaths(home: string) {
  return {
    home,
    account: join(home, "account.json"),
    keys: join(home, "keys"),
    key: join(home, "keys", "signing-key.json"),
    mcpConfigs: join(home, "mcp-server-configs"),
    signerConfig: join(home, "mcp-server-configs", "maintainer-signer-config.json"),
    bridgeConfig: (app: string) => join(home, "mcp-server-configs", `${app}-mcp-bridge-config.json`),
    plugins: join(home, "plugins"),
    /** Plugin copies are named for their artifact, so a newer plugin never replaces one a live config uses. */
    plugin: (app: string, artifactDid: string) => join(home, "plugins", `${app}-plugin-${artifactDid.replace(/^did:artifact:/, "")}.json`),
    installedDir: join(home, "installed"),
    installed: (app: string) => join(home, "installed", `${app}.json`),
    updateMarker: join(home, "update-in-progress.json"),
    lock: join(home, "update.lock"),
    config: join(home, "config"),
    liveConfig: (app: string) => join(home, "config", `${app}-adapter-config.json`),
    drafts: join(home, "config", "drafts"),
    draftConfig: (app: string) => join(home, "config", "drafts", `${app}-adapter-config.json`),
    credentials: join(home, "credentials"),
    journal: join(home, "journal"),
    ledger: join(home, "journal", "dispatch-ledger.jsonl"),
    /** Relay state is named for its relay URL and Verifier DID, so a new URL or key never reuses or moves a running adapter's file. */
    relayState: (relayUrl: string, verifierDid: string) =>
      join(home, "journal", `verifier-relay-${createHash("sha256").update(`${relayUrl}\n${verifierDid}`).digest("base64url").slice(0, 16)}.json`),
    skills: join(home, "skills"),
    workflows: join(home, "workflows"),
    workflowDb: (app: string) => join(home, "workflows", `${app}.db`),
  };
}

export type HomePaths = ReturnType<typeof homePaths>;

export function resolveHome(flag: string | undefined, deps: InstallerDependencies): string {
  return resolve(flag ?? deps.env.MPAS_HOME ?? join(deps.homedir, ".mpas"));
}

/** Directories each role needs, created with mode 0700 when missing. */
export function roleDirectories(paths: HomePaths, role: Role): string[] {
  switch (role) {
    case "proposer":
      return [paths.keys, paths.mcpConfigs, paths.plugins, paths.installedDir, paths.workflows, paths.skills];
    case "maintainer":
      return [paths.keys, paths.mcpConfigs, paths.skills];
    case "verifier":
      return [paths.keys, paths.config, paths.drafts, paths.plugins, paths.installedDir, paths.credentials, paths.journal];
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates a directory and any missing parents with mode 0700. Existing directories keep their mode. */
export async function ensureDir(path: string): Promise<void> {
  const missing: string[] = [];
  let current = resolve(path);
  while (!(await exists(current))) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of missing) {
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
  }
}

/** Writes JSON through a temporary file and a rename, so a reader never sees half a file. */
export async function writeJsonAtomic(path: string, value: unknown, mode = 0o644): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readAccount(paths: HomePaths): Promise<Account | undefined> {
  if (!(await exists(paths.account))) return undefined;
  return readJsonFile<Account>(paths.account);
}

export async function requireAccount(paths: HomePaths, home = ""): Promise<Account> {
  const account = await readAccount(paths);
  if (!account) {
    throw new InstallerError(`No MPAS account at ${paths.home}. Run \`mpas init <role>${home}\` first.`);
  }
  return account;
}

export async function writeAccount(paths: HomePaths, account: Account): Promise<void> {
  await writeJsonAtomic(paths.account, account, 0o600);
}

/** Key files in a home that has no `account.json`, which means the home was set up by hand. */
export async function handMadeKeyFiles(paths: HomePaths): Promise<string[]> {
  try {
    return (await readdir(paths.keys)).filter((name) => name.endsWith(".json")).map((name) => join(paths.keys, name));
  } catch {
    return [];
  }
}

/** Generates a key in memory. It is written by the caller's update, never on its own. */
export async function newKeyFile(suite: Suite): Promise<KeyFile> {
  const key = await generateMpasKey(suite);
  return {
    did: key.did,
    kid: key.kid,
    privateJwk: key.privateJwk as Record<string, unknown>,
    publicJwk: key.publicJwk as KeyFile["publicJwk"],
  };
}

export function keyFileText(key: KeyFile): string {
  return `${JSON.stringify(key, null, 2)}\n`;
}

/**
 * Loads a key file the way the signer server and bridges do (`KeyManager.fromFile`)
 * and requires the derived DID to be the stored one. Error text never includes key material.
 */
export async function assertRuntimeKey(path: string, did: string): Promise<void> {
  let derived: string;
  try {
    derived = (await KeyManager.fromFile(path)).did;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(/^[\w .,:;()'-]+$/.test(message) ? message : "the runtime cannot load this key");
  }
  if (derived !== did) throw new Error("the private key does not derive the stored DID");
}

/** Reads an existing MPAS key file: a decodable did:jwk whose public key matches, with a private key. */
export async function readKeyFile(path: string): Promise<{ key: KeyFile; text: string }> {
  try {
    const text = await readFile(path, "utf8");
    const key = JSON.parse(text) as KeyFile;
    if (typeof key.did !== "string" || !isDidJwk(key.did)) throw new Error("did is not a did:jwk");
    const embedded = didJwkToJwk(key.did) as Record<string, unknown>;
    for (const field of ["kty", "crv", "x", "y"]) {
      if (embedded[field] !== key.publicJwk?.[field]) throw new Error(`publicJwk.${field} does not match the DID`);
    }
    if (typeof key.privateJwk?.d !== "string") throw new Error("privateJwk is missing");
    await assertRuntimeKey(path, key.did);
    return { key, text };
  } catch (error) {
    throw new InstallerError(`${path} is not a usable MPAS key file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function keySuite(key: KeyFile): Suite {
  return key.publicJwk.crv === "P-256" ? "P-256" : "Ed25519";
}

export function parseMode(value: string | undefined): VerifierMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "direct" && value !== "relay") {
    throw new InstallerError("--mode must be direct or relay.", 2);
  }
  return value;
}

export function parseSuite(value: string | undefined): Suite | undefined {
  if (value === undefined) return undefined;
  if (value !== "Ed25519" && value !== "P-256") {
    throw new InstallerError("Unsupported signing suite: use Ed25519 or P-256.", 2);
  }
  return value;
}

export function timestamp(deps: InstallerDependencies): string {
  return deps.now().toISOString().replace(/[:.]/g, "-");
}
