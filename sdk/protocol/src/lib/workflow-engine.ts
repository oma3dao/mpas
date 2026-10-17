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
import { computeIdempotencyFingerprint } from "./routing.js";
import { computeJsonHash } from "../utils/hash.js";
import { backoffDelayMs, FAILURE_BACKOFF, PENDING_BACKOFF, retryAfterMsOf } from "./retry-backoff.js";
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
  upstreamBinding?: ActionRequest["upstreamBinding"];
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
  /**
   * Maximum wait of one claimed Action or Coordination submit. Must match the
   * Action endpoint (and Coordination) client timeout. The HTTP profile does
   * not fix relay wait duration. Default {@link DEFAULT_SUBMISSION_TIMEOUT_MS}.
   */
  submissionTimeoutMs?: number;
  /**
   * Worker claim lease. Must exceed {@link submissionTimeoutMs} so a
   * cross-process peer cannot take the workflow mid-submit. Default
   * {@link DEFAULT_CLAIM_LEASE_MS}.
   */
  claimLeaseMs?: number;
  now?: () => number;
  /** Jitter source for retry backoff, in [0, 1). Default `Math.random`. */
  random?: () => number;
}

/** Default Action/Coordination HTTP wait. Keep aligned with ActionEndpointClient. */
export const DEFAULT_SUBMISSION_TIMEOUT_MS = 30_000;
/** Default worker claim lease. Must exceed {@link DEFAULT_SUBMISSION_TIMEOUT_MS}. */
export const DEFAULT_CLAIM_LEASE_MS = 60_000;

export type ProposeResult =
  | { kind: "settled"; record: WorkflowRecord; actionResponse: ActionResponse }
  | { kind: "deferred"; record: WorkflowRecord };

/** Ledger rejection codes that mean "already dispatched; outcome not retrievable". */
const REPLAY_CODES = new Set(["REPLAY_DETECTED", "ACTION_ID_HASH_MISMATCH"]);

/** States whose next step is a remote submission or re-check by this bridge. */
const RETRYABLE_STATES: ReadonlySet<WorkflowRecord["state"]> = new Set([
  "created",
  "submittingToCoordination",
  "readyForSubmission",
  "submittingToVerifier",
  "awaitingVerifierResult",
]);

interface RetryEntry {
  state: WorkflowRecord["state"];
  failures: number;
  notBefore: number;
}

type SubmissionPhase = "initial" | "completed";

interface SubmissionIdempotencyBinding {
  stage: SubmissionPhase;
  outcome: "idempotencyBound";
  idempotencyKey: string;
  requestFingerprint: string;
  at: string;
}

export class BridgeWorkflowEngine {
  private readonly upstreamBinding?: ActionRequest["upstreamBinding"];
  private readonly store: WorkflowStore;
  private readonly actionEndpoint: WorkflowActionEndpoint;
  private readonly coordinationService: WorkflowCoordinationService;
  private readonly buildCoordinationReplacement: BuildCoordinationReplacement;
  private readonly proposerDid: Did;
  private readonly workerId: string;
  private readonly claimLeaseMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly waiters = new Map<string, Set<(record: WorkflowRecord) => void>>();
  /** In-memory retry backoff per Task; rebuilt by reconciliation after a restart. */
  private readonly retrySchedule = new Map<string, RetryEntry>();
  /** `Retry-After` from the latest failed remote call, consumed when scheduling. */
  private readonly retryAfter = new Map<string, number>();
  /**
   * Per-Task outbound lanes. Each Task ID serializes that Task's initial,
   * replacement, Coordination, and completed submissions so the request
   * handler and poller cannot double-submit. Distinct Task IDs run
   * concurrently. The durable store claim extends ownership across
   * processes; it does not serialize same-process submitters. The claim
   * lease must exceed the submission timeout so that ownership cannot
   * expire mid-submit.
   */
  private readonly outboundTails = new Map<string, Promise<void>>();

  constructor(options: BridgeWorkflowEngineOptions) {
    this.store = options.store;
    this.upstreamBinding = options.upstreamBinding === undefined ? undefined : structuredClone(options.upstreamBinding);
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
    const submissionTimeoutMs = options.submissionTimeoutMs ?? DEFAULT_SUBMISSION_TIMEOUT_MS;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    if (!(this.claimLeaseMs > submissionTimeoutMs)) {
      throw new Error(
        `claimLeaseMs (${this.claimLeaseMs}) must exceed submissionTimeoutMs (${submissionTimeoutMs}).`,
      );
    }
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  /**
   * Application-call path (feature spec §6 steps 1–4). Durably records the
   * workflow before the first adapter submission (§9.2 commit point 1), so a
   * deferred result can be returned even when the adapter is unreachable.
   */
  async propose(input: CreateWorkflowInput): Promise<ProposeResult> {
    if (proposerDidOfPackage(input.actionPackage) !== this.proposerDid) {
      throw new Error("Action Package proposer DID does not match this bridge identity.");
    }
    if (input.taskId === input.actionId) {
      throw new Error("Task ID and Action ID must be distinct.");
    }
    const record = this.store.createWorkflow(input);
    const result = await this.dispatchOutbound(record.taskId, async () => {
      const current = this.mustGet(record.taskId);
      if (current.state !== "created") {
        return this.resultFromRecord(current);
      }
      if (!this.store.claimWorkflow(current.taskId, this.workerId, this.claimLeaseMs)) {
        return { kind: "deferred", record: this.mustGet(current.taskId) } as const;
      }
      return this.submitInitial(this.mustGet(current.taskId));
    });
    this.updateRetrySchedule(record.taskId, "created");
    return result;
  }

  /**
   * One unthrottled tick: expiry sweep, Coordination poll, and advancement of
   * every workflow this worker can claim.
   *
   * @deprecated Bridges observe Coordination on demand through
   * {@link refreshCoordination} and pace remote work with {@link maintain}.
   */
  async pollOnce(): Promise<void> {
    const expiry = this.sweepExpired();
    try {
      await this.refreshCoordination();
    } catch {
      // Coordination updates are one input to the engine. Independent
      // Action retries must still run when this input is unavailable.
    }
    await this.advanceClaimable(false);
    await expiry;
  }

  /**
   * Poll Coordination once and apply its updates (feature reduce-polling §4).
   * Does nothing unless this proposer has a workflow awaiting approvals.
   * Permanent failures resolve those workflows; retryable failures reject so
   * the caller can back off. Coordination updates join each Task's outbound
   * lane so they cannot terminate a submit that is still in flight.
   */
  async refreshCoordination(): Promise<void> {
    if (!this.hasAwaitingApprovals()) {
      return;
    }
    let poll: CoordinationPollResponse;
    try {
      poll = await this.coordinationService.pollWork();
    } catch (error) {
      if (!permanentCoordinationFailure(error)) {
        throw error;
      }
      const resolution = coordinationFailureResolution(error);
      for (const record of this.store.listRecoverableWorkflows()) {
        if (record.state === "awaitingApprovals" && proposerDidOf(record) === this.proposerDid) {
          this.resolveUnresolvable(record.taskId, resolution.errorCode, resolution.errorMessage);
        }
      }
      return;
    }
    for (const update of poll.actionUpdates) {
      await this.applyUpdate(update);
    }
  }

  /**
   * Local maintenance plus due remote retries (feature reduce-polling §5):
   * expiry sweep, then each claimable workflow whose backoff has elapsed.
   * Never polls Coordination.
   */
  async maintain(): Promise<void> {
    const expiry = this.sweepExpired();
    await this.advanceClaimable(true);
    await expiry;
  }

  /** Whether this proposer has a workflow that Coordination could advance. */
  hasAwaitingApprovals(): boolean {
    return this.store
      .listRecoverableWorkflows()
      .some((record) => record.state === "awaitingApprovals" && proposerDidOf(record) === this.proposerDid);
  }

  /** Earliest time a scheduled remote retry is due, if any. */
  nextRetryAt(): number | undefined {
    let earliest: number | undefined;
    for (const [taskId, entry] of this.retrySchedule) {
      const record = this.store.getWorkflow(taskId);
      if (!record || isTerminal(record) || !RETRYABLE_STATES.has(record.state)) {
        this.retrySchedule.delete(taskId);
        continue;
      }
      earliest = earliest === undefined ? entry.notBefore : Math.min(earliest, entry.notBefore);
    }
    return earliest;
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

  /** Startup reconciliation (feature spec §9.4). Idempotent. Never polls Coordination. */
  async reconcile(): Promise<void> {
    await this.sweepExpired();
    await this.advanceClaimable(false);
  }

  /**
   * Client-track observation. Resolves when the workflow is terminal or the
   * timeout elapses; returns the current record either way, or undefined for
   * an unknown action. Never advances the workflow.
   */
  async waitForResult(taskId: string, timeoutMs: number): Promise<WorkflowRecord | undefined> {
    const record = this.store.getWorkflow(taskId);
    if (!record || proposerDidOf(record) !== this.proposerDid) {
      return undefined;
    }
    if (isTerminal(record) || timeoutMs <= 0) {
      return record;
    }

    return new Promise<WorkflowRecord | undefined>((resolve) => {
      const waiters = this.waiters.get(taskId) ?? new Set();
      this.waiters.set(taskId, waiters);

      const timer = setTimeout(() => {
        waiters.delete(wake);
        const current = this.store.getWorkflow(taskId);
        resolve(current && proposerDidOf(current) === this.proposerDid ? current : undefined);
      }, timeoutMs);

      const wake = (terminal: WorkflowRecord): void => {
        clearTimeout(timer);
        waiters.delete(wake);
        resolve(terminal);
      };
      waiters.add(wake);
    });
  }

  /** Resolve every pending {@link waitForResult} with its current record, for shutdown. */
  releaseWaiters(): void {
    for (const [taskId, waiters] of this.waiters) {
      const record = this.store.getWorkflow(taskId);
      if (!record) continue;
      this.waiters.delete(taskId);
      for (const wake of waiters) {
        wake(record);
      }
    }
  }

  private async submitInitial(record: WorkflowRecord): Promise<ProposeResult> {
    const current = this.store.getWorkflow(record.taskId);
    if (!current || proposerDidOf(current) !== this.proposerDid || isTerminal(current) || current.state !== "created") {
      return this.resultFromRecord(current ?? record);
    }
    if (!this.holdClaim(current.taskId)) {
      return this.resultFromRecord(this.mustGet(current.taskId));
    }

    let response: ActionResponse;
    try {
      const request = this.submissionRequest(current, current.actionPackage, "initial");
      if (!request) {
        return { kind: "deferred", record: this.mustGet(record.taskId) };
      }
      response = await this.actionEndpoint.submitActionRequest(request);
    } catch (error) {
      this.store.saveAdapterAttempt(record.taskId, attempt("initial", "unreachable", error));
      this.noteRetryAfter(record.taskId, error);
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
    if (!this.holdClaim(record.taskId)) {
      return this.resultFromRecord(this.mustGet(record.taskId));
    }
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
      this.noteRetryAfter(record.taskId, error);
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
    if (!record || proposerDidOf(record) !== this.proposerDid || isTerminal(record)) {
      return;
    }

    await this.dispatchOutbound(record.taskId, async () => {
      const current = this.store.getWorkflow(record.taskId);
      if (!current || isTerminal(current)) {
        return;
      }

      switch (update.state) {
        case "readyForSubmission":
          if (update.actionPackage !== undefined) {
            if (proposerDidOfPackage(update.actionPackage) !== this.proposerDid) {
              this.resolveUnresolvable(
                current.taskId,
                "PROPOSER_IDENTITY_MISMATCH",
                "Coordination returned an Action Package owned by another proposer.",
              );
              break;
            }
            this.store.saveCompletedPackage(current.taskId, update.actionPackage);
            this.store.compareAndSetState(current.taskId, "awaitingApprovals", "readyForSubmission");
          }
          break;
        case "expired":
          this.resolveUnresolvable(current.taskId, "ACTION_EXPIRED_BEFORE_RESOLUTION", "The Action expired before Approvals completed.");
          break;
        case "rejected":
          this.resolveUnresolvable(
            current.taskId,
            "COORDINATION_REJECTED",
            "The coordination workflow was rejected before completion.",
          );
          break;
        case "executed":
          this.resolveUnresolvable(
            current.taskId,
            "RESULT_UNAVAILABLE",
            "Coordination reports execution, but the authoritative Verifier result is unavailable.",
          );
          break;
        case "cancelled":
          if (this.store.cancelWorkflow(current.taskId)) {
            this.notify(this.mustGet(current.taskId));
          }
          break;
        case "awaitingApprovals":
          break;
      }
    });
  }

  /**
   * Advance every claimable workflow. With `respectSchedule`, a workflow in
   * backoff waits until its retry is due; without it, all are attempted.
   */
  private async advanceClaimable(respectSchedule: boolean): Promise<void> {
    const nowMs = this.now();
    await Promise.all(
      this.store
        .listRecoverableWorkflows()
        .filter((record) => proposerDidOf(record) === this.proposerDid)
        .filter((record) => record.state !== "awaitingApprovals")
        .filter((record) => !respectSchedule || (this.retrySchedule.get(record.taskId)?.notBefore ?? 0) <= nowMs)
        .map(async (record) => {
          await this.dispatchClaimable(record);
          this.updateRetrySchedule(record.taskId, record.state);
        }),
    );
  }

  /**
   * Back off a workflow whose remote step made no progress: a failed
   * submission stays in its state, and a Verifier `pending` is re-checked.
   * Any other outcome clears the backoff so the next step runs promptly.
   */
  private updateRetrySchedule(taskId: string, before: WorkflowRecord["state"]): void {
    const retryAfterMs = this.retryAfter.get(taskId);
    this.retryAfter.delete(taskId);
    const current = this.store.getWorkflow(taskId);
    if (!current || isTerminal(current) || !RETRYABLE_STATES.has(current.state)) {
      this.retrySchedule.delete(taskId);
      return;
    }
    const pending = current.state === "awaitingVerifierResult";
    if (!pending && current.state !== before) {
      this.retrySchedule.delete(taskId);
      return;
    }
    const previous = this.retrySchedule.get(taskId);
    const failures = previous?.state === current.state ? previous.failures + 1 : 1;
    const delay = backoffDelayMs(failures, pending ? PENDING_BACKOFF : FAILURE_BACKOFF, this.random, retryAfterMs);
    this.retrySchedule.set(taskId, { state: current.state, failures, notBefore: this.now() + delay });
  }

  private noteRetryAfter(taskId: string, error: unknown): void {
    const retryAfterMs = retryAfterMsOf(error);
    if (retryAfterMs !== undefined) {
      this.retryAfter.set(taskId, retryAfterMs);
    }
  }

  /**
   * Enqueue one recoverable row on its Task lane. Claim and submit happen
   * only after joining that lane, so a concurrent `propose` for the same
   * Task cannot double-submit, and other Tasks are not blocked.
   */
  private async dispatchClaimable(record: WorkflowRecord): Promise<void> {
    await this.dispatchOutbound(record.taskId, async () => {
      const current = this.store.getWorkflow(record.taskId);
      if (!current || isTerminal(current)) {
        return;
      }
      switch (current.state) {
        case "created":
        case "submittingToCoordination":
        case "readyForSubmission":
        case "submittingToVerifier":
        case "awaitingVerifierResult":
          break;
        default:
          return;
      }
      if (!this.store.claimWorkflow(current.taskId, this.workerId, this.claimLeaseMs)) {
        return;
      }
      const claimed = this.mustGet(current.taskId);
      switch (claimed.state) {
        case "created":
          await this.submitInitial(claimed);
          break;
        case "submittingToCoordination":
          await this.submitToCoordination(claimed);
          break;
        case "readyForSubmission":
        case "submittingToVerifier":
        case "awaitingVerifierResult":
          await this.submitCompleted(claimed);
          break;
      }
    });
  }

  private resultFromRecord(record: WorkflowRecord): ProposeResult {
    if (record.state === "resolved") {
      const resolution = record.resolution;
      if (resolution?.kind === "resolved") {
        const actionResponse = asActionResponse(resolution.actionResponse);
        if (actionResponse !== undefined) {
          return { kind: "settled", record, actionResponse };
        }
      }
    }
    return { kind: "deferred", record };
  }

  /**
   * Submit (or identically retry) the completed Action Package. The ledger
   * guarantees at most one dispatch; a replay rejection here means the outcome
   * was produced but lost, which resolves as `unresolvable`, never as the
   * Action's outcome.
   */
  private async submitCompleted(record: WorkflowRecord): Promise<void> {
    const current = this.store.getWorkflow(record.taskId);
    if (!current || proposerDidOf(current) !== this.proposerDid || isTerminal(current)) {
      return;
    }
    if (!this.holdClaim(current.taskId)) {
      return;
    }
    const pkg = current.completedPackage ?? current.actionPackage;
    if (proposerDidOfPackage(pkg) !== this.proposerDid) {
      this.resolveUnresolvable(
        current.taskId,
        "PROPOSER_IDENTITY_MISMATCH",
        "The completed Action Package is owned by another proposer.",
      );
      return;
    }
    if (current.state === "readyForSubmission") {
      if (!this.store.compareAndSetState(current.taskId, "readyForSubmission", "submittingToVerifier")) {
        return;
      }
    }

    let response: ActionResponse;
    try {
      const request = this.submissionRequest(this.mustGet(current.taskId), pkg, "completed");
      if (!request) return;
      response = await this.actionEndpoint.submitActionRequest(request);
    } catch (error) {
      this.store.saveAdapterAttempt(current.taskId, attempt("completed", "unreachable", error));
      this.noteRetryAfter(current.taskId, error);
      this.store.compareAndSetState(current.taskId, "submittingToVerifier", "readyForSubmission");
      return;
    }

    if (isTerminal(this.mustGet(current.taskId))) {
      return;
    }

    if (response.result === "pending") {
      this.store.saveLastActionResponse(current.taskId, response);
      this.store.compareAndSetState(current.taskId, "submittingToVerifier", "awaitingVerifierResult");
      return;
    }

    if (response.result === "rejected" && REPLAY_CODES.has(response.error?.code ?? "")) {
      this.resolveUnresolvable(
        current.taskId,
        "RESULT_UNAVAILABLE",
        "The Action was already dispatched and its result is not retrievable from the Verifier.",
      );
      return;
    }

    if (response.result === "additionalApprovalsRequired") {
      this.store.saveLastActionResponse(current.taskId, response);
      await this.replaceAndSubmitToCoordination(
        this.mustGet(current.taskId),
        "submittingToVerifier",
        response,
      );
      return;
    }

    this.settle(current.taskId, response);
  }

  /**
   * Build the Action Request for a submission phase, using the record's
   * persisted idempotency key. The method records a content fingerprint on
   * first use and fails closed if a later submission of the same phase
   * carries different request bytes — the key would be reused with a
   * different request body, which violates at-most-once delivery.
   */
  private submissionRequest(
    record: WorkflowRecord,
    actionPackage: unknown,
    phase: SubmissionPhase,
  ): ActionRequest | undefined {
    const request = actionRequestFor(record, actionPackage);
    if (this.upstreamBinding !== undefined) request.upstreamBinding = structuredClone(this.upstreamBinding);
    const requestFingerprint = computeIdempotencyFingerprint(request);
    const bindings = record.adapterAttempts.filter(isSubmissionIdempotencyBinding)
      .filter((binding) => binding.stage === phase);
    const binding = bindings[0];

    if (binding) {
      if (binding.requestFingerprint !== requestFingerprint) {
        this.resolveUnresolvable(
          record.taskId,
          "IDEMPOTENCY_REQUEST_CONFLICT",
          `The ${phase} submission idempotency key is already bound to different request bytes.`,
        );
        return undefined;
      }
      return request;
    }

    const created: SubmissionIdempotencyBinding = {
      stage: phase,
      outcome: "idempotencyBound",
      idempotencyKey: record.actionIdempotencyKey,
      requestFingerprint,
      at: new Date(this.now()).toISOString(),
    };
    this.store.saveAdapterAttempt(record.taskId, created);
    return request;
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

  /**
   * Expire overdue workflows on each Task's outbound lane. Same-worker claims
   * can be renewed, so a claim alone does not exclude in-process expiry from
   * an in-flight submit; joining the lane does.
   */
  private async sweepExpired(): Promise<void> {
    const nowMs = this.now();
    await Promise.all(
      this.store.listRecoverableWorkflows()
        .filter((record) => proposerDidOf(record) === this.proposerDid)
        .map((record) => {
        if (Date.parse(record.expiresAt) >= nowMs) {
          return Promise.resolve();
        }
        return this.dispatchOutbound(record.taskId, async () => {
          const current = this.store.getWorkflow(record.taskId);
          if (!current || isTerminal(current)) {
            return;
          }
          if (Date.parse(current.expiresAt) >= this.now()) {
            return;
          }
          if (this.store.claimWorkflow(current.taskId, this.workerId, this.claimLeaseMs)) {
            this.resolveUnresolvable(
              current.taskId,
              "ACTION_EXPIRED_BEFORE_RESOLUTION",
              "The Action Envelope expired without a terminal Verifier response.",
            );
          }
        });
      }),
    );
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

  /**
   * Refresh this worker's claim immediately before an outbound wait. Same-worker
   * renew is required so an Action submit followed by a Coordination submit
   * does not stack two HTTP waits against one lease.
   */
  private holdClaim(taskId: string): boolean {
    return this.store.claimWorkflow(taskId, this.workerId, this.claimLeaseMs);
  }

  /**
   * Enqueue outbound work on one Task's lane and run it as soon as that
   * lane is free. Rejections do not poison the lane; the map entry is
   * dropped when this tail is still current so idle Tasks do not leak.
   */
  private dispatchOutbound<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.outboundTails.get(taskId) ?? Promise.resolve();
    const dispatched = previous.then(operation, operation);
    const tail = dispatched.then(
      () => undefined,
      () => undefined,
    );
    this.outboundTails.set(taskId, tail);
    void tail.then(() => {
      if (this.outboundTails.get(taskId) === tail) {
        this.outboundTails.delete(taskId);
      }
    });
    return dispatched;
  }
}

function isTerminal(record: WorkflowRecord): boolean {
  return TERMINAL_WORKFLOW_STATES.has(record.state);
}

function proposerDidOf(record: WorkflowRecord): string | undefined {
  return proposerDidOfPackage(record.actionPackage);
}

function proposerDidOfPackage(pkg: unknown): string | undefined {
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

function isSubmissionIdempotencyBinding(value: unknown): value is SubmissionIdempotencyBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<SubmissionIdempotencyBinding>;
  return (
    (candidate.stage === "initial" || candidate.stage === "completed") &&
    candidate.outcome === "idempotencyBound" &&
    typeof candidate.idempotencyKey === "string" &&
    candidate.idempotencyKey.length > 0 &&
    candidate.idempotencyKey.length <= 128 &&
    typeof candidate.requestFingerprint === "string" &&
    candidate.requestFingerprint.length > 0 &&
    typeof candidate.at === "string" &&
    Number.isFinite(Date.parse(candidate.at))
  );
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

function actionRequestFor(record: WorkflowRecord, actionPackage: unknown, idempotencyKey?: string): ActionRequest {
  return {
    version: "1",
    type: "ActionRequest",
    idempotencyKey: idempotencyKey ?? record.actionIdempotencyKey,
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
