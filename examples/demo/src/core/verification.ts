/**
 * Re-exports all verification primitives from @oma3/mpas.
 * This file exists so that existing imports from "../core/verification.js" continue to work.
 */
export {
  parseActionPackage,
  validateActionEnvelope,
  verifyPayloadBinding,
  verifyApprovalSignature,
  verifyApprovalBundle,
  verifyActionPackage,
  computeJsonHash,
  isEnvelopeExpired,
  exceedsMaxEnvelopeValidity,
  DEFAULT_MAX_ENVELOPE_VALIDITY_MS,
} from "@oma3/mpas";

export type {
  ParseError,
  ParseActionPackageResult,
  ValidationError,
  TrustedSigner,
  VerifiedApproval,
  VerifiedApprovals,
  ApprovalBundleError,
  ApprovalBundleVerificationResult,
  VerificationConfig,
  VerificationFailureCode,
  VerificationResult,
  ValidationResult,
  ValidateEnvelopeOptions,
} from "@oma3/mpas";
