import { randomBytes } from "node:crypto";
import { importJWK, SignJWT, type JWK } from "jose";
import { samePublicKey } from "@oma3/mpas";
import type { AdapterKeyFile } from "./adapter-key.js";
import { OAuthOperatorError } from "./oauth-errors.js";

/**
 * RFC 7523 `private_key_jwt` client authentication with the adapter's own DID key
 * (OAUTH-15D to OAUTH-15G).
 *
 * Nothing in this module is specific to a server or provider: the method is chosen
 * only from the operator-selected Client ID Metadata Document and the authorization
 * server's standard metadata. Assertions are made per request and never stored.
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

export type LoadClientSigningKey = () => Promise<AdapterKeyFile>;

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
  const key = await loadKey(input.loadSigningKey);
  const publicJwk = publicJwkOf(key);
  const algorithm = assertionAlgorithm(publicJwk);
  const documentKeys = documentJwks(input.document);
  if (!documentKeys.some((candidate) => safeSamePublicKey(candidate, publicJwk))) {
    throw clientAuthenticationFailed("The client document's jwks does not hold this adapter's DID key");
  }
  assertAlgorithmAdvertised(input.metadata?.token_endpoint_auth_signing_alg_values_supported, algorithm);
  return { method: "private_key_jwt", algorithm, keyDid: key.did };
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
  const key = await loadKey(input.loadSigningKey);
  if (key.did !== input.binding.keyDid || assertionAlgorithm(publicJwkOf(key)) !== input.binding.algorithm) {
    throw clientAuthenticationFailed("The adapter signing key differs from the key bound to this session");
  }
  const assertion = await signClientAssertion({
    clientId: input.clientId,
    audience: input.audience,
    privateJwk: key.privateJwk,
    algorithm: input.binding.algorithm,
  });
  params.delete("client_secret");
  params.set("client_id", input.clientId);
  params.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
  params.set("client_assertion", assertion);
}

/** OAUTH-15E claims: iss = sub = client_id, aud = issuer, 256-bit jti, exp = iat + 60. */
export async function signClientAssertion(input: {
  clientId: string;
  audience: string;
  privateJwk: JWK;
  algorithm: ClientAssertionAlgorithm;
  now?: number;
}): Promise<string> {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  let key: Awaited<ReturnType<typeof importJWK>>;
  try {
    key = await importJWK(input.privateJwk, input.algorithm);
  } catch (error) {
    throw clientAuthenticationFailed("The adapter signing key cannot be used for client assertions", error);
  }
  return new SignJWT({ jti: randomBytes(32).toString("base64url") })
    .setProtectedHeader({ alg: input.algorithm, typ: CLIENT_ASSERTION_TYP })
    .setIssuer(input.clientId)
    .setSubject(input.clientId)
    .setAudience(input.audience)
    .setIssuedAt(iat)
    .setExpirationTime(iat + CLIENT_ASSERTION_LIFETIME_SECONDS)
    .sign(key);
}

export function assertionAlgorithm(publicJwk: JWK): ClientAssertionAlgorithm {
  if (publicJwk.kty === "OKP" && publicJwk.crv === "Ed25519") return "EdDSA";
  if (publicJwk.kty === "EC" && publicJwk.crv === "P-256") return "ES256";
  throw clientAuthenticationFailed("The adapter DID key type cannot sign client assertions");
}

export function publicJwkOf(key: AdapterKeyFile): JWK {
  if (key.publicJwk) return key.publicJwk;
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, oth: _oth, k: _k, ...publicJwk } = key.privateJwk;
  return publicJwk;
}

async function loadKey(loadSigningKey: LoadClientSigningKey | undefined): Promise<AdapterKeyFile> {
  if (!loadSigningKey) throw clientAuthenticationFailed("The adapter signing key is not available to this command");
  try {
    return await loadSigningKey();
  } catch (error) {
    throw clientAuthenticationFailed("The adapter signing key could not be loaded", error);
  }
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
