import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JWK } from "jose";
import { KeyManager } from "@oma3/mpas";
import type { Did } from "../core/types.js";

/**
 * The Credential Adapter's DID key file. The daemon signs MPAS receipts with it, and
 * operator OAuth commands sign RFC 7523 client assertions with the same key through
 * its `KeyManager` signer (OAUTH-15E, plan Phase 0). Both load it from one path
 * through this module; no copy is made and no second key is created.
 */
export interface AdapterKeyFile {
  did: Did;
  privateJwk: JWK;
  publicJwk?: JWK;
}

/**
 * The key file a command uses without `--adapter-key`: `MPAS_ADAPTER_KEY`, else the
 * account key every role keeps, `~/.mpas/keys/signing-key.json`, which `mpas init`
 * and the manual guides write. Versions up to 0.1.0-alpha.4 defaulted to `adapter.json`.
 */
export function defaultAdapterKeyPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.MPAS_ADAPTER_KEY ?? join(home, ".mpas", "keys", "signing-key.json");
}

/** No key file at the path a command was given or defaulted to. The message names the path and the flag. */
export class AdapterKeyNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`No adapter key file at ${path}. Pass --adapter-key <file> or set MPAS_ADAPTER_KEY.`);
    this.name = "AdapterKeyNotFoundError";
  }
}

/** The adapter's DID-key signer from its key file. The private key stays inside `KeyManager`. */
export async function loadAdapterSigner(path: string): Promise<KeyManager> {
  const key = await loadAdapterKey(path);
  return KeyManager.fromJwk(key.privateJwk, { did: key.did });
}

export async function loadAdapterKey(path: string): Promise<AdapterKeyFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AdapterKeyNotFoundError(path);
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<AdapterKeyFile>;
  if (!parsed.did || !parsed.privateJwk) {
    throw new Error(`Adapter key file is invalid: ${path}`);
  }

  const manager = await KeyManager.fromFile(path);
  return {
    did: manager.did,
    privateJwk: parsed.privateJwk,
    publicJwk: manager.publicKey,
  };
}
