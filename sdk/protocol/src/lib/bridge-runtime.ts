import { randomUUID } from "node:crypto";
import type { ActionPackage, Did } from "../types/mpas.js";
import { computeJsonHash } from "../utils/hash.js";
import {
  buildCancelTaskResult,
  buildCompleteToolCallResult,
  buildCreateTaskResult,
  buildGetTaskResult,
  buildUpdateTaskResult,
  DEFAULT_TASK_POLL_INTERVAL_MS,
  type TaskResultConfig,
} from "./bridge-tasks.js";
import type {
  CancelTaskResult,
  GetTaskResult,
  TasksToolCallResult,
  UpdateTaskResult,
} from "./mcp-tasks-extension.js";
import { workflowProposerDid } from "./mpas-task-meta.js";
import { backoffDelayMs, FAILURE_BACKOFF, retryAfterMsOf } from "./retry-backoff.js";
import {
  MPAS_WAIT_TOOL_NAME,
  buildCompatibilityError,
  buildCompatibilityToolDefinitions,
  compatibilityResultForRecord,
  validateCompatibilityWaitInput,
  type CompatibilityResultOptions,
  type CompatibilityToolResult,
} from "./bridge-compatibility.js";
import {
  BridgeWorkflowEngine,
  DEFAULT_SUBMISSION_TIMEOUT_MS,
  type WorkflowActionEndpoint,
  type WorkflowAdapter,
  type WorkflowCoordination,
  type WorkflowCoordinationService,
  type BuildCoordinationReplacement,
  type ProposeResult,
} from "./workflow-engine.js";
import type { WorkflowRecord, WorkflowStore } from "./workflow-store.js";

/** Shared runtime used by generated official MCP Tasks proposer bridges. */

export interface BridgeUpstreamTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProposerBridgeOptions {
  upstreamBinding?: import("../types/mpas.js").UpstreamBinding;
  tools: BridgeUpstreamTool[];
  buildActionPackage: (toolName: string, args: object) => Promise<ActionPackage>;
  buildCoordinationReplacement: BuildCoordinationReplacement;
  store: WorkflowStore;
  /** Common Action endpoint used for initial and completed Action submission. */
  actionEndpoint?: WorkflowActionEndpoint;
  /** Coordination Service used for approval collection and workflow updates. */
  coordinationService?: WorkflowCoordinationService;
  /** @deprecated Use {@link actionEndpoint}. */
  adapter?: WorkflowAdapter;
  /** @deprecated Use {@link coordinationService}. */
  coordination?: WorkflowCoordination;
  proposerDid: Did;
  resultRetentionSeconds: number;
  /**
   * @deprecated Ignored. Bridges no longer poll on a timer; see
   * {@link coordinationRefreshMinIntervalMs} (feature reduce-polling §7).
   */
  pollIntervalMs?: number;
  /** Client-facing tasks/get polling hint. Default 60000ms. */
  taskPollIntervalMs?: number;
  /**
   * Minimum time between Coordination polls started by client observation.
   * Default {@link DEFAULT_COORDINATION_REFRESH_MIN_INTERVAL_MS}; values below
   * {@link MIN_COORDINATION_REFRESH_INTERVAL_MS} are raised to it.
   */
  coordinationRefreshMinIntervalMs?: number;
  /** Default wait in {@link ProposerBridge.shutdown}. Default {@link DEFAULT_SHUTDOWN_GRACE_MS}. */
  shutdownGraceMs?: number;
  /** Legacy wait-tool maximum. Default 300 seconds. */
  maxWaitTimeoutSeconds?: number;
  /** Deployment assigns maintainer notification outside the proposing client. */
  notificationAssignedElsewhere?: boolean;
  workerId?: string;
  /**
   * Maximum wait of one claimed Action or Coordination submit. Defaults to the
   * Action endpoint or Coordination client `timeoutMs` when present, otherwise
   * {@link DEFAULT_SUBMISSION_TIMEOUT_MS}.
   */
  submissionTimeoutMs?: number;
  /**
   * Worker claim lease. Must exceed the submission timeout. Default
   * {@link DEFAULT_CLAIM_LEASE_MS}.
   */
  claimLeaseMs?: number;
  now?: () => number;
  /** Jitter source for backoff, in [0, 1). Default `Math.random`. */
  random?: () => number;
}

/** Default minimum time between Coordination polls (feature reduce-polling §4.2). */
export const DEFAULT_COORDINATION_REFRESH_MIN_INTERVAL_MS = 10_000;
/** Smallest accepted {@link ProposerBridgeOptions.coordinationRefreshMinIntervalMs}. */
export const MIN_COORDINATION_REFRESH_INTERVAL_MS = 5_000;
/** Minimum time between local cleanups triggered by client activity (feature reduce-polling §5.2). */
export const LOCAL_CLEANUP_MIN_INTERVAL_MS = 10_000;
/** Default shutdown grace (feature reduce-polling §6.2). */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
/** How long shutdown waits for aborted calls to record their interruption. */
export const SHUTDOWN_SETTLE_MS = 500;

export class BridgeShuttingDownError extends Error {
  constructor() {
    super("The MPAS bridge is shutting down.");
    this.name = "BridgeShuttingDownError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super("Task not found");
    this.name = "TaskNotFoundError";
  }
}

export class UnknownBridgeToolError extends Error {
  constructor(readonly toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = "UnknownBridgeToolError";
  }
}

export class ProposerBridge {
  private readonly tools: BridgeUpstreamTool[];
  private readonly buildActionPackage: ProposerBridgeOptions["buildActionPackage"];
  private readonly engine: BridgeWorkflowEngine;
  private readonly store: WorkflowStore;
  private readonly proposerDid: Did;
  private readonly resultConfig: TaskResultConfig;
  private readonly compatibilityResultConfig: CompatibilityResultOptions;
  private readonly compatibilityTools: BridgeUpstreamTool[];
  private readonly maxWaitTimeoutSeconds: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly refreshMinIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private closed = false;
  private lastCleanupAt = Number.NEGATIVE_INFINITY;
  /** Work started by a request that may outlive it, tracked for shutdown. */
  private readonly background = new Set<Promise<unknown>>();
  private refreshInFlight?: Promise<void>;
  private refreshNotBefore = 0;
  private refreshFailures = 0;
  private coordinationCheckedAt: string | null = null;
  private readonly active = new Set<Promise<unknown>>();
  private shutdownPromise?: Promise<void>;

  constructor(options: ProposerBridgeOptions) {
    this.tools = structuredClone(options.tools);
    this.buildActionPackage = options.buildActionPackage;
    this.store = options.store;
    this.proposerDid = options.proposerDid;
    this.resultConfig = {
      resultRetentionSeconds: options.resultRetentionSeconds,
      taskPollIntervalMs: options.taskPollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS,
    };
    this.compatibilityResultConfig = {
      resultRetentionSeconds: options.resultRetentionSeconds,
      ...(options.notificationAssignedElsewhere !== undefined
        ? { notificationAssignedElsewhere: options.notificationAssignedElsewhere }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    };
    this.maxWaitTimeoutSeconds = options.maxWaitTimeoutSeconds ?? 300;
    this.compatibilityTools = buildCompatibilityToolDefinitions(this.tools, {
      maxTimeoutSeconds: this.maxWaitTimeoutSeconds,
    });
    if (options.pollIntervalMs !== undefined) {
      warnPollIntervalDeprecated();
    }
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.refreshMinIntervalMs = Math.max(
      MIN_COORDINATION_REFRESH_INTERVAL_MS,
      options.coordinationRefreshMinIntervalMs ?? DEFAULT_COORDINATION_REFRESH_MIN_INTERVAL_MS,
    );
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.engine = new BridgeWorkflowEngine({
      store: options.store,
      ...(options.actionEndpoint !== undefined ? { actionEndpoint: options.actionEndpoint } : {}),
      ...(options.coordinationService !== undefined ? { coordinationService: options.coordinationService } : {}),
      ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
      ...(options.coordination !== undefined ? { coordination: options.coordination } : {}),
      buildCoordinationReplacement: options.buildCoordinationReplacement,
      proposerDid: options.proposerDid,
      ...(options.upstreamBinding !== undefined ? { upstreamBinding: options.upstreamBinding } : {}),
      ...(options.workerId !== undefined ? { workerId: options.workerId } : {}),
      submissionTimeoutMs: options.submissionTimeoutMs ?? inferredSubmissionTimeoutMs(options),
      ...(options.claimLeaseMs !== undefined ? { claimLeaseMs: options.claimLeaseMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.random !== undefined ? { random: options.random } : {}),
    });
  }

  /** Return the exact discovered upstream tool surface. */
  getToolDefinitions(): BridgeUpstreamTool[] {
    return structuredClone(this.tools);
  }

  /** Legacy MCP surface selected only for clients that initialize conventionally. */
  getCompatibilityToolDefinitions(): BridgeUpstreamTool[] {
    return structuredClone(this.compatibilityTools);
  }

  /** Return a normal tool result on the fast path; expose a Task only when deferred. */
  handleToolCall(toolName: string, args: object): Promise<TasksToolCallResult> {
    return this.track(async () => {
      this.cleanupLocal();
      const outcome = await this.proposeToolCall(toolName, args);
      return outcome.kind === "settled"
        ? buildCompleteToolCallResult(outcome.record)
        : buildCreateTaskResult(outcome.record, this.taskResultConfig());
    });
  }

  /** Legacy application and reserved wait-tool dispatch over the same workflow. */
  handleCompatibilityToolCall(toolName: string, args: object): Promise<CompatibilityToolResult> {
    return this.track(async () => {
      if (toolName === MPAS_WAIT_TOOL_NAME) {
        return this.handleCompatibilityWait(args);
      }
      this.cleanupLocal();
      if (!this.tools.some((tool) => tool.name === toolName)) {
        return buildCompatibilityError("UNKNOWN_TOOL", `Unknown tool: ${toolName}`, false);
      }

      try {
        const outcome = await this.proposeToolCall(toolName, args);
        return compatibilityResultForRecord(outcome.record, this.compatibilityConfig());
      } catch {
        return buildCompatibilityError(
          "BRIDGE_UNAVAILABLE",
          "Could not construct or durably record the MPAS Action.",
          true,
        );
      }
    });
  }

  /**
   * Task observation. Returns local state without waiting on the network, and
   * starts the observed Task's next step in the background: a rate-limited
   * Coordination poll while approvals are awaited, otherwise its due retry
   * (feature reduce-polling §4, §5). An overdue Task is reported as expired.
   */
  handleTasksGet(taskId: string): GetTaskResult {
    this.assertOpen();
    // Observe first: the cleanup sweep would otherwise hold this Task's lane
    // and keep an overdue Task from reading as expired.
    const record = this.observe(this.visibleRecord(taskId));
    this.cleanupLocal();
    return buildGetTaskResult(record, this.taskResultConfig());
  }

  /** MPAS v1 has no input_required state, so known responses are ignored. */
  handleTasksUpdate(taskId: string, _inputResponses: Record<string, unknown>): UpdateTaskResult {
    this.assertOpen();
    this.visibleRecord(taskId);
    return buildUpdateTaskResult();
  }

  /** Cooperatively cancel future bridge work and best-effort cancel Coordination. */
  handleTasksCancel(taskId: string): Promise<CancelTaskResult> {
    return this.track(async () => {
      this.cleanupLocal();
      this.visibleRecord(taskId);
      const result = await this.engine.cancel(taskId);
      if (!result) throw new TaskNotFoundError(taskId);
      return buildCancelTaskResult();
    });
  }

  /**
   * Startup reconciliation, local only: expire overdue workflows and purge
   * old results. Contacts no remote service. An interrupted submission
   * resumes when its Task is next observed (feature reduce-polling §6.3).
   */
  async start(): Promise<void> {
    if (this.closed) return;
    await this.cleanupLocal(true);
  }

  /**
   * Nothing runs on a timer, so there is nothing to stop. Kept for API
   * compatibility; use {@link shutdown} to stop serving requests.
   */
  stop(): void {}

  /**
   * Shut down conservatively (feature reduce-polling §6.2). Idempotent.
   *
   * 1. Stop accepting requests and starting new remote calls.
   * 2. Let calls already sent finish and persist their outcomes, for up to
   *    `graceMs`. Work started meanwhile, such as applying a late Coordination
   *    response, is tracked too.
   * 3. If work remains, call `abortInFlight` (the wrapper aborts its HTTP
   *    clients), then wait up to {@link SHUTDOWN_SETTLE_MS} for the aborted
   *    calls to record their interruption.
   *
   * Resolves when no tracked work remains or both waits have expired. The
   * caller closes the store afterwards. Unfinished workflows keep their Task
   * IDs and idempotency keys; an interrupted call is recorded as an unknown
   * outcome, never as failed or cancelled.
   */
  shutdown(
    graceMs: number = this.shutdownGraceMs,
    options: { abortInFlight?: () => void } = {},
  ): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.engine.stop();
    // Compatibility waits answer now with the current state rather than holding shutdown.
    this.engine.releaseWaiters();
    this.shutdownPromise = (async () => {
      if (await this.waitForIdle(graceMs)) return;
      // Only failures caused by this abort are recorded as interrupted.
      this.engine.markInFlightAborted();
      options.abortInFlight?.();
      await this.waitForIdle(SHUTDOWN_SETTLE_MS);
    })();
    return this.shutdownPromise;
  }

  /**
   * Poll Coordination now unless a poll is in flight (its result is shared),
   * the minimum interval since the last poll has not elapsed, or a failure
   * backoff is active. Never rejects.
   */
  refreshCoordination(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const startedAt = this.now();
    if (startedAt < this.refreshNotBefore || !this.engine.hasAwaitingApprovals()) {
      return Promise.resolve();
    }
    this.refreshNotBefore = startedAt + this.refreshMinIntervalMs;
    const refresh = this.engine.refreshCoordination({ advanceReady: false }).then(
      (ready) => {
        this.refreshFailures = 0;
        this.coordinationCheckedAt = new Date(this.now()).toISOString();
        // Directly dependent work: submit every package this poll found approved.
        for (const taskId of ready) this.runInBackground(this.engine.advanceTask(taskId));
      },
      (error: unknown) => {
        this.refreshFailures += 1;
        const delay = backoffDelayMs(this.refreshFailures, FAILURE_BACKOFF, this.random, retryAfterMsOf(error));
        this.refreshNotBefore = Math.max(this.refreshNotBefore, this.now() + delay);
      },
    );
    this.refreshInFlight = refresh.finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  /**
   * One unthrottled engine tick, ignoring backoff.
   *
   * @deprecated The bridge progresses on Task observation; see {@link handleTasksGet}.
   */
  async pollOnce(): Promise<void> {
    await this.engine.pollOnce();
    this.store.purgeExpiredResults(this.resultConfig.resultRetentionSeconds * 1_000);
  }

  private taskResultConfig(): TaskResultConfig {
    return { ...this.resultConfig, coordinationCheckedAt: this.coordinationCheckedAt };
  }

  private compatibilityConfig(): CompatibilityResultOptions {
    return { ...this.compatibilityResultConfig, coordinationCheckedAt: this.coordinationCheckedAt };
  }

  private assertOpen(): void {
    if (this.closed) throw new BridgeShuttingDownError();
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new BridgeShuttingDownError());
    const promise = operation();
    this.active.add(promise);
    const remove = () => {
      this.active.delete(promise);
    };
    promise.then(remove, remove);
    return promise;
  }

  /**
   * Start the observed Task's next step in the background and return its
   * current record. Expiry is enforced first, so an overdue Task reads as
   * expired and starts nothing.
   */
  private observe(record: WorkflowRecord): WorkflowRecord {
    this.engine.expireIfOverdue(record.taskId);
    const current = this.store.getWorkflow(record.taskId) ?? record;
    if (current.state === "awaitingApprovals") {
      void this.refreshCoordination();
    } else if (ADVANCEABLE_STATES.has(current.state)) {
      this.runInBackground(this.engine.advanceTask(current.taskId));
    }
    return current;
  }

  /**
   * Bounded local cleanup on client activity: expire overdue workflows and
   * purge results past retention, at most once per
   * {@link LOCAL_CLEANUP_MIN_INTERVAL_MS}. Contacts no remote service.
   */
  private cleanupLocal(force = false): Promise<void> {
    const nowMs = this.now();
    if (!force && nowMs - this.lastCleanupAt < LOCAL_CLEANUP_MIN_INTERVAL_MS) return Promise.resolve();
    this.lastCleanupAt = nowMs;
    this.store.purgeExpiredResults(this.resultConfig.resultRetentionSeconds * 1_000);
    return this.runInBackground(this.engine.expireOverdue());
  }

  /**
   * Wait until no tracked work remains, re-checking as work settles so that
   * work started during the wait is included. Returns false on timeout.
   */
  private async waitForIdle(timeoutMs: number): Promise<boolean> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      for (;;) {
        const pending = this.pendingWork();
        if (pending.length === 0) return true;
        await Promise.race([Promise.allSettled(pending), deadline]);
        if (timedOut) return this.pendingWork().length === 0;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private pendingWork(): Promise<unknown>[] {
    return [...this.active, ...this.background, this.refreshInFlight]
      .filter((promise): promise is Promise<unknown> => promise !== undefined);
  }

  /** Track work that may outlive the request that started it; never rejects. */
  private runInBackground(work: Promise<unknown>): Promise<void> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.background.add(settled);
    void settled.then(() => this.background.delete(settled));
    return settled;
  }

  private async proposeToolCall(toolName: string, args: object): Promise<ProposeResult> {
    if (!this.tools.some((tool) => tool.name === toolName)) {
      throw new UnknownBridgeToolError(toolName);
    }

    const actionPackage = await this.buildActionPackage(toolName, args);
    const envelope = actionPackage.actionEnvelope;
    return this.engine.propose({
      taskId: `urn:uuid:${randomUUID()}`,
      actionId: envelope.actionId.value,
      actionIdempotencyKey: randomUUID(),
      actionEnvelopeHash: computeJsonHash(envelope).value,
      toolName,
      actionPackage,
      expiresAt: envelope.expiresAt,
    });
  }

  private async handleCompatibilityWait(args: object): Promise<CompatibilityToolResult> {
    const input = validateCompatibilityWaitInput(args, {
      maxTimeoutSeconds: this.maxWaitTimeoutSeconds,
    });
    if (input.kind === "error") {
      return buildCompatibilityError(input.code, input.message, false);
    }

    try {
      // Start the next step but never await it: the timeout runs from call
      // entry, and a slow poll or submission cannot extend it.
      const visible = this.observe(this.visibleCompatibilityRecord(input.actionId));
      this.cleanupLocal();
      // A wait that outlives shutdown's waiter release answers with the current state.
      const timeoutMs = this.closed ? 0 : input.timeoutSeconds * 1_000;
      const record = await this.engine.waitForResult(visible.taskId, timeoutMs);
      if (!record || workflowProposerDid(record) !== this.proposerDid) {
        return buildCompatibilityError(
          "ACTION_NOT_FOUND",
          "No visible Action matches the supplied Action ID.",
          false,
        );
      }
      return compatibilityResultForRecord(record, this.compatibilityConfig());
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        return buildCompatibilityError(
          "ACTION_NOT_FOUND",
          "No visible Action matches the supplied Action ID.",
          false,
        );
      }
      return buildCompatibilityError("BRIDGE_UNAVAILABLE", "Could not read the MPAS Action result.", true);
    }
  }

  private visibleRecord(taskId: string): WorkflowRecord {
    const record = this.store.getWorkflow(taskId);
    if (!record) throw new TaskNotFoundError(taskId);
    if (workflowProposerDid(record) !== this.proposerDid) {
      throw new TaskNotFoundError(taskId);
    }
    return record;
  }

  private visibleCompatibilityRecord(actionId: string): WorkflowRecord {
    const record = this.store.getWorkflowByActionId(actionId);
    if (!record || workflowProposerDid(record) !== this.proposerDid) {
      throw new TaskNotFoundError(actionId);
    }
    return record;
  }
}

/** States whose next step is a remote call this bridge makes on observation. */
const ADVANCEABLE_STATES: ReadonlySet<WorkflowRecord["state"]> = new Set([
  "created",
  "submittingToCoordination",
  "readyForSubmission",
  "submittingToVerifier",
  "awaitingVerifierResult",
]);

let pollIntervalWarningEmitted = false;

function warnPollIntervalDeprecated(): void {
  if (pollIntervalWarningEmitted) return;
  pollIntervalWarningEmitted = true;
  process.emitWarning(
    "pollIntervalMs is ignored: MPAS bridges poll Coordination only when a client observes a Task. " +
      "Use coordinationRefreshMinIntervalMs to set the minimum interval between polls.",
    { type: "DeprecationWarning", code: "MPAS_BRIDGE_POLL_INTERVAL" },
  );
}

function inferredSubmissionTimeoutMs(options: ProposerBridgeOptions): number {
  const timeouts = [
    clientTimeoutMs(options.actionEndpoint),
    clientTimeoutMs(options.coordinationService),
    clientTimeoutMs(options.adapter),
    clientTimeoutMs(options.coordination),
  ].filter((value): value is number => value !== undefined);
  return timeouts.length > 0 ? Math.max(...timeouts) : DEFAULT_SUBMISSION_TIMEOUT_MS;
}

function clientTimeoutMs(client: object | undefined): number | undefined {
  if (client === undefined || !("timeoutMs" in client)) {
    return undefined;
  }
  const timeoutMs = (client as { timeoutMs: unknown }).timeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : undefined;
}
