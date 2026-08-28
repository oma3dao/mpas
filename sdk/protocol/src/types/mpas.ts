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

export interface BaseAuthorizationRequirements {
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

export interface AdditionalApprovalsAuthorizationRequirements {
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

export type CoordinationState =
  | "awaitingApprovals"
  | "readyForResubmission"
  | "executed"
  | "rejected"
  | "cancelled"
  | "expired";

export interface ActionReference {
  version: MpasVersion;
  type: "ActionRef";
  actionId: ActionId;
  actionEnvelopeHash: HashObject;
}

/** Workflow-creation response; the historical version 1 discriminant is retained. */
export interface CoordinationActionResponse {
  version: MpasVersion;
  type: "CoordinationActionResponse";
  actionRef: ActionReference;
  state: CoordinationState;
  createdAt?: Timestamp;
}

/** Workflow-creation request; the historical version 1 discriminant is retained. */
export interface CoordinationActionRequest {
  version: MpasVersion;
  type: "CoordinationActionRequest";
  actionPackage: ActionPackage;
  authorizationRequirements?: AuthorizationRequirements;
  /** Body-level mutation idempotency key. */
  idempotencyKey?: string;
  /** Signed-request audience added by the HTTP client. */
  audience?: string;
  context?: JsonObject;
}

export interface CoordinationPollRequest {
  version: MpasVersion;
  type: "CoordinationPollRequest";
  did: Did;
  /** Signed-request audience added by the HTTP client. */
  audience?: string;
  /** Optional continuation cursor from a previous poll response. */
  cursor?: string;
}

export interface CoordinationApprovalSubmission {
  version: MpasVersion;
  type: "CoordinationApprovalSubmission";
  actionEnvelopeHash: HashObject;
  approval: Approval;
  /** Body-level mutation idempotency key. */
  idempotencyKey?: string;
  /** Signed-request audience added by the HTTP client. */
  audience?: string;
}

export interface CoordinationActionCancelRequest {
  version: MpasVersion;
  type: "CoordinationActionCancelRequest";
  actionId: ActionId;
  proposerDid: Did;
  /** Body-level mutation idempotency key. */
  idempotencyKey?: string;
  /** Signed-request audience added by the HTTP client. */
  audience?: string;
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
  /** The authoritative deadline copied from ActionEnvelope.expiresAt. */
  expiresAt: Timestamp;
  progress?: CoordinationProgress;
  actionPackage?: ActionPackage;
  cancelledAt?: Timestamp;
  rejectedAt?: Timestamp;
}

export interface CoordinationPollResponse {
  version: MpasVersion;
  type: "CoordinationPollResponse";
  approvalRequests: ApprovalRequest[];
  actionUpdates: CoordinationActionUpdate[];
  /** Complete envelopes independently addressed to the authenticated poll DID. */
  deliveries?: DeliveryEnvelope[];
  /** Delivery-position checkpoint to persist only after the current page is accepted. */
  nextCursor?: string;
}

/**
 * Transport-layer routing metadata around an MPAS message or JSON payload.
 *
 * Recipient membership grants delivery only; it does not assign an MPAS role or
 * replace verification of the enclosed payload.
 */
export interface DeliveryEnvelope<TPayload = JsonValue> {
  version: MpasVersion;
  type: "DeliveryEnvelope";
  /** DID whose provenance is recorded by this envelope. */
  sender: Did;
  /** Non-empty, unique DIDs with independent retrieval obligations. */
  recipients: Did[];
  /** MPAS Core §5 timestamp with millisecond precision and a `Z` suffix. */
  createdAt: Timestamp;
  /** Optional Core §5 retrieval deadline later than `createdAt`. */
  expiresAt?: Timestamp;
  /** Receiving service origin when this envelope is an RFC 9421-signed request body. */
  audience?: string;
  /** Payload interpreted only after the routing layer is removed. */
  payload: TPayload;
}

/** Durable-acceptance acknowledgement for a Verifier response delivery. */
export interface CoordinationDeliveryResponse {
  version: MpasVersion;
  type: "CoordinationDeliveryResponse";
  accepted: true;
  createdAt?: Timestamp;
}

/** Signed request for a one-use notification WebSocket ticket. */
export interface CoordinationSessionRequest {
  version: MpasVersion;
  type: "CoordinationSessionRequest";
  did: Did;
  audience?: string;
}

/** Connection parameters for one notification WebSocket upgrade. */
export interface CoordinationSessionResponse {
  version: MpasVersion;
  type: "CoordinationSessionResponse";
  /** Exact URL to use for the WebSocket upgrade. */
  websocketUrl: string;
  /** Opaque, DID-bound ticket presented in the upgrade Authorization header. */
  ticket: string;
  /** Ticket expiration; the ticket is invalid after one use even before this time. */
  expiresAt: Timestamp;
}

/** Payload-free signal that instructs the participant to perform a signed poll. */
export interface CoordinationWorkAvailable {
  version: MpasVersion;
  type: "CoordinationWorkAvailable";
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
  /**
   * Provider-specific OAuth refresh scope. Defaults to `offline_access` when
   * omitted. This is not a permission scope and MUST NOT be copied from
   * `requiredCapabilities`.
   */
  refreshScope?: string;
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
    protocolVersion: string;
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

/** HTTP request wrapper for an MPAS Action Package. */
export interface ActionRequest {
  version: MpasVersion;
  type: "ActionRequest";
  actionPackage: ActionPackage;
  /** Action-processing idempotency key retained inside a Delivery Envelope. */
  idempotencyKey?: string;
  /** Signed-request audience when this is the outer body of a bare direct request. */
  audience?: string;
  /** Non-authoritative request metadata. */
  context?: JsonObject;
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
