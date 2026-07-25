export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type MpasVersion = "1";
export type Did = `did:${string}:${string}`;
export type Timestamp = string;
export type JsonSchema = Record<string, unknown>;

export type HashAlgorithm =
  | "sha-256"
  | "sha-384"
  | "sha-512"
  | "sha3-256"
  | "sha3-384"
  | "sha3-512";

export interface HashObject {
  alg: HashAlgorithm;
  value: string;
}

/** @deprecated Use HashObject instead. Kept for backward compatibility. */
export type Hash = HashObject;

export interface ActionId {
  value: string;
  scope?: string;
}

/**
 * Execution Payload is protocol-opaque JSON. At the protocol layer it is validated
 * only by hash binding. Profile-specific validation (e.g., checking for a `name`
 * field in the MCP profile) is the responsibility of higher layers.
 */
export type ExecutionPayload = JsonValue;

export interface ActionEnvelope {
  version: MpasVersion;
  type: "ActionEnvelope";
  proposer: {
    did: Did;
  };
  target: {
    applicationDid: Did;
    resource?: string;
    [profileSpecificTargetField: string]: JsonValue | undefined;
  };
  executionProfile: {
    id: Did;
    format?: string;
  };
  executionPayloadHash: HashObject;
  actionId: ActionId;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export type Decision = "propose" | "approve" | "reject" | "abstain";

export interface SignatureObject {
  format: "jws";
  value: string;
}

export interface Approval {
  version: MpasVersion;
  type: "Approval";
  actionEnvelopeHash: HashObject;
  decision: Decision;
  signature: SignatureObject;
  createdAt: Timestamp;
  expiresAt?: Timestamp;
}

export interface CanonicalApprovalPayload {
  type: "ApprovalPayload";
  actionEnvelopeHash: HashObject;
  decision: Decision;
  signerDid?: Did;
  createdAt: Timestamp;
  expiresAt?: Timestamp;
}

export interface ApprovalBundle {
  version: MpasVersion;
  type: "ApprovalBundle";
  actionEnvelopeHash: HashObject;
  approvals: Approval[];
  assembledBy?: Did;
  createdAt?: Timestamp;
}

export interface ActionPackage {
  version: MpasVersion;
  type: "ActionPackage";
  executionPayload: ExecutionPayload;
  actionEnvelope: ActionEnvelope;
  approvalBundle: ApprovalBundle;
  createdAt?: Timestamp;
}

export type AuthorizationResult =
  | "additionalApprovalsRequired"
  | "rejected"
  | "notSupported"
  | "malformed"
  | "policyUnavailable";

export interface ThresholdRequirement {
  type: "threshold";
  threshold: number;
  eligibleSigners: Did[];
  decision?: Decision;
  description?: string;
}

export interface OverrideSigner {
  signer: Did;
  permissions: string[];
  description?: string;
}

export interface ApprovalRequirements {
  anyOf?: ThresholdRequirement[];
  allOf?: ThresholdRequirement[];
  overrideSigners?: OverrideSigner[];
}

export type AuthorizationRequirements =
  | BaseAuthorizationRequirements
  | AdditionalApprovalsAuthorizationRequirements;

interface BaseAuthorizationRequirements {
  version: MpasVersion;
  type: "AuthorizationRequirements";
  actionEnvelopeHash: HashObject;
  result: Exclude<AuthorizationResult, "additionalApprovalsRequired">;
  verifier: {
    did: Did;
  };
  policyRef?: string;
  createdAt?: Timestamp;
  expiresAt?: Timestamp;
}

interface AdditionalApprovalsAuthorizationRequirements {
  version: MpasVersion;
  type: "AuthorizationRequirements";
  actionEnvelopeHash: HashObject;
  result: "additionalApprovalsRequired";
  verifier: {
    did: Did;
  };
  approvalRequirements: ApprovalRequirements;
  policyRef?: string;
  createdAt?: Timestamp;
  expiresAt?: Timestamp;
}

export interface ExecutionReceipt {
  version: MpasVersion;
  type: "ExecutionReceipt";
  format: "jws";
  signature: string;
}

export type ReceiptResult =
  | "executed"
  | "rejected"
  | "failed"
  | "indeterminate"
  | "expired"
  | "cancelled"
  | "revoked";

export interface ReceiptPayload {
  issuerDid: Did;
  actionEnvelopeHash: HashObject;
  executionPayloadHash: HashObject;
  actionId?: ActionId;
  proposerDid?: Did;
  result: ReceiptResult;
  issuedAt: Timestamp;
  executionRef?: string;
}

// ---------------------------------------------------------------------------
// Coordination Protocol Types
// ---------------------------------------------------------------------------

export type ActionStatus = "pending" | "approved" | "rejected" | "executed" | "failed" | "expired" | "cancelled";

export type CoordinationState = "awaitingApprovals" | "readyForResubmission" | "cancelled" | "expired";

export interface ActionReference {
  version: MpasVersion;
  type: "ActionRef";
  actionId: ActionId;
  actionEnvelopeHash: HashObject;
}

export interface CoordinationActionResponse {
  version: MpasVersion;
  type: "CoordinationActionResponse";
  actionRef: ActionReference;
  state: CoordinationState;
  createdAt?: Timestamp;
}

export interface SignerReviewSet {
  version: MpasVersion;
  type: "SignerReviewSet";
  actionEnvelope: ActionEnvelope;
  executionPayload: ExecutionPayload;
  authorizationRequirements?: AuthorizationRequirements;
  createdAt?: Timestamp;
  expiresAt?: Timestamp;
}

export interface ApprovalRequest {
  version: MpasVersion;
  type: "ApprovalRequest";
  actionRef: ActionReference;
  signerReviewSet: SignerReviewSet;
  requestedDecision?: Decision;
}

export interface CoordinationProgress {
  required: number;
  collected: number;
  pending: Did[];
}

export interface CoordinationActionUpdate {
  version: MpasVersion;
  type: "CoordinationActionUpdate";
  actionRef: ActionReference;
  state: CoordinationState;
  progress?: CoordinationProgress;
  actionPackage?: ActionPackage;
  cancelledAt?: Timestamp;
}

export interface CoordinationPollResponse {
  version: MpasVersion;
  type: "CoordinationPollResponse";
  approvalRequests: ApprovalRequest[];
  actionUpdates: CoordinationActionUpdate[];
}

export interface CoordinationApprovalResponse {
  version: MpasVersion;
  type: "CoordinationApprovalSubmissionResponse";
  accepted: boolean;
  actionRef?: ActionReference;
  state?: CoordinationState;
  createdAt?: Timestamp;
}

export interface CoordinationCancelResponse {
  version: MpasVersion;
  type: "CoordinationActionCancelResponse";
  actionRef: ActionReference;
  state: "cancelled";
  cancelledAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Plugin Profile Types
// ---------------------------------------------------------------------------

export interface CredentialRequirement {
  type: string;
  requiredCapabilities?: string[];
  description?: string;
}

export interface PolicySuggestion {
  description?: string;
  impact?: string;
  match: JsonSchema;
  suggestedRequirement?: JsonSchema;
}

export interface MpasApplicationPlugin {
  version: MpasVersion;
  type: "MpasApplicationPlugin";
  pluginDid: Did;
  pluginVersion: string;
  publisherDid: Did;
  applicationDid: Did;
  executionProfile: {
    id: Did;
    format?: string;
  };
  credentialRequirements?: CredentialRequirement[];
  operations: Record<string, PluginOperationDescriptor>;
  policySuggestions?: PolicySuggestion[];
}

export interface PluginOperationDescriptor {
  description?: string;
  impact?: string;
  executionPayloadSchema: JsonSchema;
}

// ---------------------------------------------------------------------------
// HTTP Profile Types
// ---------------------------------------------------------------------------

export interface AdapterError {
  code: string;
  message: string;
}

/**
 * Non-authoritative, sanitized diagnostic metadata for an ActionResponse.
 * Execution profiles define interoperable values for `code`, `phase`, and
 * `transport`.
 */
export interface ActionDiagnostic {
  code: string;
  phase?: string;
  transport?: string;
  message?: string;
}

export interface ActionResponseContext {
  diagnostic?: ActionDiagnostic;
  [key: string]: unknown;
}

/**
 * ActionResponse — the HTTP profile's protocol response (Section 6.4). The Verifier
 * returns this for any submission it can parse far enough to compute the
 * actionEnvelopeHash. `result` is the projection of the Core Action Lifecycle.
 */
export interface ActionResponse {
  version: "1";
  type: "ActionResponse";
  verifier?: { did: Did };
  actionEnvelopeHash?: HashObject;
  result:
    | "executed"
    | "additionalApprovalsRequired"
    | "rejected"
    | "notSupported"
    | "malformed"
    | "policyUnavailable"
    | "pending"
    | "failed"
    | "indeterminate"
    | "expired"
    | "cancelled";
  authorizationRequirements?: AuthorizationRequirements;
  executionReceipt?: ExecutionReceipt;
  executionResult?: unknown;
  error?: AdapterError;
  context?: ActionResponseContext;
  actionRequestId?: string;
  pollAfter?: Timestamp;
  createdAt?: Timestamp;
}

/** Standard HTTP-profile error envelope (Section 4.8) returned for non-2xx responses. */
export interface MpasHttpError {
  version: "1";
  type: "MpasHttpError";
  requestId?: string;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Array<{ path?: string; reason?: string }>;
  };
}

/** The adapter's protocol response is the HTTP-profile ActionResponse. */
export type AdapterResponse = ActionResponse;

export interface PendingAction {
  actionId: string;
  actionEnvelopeHash: HashObject;
  operationName?: string;
  status: ActionStatus;
  createdAt?: Timestamp;
  expiresAt?: Timestamp;
}
