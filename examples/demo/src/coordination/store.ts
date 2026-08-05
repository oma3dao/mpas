import type {
  ActionPackage,
  Approval,
  ApprovalRequirements,
  CanonicalApprovalPayload,
  Decision,
  Did,
  Hash,
  ThresholdRequirement,
} from "../core/types.js";
import { computeJsonHash } from "../core/verification.js";
import type {
  ActionRef,
  ActionUpdate,
  ApprovalRequest,
  CoordinationActionRequest,
  CoordinationActionResponse,
  CoordinationApprovalSubmission,
  CoordinationApprovalSubmissionResponse,
  CoordinationActionCancelRequest,
  CoordinationActionCancelResponse,
  CoordinationPollResponse,
  CoordinationProgress,
  CoordinationState,
  SignerReviewSet,
} from "./types.js";

export class CoordinationStoreError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoordinationStoreError";
  }
}

interface StoredApproval {
  approval: Approval;
  signerDid?: Did;
  decision: Decision;
}

interface StoredAction {
  actionPackage: ActionPackage;
  authorizationRequirements: CoordinationActionRequest["authorizationRequirements"];
  actionRef: ActionRef;
  state: CoordinationState;
  approvals: StoredApproval[];
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
}

export interface SubmitActionResult {
  response: CoordinationActionResponse;
  created: boolean;
}

export class CoordinationStore {
  private readonly actionsById = new Map<string, StoredAction>();
  private readonly actionsByEnvelopeHash = new Map<string, StoredAction>();

  submitAction(request: CoordinationActionRequest): SubmitActionResult {
    const actionEnvelopeHash = computeJsonHash(request.actionPackage.actionEnvelope);
    const existingById = this.actionsById.get(request.actionPackage.actionEnvelope.actionId.value);
    if (existingById && existingById.actionRef.actionEnvelopeHash.value !== actionEnvelopeHash.value) {
      throw new CoordinationStoreError(409, "ACTION_ID_CONFLICT", "Action ID already exists with a different envelope hash.");
    }

    const existingByHash = this.actionsByEnvelopeHash.get(actionEnvelopeHash.value);
    if (existingByHash) {
      this.expireIfNeeded(existingByHash);
      return {
        response: {
          version: "1",
          type: "CoordinationActionResponse",
          actionRef: existingByHash.actionRef,
          state: existingByHash.state,
          createdAt: existingByHash.createdAt,
        },
        created: false,
      };
    }

    const actionRef = buildActionRef(request.actionPackage, actionEnvelopeHash);
    const now = new Date().toISOString();
    const stored: StoredAction = {
      actionPackage: request.actionPackage,
      authorizationRequirements: request.authorizationRequirements,
      actionRef,
      state: "awaitingApprovals",
      approvals: [],
      createdAt: now,
      updatedAt: now,
    };
    this.actionsById.set(actionRef.actionId.value, stored);
    this.actionsByEnvelopeHash.set(actionRef.actionEnvelopeHash.value, stored);

    return {
      response: {
        version: "1",
        type: "CoordinationActionResponse",
        actionRef,
        state: stored.state,
        createdAt: now,
      },
      created: true,
    };
  }

  submitApproval(request: CoordinationApprovalSubmission): CoordinationApprovalSubmissionResponse {
    const stored = this.actionsByEnvelopeHash.get(request.actionEnvelopeHash.value);
    if (!stored) {
      throw new CoordinationStoreError(404, "ACTION_NOT_FOUND", "Pending action was not found.");
    }

    // Lazily transition expired actions before processing (spec §6.1). Expired actions
    // are rejected with 404, matching post-cancellation behavior.
    this.expireIfNeeded(stored);
    if (stored.state === "cancelled" || stored.state === "expired") {
      throw new CoordinationStoreError(404, "ACTION_NOT_FOUND", "Pending action was not found.");
    }

    if (request.approval.actionEnvelopeHash.value !== stored.actionRef.actionEnvelopeHash.value) {
      throw new CoordinationStoreError(400, "APPROVAL_HASH_MISMATCH", "Approval is bound to a different action envelope.");
    }

    const payload = decodeApprovalPayload(request.approval);
    if (payload?.actionEnvelopeHash.value !== stored.actionRef.actionEnvelopeHash.value) {
      throw new CoordinationStoreError(400, "APPROVAL_HASH_MISMATCH", "Signed approval payload is bound to a different action envelope.");
    }

    if (!payload?.signerDid) {
      throw new CoordinationStoreError(400, "APPROVAL_SIGNER_MISSING", "Signed approval payload does not include signerDid.");
    }

    // Self-approval prevention: the proposer of an action cannot approve their own action.
    if (payload.signerDid === stored.actionPackage.actionEnvelope.proposer.did) {
      throw new CoordinationStoreError(403, "SELF_APPROVAL_DENIED", "The proposer of an action cannot approve their own action.");
    }

    const existing = stored.approvals.some(
      (entry) => entry.signerDid === payload.signerDid && entry.decision === payload.decision,
    );
    if (!existing) {
      stored.approvals.push({
        approval: request.approval,
        signerDid: payload.signerDid,
        decision: payload.decision,
      });
      stored.updatedAt = new Date().toISOString();
    }

    if (stored.state === "awaitingApprovals" && isReady(stored.authorizationRequirements.approvalRequirements, stored.approvals)) {
      stored.state = "readyForResubmission";
      stored.updatedAt = new Date().toISOString();
    }

    return {
      version: "1",
      type: "CoordinationApprovalSubmissionResponse",
      accepted: true,
      actionRef: stored.actionRef,
      state: stored.state,
      createdAt: new Date().toISOString(),
    };
  }

  poll(did: Did): CoordinationPollResponse {
    const approvalRequests: ApprovalRequest[] = [];
    const actionUpdates: ActionUpdate[] = [];

    for (const stored of this.actionsById.values()) {
      this.expireIfNeeded(stored);

      if (stored.state === "awaitingApprovals") {
        const request = this.approvalRequestFor(stored, did);
        if (request) {
          approvalRequests.push(request);
        }
      }

      if (stored.actionPackage.actionEnvelope.proposer.did === did) {
        actionUpdates.push(buildActionUpdate(stored));
      }
    }

    return {
      version: "1",
      type: "CoordinationPollResponse",
      approvalRequests,
      actionUpdates,
    };
  }

  cancelAction(request: CoordinationActionCancelRequest): CoordinationActionCancelResponse {
    const stored = this.actionsById.get(request.actionId.value);
    if (!stored || stored.state === "cancelled") {
      throw new CoordinationStoreError(404, "ACTION_NOT_FOUND", "Pending action was not found.");
    }

    if (stored.actionPackage.actionEnvelope.proposer.did !== request.proposerDid) {
      throw new CoordinationStoreError(403, "NOT_PROPOSER", "Only the original proposer can cancel this action.");
    }

    this.expireIfNeeded(stored);
    if (stored.state === "expired") {
      throw new CoordinationStoreError(409, "ACTION_EXPIRED", "Action has expired and can no longer be cancelled.");
    }

    if (stored.state === "readyForResubmission") {
      throw new CoordinationStoreError(409, "ACTION_READY", "Action is already ready for resubmission.");
    }

    const now = new Date().toISOString();
    stored.state = "cancelled";
    stored.cancelledAt = now;
    stored.updatedAt = now;

    return {
      version: "1",
      type: "CoordinationActionCancelResponse",
      actionRef: stored.actionRef,
      state: "cancelled",
      cancelledAt: now,
    };
  }

  private expireIfNeeded(stored: StoredAction, now = Date.now()): void {
    if (stored.state === "cancelled" || stored.state === "expired") {
      return;
    }

    const expiresAt = Date.parse(stored.actionPackage.actionEnvelope.expiresAt);
    if (!Number.isNaN(expiresAt) && expiresAt <= now) {
      stored.state = "expired";
      stored.updatedAt = new Date(now).toISOString();
    }
  }

  private approvalRequestFor(stored: StoredAction, did: Did): ApprovalRequest | undefined {
    const requirement = thresholdsFor(stored.authorizationRequirements.approvalRequirements).find((threshold) =>
      threshold.eligibleSigners.includes(did),
    );
    if (!requirement) {
      return undefined;
    }

    const decision = requirement.decision ?? "approve";
    const alreadyResponded = stored.approvals.some((entry) => entry.signerDid === did && entry.decision === decision);
    if (alreadyResponded) {
      return undefined;
    }

    const signerReviewSet: SignerReviewSet = {
      version: "1",
      type: "SignerReviewSet",
      actionEnvelope: stored.actionPackage.actionEnvelope,
      executionPayload: stored.actionPackage.executionPayload,
      authorizationRequirements: stored.authorizationRequirements,
    };

    return {
      version: "1",
      type: "ApprovalRequest",
      actionRef: stored.actionRef,
      signerReviewSet,
      requestedDecision: decision,
    };
  }
}

function buildActionRef(actionPackage: ActionPackage, actionEnvelopeHash: Hash): ActionRef {
  return {
    version: "1",
    type: "ActionRef",
    actionId: actionPackage.actionEnvelope.actionId,
    actionEnvelopeHash,
  };
}

function buildActionUpdate(stored: StoredAction): ActionUpdate {
  const update: ActionUpdate = {
    version: "1",
    type: "CoordinationActionUpdate",
    actionRef: stored.actionRef,
    state: stored.state,
    expiresAt: stored.actionPackage.actionEnvelope.expiresAt,
  };

  if (stored.state === "cancelled") {
    update.cancelledAt = stored.cancelledAt;
    return update;
  }

  if (stored.state === "expired") {
    return update;
  }

  update.progress = progressFor(stored.authorizationRequirements.approvalRequirements, stored.approvals);
  if (stored.state === "readyForResubmission") {
    update.actionPackage = buildCompletedActionPackage(stored);
  }

  return update;
}

function buildCompletedActionPackage(stored: StoredAction): ActionPackage {
  const existingSignatures = new Set(stored.actionPackage.approvalBundle.approvals.map((approval) => approval.signature.value));
  const collectedApprovals = stored.approvals
    .map((entry) => entry.approval)
    .filter((approval) => !existingSignatures.has(approval.signature.value));

  return {
    ...stored.actionPackage,
    approvalBundle: {
      ...stored.actionPackage.approvalBundle,
      actionEnvelopeHash: stored.actionRef.actionEnvelopeHash,
      approvals: [...stored.actionPackage.approvalBundle.approvals, ...collectedApprovals],
      createdAt: new Date().toISOString(),
    },
  };
}

function isReady(requirements: ApprovalRequirements, approvals: StoredApproval[]): boolean {
  const anyOf = requirements.anyOf ?? [];
  const allOf = requirements.allOf ?? [];
  const anyOfSatisfied = anyOf.length === 0 || anyOf.some((threshold) => isThresholdSatisfied(threshold, approvals));
  const allOfSatisfied = allOf.every((threshold) => isThresholdSatisfied(threshold, approvals));
  return anyOfSatisfied && allOfSatisfied;
}

function progressFor(requirements: ApprovalRequirements, approvals: StoredApproval[]): CoordinationProgress {
  const thresholds = thresholdsFor(requirements);
  const threshold = thresholds.find((candidate) => !isThresholdSatisfied(candidate, approvals)) ?? thresholds[0];
  if (!threshold) {
    return {
      required: 0,
      collected: 0,
      pending: [],
    };
  }

  const decision = threshold.decision ?? "approve";
  const approved = approvedSignersFor(threshold, decision, approvals);
  return {
    required: threshold.threshold,
    collected: Math.min(approved.size, threshold.threshold),
    pending: threshold.eligibleSigners.filter((did) => !approved.has(did)),
  };
}

function isThresholdSatisfied(threshold: ThresholdRequirement, approvals: StoredApproval[]): boolean {
  return approvedSignersFor(threshold, threshold.decision ?? "approve", approvals).size >= threshold.threshold;
}

function approvedSignersFor(threshold: ThresholdRequirement, decision: Decision, approvals: StoredApproval[]): Set<Did> {
  const eligible = new Set(threshold.eligibleSigners);
  return new Set(
    approvals
      .filter((entry) => entry.signerDid && eligible.has(entry.signerDid) && entry.decision === decision)
      .map((entry) => entry.signerDid as Did),
  );
}

function thresholdsFor(requirements: ApprovalRequirements): ThresholdRequirement[] {
  return [...(requirements.anyOf ?? []), ...(requirements.allOf ?? [])];
}

function decodeApprovalPayload(approval: Approval): CanonicalApprovalPayload | undefined {
  const parts = approval.signature.value.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as CanonicalApprovalPayload;
  } catch {
    return undefined;
  }
}
