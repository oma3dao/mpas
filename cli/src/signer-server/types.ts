/**
 * Re-exports MPAS protocol types from @oma3/mpas for the signer server.
 * This file exists for backward compatibility with any code importing from here.
 */
export type {
  MpasVersion,
  Did,
  Timestamp,
  HashAlgorithm,
  HashObject as Hash,
  ActionId,
  ExecutionPayload,
  ActionEnvelope,
  Decision,
  SignatureObject,
  Approval,
  CanonicalApprovalPayload,
  AuthorizationRequirements,
  SignerReviewSet,
  ActionReference,
  ApprovalRequest,
  CoordinationPollResponse,
  CoordinationApprovalResponse,
} from "@oma3/mpas";
