import { randomBytes } from "node:crypto";
import type { JWK } from "jose";
import { samePublicKey, signMpasBytes, validateSignerIdentity, type MpasRawSigner } from "@oma3/mpas";
import { AdapterKeyNotFoundError } from "./adapter-key.js";
import { OAuthOperatorError } from "./oauth-errors.js";

/**
 * RFC 7523 `private_key_jwt` client authentication with the adapter's own DID key
 * (OAUTH-15D to OAUTH-15G).
 *
 * Nothing in this module is specific to a server or provider: the method is chosen
 * only from the operator-selected Client ID Metadata Document and the authorization
 * server's standard metadata. Assertions are made per request and never stored.
 * They are signed through the SDK signer contract (#56), so a key that never leaves
 * its provider, such as an HSM or KMS key, signs them the same way as a key file.
 */

export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const CLIENT_ASSERTION_TYP = "client-authentication+jwt";
export const CLIENT_ASSERTION_LIFETIME_SECONDS = 60;

export type ClientAssertionAlgorithm = "EdDSA" | "ES256";

/** Recorded in the session binding; the method never changes during a session (OAUTH-15D). */
export interface OAuthClientAuthenticationBinding {
  method: "private_key_jwt";
  algorithm: ClientAssertionAlgorithm;
  keyDid: string;
}

/**
 * Returns the adapter's DID-key signer: `KeyManager` for a key file, or any SDK signer
 * whose private key never leaves it. Only its public identity and `signBytes` are used.
 */
export type LoadClientSigningKey = () => Promise<MpasRawSigner>;

interface AuthorizationServerAuthMetadata {
  token_endpoint_auth_methods_supported?: unknown;
  token_endpoint_auth_signing_alg_values_supported?: unknown;
  revocation_endpoint_auth_methods_supported?: unknown;
  revocation_endpoint_auth_signing_alg_values_supported?: unknown;
}

/**
 * Selects the client authentication a validated client document declares. Returns
 * undefined for a public client (`none` or no method). Every other outcome either
 * binds `private_key_jwt` or fails closed; none falls back to a public client.
 */
export async function selectClientAuthentication(input: {
  document: Record<string, unknown>;
  metadata: AuthorizationServerAuthMetadata | undefined;
  loadSigningKey: LoadClientSigningKey | undefined;
}): Promise<OAuthClientAuthenticationBinding | undefined> {
  const declared = input.document.token_endpoint_auth_method;
  if (declared === undefined || declared === "none") return undefined;
  if (declared !== "private_key_jwt") {
    throw clientAuthenticationFailed("The client document declares an unsupported token endpoint authentication method");
  }
  const supported = stringList(input.metadata?.token_endpoint_auth_methods_supported);
  if (!supported?.includes("private_key_jwt")) {
    throw new OAuthOperatorError(
      "OAUTH_CLIENT_REGISTRATION_FAILED",
      "The authorization server does not advertise private_key_jwt, which the client document requires",
    );
  }
  const signer = await loadKey(input.loadSigningKey);
  const algorithm = assertionAlgorithm(signer.publicKey);
  const documentKeys = documentJwks(input.document);
  if (!documentKeys.some((candidate) => safeSamePublicKey(candidate, signer.publicKey))) {
    throw clientAuthenticationFailed("The client document's jwks does not hold this adapter's DID key");
  }
  assertAlgorithmAdvertised(input.metadata?.token_endpoint_auth_signing_alg_values_supported, algorithm);
  return { method: "private_key_jwt", algorithm, keyDid: signer.did };
}

/** OAUTH-15G: revocation metadata, when present, must permit the selected method. */
export function assertRevocationAuthentication(
  binding: OAuthClientAuthenticationBinding,
  metadata: AuthorizationServerAuthMetadata | undefined,
): void {
  const methods = stringList(metadata?.revocation_endpoint_auth_methods_supported);
  if (methods && !methods.includes(binding.method)) {
    throw clientAuthenticationFailed("The revocation endpoint does not accept private_key_jwt");
  }
  assertAlgorithmAdvertised(metadata?.revocation_endpoint_auth_signing_alg_values_supported, binding.algorithm);
}

/**
 * Adds a fresh client assertion to a token or revocation request body. The key is
 * loaded and checked before anything is added, so a failure leaves nothing to send.
 */
export async function applyClientAssertion(
  params: URLSearchParams,
  input: {
    clientId: string;
    audience: string;
    binding: OAuthClientAuthenticationBinding;
    loadSigningKey: LoadClientSigningKey | undefined;
  },
): Promise<void> {
  const signer = await loadKey(input.loadSigningKey);
  if (signer.did !== input.binding.keyDid || assertionAlgorithm(signer.publicKey) !== input.binding.algorithm) {
    throw clientAuthenticationFailed("The adapter signing key differs from the key bound to this session");
  }
  const assertion = await signClientAssertion({
    clientId: input.clientId,
    audience: input.audience,
    signer,
    algorithm: input.binding.algorithm,
  });
  params.delete("client_secret");
  params.set("client_id", input.clientId);
  params.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
  params.set("client_assertion", assertion);
}

/**
 * OAUTH-15E claims: iss = sub = client_id, aud = issuer, 256-bit jti, exp = iat + 60.
 * The signer signs the JWS signing input inside its own boundary. Its raw signature is
 * already the JWS form (Ed25519, or P-256 as r || s), and the SDK checks it against
 * the signer's public key before the assertion is used.
 */
export async function signClientAssertion(input: {
  clientId: string;
  audience: string;
  signer: MpasRawSigner;
  algorithm: ClientAssertionAlgorithm;
  now?: number;
}): Promise<string> {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const header = { alg: input.algorithm, typ: CLIENT_ASSERTION_TYP };
  const claims = {
    jti: randomBytes(32).toString("base64url"),
    iss: input.clientId,
    sub: input.clientId,
    aud: input.audience,
    iat,
    exp: iat + CLIENT_ASSERTION_LIFETIME_SECONDS,
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  let signature: Uint8Array;
  try {
    signature = await signMpasBytes(input.signer, new TextEncoder().encode(signingInput));
  } catch (error) {
    throw clientAuthenticationFailed("The adapter signer could not sign the client assertion", error);
  }
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

function base64urlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function assertionAlgorithm(publicJwk: JWK): ClientAssertionAlgorithm {
  if (publicJwk.kty === "OKP" && publicJwk.crv === "Ed25519") return "EdDSA";
  if (publicJwk.kty === "EC" && publicJwk.crv === "P-256") return "ES256";
  throw clientAuthenticationFailed("The adapter DID key type cannot sign client assertions");
}

async function loadKey(loadSigningKey: LoadClientSigningKey | undefined): Promise<MpasRawSigner> {
  if (!loadSigningKey) throw clientAuthenticationFailed("The adapter signing key is not available to this command");
  let signer: MpasRawSigner;
  try {
    signer = await loadSigningKey();
  } catch (error) {
    // A missing file is the operator's to fix, so its path and the flag are shown.
    const message = error instanceof AdapterKeyNotFoundError ? error.message : "The adapter signing key could not be loaded";
    throw clientAuthenticationFailed(message, error);
  }
  try {
    validateSignerIdentity(signer);
  } catch (error) {
    throw clientAuthenticationFailed("The adapter signer's DID, key ID and public key do not agree", error);
  }
  return signer;
}

function documentJwks(document: Record<string, unknown>): JWK[] {
  const jwks = document.jwks;
  if (typeof jwks !== "object" || jwks === null || !Array.isArray((jwks as { keys?: unknown }).keys)) return [];
  return ((jwks as { keys: unknown[] }).keys).filter((key): key is JWK => typeof key === "object" && key !== null);
}

function safeSamePublicKey(left: JWK, right: JWK): boolean {
  try {
    return samePublicKey(left, right);
  } catch {
    return false;
  }
}

function assertAlgorithmAdvertised(advertised: unknown, algorithm: ClientAssertionAlgorithm): void {
  const algorithms = stringList(advertised);
  if (algorithms && !algorithms.includes(algorithm)) {
    throw clientAuthenticationFailed(`The authorization server does not advertise ${algorithm} for client assertions`);
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function clientAuthenticationFailed(message: string, cause?: unknown): OAuthOperatorError {
  return new OAuthOperatorError("OAUTH_CLIENT_AUTHENTICATION_FAILED", message, cause === undefined ? {} : { cause });
}
