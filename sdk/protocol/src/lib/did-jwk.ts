import { exportJWK, generateKeyPair, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import type { Did } from "../types/mpas.js";

export interface GeneratedKey {
  did: Did;
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

/**
 * Derives a `did:jwk` DID from an Ed25519 public JWK.
 *
 * MPAS normative derivation rule: the base64url value encodes the
 * JCS-canonicalized (RFC 8785) minimal public JWK — exactly the members
 * required by RFC 7638 for the key type (`crv`, `kty`, `x` for OKP/Ed25519),
 * in lexicographic order, with no whitespace. This makes derivation
 * deterministic across independent implementations: same key, same DID.
 *
 * The did:jwk method itself does not mandate a canonical serialization
 * (the DID string, once minted, is the identifier of record). This rule
 * governs minting only; runtime comparison is always exact string match.
 */
export function deriveDidJwk(jwk: JWK): Did {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new Error("deriveDidJwk requires an Ed25519 (OKP) JWK with public parameter x.");
  }

  const minimalPublicJwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  const encoded = Buffer.from(canonicalize(minimalPublicJwk), "utf8").toString("base64url");
  return `did:jwk:${encoded}`;
}

/**
 * Decodes the public JWK embedded in a `did:jwk` DID. The DID is the source
 * of truth for the key: any separately configured JWK is redundant for
 * did:jwk identities.
 *
 * Throws if the DID is not a valid did:jwk, if the embedded JWK contains
 * private key material (`d` — the method spec requires rejection), or if the
 * key is not an Ed25519 signing key supported by this implementation.
 */
export function didJwkToJwk(did: string): JWK {
  if (!did.startsWith("did:jwk:")) {
    throw new Error(`Not a did:jwk DID: ${did}`);
  }

  const encoded = did.slice("did:jwk:".length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("did:jwk payload is not valid base64url-encoded JSON.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("did:jwk payload must be a JWK object.");
  }

  const jwk = parsed as JWK;
  if (typeof jwk.d === "string") {
    throw new Error("did:jwk must not contain private key material.");
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new Error("did:jwk must embed an Ed25519 (OKP) public JWK with parameter x.");
  }

  return jwk;
}

/** True when the DID uses the did:jwk method. */
export function isDidJwk(did: string): boolean {
  return did.startsWith("did:jwk:");
}

/**
 * The DID URL for the single verification method of a did:jwk document.
 * Per the did:jwk method spec, the fragment is always `#0`.
 */
export function didJwkToKid(did: Did): string {
  return `${did}#0`;
}

/** Generates a fresh Ed25519 signing key with its derived `did:jwk` and `kid`. */
export async function generateEd25519Key(): Promise<GeneratedKey> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const did = deriveDidJwk(publicJwk);
  const kid = didJwkToKid(did);

  return {
    did,
    kid,
    privateJwk: { ...privateJwk, kid },
    publicJwk: { ...publicJwk, kid },
  };
}
