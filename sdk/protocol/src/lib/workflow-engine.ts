import { randomUUID } from "node:crypto";
import type {
  ActionId,
  ActionPackage,
  ActionRequest,
  ActionResponse,
  AdditionalApprovalsAuthorizationRequirements,
  AuthorizationRequirements,
  CoordinationActionResponse,
  CoordinationActionUpdate,
  CoordinationCancelResponse,
  CoordinationPollResponse,
  Did,
} from "../types/mpas.js";
import { CoordinationResponseError, MpasAuthError } from "./coordination-client.js";
import { computeJsonHash } from "../utils/hash.js";
import {
  TERMINAL_WORKFLOW_STATES,
  type CreateWorkflowInput,
  type WorkflowRecord,
  type WorkflowStore,
} from "./workflow-store.js";

/**
 * Proposer-bridge workflow engine (feature spec §6 bridge track).
 *
 * Owns the bridge track: initial submission, coordination handoff, completed
 * replacement-Action construction and submission, terminal storage, startup
 * reconciliation, and expiry.
 * The client track observes through {@link waitForResult}, which never
 * advances a workflow (client profile §6.4, §7.1).
 *
 * Result recovery is best effort (feature spec §11). Dispatch stays
 * at-most-once via the Verifier ledger; when a crash window loses the terminal
 * response, the identical retry is rejected as a replay and the engine
 * marks the workflow `unresolvable` rather than fabricating an outcome.
 */

/** @deprecated Compatibility surface for the former AdapterClient-bound workflow. */
export interface WorkflowAdapter {
  submit(pkg: unknown): Promise<ActionResponse>;
}

/** @deprecated Compatibility surface for the former CoordinationClient API. */
export interface WorkflowCoordination {
  submitAction(pkg: unknown, authorizationRequirements: unknown): Promise<CoordinationActionResponse>;
  poll(did: string): Promise<CoordinationPollResponse>;
  cancelAction(actionId: ActionId, did: Did): Promise<CoordinationCancelResponse>;
}

/** Common Action endpoint surface required by the proposer workflow engine. */
export interface WorkflowActionEndpoint {
  submitActionRequest(request: ActionRequest): Promise<ActionResponse>;
}

/** Coordination Service surface required by the proposer workflow engine. */
export interface WorkflowCoordinationService {
  createApprovalWorkflow(input: {
    actionPackage: ActionPackage;
    authorizationRequirements?: AuthorizationRequirements;
  }): Promise<CoordinationActionResponse>;
  pollWork(): Promise<CoordinationPollResponse>;
  cancelAction(input: { actionId: ActionId }): Promise<CoordinationCancelResponse>;
}

export interface CoordinationReplacement {
  actionPackage: ActionPackage;
  authorizationRequirements: AdditionalApprovalsAuthorizationRequirements;
}

export type BuildCoordinationReplacement = (
  priorPackage: ActionPackage,
  verifierRequirements: AdditionalApprovalsAuthorizationRequirements,
) => Promise<CoordinationReplacement>;

export interface BridgeWorkflowEngineOptions {
  store: WorkflowStore;
  /**
   * Action endpoint used for initial and completed submission.
   *
   * A bridge that submits through a Coordination Service must supply an
   * implementation that adds the required Delivery Envelope.
   */
  actionEndpoint?: WorkflowActionEndpoint;
  /** Coordination Service client used for approval collection and updates. */
  coordinationService?: WorkflowCoordinationService;
  /** @deprecated Use {@link actionEndpoint}. */
  adapter?: WorkflowAdapter;
  /** @deprecated Use {@link coordinationService}. */
  coordination?: WorkflowCoordination;
  /** Constructs A2 (or a later replacement) after Verifier policy feedback. */
  buildCoordinationReplacement: BuildCoordinationReplacement;
  proposerDid: Did;
  /** Distinguishes workers contending for the same store. */
  workerId?: string;
  /** Worker claim lease. Default 60s. */
  claimLeaseMs?: number;
  now?: () => number;
}

export type ProposeResult =
  | { kind: "settled"; record: WorkflowRecord; actionResponse: ActionResponse }
  | { kind: "deferred"; record: WorkflowRecord };

/** Ledger rejection codes that mean "already dispatched; outcome not retrievable". */
const REPLAY_CODES = new Set(["REPLAY_DETECTED", "ACTION_ID_HASH_MISMATCH"]);

export class BridgeWorkflowEngine {
  private readonly store: WorkflowStore;
  private readonly actionEndpoint: WorkflowActionEndpoint;
  private readonly coordinationService: WorkflowCoordinationService;
  private readonly buildCoordinationReplacement: BuildCoordinationReplacement;
  private readonly proposerDid: Did;
  private readonly workerId: string;
  private readonly claimLeaseMs: number;
  private readonly now: () => number;
  private readonly waiters = new Map<string, Set<(record: WorkflowRecord) => void>>();

  constructor(options: BridgeWorkflowEngineOptions) {
    this.store = options.store;
    if (options.actionEndpoint) {
      this.actionEndpoint = options.actionEndpoint;
    } else if (options.adapter) {
      this.actionEndpoint = {
        submitActionRequest: (request) => options.adapter!.submit(request.actionPackage),
      };
    } else {
      throw new Error("BridgeWorkflowEngine requires actionEndpoint.");
    }
    if (options.coordinationService) {
      this.coordinationService = options.coordinationService;
    } else if (options.coordination) {
      this.coordinationService = {
        createApprovalWorkflow: (input) => options.coordination!.submitAction(
          input.actionPackage,
          input.authorizationRequirements,
        ),
        pollWork: () => options.coordination!.poll(options.proposerDid),
        cancelAction: (input) => options.coordination!.cancelAction(input.actionId, options.proposerDid),
      };
    } else {
      throw new Error("BridgeWorkflowEngine requires coordinationService.");
    }
    this.buildCoordinationReplacement = options.buildCoordinationReplacement;
    this.proposerDid = options.proposerDid;
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Application-call path (feature spec §6 steps 1–4). Durably records the
   * workflow before the first adapter submission (§9.2 commit point 1), so a
   * deferred result can be returned even when the adapter is unreachable.
   */
  async propose(input: CreateWorkflowInput): Promise<ProposeResult> {
    if (input.taskId === input.actionId) {
      throw new Error("Task ID and Action ID must be distinct.");
    }
    const record = this.store.createWorkflow(input);
    return this.submitInitial(record);
  }

  /**
   * One background tick: expiry sweep, coordination poll, and advancement of
   * every workflow this worker can claim.
   */
  async pollOnce(): Promise<void> {
    this.sweepExpired();

    try {
      const poll = await this.coordinationService.pollWork();
      for (const update of poll.actionUpdates) {
        await this.applyUpdate(update);
      }
    } catch {
      // Coordination updates are one input to the engine. Independent
      // adapter retries must still run when this input is unavailable.
    }

    await this.advanceClaimable();
  }

  /** Cooperatively cancel a visible workflow without advancing it. */
  async cancel(taskId: string): Promise<WorkflowRecord | undefined> {
    const record = this.store.getWorkflow(taskId);
    if (!record || proposerDidOf(record) !== this.proposerDid) {
      return undefined;
    }
    if (isTerminal(record)) {
      return record;
    }

    const coordinationStarted = record.coordinationRef !== undefined;
    if (!this.store.cancelWorkflow(taskId)) {
      return this.store.getWorkflow(taskId);
    }

    const cancelled = this.mustGet(taskId);
    this.notify(cancelled);
    if (coordinationStarted) {
      try {
        await this.coordinationService.cancelAction({ actionId: { value: record.actionId } });
      } catch {
        // Cancellation is cooperative. The durable local terminal write is
        // authoritative for future bridge work; Coordination is best effort.
      }
    }
    return cancelled;
  }

  /** Startup reconciliation (feature spec §9.4). Idempotent. */
  async reconcile(): Promise<void> {
    this.sweepExpired();

    for (const record of this.store.listRecoverableWorkflows()) {
      if (!this.store.claimWorkflow(record.taskId, this.workerId, this.claimLeaseMs)) {
        continue;
      }
      switch (record.state) {
        case "created":
          await this.submitInitial(record);
          break;
        case "submittingToCoordination":
          await this.submitToCoordination(record);
          break;
        case "submittingToVerifier":
          // Crash mid-submission: the identical package may or may not have
          // been transmitted. Resubmit identically; the ledger dedups.
          this.store.compareAndSetState(record.taskId, "submittingToVerifier", "readyForSubmission");
          await this.submitCompleted(this.mustGet(record.taskId));
          break;
        case "readyForSubmission":
          await this.submitCompleted(record);
          break;
        case "awaitingVerifierResult":
          await this.submitCompleted(record);
          break;
        case "awaitingApprovals":
          break; // pollOnce advances these when coordination reports progress.
      }
    }
  }

  /**
   * Client-track observation. Resolves when the workflow is terminal or the
   * timeout elapses; returns the current record either way, or undefined for
   * an unknown action. Never advances the workflow.
   */
  async waitForResult(taskId: string, timeoutMs: number): Promise<WorkflowRecord | undefined> {
    const record = this.store.getWorkflow(taskId);
    if (!record || isTerminal(record) || timeoutMs <= 0) {
      return record;
    }

    return new Promise<WorkflowRecord>((resolve) => {
      const waiters = this.waiters.get(taskId) ?? new Set();
      this.waiters.set(taskId, waiters);

      const timer = setTimeout(() => {
        waiters.delete(wake);
        resolve(this.mustGet(taskId));
      }, timeoutMs);

      const wake = (terminal: WorkflowRecord): void => {
        clearTimeout(timer);
        waiters.delete(wake);
        resolve(terminal);
      };
      waiters.add(wake);
    });
  }

  private async submitInitial(record: WorkflowRecord): Promise<ProposeResult> {
    const current = this.store.getWorkflow(record.taskId);
    if (!current || isTerminal(current)) {
      return { kind: "deferred", record: current ?? record };
    }

    let response: ActionResponse;
    try {
      response = await this.actionEndpoint.submitActionRequest(actionRequestFor(record, record.actionPackage));
    } catch (error) {
      this.store.saveAdapterAttempt(record.taskId, attempt("initial", "unreachable", error));
      return { kind: "deferred", record: this.mustGet(record.taskId) };
    }

    if (isTerminal(this.mustGet(record.taskId))) {
      return { kind: "deferred", record: this.mustGet(record.taskId) };
    }

    switch (response.result) {
      case "additionalApprovalsRequired": {
        this.store.saveLastActionResponse(record.taskId, response);
        return this.replaceAndSubmitToCoordination(this.mustGet(record.taskId), "created", response);
      }
      case "pending":
        this.store.saveLastActionResponse(record.taskId, response);
        this.store.compareAndSetState(record.taskId, "created", "awaitingVerifierResult");
        return { kind: "deferred", record: this.mustGet(record.taskId) };
      default:
        return this.settle(record.taskId, response);
    }
  }

  private async replaceAndSubmitToCoordination(
    record: WorkflowRecord,
    fromState: "created" | "submittingToVerifier",
    response: ActionResponse,
  ): Promise<ProposeResult> {
    const verifierRequirements = response.authorizationRequirements;
    if (verifierRequirements?.result !== "additionalApprovalsRequired") {
      this.resolveUnresolvable(
        record.taskId,
        "INVALID_VERIFIER_RESPONSE",
        "The Verifier requested additional Approvals without usable Authorization Requirements.",
      );
      return { kind: "deferred", record: this.mustGet(record.taskId) };
    }

    try {
      const replacement = await this.buildCoordinationReplacement(
        record.actionPackage as ActionPackage,
        verifierRequirements,
      );
      const envelope = replacement.actionPackage.actionEnvelope;
      const actionEnvelopeHash = computeJsonHash(envelope);
      if (envelope.actionId.value === record.actionId) {
        throw new Error("A replacement Action must use a new Action ID.");
      }
      if (envelope.actionId.value === record.taskId) {
        throw new Error("Task ID and Action ID must be distinct.");
      }
      if (!sameHash(replacement.actionPackage.approvalBundle.actionEnvelopeHash, actionEnvelopeHash)) {
        throw new Error("The replacement Approval Bundle does not bind to its Action Envelope.");
      }
      if (!sameHash(replacement.authorizationRequirements.actionEnvelopeHash, actionEnvelopeHash)) {
        throw new Error("The replacement Authorization Requirements do not bind to the replacement Action Envelope.");
      }
      if (replacement.authorizationRequirements.verifier.did !== verifierRequirements.verifier.did) {
        throw new Error("The replacement Authorization Requirements changed the intended Verifier.");
      }
      this.store.replaceAction(record.taskId, {
        fromState,
        actionId: envelope.actionId.value,
        actionIdempotencyKey: randomUUID(),
        actionEnvelopeHash: actionEnvelopeHash.value,
        actionPackage: replacement.actionPackage,
        authorizationRequirements: replacement.authorizationRequirements,
        expiresAt: envelope.expiresAt,
      });
    } catch (error) {
      const current = this.store.getWorkflow(record.taskId);
      if (current !== undefined && isTerminal(current)) {
        return { kind: "deferred", record: this.mustGet(record.taskId) };
      }
      this.resolveUnresolvable(
        record.taskId,
        "ACTION_REPLACEMENT_FAILED",
        error instanceof Error ? error.message : "Could not construct the replacement Action.",
      );
      return { kind: "deferred", record: this.mustGet(record.taskId) };
    }

    return this.submitToCoordination(this.mustGet(record.taskId));
  }

  private async submitToCoordination(record: WorkflowRecord): Promise<ProposeResult> {
    try {
      const coordination = await this.coordinationService.createApprovalWorkflow({
        actionPackage: record.actionPackage as ActionPackage,
        authorizationRequirements: record.authorizationRequirements as AuthorizationRequirements,
      });
      this.store.saveCoordinationReference(record.taskId, coordination.actionRef);
      if (this.mustGet(record.taskId).state === "cancelled") {
        try {
          await this.coordinationService.cancelAction({ actionId: { value: record.actionId } });
        } catch {
          // Cancellation won while Coordination submission was in flight.
          // The local terminal state still prevents any later execution.
        }
        return { kind: "deferred", record: this.mustGet(record.taskId) };
      }
      this.store.compareAndSetState(record.taskId, "submittingToCoordination", "awaitingApprovals");
    } catch (error) {
      const permanent = permanentCoordinationFailure(error);
      this.store.saveAdapterAttempt(
        record.taskId,
        attempt("coordination", permanent ? "rejected" : "unreachable", error),
      );
      if (permanent) {
        const resolution = coordinationFailureResolution(error);
        this.resolveUnresolvable(record.taskId, resolution.errorCode, resolution.errorMessage);
      }
    }
    return { kind: "deferred", record: this.mustGet(record.taskId) };
  }

  private async applyUpdate(update: CoordinationActionUpdate): Promise<void> {
    const actionId = update.actionRef.actionId.value;
    const record = this.store.getWorkflowByActionId(actionId);
    if (!record || isTerminal(record)) {
      return;
    }

    switch (update.state) {
      case "readyForSubmission":
        if (update.actionPackage !== undefined) {
          this.store.saveCompletedPackage(record.taskId, update.actionPackage);
          this.store.compareAndSetState(record.taskId, "awaitingApprovals", "readyForSubmission");
        }
        break;
      case "expired":
        this.resolveUnresolvable(record.taskId, "ACTION_EXPIRED_BEFORE_RESOLUTION", "The Action expired before Approvals completed.");
        break;
      case "rejected":
        this.resolveUnresolvable(
          record.taskId,
          "COORDINATION_REJECTED",
          "The coordination workflow was rejected before completion.",
        );
        break;
      case "executed":
        this.resolveUnresolvable(
          record.taskId,
          "RESULT_UNAVAILABLE",
          "Coordination reports execution, but the authoritative Verifier result is unavailable.",
        );
        break;
      case "cancelled":
        if (this.store.cancelWorkflow(record.taskId)) {
          this.notify(this.mustGet(record.taskId));
        }
        break;
      case "awaitingApprovals":
        break;
    }
  }

  private async advanceClaimable(): Promise<void> {
    for (const record of this.store.listRecoverableWorkflows()) {
      if (
        record.state !== "created" &&
        record.state !== "submittingToCoordination" &&
        record.state !== "readyForSubmission" &&
        record.state !== "awaitingVerifierResult"
      ) {
        continue;
      }
      if (!this.store.claimWorkflow(record.taskId, this.workerId, this.claimLeaseMs)) {
        continue;
      }
      if (record.state === "created") {
        await this.submitInitial(record);
      } else if (record.state === "submittingToCoordination") {
        await this.submitToCoordination(record);
      } else {
        await this.submitCompleted(record);
      }
    }
  }

  /**
   * Submit (or identically retry) the completed Action Package. The ledger
   * guarantees at most one dispatch; a replay rejection here means the outcome
   * was produced but lost, which resolves as `unresolvable`, never as the
   * Action's outcome.
   */
  private async submitCompleted(record: WorkflowRecord): Promise<void> {
    const pkg = record.completedPackage ?? record.actionPackage;
    if (record.state === "readyForSubmission") {
      if (!this.store.compareAndSetState(record.taskId, "readyForSubmission", "submittingToVerifier")) {
        return;
      }
    }

    let response: ActionResponse;
    try {
      response = await this.actionEndpoint.submitActionRequest(actionRequestFor(record, pkg));
    } catch (error) {
      this.store.saveAdapterAttempt(record.taskId, attempt("completed", "unreachable", error));
      this.store.compareAndSetState(record.taskId, "submittingToVerifier", "readyForSubmission");
      return;
    }

    if (isTerminal(this.mustGet(record.taskId))) {
      return;
    }

    if (response.result === "pending") {
      this.store.saveLastActionResponse(record.taskId, response);
      this.store.compareAndSetState(record.taskId, "submittingToVerifier", "awaitingVerifierResult");
      return;
    }

    if (response.result === "rejected" && REPLAY_CODES.has(response.error?.code ?? "")) {
      this.resolveUnresolvable(
        record.taskId,
        "RESULT_UNAVAILABLE",
        "The Action was already dispatched and its result is not retrievable from the Verifier.",
      );
      return;
    }

    if (response.result === "additionalApprovalsRequired") {
      this.store.saveLastActionResponse(record.taskId, response);
      await this.replaceAndSubmitToCoordination(
        this.mustGet(record.taskId),
        "submittingToVerifier",
        response,
      );
      return;
    }

    this.settle(record.taskId, response);
  }

  private settle(taskId: string, response: ActionResponse): ProposeResult {
    this.store.resolveWorkflow(taskId, {
      kind: "resolved",
      actionResponse: response,
      ...(response.executionReceipt !== undefined ? { executionReceipt: response.executionReceipt } : {}),
    });
    const record = this.mustGet(taskId);
    this.notify(record);
    return { kind: "settled", record, actionResponse: response };
  }

  private resolveUnresolvable(taskId: string, errorCode: string, errorMessage: string): void {
    this.store.resolveWorkflow(taskId, { kind: "unresolvable", errorCode, errorMessage });
    this.notify(this.mustGet(taskId));
  }

  private sweepExpired(): void {
    const nowMs = this.now();
    for (const record of this.store.listRecoverableWorkflows()) {
      if (Date.parse(record.expiresAt) < nowMs) {
        if (this.store.claimWorkflow(record.taskId, this.workerId, this.claimLeaseMs)) {
          this.resolveUnresolvable(
            record.taskId,
            "ACTION_EXPIRED_BEFORE_RESOLUTION",
            "The Action Envelope expired without a terminal Verifier response.",
          );
        }
      }
    }
  }

  private notify(record: WorkflowRecord): void {
    if (!isTerminal(record)) {
      return;
    }
    const waiters = this.waiters.get(record.taskId);
    if (!waiters) {
      return;
    }
    this.waiters.delete(record.taskId);
    for (const wake of waiters) {
      wake(record);
    }
  }

  private mustGet(taskId: string): WorkflowRecord {
    const record = this.store.getWorkflow(taskId);
    if (!record) {
      throw new Error(`Workflow not found for task ${taskId}.`);
    }
    return record;
  }
}

function isTerminal(record: WorkflowRecord): boolean {
  return TERMINAL_WORKFLOW_STATES.has(record.state);
}

function proposerDidOf(record: WorkflowRecord): string | undefined {
  const pkg = record.actionPackage;
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return undefined;
  const envelope = (pkg as Record<string, unknown>).actionEnvelope;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return undefined;
  const proposer = (envelope as Record<string, unknown>).proposer;
  if (typeof proposer !== "object" || proposer === null || Array.isArray(proposer)) return undefined;
  const did = (proposer as Record<string, unknown>).did;
  return typeof did === "string" ? did : undefined;
}

function asActionResponse(value: unknown): ActionResponse | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ActionResponse>;
  return candidate.type === "ActionResponse" && typeof candidate.result === "string"
    ? (candidate as ActionResponse)
    : undefined;
}

function permanentCoordinationFailure(error: unknown): boolean {
  return error instanceof MpasAuthError || error instanceof CoordinationResponseError;
}

function coordinationFailureResolution(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof MpasAuthError) {
    return {
      errorCode:
        error.status === 401 ? "COORDINATION_AUTHENTICATION_FAILED" : "COORDINATION_AUTHORIZATION_FAILED",
      errorMessage: error.message,
    };
  }
  return {
    errorCode: "COORDINATION_REQUEST_REJECTED",
    errorMessage: error instanceof Error ? error.message : "The Coordination Service rejected the workflow.",
  };
}

function actionRequestFor(record: WorkflowRecord, actionPackage: unknown): ActionRequest {
  return {
    version: "1",
    type: "ActionRequest",
    idempotencyKey: record.actionIdempotencyKey,
    actionPackage: actionPackage as ActionPackage,
  };
}

function sameHash(left: { alg: string; value: string }, right: { alg: string; value: string }): boolean {
  return left.alg === right.alg && left.value === right.value;
}

function attempt(stage: string, outcome: string, error: unknown): unknown {
  return {
    stage,
    outcome,
    message: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString(),
  };
}
