import { compactVerify, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import type { ActionEnvelope, ExecutionPayload, HashObject, ReceiptPayload } from "../types/mpas.js";
import { computeJsonHash } from "../utils/hash.js";
import { strictJsonParse } from "../utils/strict-json.js";
import { didJwkToKid, isDidJwk } from "./did-jwk.js";
import { resolveTrustedSignerJwk, type TrustedSigner } from "./verification.js";

/** Trusted context, supplied by the caller's workflow, never selected by the receipt. */
export interface ReceiptVerificationOptions {
  actionEnvelope: ActionEnvelope;
  executionPayload: ExecutionPayload;
  /** Issuer/key records authorized for this exact expected action. */
  authorizedIssuers: readonly TrustedSigner[];
  /** Trusted current Unix time in milliseconds; defaults to Date.now(). */
  now?: number;
  /** Nonnegative finite clock tolerance in milliseconds; defaults to zero. */
  timestampToleranceMs?: number;
  /** Optional nonnegative finite maximum receipt age in milliseconds. */
  maxAgeMs?: number;
}

export type ReceiptVerificationErrorCode =
  | "INVALID_VERIFICATION_OPTIONS"
  | "INVALID_TIME_OPTIONS"
  | "INVALID_RECEIPT"
  | "INVALID_JWS_HEADER"
  | "UNSUPPORTED_ALGORITHM"
  | "INVALID_RECEIPT_PAYLOAD"
  | "NON_CANONICAL_RECEIPT_PAYLOAD"
  | "UNSUPPORTED_RESULT"
  | "UNAUTHORIZED_ISSUER"
  | "INVALID_ISSUER_KEY"
  | "KEY_ID_MISMATCH"
  | "INVALID_SIGNATURE"
  | "ACTION_ENVELOPE_HASH_MISMATCH"
  | "EXECUTION_PAYLOAD_HASH_MISMATCH"
  | "ACTION_ID_MISMATCH"
  | "PROPOSER_MISMATCH"
  | "INVALID_RECEIPT_TIME"
  | "RECEIPT_FROM_FUTURE"
  | "RECEIPT_TOO_OLD";

export type ReceiptVerificationResult =
  | { ok: true; payload: ReceiptPayload }
  | { ok: false; error: { code: ReceiptVerificationErrorCode; message: string } };

function receiptFailure(code: ReceiptVerificationErrorCode, message: string): ReceiptVerificationResult {
  return { ok: false, error: { code, message } };
}

function receiptObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))
    && required.every(key => Object.hasOwn(value, key));
}

function receiptHash(value: unknown): value is HashObject {
  return receiptObject(value, ["alg", "value"], ["alg", "value"])
    && ["sha-256", "sha-384", "sha-512", "sha3-256", "sha3-384", "sha3-512"].includes(value.alg as string)
    && typeof value.value === "string" && /^[A-Za-z0-9_-]+$/.test(value.value)
    && Buffer.from(value.value, "base64url").toString("base64url") === value.value;
}

/**
 * Verifies an untrusted receipt object or raw JSON text against trusted expected
 * objects and action-specific issuer authority. Failures never return a payload.
 * This verifies historical evidence, not permission to execute or retry an action.
 */
export async function verifyExecutionReceipt(
  receipt: unknown,
  options: ReceiptVerificationOptions,
): Promise<ReceiptVerificationResult> {
  try {
    if (!options || typeof options !== "object" || !options.actionEnvelope
      || !Object.hasOwn(options, "executionPayload") || options.executionPayload === undefined
      || !Array.isArray(options.authorizedIssuers) || options.authorizedIssuers.length === 0) {
      return receiptFailure("INVALID_VERIFICATION_OPTIONS", "Expected objects and action-specific authorized issuers are required.");
    }
    const now = options.now === undefined ? Date.now() : options.now;
    const tolerance = options.timestampToleranceMs === undefined ? 0 : options.timestampToleranceMs;
    const maxAge = options.maxAgeMs;
    if (typeof now !== "number" || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())
      || typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0
      || (maxAge !== undefined && (typeof maxAge !== "number" || !Number.isFinite(maxAge) || maxAge < 0))) {
      return receiptFailure("INVALID_TIME_OPTIONS", "Time and tolerance must be finite; age and tolerance must be nonnegative.");
    }
    let expectedEnvelopeHash: HashObject;
    let expectedPayloadHash: HashObject;
    try {
      expectedEnvelopeHash = computeJsonHash(options.actionEnvelope);
      expectedPayloadHash = computeJsonHash(options.executionPayload);
    } catch {
      return receiptFailure("INVALID_VERIFICATION_OPTIONS", "Expected action objects must be hashable JSON.");
    }
    if (typeof receipt === "string") receipt = strictJsonParse(receipt);
    if (!receiptObject(receipt, ["version", "type", "format", "signature"], ["version", "type", "format", "signature"])
      || receipt.version !== "1" || receipt.type !== "ExecutionReceipt" || receipt.format !== "jws"
      || typeof receipt.signature !== "string"
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(receipt.signature)) {
      return receiptFailure("INVALID_RECEIPT", "Expected the Core ExecutionReceipt wrapper and compact JWS.");
    }
    const signature = receipt.signature;
    const segments = signature.split(".");
    const bytes = segments.map(part => Buffer.from(part, "base64url"));
    if (bytes.some((part, index) => part.toString("base64url") !== segments[index])) {
      return receiptFailure("INVALID_RECEIPT", "Compact JWS must use canonical unpadded base64url.");
    }
    let header: Record<string, unknown>;
    try {
      const parsed = strictJsonParse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes[0]));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("header");
      header = parsed as Record<string, unknown>;
    } catch {
      return receiptFailure("INVALID_JWS_HEADER", "Protected header must be valid JSON without duplicate members.");
    }
    if (typeof header.alg !== "string" || header.alg.length === 0) {
      return receiptFailure("INVALID_JWS_HEADER", "Protected alg is required.");
    }
    if (header.alg !== "EdDSA") return receiptFailure("UNSUPPORTED_ALGORITHM", "Only Ed25519/EdDSA receipts are supported.");
    if (typeof header.kid !== "string" || header.kid.length === 0) {
      return receiptFailure("KEY_ID_MISMATCH", "Protected kid must identify an authorized receipt key.");
    }
    // Core requires an encoded payload. No critical extensions are implemented.
    // Harmless JOSE metadata (including a non-authoritative jwk) remains allowed.
    if (Object.hasOwn(header, "crit") || (Object.hasOwn(header, "b64") && header.b64 !== true)) {
      return receiptFailure("INVALID_JWS_HEADER", "Unsupported critical extension or unencoded payload.");
    }
    let payload: ReceiptPayload;
    let payloadText: string;
    try {
      payloadText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes[1]);
      const parsed = strictJsonParse(payloadText);
      if (!receiptObject(parsed,
        ["issuerDid", "actionEnvelopeHash", "executionPayloadHash", "actionId", "proposerDid", "result", "issuedAt", "executionRef"],
        ["issuerDid", "actionEnvelopeHash", "executionPayloadHash", "result", "issuedAt"])
        || typeof parsed.issuerDid !== "string" || !/^did:[a-z0-9]+:[^\s]+$/.test(parsed.issuerDid)
        || !receiptHash(parsed.actionEnvelopeHash) || !receiptHash(parsed.executionPayloadHash)
        || (Object.hasOwn(parsed, "proposerDid") && (typeof parsed.proposerDid !== "string" || !/^did:[a-z0-9]+:[^\s]+$/.test(parsed.proposerDid)))
        || (Object.hasOwn(parsed, "executionRef") && typeof parsed.executionRef !== "string")) throw new Error("payload");
      if (Object.hasOwn(parsed, "actionId") && (!receiptObject(parsed.actionId, ["value", "scope"], ["value"])
        || typeof parsed.actionId.value !== "string" || parsed.actionId.value.length === 0
        || (Object.hasOwn(parsed.actionId, "scope") && (typeof parsed.actionId.scope !== "string" || parsed.actionId.scope.length === 0)))) throw new Error("actionId");
      // RFC 8785 forbids lone Unicode surrogates, including escaped JSON input.
      const strings = Object.values(parsed).flatMap(value => typeof value === "object" && value !== null ? Object.values(value) : [value]);
      if (strings.some(value => typeof value === "string" && /[\uD800-\uDFFF]/u.test(value))) throw new Error("unicode");
      payload = parsed as unknown as ReceiptPayload;
    } catch {
      return receiptFailure("INVALID_RECEIPT_PAYLOAD", "Signed receipt payload must follow the closed Core schema without duplicate members.");
    }
    if (!["executed", "rejected", "failed", "indeterminate", "expired", "cancelled", "revoked"].includes(payload.result)) {
      return receiptFailure("UNSUPPORTED_RESULT", "Receipt result is not a supported Core outcome.");
    }
    if (canonicalize(payload) !== payloadText) {
      return receiptFailure("NON_CANONICAL_RECEIPT_PAYLOAD", "Signed payload bytes must be JCS canonical.");
    }
    const issuers = options.authorizedIssuers.filter(issuer => issuer?.did === payload.issuerDid);
    if (issuers.length === 0) return receiptFailure("UNAUTHORIZED_ISSUER", "Issuer is not authorized for this expected action.");
    const keys: JWK[] = [];
    for (const issuer of issuers) {
      const jwk = resolveTrustedSignerJwk(issuer);
      if (!jwk) return receiptFailure("INVALID_ISSUER_KEY", "Authorized issuer has no resolvable public key.");
      const kid = isDidJwk(issuer.did) ? didJwkToKid(issuer.did) : issuer.kid ?? jwk.kid;
      if (typeof kid !== "string" || kid.length === 0
        || (issuer.kid !== undefined && issuer.kid !== kid)
        || (issuer.publicJwk?.kid !== undefined && issuer.publicJwk.kid !== kid)) {
        return receiptFailure("KEY_ID_MISMATCH", "Authorized key identifiers are missing or conflicting.");
      }
      if (kid !== header.kid) continue;
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string"
        || Object.hasOwn(jwk, "d") || !/^[A-Za-z0-9_-]+$/.test(jwk.x)
        || Buffer.from(jwk.x, "base64url").length !== 32
        || Buffer.from(jwk.x, "base64url").toString("base64url") !== jwk.x) {
        return receiptFailure("INVALID_ISSUER_KEY", "Authorized receipt key must be a public Ed25519 key.");
      }
      keys.push({ ...jwk });
    }
    if (keys.length === 0) return receiptFailure("KEY_ID_MISMATCH", "Protected kid does not match an authorized issuer key.");
    if (keys.some(key => key.x !== keys[0].x)) return receiptFailure("INVALID_ISSUER_KEY", "Conflicting public keys share one authorized issuer/key identifier.");
    // Capture all caller bindings before the asynchronous signature operation.
    const actionIdMatches = !payload.actionId || (payload.actionId.value === options.actionEnvelope.actionId?.value
      && payload.actionId.scope === options.actionEnvelope.actionId?.scope);
    const proposerMatches = payload.proposerDid === undefined || payload.proposerDid === options.actionEnvelope.proposer?.did;
    try {
      await compactVerify(signature, await importJWK(keys[0], "EdDSA"), { algorithms: ["EdDSA"] });
    } catch {
      return receiptFailure("INVALID_SIGNATURE", "Receipt signature does not verify under the authorized issuer key.");
    }
    if (payload.actionEnvelopeHash.alg !== expectedEnvelopeHash.alg || payload.actionEnvelopeHash.value !== expectedEnvelopeHash.value) {
      return receiptFailure("ACTION_ENVELOPE_HASH_MISMATCH", "Receipt does not bind to the complete expected Action Envelope.");
    }
    if (payload.executionPayloadHash.alg !== expectedPayloadHash.alg || payload.executionPayloadHash.value !== expectedPayloadHash.value) {
      return receiptFailure("EXECUTION_PAYLOAD_HASH_MISMATCH", "Receipt does not bind to the complete expected Execution Payload.");
    }
    if (!actionIdMatches) return receiptFailure("ACTION_ID_MISMATCH", "Receipt Action ID value and scope must match the expected envelope.");
    if (!proposerMatches) return receiptFailure("PROPOSER_MISMATCH", "Receipt proposer must match the expected envelope.");
    const issuedAt = Date.parse(payload.issuedAt);
    if (typeof payload.issuedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.issuedAt)
      || !Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== payload.issuedAt) {
      return receiptFailure("INVALID_RECEIPT_TIME", "issuedAt must be a real UTC timestamp with exactly three fractional digits.");
    }
    if (issuedAt - now > tolerance) return receiptFailure("RECEIPT_FROM_FUTURE", "Receipt issuance exceeds the trusted clock tolerance.");
    if (maxAge !== undefined && now - issuedAt - tolerance > maxAge) {
      return receiptFailure("RECEIPT_TOO_OLD", "Receipt exceeds the caller's trusted maximum age.");
    }
    return { ok: true, payload };
  } catch {
    return receiptFailure("INVALID_RECEIPT", "Receipt or verification input is malformed.");
  }
}
