import { exportJWK, generateKeyPair, type JWK } from "jose";
import type { Did } from "./types.js";

const base58btcAlphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ed25519MulticodecPrefix = Uint8Array.from([0xed, 0x01]);

export interface GeneratedKey {
  did: Did;
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

/**
 * Derives a `did:key` from an Ed25519 public JWK using the same multicodec
 * (0xed01) + base58btc encoding as the bridge KeyManager, so DIDs match across
 * the adapter, coordination service, and bridges.
 */
export function deriveDidKey(jwk: JWK): Did {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("deriveDidKey requires an Ed25519 (OKP) JWK with public parameter x.");
  }

  const publicKeyBytes = Buffer.from(jwk.x, "base64url");
  const prefixed = new Uint8Array(ed25519MulticodecPrefix.length + publicKeyBytes.length);
  prefixed.set(ed25519MulticodecPrefix, 0);
  prefixed.set(publicKeyBytes, ed25519MulticodecPrefix.length);

  return `did:key:z${base58Encode(prefixed)}`;
}

export function didKeyToKid(did: Did): string {
  return `${did}#${did.slice("did:key:".length)}`;
}

/** Generates a fresh Ed25519 signing key with its derived `did:key` and `kid`. */
export async function generateEd25519Key(): Promise<GeneratedKey> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const did = deriveDidKey(publicJwk);
  const kid = didKeyToKid(did);

  return {
    did,
    kid,
    privateJwk: { ...privateJwk, alg: "EdDSA", use: "sig", kid },
    publicJwk: { ...publicJwk, alg: "EdDSA", use: "sig", kid },
  };
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
