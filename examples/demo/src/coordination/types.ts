import type {
  ActionEnvelope,
  ActionId,
  ActionPackage,
  ActionRequest,
  ActionResponse,
  Approval,
  AuthorizationRequirements,
  Did,
  Hash,
  DeliveryEnvelope,
} from "../core/types.js";

export type AdditionalApprovalRequirements = Extract<
  AuthorizationRequirements,
  { result: "additionalApprovalsRequired" }
>;

export type CoordinationState = "awaitingApprovals" | "readyForResubmission" | "rejected" | "cancelled" | "expired";

export interface ActionRef {
  version: "1";
  type: "ActionRef";
  actionId: ActionId;
  actionEnvelopeHash: Hash;
}

export interface SignerReviewSet {
  version: "1";
  type: "SignerReviewSet";
  actionEnvelope: ActionEnvelope;
  executionPayload: ActionPackage["executionPayload"];
  authorizationRequirements: AuthorizationRequirements;
  createdAt?: string;
  expiresAt?: string;
}

export interface ApprovalRequest {
  version: "1";
  type: "ApprovalRequest";
  actionRef: ActionRef;
  signerReviewSet: SignerReviewSet;
  requestedDecision?: string;
}

export interface CoordinationProgress {
  required: number;
  collected: number;
  pending: Did[];
}

export interface ActionUpdate {
  version: "1";
  type: "CoordinationActionUpdate";
  actionRef: ActionRef;
  state: CoordinationState;
  expiresAt: string;
  progress?: CoordinationProgress;
  actionPackage?: ActionPackage;
  cancelledAt?: string;
  rejectedAt?: string;
}

/** Workflow-creation request using the established version 1 wire discriminant. */
export interface CoordinationActionRequest {
  version: "1";
  type: "CoordinationActionRequest";
  actionPackage: ActionPackage;
  authorizationRequirements: AdditionalApprovalRequirements;
  idempotencyKey?: string;
  audience?: string;
}

/** Workflow-creation response using the established version 1 wire discriminant. */
export interface CoordinationActionResponse {
  version: "1";
  type: "CoordinationActionResponse";
  actionRef: ActionRef;
  state: CoordinationState;
  createdAt: string;
}

export interface CoordinationPollRequest {
  version: "1";
  type: "CoordinationPollRequest";
  did: Did;
  audience?: string;
  cursor?: string;
}

export interface CoordinationPollResponse {
  version: "1";
  type: "CoordinationPollResponse";
  approvalRequests: ApprovalRequest[];
  actionUpdates: ActionUpdate[];
  deliveries?: DeliveryEnvelope[];
  nextCursor?: string;
}

export interface CoordinationApprovalSubmission {
  version: "1";
  type: "CoordinationApprovalSubmission";
  actionEnvelopeHash: Hash;
  approval: Approval;
  idempotencyKey?: string;
  audience?: string;
}

export interface CoordinationApprovalSubmissionResponse {
  version: "1";
  type: "CoordinationApprovalSubmissionResponse";
  accepted: boolean;
  actionRef: ActionRef;
  state: CoordinationState;
  createdAt: string;
}

export interface CoordinationActionCancelRequest {
  version: "1";
  type: "CoordinationActionCancelRequest";
  actionId: ActionId;
  proposerDid: Did;
  idempotencyKey?: string;
  audience?: string;
}

export interface CoordinationActionCancelResponse {
  version: "1";
  type: "CoordinationActionCancelResponse";
  actionRef: ActionRef;
  state: "cancelled";
  cancelledAt: string;
}

export interface CoordinationHealthResponse {
  status: "ok";
  service: "mpas-local-coordination";
}

export type RoutedActionRequest = DeliveryEnvelope<ActionRequest>;
export type RoutedActionResponse = DeliveryEnvelope<ActionResponse>;
