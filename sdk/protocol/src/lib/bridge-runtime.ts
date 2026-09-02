import { randomUUID } from "node:crypto";
import type { ActionPackage, Did } from "../types/mpas.js";
import { computeJsonHash } from "../utils/hash.js";
import {
  buildCancelTaskResult,
  buildCompleteToolCallResult,
  buildCreateTaskResult,
  buildGetTaskResult,
  buildUpdateTaskResult,
  type TaskResultConfig,
} from "./bridge-tasks.js";
import type {
  CancelTaskResult,
  GetTaskResult,
  TasksToolCallResult,
  UpdateTaskResult,
} from "./mcp-tasks-extension.js";
import { workflowProposerDid } from "./mpas-task-meta.js";
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
  /** Background MPAS engine tick interval. Default 2000ms. */
  pollIntervalMs?: number;
  /** Client-facing tasks/get polling hint. Default 5000ms. */
  taskPollIntervalMs?: number;
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
  private readonly pollIntervalMs: number;
  private ticker?: ReturnType<typeof setInterval>;

  constructor(options: ProposerBridgeOptions) {
    this.tools = structuredClone(options.tools);
    this.buildActionPackage = options.buildActionPackage;
    this.store = options.store;
    this.proposerDid = options.proposerDid;
    this.resultConfig = {
      resultRetentionSeconds: options.resultRetentionSeconds,
      taskPollIntervalMs: options.taskPollIntervalMs ?? 5_000,
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
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.engine = new BridgeWorkflowEngine({
      store: options.store,
      ...(options.actionEndpoint !== undefined ? { actionEndpoint: options.actionEndpoint } : {}),
      ...(options.coordinationService !== undefined ? { coordinationService: options.coordinationService } : {}),
      ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
      ...(options.coordination !== undefined ? { coordination: options.coordination } : {}),
      buildCoordinationReplacement: options.buildCoordinationReplacement,
      proposerDid: options.proposerDid,
      ...(options.workerId !== undefined ? { workerId: options.workerId } : {}),
      submissionTimeoutMs: options.submissionTimeoutMs ?? inferredSubmissionTimeoutMs(options),
      ...(options.claimLeaseMs !== undefined ? { claimLeaseMs: options.claimLeaseMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
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
  async handleToolCall(toolName: string, args: object): Promise<TasksToolCallResult> {
    const outcome = await this.proposeToolCall(toolName, args);
    return outcome.kind === "settled"
      ? buildCompleteToolCallResult(outcome.record)
      : buildCreateTaskResult(outcome.record, this.resultConfig);
  }

  /** Legacy application and reserved wait-tool dispatch over the same workflow. */
  async handleCompatibilityToolCall(toolName: string, args: object): Promise<CompatibilityToolResult> {
    if (toolName === MPAS_WAIT_TOOL_NAME) {
      return this.handleCompatibilityWait(args);
    }
    if (!this.tools.some((tool) => tool.name === toolName)) {
      return buildCompatibilityError("UNKNOWN_TOOL", `Unknown tool: ${toolName}`, false);
    }

    try {
      const outcome = await this.proposeToolCall(toolName, args);
      return compatibilityResultForRecord(outcome.record, this.compatibilityResultConfig);
    } catch {
      return buildCompatibilityError(
        "BRIDGE_UNAVAILABLE",
        "Could not construct or durably record the MPAS Action.",
        true,
      );
    }
  }

  /** Read-only Task observation; never advances the MPAS workflow. */
  handleTasksGet(taskId: string): GetTaskResult {
    return buildGetTaskResult(this.visibleRecord(taskId), this.resultConfig);
  }

  /** MPAS v1 has no input_required state, so known responses are ignored. */
  handleTasksUpdate(taskId: string, _inputResponses: Record<string, unknown>): UpdateTaskResult {
    this.visibleRecord(taskId);
    return buildUpdateTaskResult();
  }

  /** Cooperatively cancel future bridge work and best-effort cancel Coordination. */
  async handleTasksCancel(taskId: string): Promise<CancelTaskResult> {
    this.visibleRecord(taskId);
    const result = await this.engine.cancel(taskId);
    if (!result) throw new TaskNotFoundError(taskId);
    return buildCancelTaskResult();
  }

  async start(): Promise<void> {
    if (this.ticker) return;
    await this.engine.reconcile();
    this.ticker = setInterval(() => {
      void this.engine.pollOnce().then(() => {
        this.store.purgeExpiredResults(this.resultConfig.resultRetentionSeconds * 1_000);
      });
    }, this.pollIntervalMs);
    this.ticker.unref?.();
  }

  stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  async pollOnce(): Promise<void> {
    await this.engine.pollOnce();
    this.store.purgeExpiredResults(this.resultConfig.resultRetentionSeconds * 1_000);
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
      const visible = this.visibleCompatibilityRecord(input.actionId);
      const record = await this.engine.waitForResult(visible.taskId, input.timeoutSeconds * 1_000);
      if (!record || workflowProposerDid(record) !== this.proposerDid) {
        return buildCompatibilityError(
          "ACTION_NOT_FOUND",
          "No visible Action matches the supplied Action ID.",
          false,
        );
      }
      return compatibilityResultForRecord(record, this.compatibilityResultConfig);
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
