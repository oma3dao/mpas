import type {
  ActionId,
  ActionResponse,
  CoordinationActionResponse,
  CoordinationActionUpdate,
  CoordinationCancelResponse,
  CoordinationPollResponse,
  Did,
} from "../types/mpas.js";
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
 * package resubmission, terminal storage, startup reconciliation, and expiry.
 * The client track observes through {@link waitForResult}, which never
 * advances a workflow (client profile §6.4, §7.1).
 *
 * Result recovery is best effort (feature spec §11). Dispatch stays
 * at-most-once via the Verifier ledger; when a crash window loses the terminal
 * response, the identical resubmission is rejected as a replay and the engine
 * marks the workflow `unresolvable` rather than fabricating an outcome.
 */

/** The adapter surface the engine needs (satisfied by AdapterClient). */
export interface WorkflowAdapter {
  submit(pkg: unknown): Promise<ActionResponse>;
}

/** The coordination surface the engine needs (satisfied by CoordinationClient). */
export interface WorkflowCoordination {
  submitAction(pkg: unknown, authorizationRequirements: unknown): Promise<CoordinationActionResponse>;
  poll(did: string): Promise<CoordinationPollResponse>;
  cancelAction(actionId: ActionId, did: Did): Promise<CoordinationCancelResponse>;
}

export interface BridgeWorkflowEngineOptions {
  store: WorkflowStore;
  adapter: WorkflowAdapter;
  coordination: WorkflowCoordination;
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

const NONTERMINAL_RESULTS = new Set<ActionResponse["result"]>(["additionalApprovalsRequired", "pending"]);

export class BridgeWorkflowEngine {
  private readonly store: WorkflowStore;
  private readonly adapter: WorkflowAdapter;
  private readonly coordination: WorkflowCoordination;
  private readonly proposerDid: Did;
  private readonly workerId: string;
  private readonly claimLeaseMs: number;
  private readonly now: () => number;
  private readonly waiters = new Map<string, Set<(record: WorkflowRecord) => void>>();

  constructor(options: BridgeWorkflowEngineOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.coordination = options.coordination;
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
      const poll = await this.coordination.poll(this.proposerDid);
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
  async cancel(actionId: string): Promise<WorkflowRecord | undefined> {
    const record = this.store.getWorkflow(actionId);
    if (!record || proposerDidOf(record) !== this.proposerDid) {
      return undefined;
    }
    if (isTerminal(record)) {
      return record;
    }

    const coordinationStarted = record.coordinationRef !== undefined;
    if (!this.store.cancelWorkflow(actionId)) {
      return this.store.getWorkflow(actionId);
    }

    const cancelled = this.mustGet(actionId);
    this.notify(cancelled);
    if (coordinationStarted) {
      try {
        await this.coordination.cancelAction({ value: actionId }, this.proposerDid);
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
      if (!this.store.claimWorkflow(record.actionId, this.workerId, this.claimLeaseMs)) {
        continue;
      }
      switch (record.state) {
        case "created":
          await this.submitInitial(record);
          break;
        case "submittingToVerifier":
          // Crash mid-submission: the identical package may or may not have
          // been transmitted. Resubmit identically; the ledger dedups.
          this.store.compareAndSetState(record.actionId, "submittingToVerifier", "readyForResubmission");
          await this.submitCompleted(this.mustGet(record.actionId));
          break;
        case "readyForResubmission":
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
  async waitForResult(actionId: string, timeoutMs: number): Promise<WorkflowRecord | undefined> {
    const record = this.store.getWorkflow(actionId);
    if (!record || isTerminal(record) || timeoutMs <= 0) {
      return record;
    }

    return new Promise<WorkflowRecord>((resolve) => {
      const waiters = this.waiters.get(actionId) ?? new Set();
      this.waiters.set(actionId, waiters);

      const timer = setTimeout(() => {
        waiters.delete(wake);
        resolve(this.mustGet(actionId));
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
    const current = this.store.getWorkflow(record.actionId);
    if (!current || isTerminal(current)) {
      return { kind: "deferred", record: current ?? record };
    }

    let response: ActionResponse;
    try {
      response = await this.adapter.submit(record.actionPackage);
    } catch (error) {
      this.store.saveAdapterAttempt(record.actionId, attempt("initial", "unreachable", error));
      return { kind: "deferred", record: this.mustGet(record.actionId) };
    }

    if (isTerminal(this.mustGet(record.actionId))) {
      return { kind: "deferred", record: this.mustGet(record.actionId) };
    }

    switch (response.result) {
      case "additionalApprovalsRequired": {
        this.store.saveLastActionResponse(record.actionId, response);
        if (response.authorizationRequirements !== undefined) {
          this.store.saveAuthorizationRequirements(record.actionId, response.authorizationRequirements);
        }
        try {
          const coordination = await this.coordination.submitAction(
            record.actionPackage,
            response.authorizationRequirements,
          );
          this.store.saveCoordinationReference(record.actionId, coordination.actionRef);
          if (this.mustGet(record.actionId).state === "cancelled") {
            try {
              await this.coordination.cancelAction({ value: record.actionId }, this.proposerDid);
            } catch {
              // Cancellation won while Coordination submission was in flight.
              // The local terminal state still prevents any later execution.
            }
            return { kind: "deferred", record: this.mustGet(record.actionId) };
          }
          this.store.compareAndSetState(record.actionId, "created", "awaitingApprovals");
        } catch (error) {
          // Coordination unavailable: stay `created`; reconcile retries the
          // whole (stateless) initial submission.
          this.store.saveAdapterAttempt(record.actionId, attempt("coordination", "unreachable", error));
        }
        return { kind: "deferred", record: this.mustGet(record.actionId) };
      }
      case "pending":
        this.store.saveLastActionResponse(record.actionId, response);
        this.store.compareAndSetState(record.actionId, "created", "awaitingVerifierResult");
        return { kind: "deferred", record: this.mustGet(record.actionId) };
      default:
        return this.settle(record.actionId, response);
    }
  }

  private async applyUpdate(update: CoordinationActionUpdate): Promise<void> {
    const actionId = update.actionRef.actionId.value;
    const record = this.store.getWorkflow(actionId);
    if (!record || isTerminal(record)) {
      return;
    }

    switch (update.state) {
      case "readyForResubmission":
        if (update.actionPackage !== undefined) {
          this.store.saveCompletedPackage(actionId, update.actionPackage);
          this.store.compareAndSetState(actionId, "awaitingApprovals", "readyForResubmission");
        }
        break;
      case "expired":
        this.resolveUnresolvable(actionId, "ACTION_EXPIRED_BEFORE_RESOLUTION", "The Action expired before Approvals completed.");
        break;
      case "rejected":
        this.resolveUnresolvable(
          actionId,
          "COORDINATION_REJECTED",
          "The coordination workflow was rejected before completion.",
        );
        break;
      case "executed":
        this.resolveUnresolvable(
          actionId,
          "RESULT_UNAVAILABLE",
          "Coordination reports execution, but the authoritative Verifier result is unavailable.",
        );
        break;
      case "cancelled":
        if (this.store.cancelWorkflow(actionId)) {
          this.notify(this.mustGet(actionId));
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
        record.state !== "readyForResubmission" &&
        record.state !== "awaitingVerifierResult"
      ) {
        continue;
      }
      if (!this.store.claimWorkflow(record.actionId, this.workerId, this.claimLeaseMs)) {
        continue;
      }
      if (record.state === "created") {
        await this.submitInitial(record);
      } else {
        await this.submitCompleted(record);
      }
    }
  }

  /**
   * Submit (or identically resubmit) the completed Action Package. The ledger
   * guarantees at most one dispatch; a replay rejection here means the outcome
   * was produced but lost, which resolves as `unresolvable`, never as the
   * Action's outcome.
   */
  private async submitCompleted(record: WorkflowRecord): Promise<void> {
    const pkg = record.completedPackage ?? record.actionPackage;
    if (record.state === "readyForResubmission") {
      if (!this.store.compareAndSetState(record.actionId, "readyForResubmission", "submittingToVerifier")) {
        return;
      }
    }

    let response: ActionResponse;
    try {
      response = await this.adapter.submit(pkg);
    } catch (error) {
      this.store.saveAdapterAttempt(record.actionId, attempt("completed", "unreachable", error));
      this.store.compareAndSetState(record.actionId, "submittingToVerifier", "readyForResubmission");
      return;
    }

    if (isTerminal(this.mustGet(record.actionId))) {
      return;
    }

    if (response.result === "pending") {
      this.store.saveLastActionResponse(record.actionId, response);
      this.store.compareAndSetState(record.actionId, "submittingToVerifier", "awaitingVerifierResult");
      return;
    }

    if (response.result === "rejected" && REPLAY_CODES.has(response.error?.code ?? "")) {
      this.resolveUnresolvable(
        record.actionId,
        "RESULT_UNAVAILABLE",
        "The Action was already dispatched and its result is not retrievable from the Verifier.",
      );
      return;
    }

    if (NONTERMINAL_RESULTS.has(response.result)) {
      // additionalApprovalsRequired on a completed package: policy changed or
      // approvals no longer satisfy it. Send it back through coordination on a
      // later tick rather than guessing here.
      this.store.saveLastActionResponse(record.actionId, response);
      this.store.compareAndSetState(record.actionId, "submittingToVerifier", "awaitingApprovals");
      return;
    }

    this.settle(record.actionId, response);
  }

  private settle(actionId: string, response: ActionResponse): ProposeResult {
    this.store.resolveWorkflow(actionId, {
      kind: "resolved",
      actionResponse: response,
      ...(response.executionReceipt !== undefined ? { executionReceipt: response.executionReceipt } : {}),
    });
    const record = this.mustGet(actionId);
    this.notify(record);
    return { kind: "settled", record, actionResponse: response };
  }

  private resolveUnresolvable(actionId: string, errorCode: string, errorMessage: string): void {
    this.store.resolveWorkflow(actionId, { kind: "unresolvable", errorCode, errorMessage });
    this.notify(this.mustGet(actionId));
  }

  private sweepExpired(): void {
    const nowMs = this.now();
    for (const record of this.store.listRecoverableWorkflows()) {
      if (Date.parse(record.expiresAt) < nowMs) {
        if (this.store.claimWorkflow(record.actionId, this.workerId, this.claimLeaseMs)) {
          this.resolveUnresolvable(
            record.actionId,
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
    const waiters = this.waiters.get(record.actionId);
    if (!waiters) {
      return;
    }
    this.waiters.delete(record.actionId);
    for (const wake of waiters) {
      wake(record);
    }
  }

  private mustGet(actionId: string): WorkflowRecord {
    const record = this.store.getWorkflow(actionId);
    if (!record) {
      throw new Error(`Workflow not found for action ${actionId}.`);
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

function attempt(stage: string, outcome: string, error: unknown): unknown {
  return {
    stage,
    outcome,
    message: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString(),
  };
}
