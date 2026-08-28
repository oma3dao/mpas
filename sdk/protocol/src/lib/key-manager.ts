import { readFile } from "node:fs/promises";
import {
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
  type JsonWebKey,
} from "node:crypto";
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";
import type { Did } from "../types/mpas.js";
import { deriveDidJwk, didJwkToKid } from "./did-jwk.js";

interface KeyFixtureFile {
  did?: Did;
  kid?: string;
  privateJwk?: JWK;
  publicJwk?: JWK;
}

/**
 * Manages an Ed25519 JWK and its deterministic did:jwk identity.
 *
 * A public-only manager can verify signatures. Signing operations require the
 * private `d` parameter to be present in the configured JWK.
 */
export class KeyManager {
  private constructor(private readonly jwk: JWK) {}

  /** Loads a JWK or MPAS key fixture and verifies any stored DID binding. */
  static async fromFile(path: string): Promise<KeyManager> {
    const parsed = JSON.parse(await readFile(path, "utf8")) as JWK | KeyFixtureFile;
    const jwk = selectJwk(parsed);
    const manager = KeyManager.fromJwk(jwk);

    // Mint-once rule: the DID stored alongside the key is the identifier of
    // record. Since MPAS fixes the did:jwk derivation (JCS-canonical minimal
    // public JWK), re-derivation is deterministic and any mismatch means the
    // file was corrupted or the key replaced.
    if ("did" in parsed && parsed.did && parsed.did !== manager.did) {
      throw new Error(`Configured DID ${parsed.did} does not match derived DID ${manager.did}.`);
    }

    return manager;
  }

  /** Creates a manager from an Ed25519 public or private JWK. */
  static fromJwk(jwk: JWK): KeyManager {
    validateEd25519Jwk(jwk);
    return new KeyManager({ ...jwk, kid: jwk.kid ?? didJwkToKid(deriveDidJwk(jwk)) });
  }

  /** Deterministic did:jwk derived from the minimal public JWK. */
  get did(): Did {
    return deriveDidJwk(this.jwk);
  }

  /** Public JWK with private key material removed. */
  get publicKey(): JWK {
    const { d: _privateKey, ...publicJwk } = this.jwk;
    return publicJwk;
  }

  /** Signs bytes and returns a compact JWS carrying the signed payload. */
  async signCompactJws(payload: Uint8Array): Promise<string> {
    if (typeof this.jwk.d !== "string" || this.jwk.d.length === 0) {
      throw new Error("Ed25519 private key material is required for signing.");
    }

    const key = await importJWK(this.jwk, "EdDSA");
    return new CompactSign(payload).setProtectedHeader({ alg: "EdDSA", kid: this.jwk.kid }).sign(key);
  }

  /** Signs raw bytes with Ed25519, without a JWS envelope. */
  async signBytes(payload: Uint8Array): Promise<Uint8Array> {
    if (typeof this.jwk.d !== "string" || this.jwk.d.length === 0) {
      throw new Error("Ed25519 private key material is required for signing.");
    }

    const key = createPrivateKey({ key: this.jwk as JsonWebKey, format: "jwk" });
    return signEd25519(null, Buffer.from(payload), key);
  }

  /** Verifies a compact JWS with this manager's public key. */
  async verifyCompactJws(jws: string): Promise<boolean> {
    try {
      const key = await importJWK(this.publicKey, "EdDSA");
      const { protectedHeader } = await compactVerify(jws, key);
      return protectedHeader.alg === "EdDSA";
    } catch {
      return false;
    }
  }

  /** @deprecated Use {@link signCompactJws}. */
  async sign(payload: Uint8Array): Promise<string> {
    return this.signCompactJws(payload);
  }

  /** @deprecated Use {@link verifyCompactJws}. */
  async verify(jws: string): Promise<boolean> {
    return this.verifyCompactJws(jws);
  }

  /** Verifies a raw Ed25519 signature over the supplied bytes. */
  async verifyBytes(payload: Uint8Array, signature: Uint8Array): Promise<boolean> {
    try {
      const key = createPublicKey({ key: this.publicKey as JsonWebKey, format: "jwk" });
      return verifyEd25519(null, Buffer.from(payload), key, Buffer.from(signature));
    } catch {
      return false;
    }
  }
}

function selectJwk(parsed: JWK | KeyFixtureFile): JWK {
  if ("privateJwk" in parsed && parsed.privateJwk) {
    return parsed.privateJwk;
  }
  if ("publicJwk" in parsed && parsed.publicJwk) {
    return parsed.publicJwk;
  }

  return parsed as JWK;
}

function validateEd25519Jwk(jwk: JWK): void {
  if (jwk.kty !== "OKP") {
    throw new Error('Ed25519 JWK must use kty "OKP".');
  }
  if (jwk.crv !== "Ed25519") {
    throw new Error('Ed25519 JWK must use crv "Ed25519".');
  }
  if (typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new Error("Ed25519 JWK must include public key parameter x.");
  }
}
