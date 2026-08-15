import type { ActionPackage, Did } from "../types/mpas.js";
import { computeHash } from "../utils/hash.js";
import {
  buildCancelTaskResult,
  buildCreateTaskResult,
  buildGetTaskResult,
  buildUpdateTaskResult,
  type TaskResultConfig,
} from "./bridge-tasks.js";
import type {
  CancelTaskResult,
  CreateTaskResult,
  GetTaskResult,
  UpdateTaskResult,
} from "./mcp-tasks-extension.js";
import { workflowProposerDid } from "./mpas-task-meta.js";
import {
  BridgeWorkflowEngine,
  type WorkflowAdapter,
  type WorkflowCoordination,
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
  store: WorkflowStore;
  adapter: WorkflowAdapter;
  coordination: WorkflowCoordination;
  proposerDid: Did;
  resultRetentionSeconds: number;
  /** Background MPAS engine tick interval. Default 2000ms. */
  pollIntervalMs?: number;
  /** Client-facing tasks/get polling hint. Default 5000ms. */
  taskPollIntervalMs?: number;
  workerId?: string;
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
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.engine = new BridgeWorkflowEngine({
      store: options.store,
      adapter: options.adapter,
      coordination: options.coordination,
      proposerDid: options.proposerDid,
      ...(options.workerId !== undefined ? { workerId: options.workerId } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  /** Return the exact discovered upstream tool surface. */
  getToolDefinitions(): BridgeUpstreamTool[] {
    return structuredClone(this.tools);
  }

  /** Every accepted application call creates and returns an official Task. */
  async handleToolCall(toolName: string, args: object): Promise<CreateTaskResult> {
    if (!this.tools.some((tool) => tool.name === toolName)) {
      throw new UnknownBridgeToolError(toolName);
    }

    const actionPackage = await this.buildActionPackage(toolName, args);
    const envelope = actionPackage.actionEnvelope;
    const outcome = await this.engine.propose({
      actionId: envelope.actionId.value,
      actionEnvelopeHash: computeHash(envelope).value,
      toolName,
      actionPackage,
      expiresAt: envelope.expiresAt,
    });
    return buildCreateTaskResult(outcome.record, this.resultConfig);
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

  private visibleRecord(taskId: string): WorkflowRecord {
    const record = this.store.getWorkflow(taskId);
    if (!record) throw new TaskNotFoundError(taskId);
    if (workflowProposerDid(record) !== this.proposerDid) {
      throw new TaskNotFoundError(taskId);
    }
    return record;
  }
}
