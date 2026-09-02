import type {
  ActionRequest,
  ActionResponse,
  ActionPackage,
  Approval,
  ApprovalRequirements,
  AuthorizationRequirements,
  CanonicalApprovalPayload,
  RelayDeliveryResponse,
  RelayPollResponse,
  Decision,
  Did,
  DeliveryEnvelope,
  Hash,
  ThresholdRequirement,
} from "../core/types.js";
import { computeIdempotencyFingerprint, evaluateApprovalRequirements } from "@oma3/mpas";
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

export class MpasServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MpasServiceError";
  }
}

interface StoredApproval {
  approval: Approval;
  signerDid: Did;
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
  rejectedAt?: string;
}

interface StoredRelayedAction {
  envelope: DeliveryEnvelope<ActionRequest>;
  actionRef: ActionRef;
  verifierDid: Did;
  createdAt: string;
  response?: ActionResponse;
  result: Promise<ActionResponse>;
  resolve: (response: ActionResponse) => void;
}

interface StoredDelivery {
  sequence: number;
  recipient: Did;
  envelope: DeliveryEnvelope;
}

export interface RoutingAuditEntry {
  purpose: "initialAction" | "actionResponse";
  sender: Did;
  recipients: Did[];
  designatedVerifierDid: Did;
  payloadHash: Hash;
  createdAt: string;
}

export interface CreateWorkflowResult {
  response: CoordinationActionResponse;
  created: boolean;
}

const DELIVERY_PAGE_SIZE = 100;
const IDEMPOTENCY_CACHE_TTL_MS = 15 * 60_000;

export class CoordinationStore {
  private readonly actionsById = new Map<string, StoredAction>();
  private readonly actionsByEnvelopeHash = new Map<string, StoredAction>();
  private readonly relayedActionsById = new Map<string, StoredRelayedAction>();
  private readonly relayedActionsByEnvelopeHash = new Map<string, StoredRelayedAction>();
  private readonly deliveries: StoredDelivery[] = [];
  private readonly routingAuditEntries: RoutingAuditEntry[] = [];
  // Demo-scope cache only. Production services need durable idempotency records
  // with an operator-defined retention policy and atomic claim semantics.
  private readonly idempotency = new Map<string, {
    fingerprint: string;
    result: Promise<unknown>;
    expiresAt: number;
  }>();
  private nextDeliverySequence = 1;

  runIdempotent<T>(
    service: "relay" | "coordination",
    did: Did,
    key: string | undefined,
    request: unknown,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    if (!key) return Promise.resolve().then(operation);
    const now = Date.now();
    for (const [cachedScope, entry] of this.idempotency) {
      if (entry.expiresAt <= now) this.idempotency.delete(cachedScope);
    }
    const scope = `${service}\0${did}\0${key}`;
    const fingerprint = computeIdempotencyFingerprint(request);
    const existing = this.idempotency.get(scope);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new MpasServiceError(409, "idempotency_conflict", "Idempotency key was reused with a different request.");
      }
      return existing.result as Promise<T>;
    }
    const result = Promise.resolve().then(operation);
    this.idempotency.set(scope, { fingerprint, result, expiresAt: now + IDEMPOTENCY_CACHE_TTL_MS });
    void result.catch(() => this.idempotency.delete(scope));
    return result;
  }

  beginRelayedAction(envelope: DeliveryEnvelope<ActionRequest>, verifierDid: Did): {
    created: boolean;
    response: Promise<ActionResponse>;
  } {
    this.validateRelayedAction(envelope, verifierDid);
    const hash = computeJsonHash(envelope.payload.actionPackage.actionEnvelope);
    const existing = this.relayedActionsByEnvelopeHash.get(hash.value);
    if (existing) return { created: false, response: existing.result };

    let resolve!: (response: ActionResponse) => void;
    const result = new Promise<ActionResponse>((resolved) => { resolve = resolved; });
    const actionRef = buildActionRef(envelope.payload.actionPackage, hash);
    const stored: StoredRelayedAction = {
      envelope,
      actionRef,
      verifierDid,
      createdAt: new Date().toISOString(),
      result,
      resolve,
    };
    this.relayedActionsById.set(actionRef.actionId.value, stored);
    this.relayedActionsByEnvelopeHash.set(hash.value, stored);
    this.storeEnvelope(envelope);
    this.recordRoutingAudit("initialAction", envelope, verifierDid);
    return { created: true, response: result };
  }

  validateRelayedAction(envelope: DeliveryEnvelope<ActionRequest>, verifierDid: Did): void {
    validateActionPackageBindings(envelope.payload.actionPackage);
    const hash = computeJsonHash(envelope.payload.actionPackage.actionEnvelope);
    const actionId = envelope.payload.actionPackage.actionEnvelope.actionId.value;
    const existing = this.relayedActionsById.get(actionId);
    if (existing && existing.actionRef.actionEnvelopeHash.value !== hash.value) {
      throw new MpasServiceError(409, "ACTION_ID_CONFLICT", "Action ID already exists with a different envelope hash.");
    }
    if (!envelope.recipients.includes(verifierDid)) {
      throw new MpasServiceError(400, "INVALID_REQUEST", "Configured Verifier DID is not an envelope recipient.");
    }
  }

  validateResponseDelivery(
    envelope: DeliveryEnvelope<ActionResponse>,
    administrativelyAuthorizedRecipients: Iterable<Did> = [],
  ): void {
    this.responseDeliveryTarget(envelope, administrativelyAuthorizedRecipients);
  }

  submitResponseDelivery(
    envelope: DeliveryEnvelope<ActionResponse>,
    administrativelyAuthorizedRecipients: Iterable<Did> = [],
  ): RelayDeliveryResponse {
    const stored = this.responseDeliveryTarget(envelope, administrativelyAuthorizedRecipients);

    this.storeEnvelope(envelope);
    this.recordRoutingAudit("actionResponse", envelope, stored.verifierDid);
    if (!stored.response) {
      stored.response = envelope.payload;
      stored.resolve(envelope.payload);
    }
    return {
      version: "1",
      type: "RelayDeliveryResponse",
      accepted: true,
      createdAt: new Date().toISOString(),
    };
  }

  private responseDeliveryTarget(
    envelope: DeliveryEnvelope<ActionResponse>,
    administrativelyAuthorizedRecipients: Iterable<Did>,
  ): StoredRelayedAction {
    const responseHash = envelope.payload.actionEnvelopeHash;
    const stored = responseHash ? this.relayedActionsByEnvelopeHash.get(responseHash.value) : undefined;
    if (!stored) throw new MpasServiceError(404, "ACTION_NOT_FOUND", "Relayed action was not found.");
    if (responseHash?.alg !== stored.actionRef.actionEnvelopeHash.alg) {
      throw new MpasServiceError(400, "ACTION_HASH_MISMATCH", "Action Response hash algorithm does not match the relayed Action.");
    }
    if (envelope.sender !== stored.verifierDid || envelope.payload.verifier?.did !== stored.verifierDid) {
      throw new MpasServiceError(403, "permission_denied", "Response sender is not the relayed Action's designated Verifier.");
    }
    if (!envelope.recipients.includes(stored.envelope.payload.actionPackage.actionEnvelope.proposer.did)) {
      throw new MpasServiceError(400, "INVALID_REQUEST", "Response envelope must address the Action Proposer.");
    }
    const requirements = envelope.payload.authorizationRequirements;
    if (envelope.payload.result === "additionalApprovalsRequired" && !requirements) {
      throw new MpasServiceError(
        400,
        "INVALID_REQUEST",
        "additionalApprovalsRequired response must include Authorization Requirements.",
      );
    }
    if (envelope.payload.result !== "additionalApprovalsRequired" && requirements) {
      throw new MpasServiceError(
        400,
        "INVALID_REQUEST",
        "Authorization Requirements are valid only with additionalApprovalsRequired.",
      );
    }
    if (requirements) {
      validateAuthorizationRequirements(requirements, stored.actionRef.actionEnvelopeHash, stored.verifierDid);
    }

    const authorizedRecipients = new Set<Did>([
      stored.envelope.payload.actionPackage.actionEnvelope.proposer.did,
      ...administrativelyAuthorizedRecipients,
    ]);
    if (envelope.recipients.some((did) => !authorizedRecipients.has(did))) {
      throw new MpasServiceError(403, "permission_denied", "Response envelope contains an unauthorized recipient.");
    }

    return stored;
  }

  createWorkflow(request: CoordinationActionRequest): CreateWorkflowResult {
    this.validateCreateWorkflow(request);
    const actionEnvelopeHash = computeJsonHash(request.actionPackage.actionEnvelope);
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
    const { stored, payload, duplicate } = this.approvalPreflight(request);

    if (!duplicate) {
      stored.approvals.push({
        approval: request.approval,
        signerDid: payload.signerDid,
        decision: payload.decision,
      });
      stored.updatedAt = new Date().toISOString();
    }

    if (stored.state === "awaitingApprovals") {
      const status = evaluateApprovalRequirements(stored.authorizationRequirements.approvalRequirements, stored.approvals);
      if (status === "satisfied") {
        stored.state = "readyForSubmission";
        stored.updatedAt = new Date().toISOString();
      } else if (status === "unreachable") {
        stored.state = "rejected";
        stored.rejectedAt = new Date().toISOString();
        stored.updatedAt = stored.rejectedAt;
      }
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

  pollDeliveries(did: Did, cursor?: string): RelayPollResponse {
    const after = parseCursor(cursor);
    const deliveries = this.deliveries
      .filter((entry) => entry.sequence > after)
      .filter((entry) => entry.recipient === did)
      .filter((entry) => entry.envelope.expiresAt === undefined || Date.parse(entry.envelope.expiresAt) > Date.now())
      .slice(0, DELIVERY_PAGE_SIZE);
    const nextCursor = deliveries.length > 0 ? String(deliveries.at(-1)!.sequence) : undefined;
    return {
      version: "1",
      type: "RelayPollResponse",
      deliveries: deliveries.map((entry) => entry.envelope),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  cancelAction(request: CoordinationActionCancelRequest): CoordinationActionCancelResponse {
    this.validateCancelAction(request);
    const stored = this.actionsById.get(request.actionId.value);
    if (!stored) {
      throw new MpasServiceError(404, "ACTION_NOT_FOUND", "Pending action was not found.");
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

  validateCreateWorkflow(request: CoordinationActionRequest): void {
    validateActionPackageBindings(request.actionPackage);
    const actionEnvelopeHash = computeJsonHash(request.actionPackage.actionEnvelope);
    validateAuthorizationRequirements(request.authorizationRequirements, actionEnvelopeHash);
    const actionId = request.actionPackage.actionEnvelope.actionId.value;
    const existingById = this.actionsById.get(actionId);
    if (existingById && existingById.actionRef.actionEnvelopeHash.value !== actionEnvelopeHash.value) {
      throw new MpasServiceError(409, "ACTION_ID_CONFLICT", "Action ID already exists with a different envelope hash.");
    }
  }

  validateSubmitApproval(request: CoordinationApprovalSubmission): void {
    this.approvalPreflight(request);
  }

  validateCancelAction(request: CoordinationActionCancelRequest): void {
    const stored = this.actionsById.get(request.actionId.value);
    if (!stored || stored.state === "cancelled") {
      throw new MpasServiceError(404, "ACTION_NOT_FOUND", "Pending action was not found.");
    }

    if (stored.actionPackage.actionEnvelope.proposer.did !== request.proposerDid) {
      throw new MpasServiceError(403, "NOT_PROPOSER", "Only the original proposer can cancel this action.");
    }

    if (this.effectiveState(stored) === "expired") {
      throw new MpasServiceError(409, "ACTION_EXPIRED", "Action has expired and can no longer be cancelled.");
    }

    if (stored.state === "readyForSubmission") {
      throw new MpasServiceError(409, "ACTION_READY", "Action is already ready for resubmission.");
    }
    if (stored.state === "rejected") {
      throw new MpasServiceError(409, "ACTION_REJECTED", "Action approval requirements are already unreachable.");
    }
  }

  proposerForAction(actionId: string): Did | undefined {
    return this.actionsById.get(actionId)?.actionPackage.actionEnvelope.proposer.did;
  }

  hasActionEnvelopeHash(actionEnvelopeHash: string): boolean {
    return this.actionsByEnvelopeHash.has(actionEnvelopeHash);
  }

  isEligibleSigner(actionEnvelopeHash: string, did: Did): boolean {
    const stored = this.actionsByEnvelopeHash.get(actionEnvelopeHash);
    return stored
      ? thresholdsFor(stored.authorizationRequirements.approvalRequirements).some((threshold) =>
          threshold.eligibleSigners.includes(did),
        ) || (stored.authorizationRequirements.approvalRequirements.overrideSigners ?? []).some((entry) => entry.signer === did)
      : false;
  }

  participantsForActionHash(actionEnvelopeHash: string): Did[] {
    const stored = this.actionsByEnvelopeHash.get(actionEnvelopeHash);
    if (!stored) return [];
    return [...new Set<Did>([
      stored.actionPackage.actionEnvelope.proposer.did,
      stored.authorizationRequirements.verifier.did,
      ...thresholdsFor(stored.authorizationRequirements.approvalRequirements).flatMap((threshold) => threshold.eligibleSigners),
      ...(stored.authorizationRequirements.approvalRequirements.overrideSigners ?? []).map((entry) => entry.signer),
    ])];
  }

  hasOutstandingCoordinationWork(did: Did): boolean {
    for (const stored of this.actionsById.values()) {
      this.expireIfNeeded(stored);
      if (stored.state === "awaitingApprovals" && this.approvalRequestFor(stored, did)) return true;
      // Action updates have no acknowledgement cursor in v1, so even a terminal
      // proposer update remains pollable and must not be hidden on reconnect.
      if (stored.actionPackage.actionEnvelope.proposer.did === did) return true;
    }
    return false;
  }

  hasOutstandingRelayWork(did: Did): boolean {
    return this.deliveries.some((entry) =>
      entry.recipient === did &&
      (entry.envelope.expiresAt === undefined || Date.parse(entry.envelope.expiresAt) > Date.now()));
  }

  routingAudit(): RoutingAuditEntry[] {
    return structuredClone(this.routingAuditEntries);
  }

  private storeEnvelope(envelope: DeliveryEnvelope<unknown>): void {
    for (const recipient of envelope.recipients) {
      this.deliveries.push({
        sequence: this.nextDeliverySequence++,
        recipient,
        envelope: structuredClone(envelope) as DeliveryEnvelope,
      });
    }
  }

  private recordRoutingAudit(
    purpose: RoutingAuditEntry["purpose"],
    envelope: DeliveryEnvelope<unknown>,
    designatedVerifierDid: Did,
  ): void {
    this.routingAuditEntries.push({
      purpose,
      sender: envelope.sender,
      recipients: [...envelope.recipients],
      designatedVerifierDid,
      payloadHash: computeJsonHash(envelope.payload),
      createdAt: new Date().toISOString(),
    });
  }

  private expireIfNeeded(stored: StoredAction, now = Date.now()): void {
    if (stored.state === "cancelled" || stored.state === "expired" || stored.state === "rejected") {
      return;
    }

    const expiresAt = Date.parse(stored.actionPackage.actionEnvelope.expiresAt);
    if (!Number.isNaN(expiresAt) && expiresAt <= now) {
      stored.state = "expired";
      stored.updatedAt = new Date(now).toISOString();
    }
  }

  private effectiveState(stored: StoredAction, now = Date.now()): CoordinationState {
    if (stored.state === "cancelled" || stored.state === "expired" || stored.state === "rejected") return stored.state;
    const expiresAt = Date.parse(stored.actionPackage.actionEnvelope.expiresAt);
    return !Number.isNaN(expiresAt) && expiresAt <= now ? "expired" : stored.state;
  }

  private approvalPreflight(request: CoordinationApprovalSubmission): {
    stored: StoredAction;
    payload: CanonicalApprovalPayload & { signerDid: Did };
    duplicate: boolean;
  } {
    const stored = this.actionsByEnvelopeHash.get(request.actionEnvelopeHash.value);
    if (!stored || this.effectiveState(stored) === "cancelled" || this.effectiveState(stored) === "expired") {
      throw new MpasServiceError(404, "ACTION_NOT_FOUND", "Pending action was not found.");
    }

    if (request.approval.actionEnvelopeHash.value !== stored.actionRef.actionEnvelopeHash.value) {
      throw new MpasServiceError(400, "APPROVAL_HASH_MISMATCH", "Approval is bound to a different action envelope.");
    }

    const payload = decodeApprovalPayload(request.approval);
    if (payload?.actionEnvelopeHash.value !== stored.actionRef.actionEnvelopeHash.value) {
      throw new MpasServiceError(400, "APPROVAL_HASH_MISMATCH", "Signed approval payload is bound to a different action envelope.");
    }

    if (!payload?.signerDid) {
      throw new MpasServiceError(400, "APPROVAL_SIGNER_MISSING", "Signed approval payload does not include signerDid.");
    }

    if (request.approval.decision !== payload.decision) {
      throw new MpasServiceError(400, "APPROVAL_DECISION_MISMATCH", "Approval decision does not match its signed payload.");
    }

    // Self-approval prevention: the proposer of an action cannot approve their own action.
    if (payload.signerDid === stored.actionPackage.actionEnvelope.proposer.did) {
      throw new MpasServiceError(403, "SELF_APPROVAL_DENIED", "The proposer of an action cannot approve their own action.");
    }

    const prior = stored.approvals.find((entry) => entry.signerDid === payload.signerDid);
    if (prior && prior.decision !== payload.decision) {
      throw new MpasServiceError(
        409,
        "SIGNER_DECISION_CONFLICT",
        "A Signer's first decision for an Action Envelope is final.",
      );
    }
    if (stored.state !== "awaitingApprovals" && !prior) {
      throw new MpasServiceError(409, "ACTION_NOT_AWAITING_APPROVALS", "The workflow is no longer accepting new decisions.");
    }

    return {
      stored,
      payload: payload as CanonicalApprovalPayload & { signerDid: Did },
      duplicate: prior !== undefined,
    };
  }

  private approvalRequestFor(stored: StoredAction, did: Did): ApprovalRequest | undefined {
    const requirement = thresholdsFor(stored.authorizationRequirements.approvalRequirements).find((threshold) =>
      threshold.eligibleSigners.includes(did),
    );
    const override = (stored.authorizationRequirements.approvalRequirements.overrideSigners ?? [])
      .find((entry) => entry.signer === did);
    if (!requirement && !override) {
      return undefined;
    }

    const decision = requirement?.decision ?? (override?.permissions.includes("approve") ? "approve" : "reject");
    const alreadyResponded = stored.approvals.some((entry) => entry.signerDid === did);
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

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new MpasServiceError(400, "INVALID_CURSOR", "Relay cursor is invalid.");
  }
  return Number(cursor);
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

  if (stored.state === "rejected") {
    update.rejectedAt = stored.rejectedAt;
    return update;
  }

  if (stored.state === "expired") {
    return update;
  }

  update.progress = progressFor(stored.authorizationRequirements.approvalRequirements, stored.approvals);
  if (stored.state === "readyForSubmission") {
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
    pending: threshold.eligibleSigners.filter((did) => !approvals.some((entry) => entry.signerDid === did)),
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

function validateActionPackageBindings(actionPackage: ActionPackage): void {
  const raw = actionPackage as unknown as Record<string, unknown>;
  if (!("executionPayload" in raw) || !isRecord(raw.actionEnvelope) || !isRecord(raw.approvalBundle) ||
      !isRecord(raw.actionEnvelope.executionPayloadHash) ||
      !isRecord(raw.approvalBundle.actionEnvelopeHash)) {
    throw new MpasServiceError(400, "INVALID_REQUEST", "Action Package hash bindings are malformed.");
  }
  const payloadHash = computeJsonHash(actionPackage.executionPayload);
  if (!hashesEqual(payloadHash, actionPackage.actionEnvelope.executionPayloadHash)) {
    throw new MpasServiceError(
      400,
      "artifact_hash_mismatch",
      "Execution Payload hash does not match ActionEnvelope.executionPayloadHash.",
    );
  }
  const actionEnvelopeHash = computeJsonHash(actionPackage.actionEnvelope);
  if (!hashesEqual(actionEnvelopeHash, actionPackage.approvalBundle.actionEnvelopeHash)) {
    throw new MpasServiceError(
      400,
      "artifact_hash_mismatch",
      "ApprovalBundle.actionEnvelopeHash does not match the Action Envelope.",
    );
  }
}

function validateAuthorizationRequirements(
  requirements: AuthorizationRequirements,
  actionEnvelopeHash: Hash,
  verifierDid?: Did,
): void {
  const raw = requirements as unknown as Record<string, unknown>;
  if (!isRecord(raw.actionEnvelopeHash) ||
      typeof raw.actionEnvelopeHash.alg !== "string" ||
      typeof raw.actionEnvelopeHash.value !== "string" ||
      !isRecord(raw.verifier) ||
      typeof raw.verifier.did !== "string" ||
      !raw.verifier.did.startsWith("did:") ||
      !isRecord(raw.approvalRequirements)) {
    throw new MpasServiceError(400, "INVALID_REQUEST", "Authorization Requirements are malformed.");
  }
  for (const field of ["anyOf", "allOf"] as const) {
    const entries = raw.approvalRequirements[field];
    if (entries !== undefined && !Array.isArray(entries)) {
      throw new MpasServiceError(400, "INVALID_REQUEST", `approvalRequirements.${field} must be an array.`);
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isRecord(entry) || entry.type !== "threshold" || !Array.isArray(entry.eligibleSigners) ||
          entry.eligibleSigners.some((did) => typeof did !== "string" || !did.startsWith("did:"))) {
        throw new MpasServiceError(400, "INVALID_REQUEST", "Authorization threshold is malformed.");
      }
    }
  }
  const rawOverrides = raw.approvalRequirements.overrideSigners;
  if (rawOverrides !== undefined && (!Array.isArray(rawOverrides) || rawOverrides.some((entry) =>
    !isRecord(entry) || typeof entry.signer !== "string" || !entry.signer.startsWith("did:") ||
    !Array.isArray(entry.permissions) || entry.permissions.length === 0 ||
    entry.permissions.some((permission) => typeof permission !== "string")))) {
    throw new MpasServiceError(400, "INVALID_REQUEST", "Authorization override Signers are malformed.");
  }

  if (requirements.result !== "additionalApprovalsRequired") {
    throw new MpasServiceError(400, "INVALID_REQUEST", "Approval workflow requires additional-approval requirements.");
  }
  if (!hashesEqual(requirements.actionEnvelopeHash, actionEnvelopeHash)) {
    throw new MpasServiceError(400, "artifact_hash_mismatch", "Authorization Requirements are bound to another Action.");
  }
  if (verifierDid !== undefined && requirements.verifier.did !== verifierDid) {
    throw new MpasServiceError(403, "permission_denied", "Authorization Requirements came from another Verifier.");
  }
  if (requirements.expiresAt !== undefined) {
    const expiresAt = Date.parse(requirements.expiresAt);
    if (Number.isNaN(expiresAt)) {
      throw new MpasServiceError(400, "INVALID_REQUEST", "Authorization Requirements expiry is invalid.");
    }
    if (expiresAt <= Date.now()) {
      throw new MpasServiceError(409, "expired", "Authorization Requirements are expired.");
    }
  }

  const thresholds = thresholdsFor(requirements.approvalRequirements);
  const overrides = requirements.approvalRequirements.overrideSigners ?? [];
  if (thresholds.length === 0 && overrides.length === 0) {
    throw new MpasServiceError(400, "INVALID_REQUEST", "Authorization Requirements contain no approval path.");
  }
  for (const threshold of thresholds) {
    const eligible = new Set(threshold.eligibleSigners);
    if (eligible.size !== threshold.eligibleSigners.length) {
      throw new MpasServiceError(400, "INVALID_REQUEST", "Threshold eligibleSigners must be unique.");
    }
    if (!Number.isInteger(threshold.threshold) || threshold.threshold < 1 || threshold.threshold > eligible.size) {
      throw new MpasServiceError(400, "INVALID_REQUEST", "Threshold must be achievable by its eligibleSigners.");
    }
  }
  if (new Set(overrides.map((entry) => entry.signer)).size !== overrides.length) {
    throw new MpasServiceError(400, "INVALID_REQUEST", "Override Signer DIDs must be unique.");
  }
}

function hashesEqual(left: Hash, right: Hash): boolean {
  return left.alg === right.alg && left.value === right.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeApprovalPayload(approval: Approval | undefined): CanonicalApprovalPayload | undefined {
  if (!approval || typeof approval.signature?.value !== "string") {
    return undefined;
  }

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

export function decodeApprovalSignerDid(approval: Approval | undefined): Did | undefined {
  return decodeApprovalPayload(approval)?.signerDid;
}
