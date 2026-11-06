import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JWK } from "jose";
import { KeyManager } from "@oma3/mpas";
import type { Did } from "../core/types.js";

/**
 * The Credential Adapter's DID key file. The daemon signs MPAS receipts with it, and
 * operator OAuth commands sign RFC 7523 client assertions with the same key
 * (OAUTH-15E, plan Phase 0). Both load it from one path through this module; no copy
 * is made and no second key is created.
 */
export interface AdapterKeyFile {
  did: Did;
  privateJwk: JWK;
  publicJwk?: JWK;
}

export function defaultAdapterKeyPath(): string {
  return process.env.MPAS_ADAPTER_KEY ?? join(homedir(), ".mpas", "keys", "adapter.json");
}

export async function loadAdapterKey(path: string): Promise<AdapterKeyFile> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AdapterKeyFile>;
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
