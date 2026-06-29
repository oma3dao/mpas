export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type MpasVersion = "1";
export type Did = `did:${string}:${string}`;
export type Timestamp = string;

export type HashAlgorithm =
  | "sha-256"
  | "sha-384"
  | "sha-512"
  | "sha3-256"
  | "sha3-384"
  | "sha3-512";

export interface Hash {
  alg: HashAlgorithm;
  value: string;
}

export interface ActionId {
  value: string;
  scope?: string;
}

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
  executionPayloadHash: Hash;
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
  actionEnvelopeHash: Hash;
  decision: Decision;
  signature: SignatureObject;
  createdAt: Timestamp;
  expiresAt?: Timestamp;
}

export interface CanonicalApprovalPayload {
  type: "ApprovalPayload";
  actionEnvelopeHash: Hash;
  decision: Decision;
  signerDid?: Did;
  createdAt: Timestamp;
  expiresAt?: Timestamp;
}

export interface ApprovalBundle {
  version: MpasVersion;
  type: "ApprovalBundle";
  actionEnvelopeHash: Hash;
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
  actionEnvelopeHash: Hash;
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
  actionEnvelopeHash: Hash;
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
  actionEnvelopeHash: Hash;
  executionPayloadHash: Hash;
  actionId?: ActionId;
  proposerDid?: Did;
  result: ReceiptResult;
  issuedAt: Timestamp;
  executionRef?: string;
}
