import { compactVerify, decodeProtectedHeader, importJWK, type JWK } from "jose";
import type { ActionEnvelope, ActionPackage, Approval, CanonicalApprovalPayload, Did } from "../types/mpas.js";
import type { ExecutionPayload, Hash } from "../types/mpas.js";
import type { VerificationTraceCallback } from "./trace.js";
import { computeJsonHash } from "../utils/hash.js";

export { computeJsonHash } from "../utils/hash.js";

export interface ParseError {
  kind: "ParseError";
  code: "INVALID_ACTION_PACKAGE";
  message: string;
  path: string;
}

export type ParseActionPackageResult =
  | {
      ok: true;
      actionPackage: ActionPackage;
    }
  | {
      ok: false;
      error: ParseError;
    };

export interface ValidationError {
  kind: "ValidationError";
  code: "INVALID_ACTION_ENVELOPE" | "EXPIRED_ACTION_ENVELOPE";
  message: string;
  path: string;
}

export interface TrustedSigner {
  did: Did;
  label?: string;
  publicJwk: JWK;
}

export interface VerifiedApproval {
  approval: Approval;
  signerDid: Did;
  decision: Approval["decision"];
  createdAt: string;
}

export interface VerifiedApprovals {
  actionEnvelopeHash: Hash;
  approvals: VerifiedApproval[];
}

export interface ApprovalBundleError {
  kind: "ApprovalBundleError";
  code:
    | "ACTION_ENVELOPE_HASH_MISMATCH"
    | "APPROVAL_HASH_MISMATCH"
    | "UNTRUSTED_SIGNER"
    | "INVALID_SIGNATURE"
    | "APPROVAL_PAYLOAD_MISMATCH";
  message: string;
  path: string;
}

export type ApprovalBundleVerificationResult =
  | {
      ok: true;
      verifiedApprovals: VerifiedApprovals;
    }
  | {
      ok: false;
      error: ApprovalBundleError;
    };

export interface VerificationConfig {
  trustedSigners: TrustedSigner[];
  trustedApplicationDids?: Did[];
  /** Optional callback invoked after each verification sub-step for protocol tracing. */
  onStep?: VerificationTraceCallback;
}

export type VerificationFailureCode =
  | "INVALID_ACTION_ENVELOPE"
  | "EXPIRED_ACTION_ENVELOPE"
  | "PAYLOAD_HASH_MISMATCH"
  | "APPROVAL_BUNDLE_INVALID"
  | "UNKNOWN_APPLICATION";

export type VerificationResult =
  | {
      status: "verified";
      actionId: string;
      applicationDid: Did;
      operationName?: string;
      verifiedApprovals: VerifiedApprovals;
    }
  | {
      status: "rejected";
      code: VerificationFailureCode;
      message: string;
      path: string;
    };

export type ValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: ValidationError;
    };

export function parseActionPackage(json: unknown): ParseActionPackageResult {
  if (!isRecord(json)) {
    return parseError("Action Package must be a JSON object.", "$");
  }

  if (!hasOwn(json, "executionPayload")) {
    return parseError("Action Package missing required field: executionPayload", "$.executionPayload");
  }

  if (!hasOwn(json, "actionEnvelope")) {
    return parseError("Action Package missing required field: actionEnvelope", "$.actionEnvelope");
  }

  if (!isRecord(json.actionEnvelope)) {
    return parseError("Action Package field actionEnvelope must be a JSON object.", "$.actionEnvelope");
  }

  if (!hasOwn(json, "approvalBundle")) {
    return parseError("Action Package missing required field: approvalBundle", "$.approvalBundle");
  }

  if (!isRecord(json.approvalBundle)) {
    return parseError("Action Package field approvalBundle must be a JSON object.", "$.approvalBundle");
  }

  return {
    ok: true,
    actionPackage: json as unknown as ActionPackage,
  };
}

export interface ValidateEnvelopeOptions {
  /**
   * When false, structural validation is performed but expiry is NOT checked. The
   * Action Lifecycle requires the dispatch-ledger check to run before any stateless
   * expiry rejection (an expired envelope whose actionId is already in the ledger
   * resolves via the ledger, not as `expired`).
   */
  checkExpiry?: boolean;
}

export function validateActionEnvelope(envelope: ActionEnvelope, options: ValidateEnvelopeOptions = {}): ValidationResult {
  const checkExpiry = options.checkExpiry ?? true;
  if (!isRecord(envelope)) {
    return validationError("INVALID_ACTION_ENVELOPE", "Action Envelope must be a JSON object.", "$");
  }

  const requiredChecks: Array<[keyof ActionEnvelope, string]> = [
    ["version", "$.version"],
    ["type", "$.type"],
    ["proposer", "$.proposer"],
    ["target", "$.target"],
    ["executionProfile", "$.executionProfile"],
    ["executionPayloadHash", "$.executionPayloadHash"],
    ["actionId", "$.actionId"],
    ["createdAt", "$.createdAt"],
    ["expiresAt", "$.expiresAt"],
  ];

  for (const [field, path] of requiredChecks) {
    if (!hasOwn(envelope, field)) {
      return validationError("INVALID_ACTION_ENVELOPE", `Action Envelope missing required field: ${field}`, path);
    }
  }

  if (envelope.version !== "1") {
    return validationError("INVALID_ACTION_ENVELOPE", 'Action Envelope version must be "1".', "$.version");
  }

  if (envelope.type !== "ActionEnvelope") {
    return validationError("INVALID_ACTION_ENVELOPE", 'Action Envelope type must be "ActionEnvelope".', "$.type");
  }

  if (!isRecord(envelope.proposer) || !isDid(envelope.proposer.did)) {
    return validationError("INVALID_ACTION_ENVELOPE", "Action Envelope proposer.did must be a DID.", "$.proposer.did");
  }

  if (!isRecord(envelope.target) || !isDid(envelope.target.applicationDid)) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope target.applicationDid must be a DID.",
      "$.target.applicationDid",
    );
  }

  if (!isRecord(envelope.executionProfile) || !isDid(envelope.executionProfile.id)) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope executionProfile.id must be a DID.",
      "$.executionProfile.id",
    );
  }

  if (!isRecord(envelope.executionPayloadHash) || envelope.executionPayloadHash.alg !== "sha-256") {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      'Action Envelope executionPayloadHash must use alg "sha-256".',
      "$.executionPayloadHash",
    );
  }

  if (!isRecord(envelope.actionId) || typeof envelope.actionId.value !== "string" || envelope.actionId.value === "") {
    return validationError("INVALID_ACTION_ENVELOPE", "Action Envelope actionId.value is required.", "$.actionId.value");
  }

  if (!isMpasTimestamp(envelope.createdAt)) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope createdAt must be an MPAS timestamp with millisecond precision.",
      "$.createdAt",
    );
  }

  if (!isMpasTimestamp(envelope.expiresAt)) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope expiresAt must be an MPAS timestamp with millisecond precision.",
      "$.expiresAt",
    );
  }

  const expiresAt = Date.parse(envelope.expiresAt);
  if (checkExpiry && expiresAt <= Date.now()) {
    return validationError("EXPIRED_ACTION_ENVELOPE", "Action Envelope is expired.", "$.expiresAt");
  }

  return { ok: true };
}

/** True when the Action Envelope's `expiresAt` is at or before `now`. */
export function isEnvelopeExpired(envelope: ActionEnvelope, now = Date.now()): boolean {
  const expiresAt = Date.parse(envelope.expiresAt);
  return !Number.isNaN(expiresAt) && expiresAt <= now;
}

export function verifyPayloadBinding(payload: ExecutionPayload, envelope: ActionEnvelope): boolean {
  if (envelope.executionPayloadHash.alg !== "sha-256") {
    return false;
  }

  return hashesEqual(computeJsonHash(payload), envelope.executionPayloadHash);
}

export async function verifyApprovalSignature(approval: Approval, publicKey: JWK): Promise<boolean> {
  if (approval.signature.format !== "jws") {
    return false;
  }

  try {
    const protectedHeader = decodeProtectedHeader(approval.signature.value);
    if (protectedHeader.alg === "none" || protectedHeader.alg !== "EdDSA") {
      return false;
    }

    const key = await importJWK(publicKey, protectedHeader.alg);
    await compactVerify(approval.signature.value, key);
    return true;
  } catch {
    return false;
  }
}

export async function verifyApprovalBundle(
  bundle: ActionPackage["approvalBundle"],
  actionEnvelopeHash: Hash,
  trustedSigners: TrustedSigner[],
): Promise<ApprovalBundleVerificationResult> {
  if (!hashesEqual(bundle.actionEnvelopeHash, actionEnvelopeHash)) {
    return approvalBundleError(
      "ACTION_ENVELOPE_HASH_MISMATCH",
      "Approval Bundle actionEnvelopeHash does not match the Action Envelope hash.",
      "$.approvalBundle.actionEnvelopeHash",
    );
  }

  const trustedByDid = new Map(trustedSigners.map((signer) => [signer.did, signer]));
  const approvals: VerifiedApproval[] = [];

  for (const [index, approval] of bundle.approvals.entries()) {
    const path = `$.approvalBundle.approvals[${index}]`;

    if (!hashesEqual(approval.actionEnvelopeHash, actionEnvelopeHash)) {
      return approvalBundleError(
        "APPROVAL_HASH_MISMATCH",
        "Approval actionEnvelopeHash does not match the Action Envelope hash.",
        `${path}.actionEnvelopeHash`,
      );
    }

    const untrustedPayload = decodeApprovalPayload(approval);
    if (!untrustedPayload?.signerDid) {
      return approvalBundleError("UNTRUSTED_SIGNER", "Approval payload does not identify a trusted signer.", path);
    }

    const trustedSigner = trustedByDid.get(untrustedPayload.signerDid);
    if (!trustedSigner) {
      return approvalBundleError("UNTRUSTED_SIGNER", "Approval signer is not trusted.", `${path}.signature`);
    }

    if (!(await verifyApprovalSignature(approval, trustedSigner.publicJwk))) {
      return approvalBundleError("INVALID_SIGNATURE", "Approval signature could not be verified.", `${path}.signature`);
    }

    const verifiedPayload = await verifiedApprovalPayload(approval, trustedSigner.publicJwk);
    if (
      !hashesEqual(verifiedPayload.actionEnvelopeHash, approval.actionEnvelopeHash) ||
      verifiedPayload.decision !== approval.decision ||
      verifiedPayload.createdAt !== approval.createdAt ||
      verifiedPayload.signerDid !== trustedSigner.did
    ) {
      return approvalBundleError(
        "APPROVAL_PAYLOAD_MISMATCH",
        "Signed Approval payload does not match the top-level Approval fields.",
        path,
      );
    }

    approvals.push({
      approval,
      signerDid: trustedSigner.did,
      decision: approval.decision,
      createdAt: approval.createdAt,
    });
  }

  return {
    ok: true,
    verifiedApprovals: {
      actionEnvelopeHash,
      approvals,
    },
  };
}

export const DEFAULT_MAX_ENVELOPE_VALIDITY_MS = 24 * 60 * 60 * 1000;

/**
 * Returns true if the Action Envelope's validity window (expiresAt - now) exceeds
 * the configured maximum. Verifiers MUST reject such envelopes per the MPAS Core
 * Action Lifecycle (maximum envelope validity window). This is what makes
 * TTL-bounded retention of dispatch-ledger records provably safe.
 */
export function exceedsMaxEnvelopeValidity(
  envelope: ActionEnvelope,
  maxValidityMs = DEFAULT_MAX_ENVELOPE_VALIDITY_MS,
  now = Date.now(),
): boolean {
  const expiresAt = Date.parse(envelope.expiresAt);
  if (Number.isNaN(expiresAt)) {
    return false;
  }

  return expiresAt - now > maxValidityMs;
}

export async function verifyActionPackage(
  actionPackage: ActionPackage,
  config: VerificationConfig,
): Promise<VerificationResult> {
  const onStep = config.onStep;

  const envelopeResult = validateActionEnvelope(actionPackage.actionEnvelope);
  if (!envelopeResult.ok) {
    onStep?.("envelope_validation", false, { code: envelopeResult.error.code, message: envelopeResult.error.message });
    return {
      status: "rejected",
      code: envelopeResult.error.code,
      message: envelopeResult.error.message,
      path: envelopeResult.error.path,
    };
  }
  onStep?.("envelope_validation", true);

  if (
    config.trustedApplicationDids &&
    !config.trustedApplicationDids.includes(actionPackage.actionEnvelope.target.applicationDid)
  ) {
    onStep?.("application_did_check", false, { applicationDid: actionPackage.actionEnvelope.target.applicationDid });
    return {
      status: "rejected",
      code: "UNKNOWN_APPLICATION",
      message: "Action Envelope target.applicationDid is not configured.",
      path: "$.actionEnvelope.target.applicationDid",
    };
  }
  onStep?.("application_did_check", true, { applicationDid: actionPackage.actionEnvelope.target.applicationDid });

  if (!verifyPayloadBinding(actionPackage.executionPayload, actionPackage.actionEnvelope)) {
    onStep?.("payload_hash_binding", false);
    return {
      status: "rejected",
      code: "PAYLOAD_HASH_MISMATCH",
      message: "Execution Payload hash does not match the Action Envelope.",
      path: "$.actionEnvelope.executionPayloadHash",
    };
  }
  onStep?.("payload_hash_binding", true);

  const bundleResult = await verifyApprovalBundle(
    actionPackage.approvalBundle,
    computeJsonHash(actionPackage.actionEnvelope),
    config.trustedSigners,
  );
  if (!bundleResult.ok) {
    onStep?.("approval_bundle_verification", false, { code: bundleResult.error.code, message: bundleResult.error.message });
    return {
      status: "rejected",
      code: "APPROVAL_BUNDLE_INVALID",
      message: bundleResult.error.message,
      path: bundleResult.error.path,
    };
  }
  onStep?.("approval_bundle_verification", true, { approvalCount: bundleResult.verifiedApprovals.approvals.length });

  return {
    status: "verified",
    actionId: actionPackage.actionEnvelope.actionId.value,
    applicationDid: actionPackage.actionEnvelope.target.applicationDid,
    operationName: operationNameFromPayload(actionPackage.executionPayload),
    verifiedApprovals: bundleResult.verifiedApprovals,
  };
}

function parseError(message: string, path: string): ParseActionPackageResult {
  return {
    ok: false,
    error: {
      kind: "ParseError",
      code: "INVALID_ACTION_PACKAGE",
      message,
      path,
    },
  };
}

function validationError(code: ValidationError["code"], message: string, path: string): ValidationResult {
  return {
    ok: false,
    error: {
      kind: "ValidationError",
      code,
      message,
      path,
    },
  };
}

function approvalBundleError(
  code: ApprovalBundleError["code"],
  message: string,
  path: string,
): ApprovalBundleVerificationResult {
  return {
    ok: false,
    error: {
      kind: "ApprovalBundleError",
      code,
      message,
      path,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isDid(value: unknown): value is `did:${string}:${string}` {
  return typeof value === "string" && /^did:[a-z0-9]+:\S+$/.test(value);
}

function isMpasTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }

  return !Number.isNaN(Date.parse(value));
}

function hashesEqual(left: Hash, right: Hash): boolean {
  return left.alg === right.alg && left.value === right.value;
}

function operationNameFromPayload(payload: ExecutionPayload): string | undefined {
  if (isRecord(payload) && typeof payload.name === "string") {
    return payload.name;
  }

  return undefined;
}

function decodeApprovalPayload(approval: Approval): CanonicalApprovalPayload | null {
  try {
    const [, encodedPayload] = approval.signature.value.split(".");
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as CanonicalApprovalPayload;
  } catch {
    return null;
  }
}

async function verifiedApprovalPayload(approval: Approval, publicKey: JWK): Promise<CanonicalApprovalPayload> {
  const protectedHeader = decodeProtectedHeader(approval.signature.value);
  const key = await importJWK(publicKey, protectedHeader.alg);
  const { payload } = await compactVerify(approval.signature.value, key);
  return JSON.parse(Buffer.from(payload).toString("utf8")) as CanonicalApprovalPayload;
}
