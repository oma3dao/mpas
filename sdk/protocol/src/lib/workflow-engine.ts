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
import { ActionEndpointClientError } from "./action-endpoint-client.js";
import { ActionRelayResponseError } from "./action-relay-client.js";
import { AdapterRequestError, AdapterResponseError } from "./adapter-client.js";
import { CoordinationResponseError, MpasAuthError } from "./coordination-client.js";
import { computeIdempotencyFingerprint, RoutingValidationError } from "./routing.js";
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

/** Remote call recorded in a workflow's durable attempt log. */
type AttemptStage = "initial" | "coordination" | "completed";

/**
 * Outcome of one remote call (feature reduce-polling §5.2):
 * - `responded`: a definitive response was received and persisted;
 * - `pending`: the Verifier answered `pending` (legacy); re-check later;
 * - `unreachable`: a transient failure or unknown outcome; retry later;
 * - `interrupted`: shutdown cut the call short; outcome unknown, no backoff;
 * - `rejected`: a permanent failure; the workflow stops.
 */
type AttemptOutcome = "responded" | "pending" | "unreachable" | "interrupted" | "rejected";

/**
 * One durable attempt-log entry. `notBefore` is the earliest time the call may
 * be retried, so backoff survives a restart.
 */
interface AttemptRecord {
  stage: AttemptStage;
  outcome: AttemptOutcome;
  at: string;
  message?: string;
  retryAfterMs?: number;
  consecutive?: number;
  notBefore?: string;
}

const ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set(["responded", "pending", "unreachable", "interrupted", "rejected"]);

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
  /** One observation-driven operation per Task (see {@link advanceTask}). */
  private readonly advancing = new Map<string, Promise<void>>();
  /** Set by {@link stop}: no new remote call starts after shutdown begins. */
  private stopped = false;
  /** Set by {@link markInFlightAborted}: shutdown is aborting calls still in flight. */
  private inFlightAborted = false;
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
      if (this.stopped) {
        // Recorded but never sent; resumes on a later observation.
        return { kind: "deferred", record: current } as const;
      }
      if (!this.store.claimWorkflow(current.taskId, this.workerId, this.claimLeaseMs)) {
        return { kind: "deferred", record: this.mustGet(current.taskId) } as const;
      }
      return this.submitInitial(this.mustGet(current.taskId));
    });
    return result;
  }

  /**
   * Begin shutdown: no new remote call starts after this (feature
   * reduce-polling §6.2). Calls already sent may finish and persist their
   * outcomes; a late Coordination response may still update durable state,
   * but starts no Verifier submission.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Note that shutdown is about to abort the calls still in flight, once its
   * grace period has expired. From then on, a call that fails without an HTTP
   * response is recorded as `interrupted`. A response received at any time,
   * including during the grace period, keeps its normal classification and
   * backoff, so a `503` with `Retry-After` keeps its delay.
   */
  markInFlightAborted(): void {
    this.inFlightAborted = true;
  }

  /**
   * Earliest time this workflow's next remote call may run, from its durable
   * attempt log, or undefined if it may run now.
   */
  retryNotBefore(record: WorkflowRecord): number | undefined {
    const last = lastAttempt(record);
    if (!last || (last.outcome !== "unreachable" && last.outcome !== "pending") || last.notBefore === undefined) {
      return undefined;
    }
    const notBefore = Date.parse(last.notBefore);
    return Number.isFinite(notBefore) ? notBefore : undefined;
  }

  /**
   * One unthrottled tick: expiry sweep, Coordination poll, and advancement of
   * every workflow this worker can claim, ignoring backoff.
   *
   * @deprecated Bridges progress on observation through
   * {@link refreshCoordination} and {@link advanceTask}.
   */
  async pollOnce(): Promise<void> {
    const expiry = this.sweepExpired();
    try {
      await this.refreshCoordination({ advanceReady: false });
    } catch {
      // Coordination updates are one input to the engine. Independent
      // Action retries must still run when this input is unavailable.
    }
    await this.advanceClaimable();
    await expiry;
  }

  /**
   * Poll Coordination once and apply its updates (feature reduce-polling §4).
   * Does nothing unless this proposer has a workflow awaiting approvals.
   * Permanent failures resolve those workflows; retryable failures reject so
   * the caller can back off. Coordination updates join each Task's outbound
   * lane so they cannot terminate a submit that is still in flight.
   *
   * Directly dependent work follows: each workflow this poll newly moved from
   * `awaitingApprovals` to `readyForSubmission` has its completed package
   * submitted, whichever Task was observed. With `advanceReady: false` the
   * caller does that instead, using the returned Task IDs. After {@link stop},
   * no poll starts and no submission follows.
   */
  async refreshCoordination(options: { advanceReady?: boolean } = {}): Promise<string[]> {
    if (this.stopped || !this.hasAwaitingApprovals()) {
      return [];
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
      return [];
    }
    // Only a transition this poll applied, from awaitingApprovals to
    // readyForSubmission, is newly approved work. A repeated ready update for
    // a workflow whose submission already failed is not, and is retried only
    // when that Task itself is observed.
    const ready: string[] = [];
    for (const update of poll.actionUpdates) {
      const applied = await this.applyUpdate(update);
      if (applied?.newlyReady) ready.push(applied.taskId);
    }
    if (options.advanceReady !== false) {
      await Promise.all(ready.map((taskId) => this.advanceTask(taskId)));
    }
    return ready;
  }

  /**
   * Run one observed Task's next remote step if it is due (feature
   * reduce-polling §5): a failed submission's retry, a Verifier `pending`
   * re-check, or a completed package's submission. At most one such
   * operation per Task is in flight; another observation joins it rather
   * than queuing a second attempt. Eligibility is checked when the operation
   * runs, inside the Task's lane, and its outcome is recorded before the lane
   * is released.
   */
  advanceTask(taskId: string): Promise<void> {
    const running = this.advancing.get(taskId);
    if (running) return running;
    const operation = this.dispatchClaimable(taskId, true);
    const tracked = operation.finally(() => {
      if (this.advancing.get(taskId) === tracked) this.advancing.delete(taskId);
    });
    this.advancing.set(taskId, tracked);
    return tracked;
  }

  /**
   * Resolve an overdue workflow as expired now, so a reader never sees it as
   * still working. Leaves a workflow alone while an operation holds its lane.
   */
  expireIfOverdue(taskId: string): void {
    if (this.outboundTails.has(taskId)) return;
    const current = this.store.getWorkflow(taskId);
    if (!current || isTerminal(current) || proposerDidOf(current) !== this.proposerDid) return;
    if (Date.parse(current.expiresAt) >= this.now()) return;
    if (this.store.claimWorkflow(taskId, this.workerId, this.claimLeaseMs)) {
      this.resolveUnresolvable(
        taskId,
        "ACTION_EXPIRED_BEFORE_RESOLUTION",
        "The Action Envelope expired without a terminal Verifier response.",
      );
    }
  }

  /** Local cleanup: resolve every overdue workflow as expired. Never contacts a remote service. */
  expireOverdue(): Promise<void> {
    return this.sweepExpired();
  }

  /** Whether this proposer has a workflow that Coordination could advance. */
  hasAwaitingApprovals(): boolean {
    return this.store
      .listRecoverableWorkflows()
      .some((record) => record.state === "awaitingApprovals" && proposerDidOf(record) === this.proposerDid);
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

  /**
   * Full recovery pass: expire overdue workflows and immediately resume every
   * interrupted submission, ignoring backoff. Idempotent. The proposer bridge
   * runtime does not call this at startup; it expires locally with
   * {@link expireOverdue} and resumes each Task on observation
   * (feature reduce-polling §6.3).
   */
  async reconcile(): Promise<void> {
    await this.sweepExpired();
    await this.advanceClaimable();
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
    if (this.stopped || !this.holdClaim(current.taskId)) {
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
      this.recordFailure(record.taskId, "initial", error, "ACTION_SUBMISSION_REJECTED");
      return { kind: "deferred", record: this.mustGet(record.taskId) };
    }

    if (isTerminal(this.mustGet(record.taskId))) {
      return { kind: "deferred", record: this.mustGet(record.taskId) };
    }

    switch (response.result) {
      case "additionalApprovalsRequired": {
        this.recordAttempt(record.taskId, "initial", "responded");
        this.store.saveLastActionResponse(record.taskId, response);
        return this.replaceAndSubmitToCoordination(this.mustGet(record.taskId), "created", response);
      }
      case "pending":
        this.recordAttempt(record.taskId, "initial", "pending");
        this.store.saveLastActionResponse(record.taskId, response);
        this.store.compareAndSetState(record.taskId, "created", "awaitingVerifierResult");
        return { kind: "deferred", record: this.mustGet(record.taskId) };
      default:
        this.recordAttempt(record.taskId, "initial", "responded");
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
    if (this.stopped || !this.holdClaim(record.taskId)) {
      // After stop: the Verifier's response is persisted, the Coordination
      // workflow is not yet created, and creation resumes on observation.
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
      this.recordAttempt(record.taskId, "coordination", "responded");
      this.store.compareAndSetState(record.taskId, "submittingToCoordination", "awaitingApprovals");
    } catch (error) {
      if (permanentCoordinationFailure(error)) {
        this.recordAttempt(record.taskId, "coordination", "rejected", error);
        const resolution = coordinationFailureResolution(error);
        this.resolveUnresolvable(record.taskId, resolution.errorCode, resolution.errorMessage);
      } else {
        this.recordFailure(record.taskId, "coordination", error, "COORDINATION_REQUEST_REJECTED");
      }
    }
    return { kind: "deferred", record: this.mustGet(record.taskId) };
  }

  /**
   * Apply one update to this proposer's matching workflow. `newlyReady` is
   * true only when this update moved it from `awaitingApprovals` to
   * `readyForSubmission`, decided inside the Task's serialized lane.
   */
  private async applyUpdate(
    update: CoordinationActionUpdate,
  ): Promise<{ taskId: string; newlyReady: boolean } | undefined> {
    const actionId = update.actionRef.actionId.value;
    const record = this.store.getWorkflowByActionId(actionId);
    if (!record || proposerDidOf(record) !== this.proposerDid || isTerminal(record)) {
      return undefined;
    }
    let newlyReady = false;

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
            if (current.state !== "awaitingApprovals") break;
            this.store.saveCompletedPackage(current.taskId, update.actionPackage);
            newlyReady = this.store.compareAndSetState(current.taskId, "awaitingApprovals", "readyForSubmission");
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
    return { taskId: record.taskId, newlyReady };
  }

  /** Advance every claimable workflow, ignoring backoff ({@link pollOnce}, {@link reconcile}). */
  private async advanceClaimable(): Promise<void> {
    await Promise.all(
      this.store
        .listRecoverableWorkflows()
        .filter((record) => proposerDidOf(record) === this.proposerDid)
        .filter((record) => record.state !== "awaitingApprovals")
        .map((record) => this.dispatchClaimable(record.taskId, false)),
    );
  }

  /**
   * Append one remote call's outcome to the durable attempt log. A retryable
   * failure or a Verifier `pending` also records when the call may next run
   * (exponential backoff with jitter, honoring `Retry-After`), so the
   * schedule follows the last attempted call and survives a restart.
   */
  private recordAttempt(taskId: string, stage: AttemptStage, outcome: AttemptOutcome, error?: unknown): void {
    const record = this.store.getWorkflow(taskId);
    const previous = record ? lastAttempt(record) : undefined;
    const entry: AttemptRecord = { stage, outcome, at: new Date(this.now()).toISOString() };
    if (error !== undefined) entry.message = error instanceof Error ? error.message : String(error);
    if (outcome === "unreachable" || outcome === "pending") {
      const consecutive = previous?.outcome === outcome ? (previous.consecutive ?? 1) + 1 : 1;
      const retryAfterMs = outcome === "unreachable" ? retryAfterMsOf(error) : undefined;
      const delay = backoffDelayMs(
        consecutive,
        outcome === "unreachable" ? FAILURE_BACKOFF : PENDING_BACKOFF,
        this.random,
        retryAfterMs,
      );
      entry.consecutive = consecutive;
      if (retryAfterMs !== undefined) entry.retryAfterMs = retryAfterMs;
      entry.notBefore = new Date(this.now() + delay).toISOString();
    }
    this.store.saveAdapterAttempt(taskId, entry);
  }

  /**
   * Record a failed remote call by class (feature reduce-polling §5.5): a
   * permanent failure surfaces and stops the workflow; a call that the
   * shutdown abort cut short, with no HTTP response, has an unknown outcome
   * and no backoff; anything else, including any response received during
   * the shutdown grace period, is a transient failure or unknown outcome,
   * retried with the same key after its backoff.
   */
  private recordFailure(taskId: string, stage: AttemptStage, error: unknown, permanentCode: string): void {
    if (isPermanentRemoteFailure(error)) {
      this.recordAttempt(taskId, stage, "rejected", error);
      this.resolveUnresolvable(
        taskId,
        permanentCode,
        error instanceof Error ? error.message : "The request was permanently rejected.",
      );
      return;
    }
    const interrupted = this.inFlightAborted && httpStatusOf(error) === undefined;
    this.recordAttempt(taskId, stage, interrupted ? "interrupted" : "unreachable", error);
  }

  /**
   * Enqueue one recoverable row on its Task lane. Expiry, backoff, claim and
   * submit are all decided only after joining that lane, so a concurrent
   * operation for the same Task cannot double-submit or retry early, and
   * other Tasks are not blocked. The attempt's outcome is recorded before
   * the lane is released.
   */
  private async dispatchClaimable(taskId: string, respectSchedule: boolean): Promise<void> {
    await this.dispatchOutbound(taskId, async () => {
      const current = this.store.getWorkflow(taskId);
      if (!current || isTerminal(current) || proposerDidOf(current) !== this.proposerDid) {
        return;
      }
      if (Date.parse(current.expiresAt) < this.now()) {
        if (this.store.claimWorkflow(taskId, this.workerId, this.claimLeaseMs)) {
          this.resolveUnresolvable(
            taskId,
            "ACTION_EXPIRED_BEFORE_RESOLUTION",
            "The Action Envelope expired without a terminal Verifier response.",
          );
        }
        return;
      }
      if (this.stopped) {
        return;
      }
      if (respectSchedule && (this.retryNotBefore(current) ?? 0) > this.now()) {
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
    if (this.stopped || !this.holdClaim(current.taskId)) {
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
      this.recordFailure(current.taskId, "completed", error, "ACTION_SUBMISSION_REJECTED");
      this.store.compareAndSetState(current.taskId, "submittingToVerifier", "readyForSubmission");
      return;
    }

    if (isTerminal(this.mustGet(current.taskId))) {
      return;
    }

    this.recordAttempt(current.taskId, "completed", response.result === "pending" ? "pending" : "responded");
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
      .filter((binding) => binding.stage === phase && binding.idempotencyKey === record.actionIdempotencyKey);
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

/** The HTTP status of the response behind a client error, if a response was received. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** The most recent remote-call outcome in a workflow's attempt log. */
function lastAttempt(record: WorkflowRecord): AttemptRecord | undefined {
  for (let index = record.adapterAttempts.length - 1; index >= 0; index -= 1) {
    const entry = record.adapterAttempts[index];
    if (
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      ATTEMPT_OUTCOMES.has(String((entry as { outcome?: unknown }).outcome))
    ) {
      return entry as AttemptRecord;
    }
  }
  return undefined;
}

/**
 * Failures that a retry cannot fix: authentication and authorization,
 * explicit non-retryable rejections, protocol and validation errors. Every
 * HTTP client classifies HTTP failures with the same rule
 * (`isRetryableHttpFailure`): an `MpasHttpError` `retryable` flag wins,
 * otherwise 408, 425, 429 and 5xx are retryable.
 * Anything else is a transient failure or an unknown outcome, which the
 * idempotency contract makes safe to retry with the same key and request.
 */
function isPermanentRemoteFailure(error: unknown): boolean {
  if (error instanceof MpasAuthError) return true;
  if (error instanceof CoordinationResponseError) return true;
  if (error instanceof ActionRelayResponseError) return true;
  if (error instanceof RoutingValidationError) return true;
  if (error instanceof ActionEndpointClientError) return error.retryable === false;
  if (error instanceof AdapterResponseError) return true;
  if (error instanceof AdapterRequestError) return !error.retryable;
  return false;
}
