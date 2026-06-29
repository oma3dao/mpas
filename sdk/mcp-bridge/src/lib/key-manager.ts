import { readFile } from "node:fs/promises";
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";
import type { Did } from "../types/mpas.js";

interface KeyFixtureFile {
  did?: Did;
  kid?: string;
  privateJwk?: JWK;
  publicJwk?: JWK;
}

const base58btcAlphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ed25519MulticodecPrefix = Uint8Array.from([0xed, 0x01]);

export class KeyManager {
  private constructor(private readonly jwk: JWK) {}

  static async fromFile(path: string): Promise<KeyManager> {
    const parsed = JSON.parse(await readFile(path, "utf8")) as JWK | KeyFixtureFile;
    const jwk = selectJwk(parsed);
    const manager = KeyManager.fromJwk(jwk);

    if ("did" in parsed && parsed.did && parsed.did !== manager.did) {
      throw new Error(`Configured DID ${parsed.did} does not match derived DID ${manager.did}.`);
    }

    return manager;
  }

  static fromJwk(jwk: JWK): KeyManager {
    validateEd25519Jwk(jwk);
    return new KeyManager({ ...jwk, kid: jwk.kid ?? didKeyToKid(deriveDid(jwk)) });
  }

  get did(): Did {
    return deriveDid(this.jwk);
  }

  get publicKey(): JWK {
    const { d: _privateKey, ...publicJwk } = this.jwk;
    return publicJwk;
  }

  async sign(payload: Uint8Array): Promise<string> {
    if (typeof this.jwk.d !== "string" || this.jwk.d.length === 0) {
      throw new Error("Ed25519 private key material is required for signing.");
    }

    const key = await importJWK(this.jwk, "EdDSA");
    return new CompactSign(payload).setProtectedHeader({ alg: "EdDSA", kid: this.jwk.kid }).sign(key);
  }

  async verify(jws: string): Promise<boolean> {
    try {
      const key = await importJWK(this.publicKey, "EdDSA");
      const { protectedHeader } = await compactVerify(jws, key);
      return protectedHeader.alg === "EdDSA";
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

function deriveDid(jwk: JWK): Did {
  const publicKeyBytes = Buffer.from(requiredPublicKey(jwk), "base64url");
  const prefixed = new Uint8Array(ed25519MulticodecPrefix.length + publicKeyBytes.length);
  prefixed.set(ed25519MulticodecPrefix, 0);
  prefixed.set(publicKeyBytes, ed25519MulticodecPrefix.length);

  return `did:key:z${base58Encode(prefixed)}`;
}

function requiredPublicKey(jwk: JWK): string {
  if (typeof jwk.x !== "string") {
    throw new Error("Ed25519 JWK must include public key parameter x.");
  }

  return jwk.x;
}

function didKeyToKid(did: Did): string {
  return `${did}#${did.slice("did:key:".length)}`;
}

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let encoded = "";
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    encoded += base58btcAlphabet[0];
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    encoded += base58btcAlphabet[digits[index]];
  }

  return encoded;
}
