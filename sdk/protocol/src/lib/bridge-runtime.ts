import type { ActionPackage } from "../types/mpas.js";
import { computeHash } from "../utils/hash.js";
import {
  MPAS_WAIT_TOOL_NAME,
  appendMpasNotice,
  buildApplicationOutputSchema,
  buildBridgeError,
  buildWaitToolDefinition,
  toolResultForRecord,
  validateWaitInput,
  type BridgeToolResult,
} from "./bridge-results.js";
import {
  BridgeWorkflowEngine,
  type WorkflowAdapter,
  type WorkflowCoordination,
} from "./workflow-engine.js";
import type { WorkflowStore } from "./workflow-store.js";

/**
 * Shared proposer-bridge runtime (implementation plan §5.1).
 *
 * A generated bridge wires its application-specific tool definitions and
 * configuration around this class. It exposes the client-profile MCP surface:
 * upstream tools (with the MPAS notice and output-schema unions), the
 * reserved `mpas_wait_for_action_result` tool, and the profile result
 * objects. The workflow store is injected — the SDK ships an in-memory
 * reference; durable stores are deployment code.
 */

export interface BridgeUpstreamTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProposerBridgeOptions {
  /** Upstream application tool definitions, preserved per profile §3.1. */
  tools: BridgeUpstreamTool[];
  /** Builds a signed Action Package for one application tool call. */
  buildActionPackage: (toolName: string, args: object) => Promise<ActionPackage>;
  store: WorkflowStore;
  adapter: WorkflowAdapter;
  coordination: WorkflowCoordination;
  proposerDid: string;
  resultRetentionSeconds: number;
  /** Deployment assigns maintainer notification to the bridge or another component. */
  notificationAssignedElsewhere?: boolean;
  /** Advertised wait-tool maximum (profile §6.1). Default 300. */
  maxTimeoutSeconds?: number;
  /** Background tick interval for start(). Default 2000ms. */
  pollIntervalMs?: number;
  workerId?: string;
  now?: () => number;
}

export class ProposerBridge {
  private readonly tools: BridgeUpstreamTool[];
  private readonly buildActionPackage: ProposerBridgeOptions["buildActionPackage"];
  private readonly engine: BridgeWorkflowEngine;
  private readonly store: WorkflowStore;
  private readonly resultRetentionSeconds: number;
  private readonly notificationAssignedElsewhere: boolean;
  private readonly maxTimeoutSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private ticker?: ReturnType<typeof setInterval>;

  constructor(options: ProposerBridgeOptions) {
    this.tools = options.tools;
    this.buildActionPackage = options.buildActionPackage;
    this.store = options.store;
    this.resultRetentionSeconds = options.resultRetentionSeconds;
    this.notificationAssignedElsewhere = options.notificationAssignedElsewhere ?? false;
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? 300;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.now = options.now ?? (() => Date.now());
    this.engine = new BridgeWorkflowEngine({
      store: options.store,
      adapter: options.adapter,
      coordination: options.coordination,
      proposerDid: options.proposerDid,
      ...(options.workerId !== undefined ? { workerId: options.workerId } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  /** Upstream tools with the MPAS notice and output unions, plus the wait tool. */
  getToolDefinitions(): BridgeUpstreamTool[] {
    const application = this.tools.map((tool) => {
      const outputSchema = buildApplicationOutputSchema(tool.outputSchema);
      return {
        ...tool,
        description: appendMpasNotice(tool.description),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
      };
    });
    return [...application, buildWaitToolDefinition({ maxTimeoutSeconds: this.maxTimeoutSeconds }) as unknown as BridgeUpstreamTool];
  }

  async handleToolCall(toolName: string, args: object): Promise<BridgeToolResult> {
    if (toolName === MPAS_WAIT_TOOL_NAME) {
      return this.handleWait(args);
    }
    if (!this.tools.some((tool) => tool.name === toolName)) {
      return buildBridgeError("UNKNOWN_TOOL", `Unknown tool: ${toolName}`, false);
    }
    return this.handleApplicationCall(toolName, args);
  }

  /**
   * Startup reconciliation plus the background tick loop (bridge track).
   * The loop is what lets Actions progress with no client request in flight.
   */
  async start(): Promise<void> {
    await this.engine.reconcile();
    this.ticker = setInterval(() => {
      void this.engine.pollOnce().then(() => {
        this.store.purgeExpiredResults(this.resultRetentionSeconds * 1000);
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

  /** One background tick, exposed for deployments and tests that drive their own cadence. */
  async pollOnce(): Promise<void> {
    await this.engine.pollOnce();
    this.store.purgeExpiredResults(this.resultRetentionSeconds * 1000);
  }

  private async handleApplicationCall(toolName: string, args: object): Promise<BridgeToolResult> {
    let actionPackage: ActionPackage;
    try {
      actionPackage = await this.buildActionPackage(toolName, args);
    } catch (error) {
      return buildBridgeError("BRIDGE_UNAVAILABLE", sanitizedMessage(error, "Could not construct the Action Package."), true);
    }

    const envelope = actionPackage.actionEnvelope;
    const outcome = await this.engine.propose({
      actionId: envelope.actionId.value,
      actionEnvelopeHash: computeHash(envelope).value,
      toolName,
      actionPackage,
      expiresAt: envelope.expiresAt,
    });

    return toolResultForRecord(outcome.record, this.resultOptions());
  }

  private async handleWait(args: object): Promise<BridgeToolResult> {
    const input = validateWaitInput(args, { maxTimeoutSeconds: this.maxTimeoutSeconds });
    if (input.kind === "error") {
      return buildBridgeError(input.code, input.message, false);
    }

    const record = await this.engine.waitForResult(input.actionId, input.timeoutSeconds * 1000);
    if (!record) {
      return buildBridgeError("ACTION_NOT_FOUND", "No visible Action matches the supplied Action ID.", false);
    }
    return toolResultForRecord(record, this.resultOptions());
  }

  private resultOptions() {
    return {
      resultRetentionSeconds: this.resultRetentionSeconds,
      notificationAssignedElsewhere: this.notificationAssignedElsewhere,
      now: this.now,
    };
  }
}

function sanitizedMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
