import type { JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { verifySuiteCompactJws } from "./signature-suites.js";
import { verificationKid } from "./signer.js";
import { deriveDidJwk, didJwkToJwk, didJwkToKid, isDidJwk } from "./did-jwk.js";
import type { ActionEnvelope, ActionId, ActionPackage, Approval, CanonicalApprovalPayload, Did } from "../types/mpas.js";
import type { ExecutionPayload, Hash, ExecutionReceipt } from "../types/mpas.js";
import type { VerificationTraceCallback } from "./trace.js";
import { computeJsonHash } from "../utils/hash.js";
import { strictJsonParse } from "../utils/strict-json.js";

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
  /** Authorized JWS key identifier. Required for non-did:jwk signers when publicJwk.kid is absent. */
  kid?: string;
  /**
   * Verification key for the signer. Optional when `did` is a did:jwk — the
   * DID itself embeds the key and is the source of truth; a configured
   * publicJwk is then ignored in favor of the key decoded from the DID.
   * Required for all other DID methods.
   */
  publicJwk?: JWK;
}

/**
 * Resolves the effective verification JWK for a trusted signer. For did:jwk
 * identities the key embedded in the DID is authoritative; otherwise the
 * configured publicJwk is used. Returns undefined when no key can be resolved.
 */
export function resolveTrustedSignerJwk(signer: TrustedSigner): JWK | undefined {
  if (isDidJwk(signer.did)) {
    try {
      return didJwkToJwk(signer.did);
    } catch {
      return undefined;
    }
  }

  return signer.publicJwk;
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
    | "MALFORMED_APPROVAL_BUNDLE"
    | "UNTRUSTED_SIGNER"
    | "INVALID_SIGNATURE"
    | "APPROVAL_PAYLOAD_MISMATCH"
    | "NON_CANONICAL_APPROVAL_PAYLOAD"
    | "KEY_ID_MISMATCH"
    | "APPROVAL_TIME_INVALID"
    | "CONFLICTING_SIGNER_DECISIONS";
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

export interface TrustedExecutionProfile {
  id: Did;
  format: string;
  /** Returns true only when the payload is well formed for this declared profile. */
  validatePayload: (payload: ExecutionPayload) => boolean;
  /** Computes the profile-defined payload hash. */
  hashPayload: (payload: ExecutionPayload) => Hash;
  /** Optional profile rule for action identifiers and replay-domain scope. */
  validateActionId?: (actionId: ActionId) => boolean;
}

export interface TrustedApplicationProfile {
  applicationDid: Did;
  executionProfile: TrustedExecutionProfile;
}

export interface ApprovalTimeOptions {
  actionEnvelope?: ActionEnvelope;
  now?: number;
  timestampToleranceMs?: number;
}

export const MCP_TOOL_CALL_EXECUTION_PROFILE: TrustedExecutionProfile = {
  id: "did:web:profiles.oma3.org:mcp",
  format: "mcp.toolsCall",
  validatePayload: isMcpToolCallPayload,
  hashPayload: computeJsonHash,
  validateActionId: hasSafeReplayDomain,
};

export interface VerificationConfig {
  trustedSigners: TrustedSigner[];
  /** Exact trusted Application/profile/format bindings. */
  trustedApplicationProfiles?: TrustedApplicationProfile[];
  /** @deprecated Use trustedApplicationProfiles. This legacy form authorizes only the built-in MCP profile. */
  trustedApplicationDids?: Did[];
  /** Trusted clock value used for deterministic verification. Defaults to Date.now(). */
  now?: number;
  /** Accepted clock skew in milliseconds. Defaults to zero. */
  timestampToleranceMs?: number;
  /** Maximum remaining envelope validity. Defaults to 24 hours. */
  maxEnvelopeValidityMs?: number;
  /** Optional callback invoked after each verification sub-step for protocol tracing. */
  onStep?: VerificationTraceCallback;
}

export type VerificationFailureCode =
  | "INVALID_ACTION_PACKAGE"
  | "INVALID_ACTION_ENVELOPE"
  | "EXPIRED_ACTION_ENVELOPE"
  | "ENVELOPE_VALIDITY_TOO_LONG"
  | "UNSUPPORTED_EXECUTION_PROFILE"
  | "INVALID_EXECUTION_PAYLOAD"
  | "INVALID_ACTION_ID"
  | "PAYLOAD_HASH_MISMATCH"
  | "APPROVAL_BUNDLE_INVALID"
  | "MALFORMED_APPROVAL_BUNDLE"
  | "MISSING_PROPOSER_APPROVAL"
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

  const unexpectedPackageField = firstUnexpectedKey(json, [
    "version",
    "type",
    "executionPayload",
    "actionEnvelope",
    "approvalBundle",
    "createdAt",
  ]);
  if (unexpectedPackageField) {
    return parseError("Action Package contains an undeclared field.", `$.${unexpectedPackageField}`);
  }

  if (json.version !== "1") {
    return parseError('Action Package version must be "1".', "$.version");
  }

  if (json.type !== "ActionPackage") {
    return parseError('Action Package type must be "ActionPackage".', "$.type");
  }

  if (!hasOwn(json, "executionPayload")) {
    return parseError("Action Package missing required field: executionPayload", "$.executionPayload");
  }

  if (json.executionPayload === null) {
    return parseError("Action Package executionPayload must not be null.", "$.executionPayload");
  }

  if (!hasOwn(json, "actionEnvelope")) {
    return parseError("Action Package missing required field: actionEnvelope", "$.actionEnvelope");
  }

  if (!isRecord(json.actionEnvelope)) {
    return parseError("Action Package field actionEnvelope must be a JSON object.", "$.actionEnvelope");
  }

  const envelopeResult = validateActionEnvelope(json.actionEnvelope as unknown as ActionEnvelope, {
    checkExpiry: false,
    checkTime: false,
  });
  if (!envelopeResult.ok) {
    return parseError(envelopeResult.error.message, `$.actionEnvelope${envelopeResult.error.path.slice(1)}`);
  }

  if (!hasOwn(json, "approvalBundle")) {
    return parseError("Action Package missing required field: approvalBundle", "$.approvalBundle");
  }

  if (!isRecord(json.approvalBundle)) {
    return parseError("Action Package field approvalBundle must be a JSON object.", "$.approvalBundle");
  }

  const bundleResult = validateApprovalBundleStructure(json.approvalBundle as unknown as ActionPackage["approvalBundle"]);
  if (!bundleResult.ok) {
    return parseError(bundleResult.message, bundleResult.path);
  }

  if (hasOwn(json, "createdAt") && !isMpasTimestamp(json.createdAt)) {
    return parseError("Action Package createdAt must be an MPAS timestamp.", "$.createdAt");
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
  /** When false, perform structural validation without consulting a clock. */
  checkTime?: boolean;
  now?: number;
  timestampToleranceMs?: number;
}

export function validateActionEnvelope(envelope: ActionEnvelope, options: ValidateEnvelopeOptions = {}): ValidationResult {
  const checkExpiry = options.checkExpiry ?? true;
  const checkTime = options.checkTime ?? true;
  const now = options.now ?? Date.now();
  const timestampToleranceMs = options.timestampToleranceMs ?? 0;
  if (!isRecord(envelope)) {
    return validationError("INVALID_ACTION_ENVELOPE", "Action Envelope must be a JSON object.", "$");
  }

  const unexpectedEnvelopeField = firstUnexpectedKey(envelope, [
    "version",
    "type",
    "proposer",
    "target",
    "executionProfile",
    "executionPayloadHash",
    "actionId",
    "createdAt",
    "expiresAt",
  ]);
  if (unexpectedEnvelopeField) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope contains an undeclared field.",
      `$.${unexpectedEnvelopeField}`,
    );
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

  if (!isRecord(envelope.proposer) || firstUnexpectedKey(envelope.proposer, ["did"]) !== undefined || !isDid(envelope.proposer.did)) {
    return validationError("INVALID_ACTION_ENVELOPE", "Action Envelope proposer.did must be a DID.", "$.proposer.did");
  }

  if (!isRecord(envelope.target) || !isDid(envelope.target.applicationDid)) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope target.applicationDid must be a DID.",
      "$.target.applicationDid",
    );
  }

  if (
    !isRecord(envelope.executionProfile) ||
    firstUnexpectedKey(envelope.executionProfile, ["id", "format"]) !== undefined ||
    !isDid(envelope.executionProfile.id)
  ) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope executionProfile.id must be a DID.",
      "$.executionProfile.id",
    );
  }

  if (hasOwn(envelope.executionProfile, "format") && typeof envelope.executionProfile.format !== "string") {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope executionProfile.format must be a string.",
      "$.executionProfile.format",
    );
  }

  if (!isHashObject(envelope.executionPayloadHash)) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope executionPayloadHash must be a well-formed hash object.",
      "$.executionPayloadHash",
    );
  }

  if (
    !isRecord(envelope.actionId) ||
    firstUnexpectedKey(envelope.actionId, ["value", "scope"]) !== undefined ||
    typeof envelope.actionId.value !== "string" ||
    envelope.actionId.value === ""
  ) {
    return validationError("INVALID_ACTION_ENVELOPE", "Action Envelope actionId.value is required.", "$.actionId.value");
  }

  if (hasOwn(envelope.actionId, "scope") && (typeof envelope.actionId.scope !== "string" || envelope.actionId.scope === "")) {
    return validationError("INVALID_ACTION_ENVELOPE", "Action Envelope actionId.scope must be non-empty.", "$.actionId.scope");
  }

  if (!isEnvelopeTimestamp(envelope.createdAt)) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope createdAt must be an MPAS timestamp with millisecond precision.",
      "$.createdAt",
    );
  }

  if (!isEnvelopeTimestamp(envelope.expiresAt)) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope expiresAt must be an MPAS timestamp with millisecond precision.",
      "$.expiresAt",
    );
  }

  const createdAt = Date.parse(envelope.createdAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (expiresAt <= createdAt) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope expiresAt must be after createdAt.",
      "$.expiresAt",
    );
  }

  if (checkTime && createdAt > now + timestampToleranceMs) {
    return validationError(
      "INVALID_ACTION_ENVELOPE",
      "Action Envelope createdAt is beyond the accepted clock tolerance.",
      "$.createdAt",
    );
  }

  if (checkTime && checkExpiry && expiresAt <= now - timestampToleranceMs) {
    return validationError("EXPIRED_ACTION_ENVELOPE", "Action Envelope is expired.", "$.expiresAt");
  }

  return { ok: true };
}

/** Returns whether an Action Envelope has reached its authoritative expiry time. */
export function isActionEnvelopeExpired(envelope: ActionEnvelope, now = Date.now()): boolean {
  const expiresAt = Date.parse(envelope.expiresAt);
  return !Number.isNaN(expiresAt) && expiresAt <= now;
}

/** @deprecated Use {@link isActionEnvelopeExpired}. */
export const isEnvelopeExpired = isActionEnvelopeExpired;

export function verifyPayloadBinding(
  payload: ExecutionPayload,
  envelope: ActionEnvelope,
  executionProfile?: TrustedExecutionProfile,
): boolean {
  const profile = executionProfile ?? resolveBuiltInExecutionProfile(envelope);
  if (!profile || !profile.validatePayload(payload)) {
    return false;
  }

  return hashesEqual(profile.hashPayload(payload), envelope.executionPayloadHash);
}

export async function verifyApprovalSignature(approval: Approval, publicKey: JWK, signerDid?: Did): Promise<boolean> {
  if (approval.signature.format !== "jws") {
    return false;
  }

  try {
    const kid = verificationKid(publicKey, signerDid);
    const payloadBytes = await verifySuiteCompactJws(approval.signature.value, publicKey, kid);
    const payloadText = Buffer.from(payloadBytes).toString("utf8");
    const parsed = strictJsonParse(payloadText);
    if (!isCanonicalApprovalPayload(parsed) || canonicalize(parsed) !== payloadText) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies a did:jwk Approval signature and its signed/top-level field binding.
 *
 * Use {@link verifyApprovalSignature} when only cryptographic signature validity is
 * needed. This function additionally verifies the Action hash, decision, timestamp,
 * and signer DID carried by the signed Approval payload.
 */
export async function verifyApproval(approval: Approval, signerPublicKey: JWK, signerDid?: Did): Promise<boolean> {
  if (!(await verifyApprovalSignature(approval, signerPublicKey, signerDid))) return false;
  try {
    const payload = await verifiedApprovalPayload(approval, signerPublicKey, signerDid);
    return (
      hashesEqual(payload.actionEnvelopeHash, approval.actionEnvelopeHash) &&
      payload.decision === approval.decision &&
      payload.createdAt === approval.createdAt &&
      payload.expiresAt === approval.expiresAt &&
      payload.signerDid === (signerDid ?? deriveDidJwk(signerPublicKey))
    );
  } catch {
    return false;
  }
}

export async function verifyApprovalBundle(
  bundle: ActionPackage["approvalBundle"],
  actionEnvelopeHash: Hash,
  trustedSigners: TrustedSigner[],
  timeOptions: ApprovalTimeOptions = {},
): Promise<ApprovalBundleVerificationResult> {
  const bundleStructure = validateApprovalBundleStructure(bundle);
  if (!bundleStructure.ok) {
    return approvalBundleError(
      "MALFORMED_APPROVAL_BUNDLE",
      bundleStructure.message,
      bundleStructure.path,
    );
  }

  if (!hashesEqual(bundle.actionEnvelopeHash, actionEnvelopeHash)) {
    return approvalBundleError(
      "ACTION_ENVELOPE_HASH_MISMATCH",
      "Approval Bundle actionEnvelopeHash does not match the Action Envelope hash.",
      "$.approvalBundle.actionEnvelopeHash",
    );
  }

  const trustedByDid = new Map(trustedSigners.map((signer) => [signer.did, signer]));
  const approvals: VerifiedApproval[] = [];
  const decisionBySigner = new Map<Did, Approval["decision"]>();

  for (const [index, approval] of bundle.approvals.entries()) {
    const path = `$.approvalBundle.approvals[${index}]`;

    if (!hashesEqual(approval.actionEnvelopeHash, actionEnvelopeHash)) {
      return approvalBundleError(
        "APPROVAL_HASH_MISMATCH",
        "Approval actionEnvelopeHash does not match the Action Envelope hash.",
        `${path}.actionEnvelopeHash`,
      );
    }

    const decoded = decodeApprovalJws(approval);
    if (!decoded.ok) {
      return approvalBundleError(decoded.code, decoded.message, `${path}.signature.value`);
    }

    const untrustedPayload = decoded.payload;
    if (!untrustedPayload.signerDid) {
      return approvalBundleError("UNTRUSTED_SIGNER", "Approval payload does not identify a trusted signer.", path);
    }

    const trustedSigner = trustedByDid.get(untrustedPayload.signerDid);
    if (!trustedSigner) {
      return approvalBundleError("UNTRUSTED_SIGNER", "Approval signer is not trusted.", `${path}.signature`);
    }

    const signerJwk = resolveTrustedSignerJwk(trustedSigner);
    if (!signerJwk) {
      return approvalBundleError(
        "UNTRUSTED_SIGNER",
        "No verification key could be resolved for the trusted signer.",
        `${path}.signature`,
      );
    }

    const expectedKid = authorizedSignerKid(trustedSigner, signerJwk);
    if (!expectedKid || decoded.protectedHeaderKid !== expectedKid) {
      return approvalBundleError(
        "KEY_ID_MISMATCH",
        "Approval JWS kid does not identify the authorized Signer key.",
        `${path}.signature.value`,
      );
    }

    try {
      await verifySuiteCompactJws(approval.signature.value, signerJwk, expectedKid);
    } catch {
      return approvalBundleError("INVALID_SIGNATURE", "Approval signature could not be verified.", `${path}.signature`);
    }

    const verifiedPayload = decoded.payload;
    if (
      !hashesEqual(verifiedPayload.actionEnvelopeHash, approval.actionEnvelopeHash) ||
      verifiedPayload.decision !== approval.decision ||
      verifiedPayload.createdAt !== approval.createdAt ||
      verifiedPayload.expiresAt !== approval.expiresAt ||
      verifiedPayload.signerDid !== trustedSigner.did
    ) {
      return approvalBundleError(
        "APPROVAL_PAYLOAD_MISMATCH",
        "Signed Approval payload does not match the top-level Approval fields.",
        path,
      );
    }

    const timeError = validateApprovalTime(approval, timeOptions);
    if (timeError) {
      return approvalBundleError("APPROVAL_TIME_INVALID", timeError.message, `${path}.${timeError.field}`);
    }

    const priorDecision = decisionBySigner.get(trustedSigner.did);
    if (priorDecision !== undefined) {
      if (priorDecision !== approval.decision) {
        return approvalBundleError(
          "CONFLICTING_SIGNER_DECISIONS",
          "One Signer supplied contradictory decisions for the same Action Envelope.",
          `${path}.decision`,
        );
      }
    } else {
      decisionBySigner.set(trustedSigner.did, approval.decision);
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
  const now = config.now ?? Date.now();
  const timestampToleranceMs = config.timestampToleranceMs ?? 0;

  const packageResult = parseActionPackage(actionPackage);
  if (!packageResult.ok) {
    onStep?.("package_validation", false, { code: packageResult.error.code, message: packageResult.error.message });
    const code: VerificationFailureCode = packageResult.error.path.startsWith("$.approvalBundle")
      ? "MALFORMED_APPROVAL_BUNDLE"
      : "INVALID_ACTION_PACKAGE";
    return {
      status: "rejected",
      code,
      message: packageResult.error.message,
      path: packageResult.error.path,
    };
  }
  onStep?.("package_validation", true);

  const envelopeResult = validateActionEnvelope(actionPackage.actionEnvelope, { now, timestampToleranceMs });
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

  if (exceedsMaxEnvelopeValidity(actionPackage.actionEnvelope, config.maxEnvelopeValidityMs, now)) {
    onStep?.("max_validity_check", false);
    return {
      status: "rejected",
      code: "ENVELOPE_VALIDITY_TOO_LONG",
      message: "Action Envelope remaining validity exceeds the configured maximum.",
      path: "$.actionEnvelope.expiresAt",
    };
  }
  onStep?.("max_validity_check", true);

  const applicationBindings = trustedApplicationBindings(config);
  const applicationMatches = applicationBindings.filter(
    (binding) => binding.applicationDid === actionPackage.actionEnvelope.target.applicationDid,
  );
  if (applicationMatches.length === 0) {
    onStep?.("application_did_check", false, { applicationDid: actionPackage.actionEnvelope.target.applicationDid });
    return {
      status: "rejected",
      code: "UNKNOWN_APPLICATION",
      message: "Action Envelope target.applicationDid is not trusted.",
      path: "$.actionEnvelope.target.applicationDid",
    };
  }
  onStep?.("application_did_check", true, { applicationDid: actionPackage.actionEnvelope.target.applicationDid });

  const executionProfile = applicationMatches.find(
    (binding) =>
      binding.executionProfile.id === actionPackage.actionEnvelope.executionProfile.id &&
      binding.executionProfile.format === actionPackage.actionEnvelope.executionProfile.format,
  )?.executionProfile;
  if (!executionProfile) {
    onStep?.("execution_profile_check", false, {
      executionProfileId: actionPackage.actionEnvelope.executionProfile.id,
      executionProfileFormat: actionPackage.actionEnvelope.executionProfile.format,
    });
    return {
      status: "rejected",
      code: "UNSUPPORTED_EXECUTION_PROFILE",
      message: "Action Envelope execution profile is not authorized for the target Application.",
      path: "$.actionEnvelope.executionProfile",
    };
  }
  onStep?.("execution_profile_check", true);

  if (!executionProfile.validatePayload(actionPackage.executionPayload)) {
    onStep?.("execution_payload_validation", false);
    return {
      status: "rejected",
      code: "INVALID_EXECUTION_PAYLOAD",
      message: "Execution Payload is malformed for the declared execution profile.",
      path: "$.executionPayload",
    };
  }
  onStep?.("execution_payload_validation", true);

  if (!(executionProfile.validateActionId ?? hasSafeReplayDomain)(actionPackage.actionEnvelope.actionId)) {
    onStep?.("action_id_validation", false);
    return {
      status: "rejected",
      code: "INVALID_ACTION_ID",
      message: "Action ID is not globally unique and has no trusted replay-domain scope.",
      path: "$.actionEnvelope.actionId.scope",
    };
  }
  onStep?.("action_id_validation", true);

  if (!verifyPayloadBinding(actionPackage.executionPayload, actionPackage.actionEnvelope, executionProfile)) {
    onStep?.("payload_hash_binding", false);
    return {
      status: "rejected",
      code: "PAYLOAD_HASH_MISMATCH",
      message: "Execution Payload hash does not match the Action Envelope.",
      path: "$.actionEnvelope.executionPayloadHash",
    };
  }
  onStep?.("payload_hash_binding", true);

  const bundleStructure = validateApprovalBundleStructure(actionPackage.approvalBundle);
  if (!bundleStructure.ok) {
    onStep?.("approval_bundle_structure", false, { message: bundleStructure.message });
    return {
      status: "rejected",
      code: "MALFORMED_APPROVAL_BUNDLE",
      message: bundleStructure.message,
      path: bundleStructure.path,
    };
  }
  onStep?.("approval_bundle_structure", true);

  const bundleResult = await verifyApprovalBundle(
    actionPackage.approvalBundle,
    computeJsonHash(actionPackage.actionEnvelope),
    config.trustedSigners,
    { actionEnvelope: actionPackage.actionEnvelope, now, timestampToleranceMs },
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
  const normalizedApprovals = normalizeVerifiedApprovals(bundleResult.verifiedApprovals);
  onStep?.("approval_bundle_verification", true, { approvalCount: normalizedApprovals.approvals.length });

  const proposerDid = actionPackage.actionEnvelope.proposer.did;
  const hasProposerApproval = normalizedApprovals.approvals.some(
    (verified) =>
      (verified.decision === "propose" || verified.decision === "approve") && verified.signerDid === proposerDid,
  );
  if (!hasProposerApproval) {
    onStep?.("proposer_approval_check", false, { proposerDid });
    return {
      status: "rejected",
      code: "MISSING_PROPOSER_APPROVAL",
      message: "Approval Bundle must include a verified propose or approve Approval from actionEnvelope.proposer.did.",
      path: "$.approvalBundle.approvals",
    };
  }
  onStep?.("proposer_approval_check", true, { proposerDid });

  return {
    status: "verified",
    actionId: actionPackage.actionEnvelope.actionId.value,
    applicationDid: actionPackage.actionEnvelope.target.applicationDid,
    operationName: operationNameFromPayload(actionPackage.executionPayload),
    verifiedApprovals: normalizedApprovals,
  };
}

type BundleStructureResult = { ok: true } | { ok: false; message: string; path: string };

function validateApprovalBundleStructure(bundle: ActionPackage["approvalBundle"]): BundleStructureResult {
  if (!isRecord(bundle)) {
    return { ok: false, message: "Approval Bundle must be a JSON object.", path: "$.approvalBundle" };
  }
  const unexpectedBundleField = firstUnexpectedKey(bundle, [
    "version",
    "type",
    "actionEnvelopeHash",
    "approvals",
    "assembledBy",
    "createdAt",
  ]);
  if (unexpectedBundleField) {
    return {
      ok: false,
      message: "Approval Bundle contains an undeclared field.",
      path: `$.approvalBundle.${unexpectedBundleField}`,
    };
  }
  if (bundle.version !== "1") {
    return { ok: false, message: 'Approval Bundle version must be "1".', path: "$.approvalBundle.version" };
  }
  if (bundle.type !== "ApprovalBundle") {
    return { ok: false, message: 'Approval Bundle type must be "ApprovalBundle".', path: "$.approvalBundle.type" };
  }
  if (!isHashObject(bundle.actionEnvelopeHash)) {
    return {
      ok: false,
      message: "Approval Bundle actionEnvelopeHash must be a hash object.",
      path: "$.approvalBundle.actionEnvelopeHash",
    };
  }
  if (hasOwn(bundle, "assembledBy") && !isDid(bundle.assembledBy)) {
    return { ok: false, message: "Approval Bundle assembledBy must be a DID.", path: "$.approvalBundle.assembledBy" };
  }
  if (hasOwn(bundle, "createdAt") && !isMpasTimestamp(bundle.createdAt)) {
    return {
      ok: false,
      message: "Approval Bundle createdAt must be an MPAS timestamp.",
      path: "$.approvalBundle.createdAt",
    };
  }
  if (!Array.isArray(bundle.approvals) || bundle.approvals.length === 0) {
    return {
      ok: false,
      message: "Approval Bundle approvals must be a non-empty array.",
      path: "$.approvalBundle.approvals",
    };
  }
  for (const [index, approval] of bundle.approvals.entries()) {
    const path = `$.approvalBundle.approvals[${index}]`;
    if (!isRecord(approval)) {
      return { ok: false, message: "Approval must be a JSON object.", path };
    }
    const unexpectedApprovalField = firstUnexpectedKey(approval, [
      "version",
      "type",
      "actionEnvelopeHash",
      "decision",
      "signature",
      "createdAt",
      "expiresAt",
    ]);
    if (unexpectedApprovalField) {
      return { ok: false, message: "Approval contains an undeclared field.", path: `${path}.${unexpectedApprovalField}` };
    }
    if (approval.version !== "1") {
      return { ok: false, message: 'Approval version must be "1".', path: `${path}.version` };
    }
    if (approval.type !== "Approval") {
      return { ok: false, message: 'Approval type must be "Approval".', path: `${path}.type` };
    }
    if (!isHashObject(approval.actionEnvelopeHash)) {
      return { ok: false, message: "Approval actionEnvelopeHash must be a hash object.", path: `${path}.actionEnvelopeHash` };
    }
    if (!isDecision(approval.decision)) {
      return { ok: false, message: "Approval decision is not a Core decision.", path: `${path}.decision` };
    }
    if (
      !isRecord(approval.signature) ||
      firstUnexpectedKey(approval.signature, ["format", "value"]) !== undefined ||
      approval.signature.format !== "jws" ||
      typeof approval.signature.value !== "string" ||
      !isCompactJws(approval.signature.value)
    ) {
      return { ok: false, message: "Approval signature must be a signature object.", path: `${path}.signature` };
    }
    if (!isMpasTimestamp(approval.createdAt)) {
      return { ok: false, message: "Approval createdAt must be an MPAS timestamp.", path: `${path}.createdAt` };
    }
    if (hasOwn(approval, "expiresAt") && !isMpasTimestamp(approval.expiresAt)) {
      return { ok: false, message: "Approval expiresAt must be an MPAS timestamp.", path: `${path}.expiresAt` };
    }
  }

  return { ok: true };
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

function firstUnexpectedKey(record: Record<string, unknown>, allowedKeys: readonly string[]): string | undefined {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).find((key) => !allowed.has(key));
}

function isDid(value: unknown): value is `did:${string}:${string}` {
  return typeof value === "string" && /^did:[a-z0-9]+:\S+$/.test(value);
}

function isMpasTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }

  return !Number.isNaN(Date.parse(value));
}

function isEnvelopeTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isHashObject(value: unknown): value is Hash {
  if (!isRecord(value) || firstUnexpectedKey(value, ["alg", "value"]) !== undefined) {
    return false;
  }

  return (
    typeof value.alg === "string" &&
    ["sha-256", "sha-384", "sha-512", "sha3-256", "sha3-384", "sha3-512"].includes(value.alg) &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    /^[A-Za-z0-9_-]+$/.test(value.value)
  );
}

function isDecision(value: unknown): value is Approval["decision"] {
  return value === "propose" || value === "approve" || value === "reject" || value === "abstain";
}

function isCompactJws(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part));
}

function hashesEqual(left: Hash, right: Hash): boolean {
  return left.alg === right.alg && left.value === right.value;
}

function normalizeVerifiedApprovals(verified: VerifiedApprovals): VerifiedApprovals {
  const seen = new Set<Did>();
  return {
    actionEnvelopeHash: verified.actionEnvelopeHash,
    approvals: verified.approvals.filter((approval) => {
      if (seen.has(approval.signerDid)) return false;
      seen.add(approval.signerDid);
      return true;
    }),
  };
}

function isMcpToolCallPayload(payload: ExecutionPayload): boolean {
  if (!isRecord(payload) || firstUnexpectedKey(payload, ["name", "arguments"]) !== undefined) {
    return false;
  }

  return typeof payload.name === "string" && payload.name.length > 0 && isRecord(payload.arguments);
}

function resolveBuiltInExecutionProfile(envelope: ActionEnvelope): TrustedExecutionProfile | undefined {
  if (
    envelope.executionProfile.id === MCP_TOOL_CALL_EXECUTION_PROFILE.id &&
    envelope.executionProfile.format === MCP_TOOL_CALL_EXECUTION_PROFILE.format
  ) {
    return MCP_TOOL_CALL_EXECUTION_PROFILE;
  }

  return undefined;
}

function trustedApplicationBindings(config: VerificationConfig): TrustedApplicationProfile[] {
  if (config.trustedApplicationProfiles !== undefined) {
    return config.trustedApplicationProfiles;
  }

  return (config.trustedApplicationDids ?? []).map((applicationDid) => ({
    applicationDid,
    executionProfile: MCP_TOOL_CALL_EXECUTION_PROFILE,
  }));
}

function hasSafeReplayDomain(actionId: ActionId): boolean {
  if (/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId.value)) {
    return true;
  }
  if (/^urn:ulid:[0-9A-HJKMNP-TV-Z]{26}$/.test(actionId.value) || isDid(actionId.value)) {
    return true;
  }

  return typeof actionId.scope === "string" && (isDid(actionId.scope) || /^[a-z0-9]+:[^\s:]+:[^\s]+$/i.test(actionId.scope));
}

function operationNameFromPayload(payload: ExecutionPayload): string | undefined {
  if (isRecord(payload) && typeof payload.name === "string") {
    return payload.name;
  }

  return undefined;
}

function isCanonicalApprovalPayload(value: unknown): value is CanonicalApprovalPayload {
  if (!isRecord(value) || firstUnexpectedKey(value, ["type", "actionEnvelopeHash", "decision", "signerDid", "createdAt", "expiresAt"]) !== undefined) {
    return false;
  }

  return (
    value.type === "ApprovalPayload" &&
    isHashObject(value.actionEnvelopeHash) &&
    isDecision(value.decision) &&
    isDid(value.signerDid) &&
    isMpasTimestamp(value.createdAt) &&
    (!hasOwn(value, "expiresAt") || isMpasTimestamp(value.expiresAt))
  );
}

type DecodedApprovalJws =
  | { ok: true; payload: CanonicalApprovalPayload; protectedHeaderKid: string | undefined }
  | {
      ok: false;
      code: Extract<ApprovalBundleError["code"], "APPROVAL_PAYLOAD_MISMATCH" | "NON_CANONICAL_APPROVAL_PAYLOAD">;
      message: string;
    };

function decodeApprovalJws(approval: Approval): DecodedApprovalJws {
  try {
    const parts = approval.signature.value.split(".");
    const headerText = Buffer.from(parts[0], "base64url").toString("utf8");
    const header = strictJsonParse(headerText) as Record<string, unknown>;
    const protectedHeaderKid = typeof header.kid === "string" ? header.kid : undefined;

    const payloadText = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = strictJsonParse(payloadText);
    if (!isCanonicalApprovalPayload(payload)) {
      return {
        ok: false,
        code: "APPROVAL_PAYLOAD_MISMATCH",
        message: "Signed Approval payload is malformed.",
      };
    }
    if (canonicalize(payload) !== payloadText) {
      return {
        ok: false,
        code: "NON_CANONICAL_APPROVAL_PAYLOAD",
        message: "Signed Approval payload bytes are not JCS canonical.",
      };
    }

    return {
      ok: true,
      payload,
      protectedHeaderKid,
    };
  } catch {
    return {
      ok: false,
      code: "APPROVAL_PAYLOAD_MISMATCH",
      message: "Signed Approval payload is malformed.",
    };
  }
}

function authorizedSignerKid(signer: TrustedSigner, signerJwk: JWK): string | undefined {
  if (typeof signer.kid === "string" && signer.kid.length > 0) {
    return signer.kid;
  }
  try {
    return verificationKid(signerJwk, signer.did);
  } catch {
    return undefined;
  }
}

function validateApprovalTime(
  approval: Approval,
  options: ApprovalTimeOptions,
): { field: "createdAt" | "expiresAt"; message: string } | undefined {
  const now = options.now ?? Date.now();
  const tolerance = options.timestampToleranceMs ?? 0;
  const createdAt = Date.parse(approval.createdAt);
  const envelopeCreatedAt = options.actionEnvelope ? Date.parse(options.actionEnvelope.createdAt) : undefined;
  const envelopeExpiresAt = options.actionEnvelope ? Date.parse(options.actionEnvelope.expiresAt) : undefined;
  const expiresAt = approval.expiresAt ? Date.parse(approval.expiresAt) : envelopeExpiresAt;

  if (createdAt > now + tolerance) {
    return { field: "createdAt", message: "Approval createdAt is beyond the accepted clock tolerance." };
  }
  if (envelopeCreatedAt !== undefined && createdAt < envelopeCreatedAt - tolerance) {
    return { field: "createdAt", message: "Approval createdAt is before the Action Envelope temporal window." };
  }
  if (envelopeExpiresAt !== undefined && createdAt > envelopeExpiresAt + tolerance) {
    return { field: "createdAt", message: "Approval createdAt is after the Action Envelope expiresAt." };
  }
  if (expiresAt !== undefined && expiresAt <= createdAt) {
    return { field: "expiresAt", message: "Approval expiresAt must be after createdAt." };
  }
  if (envelopeExpiresAt !== undefined && expiresAt !== undefined && expiresAt > envelopeExpiresAt + tolerance) {
    return { field: "expiresAt", message: "Approval expiresAt cannot outlive the Action Envelope." };
  }
  if (expiresAt !== undefined && expiresAt <= now - tolerance) {
    return { field: "expiresAt", message: "Approval is expired." };
  }

  return undefined;
}

async function verifiedApprovalPayload(approval: Approval, publicKey: JWK, signerDid?: Did): Promise<CanonicalApprovalPayload> {
  const payload = await verifySuiteCompactJws(approval.signature.value, publicKey, verificationKid(publicKey, signerDid));
  return strictJsonParse(Buffer.from(payload).toString("utf8")) as CanonicalApprovalPayload;
}

export interface VerifyExecutionReceiptOptions {
  /** Trusted issuer binding; received receipt headers never establish trust. */
  verifier: TrustedSigner;
  actionEnvelope: ActionEnvelope;
  executionPayload: ExecutionPayload;
  /** Additional application-defined results accepted by the caller. */
  additionalResults?: readonly string[];
}

/** Verify receipt issuer, protected signature, payload structure, and expected Action. */
export async function verifyExecutionReceipt(receipt: ExecutionReceipt, options: VerifyExecutionReceiptOptions): Promise<boolean> {
  try {
    if (receipt.version !== "1" || receipt.type !== "ExecutionReceipt" || receipt.format !== "jws" || hasOwn(receipt as unknown as Record<string, unknown>, "payload")) return false;
    const key = resolveTrustedSignerJwk(options.verifier);
    if (!key) return false;
    const bytes = await verifySuiteCompactJws(receipt.signature, key, verificationKid(key, options.verifier.did));
    const payload = strictJsonParse(Buffer.from(bytes).toString("utf8"));
    if (!isRecord(payload) || !isRecord(payload.actionEnvelopeHash) || !isRecord(payload.executionPayloadHash) ||
        (payload.actionId !== undefined && !isRecord(payload.actionId)) || !isMpasTimestamp(payload.issuedAt) ||
        (payload.executionRef !== undefined && typeof payload.executionRef !== "string")) return false;
    if (Object.keys(payload).some((key) => !["issuerDid", "actionEnvelopeHash", "executionPayloadHash", "actionId", "proposerDid", "result", "issuedAt", "executionRef"].includes(key))) return false;
    const results: readonly string[] = ["executed", "failed", "indeterminate", "rejected", "expired", "cancelled", "revoked", ...(options.additionalResults ?? [])];
    if (typeof payload.result !== "string" || !results.includes(payload.result)) return false;
    const { actionEnvelope, executionPayload, verifier } = options;
    return payload.issuerDid === verifier.did &&
      (payload.proposerDid === undefined || payload.proposerDid === actionEnvelope.proposer.did) &&
      (payload.actionId === undefined || canonicalize(payload.actionId) === canonicalize(actionEnvelope.actionId)) &&
      hashesEqual(payload.actionEnvelopeHash as unknown as Hash, computeJsonHash(actionEnvelope)) &&
      hashesEqual(payload.executionPayloadHash as unknown as Hash, computeJsonHash(executionPayload)) &&
      verifyPayloadBinding(executionPayload, actionEnvelope);
  } catch { return false; }
}
