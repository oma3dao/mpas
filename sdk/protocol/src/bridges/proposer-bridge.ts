import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ValidateFunction } from "ajv";
import type { JWK } from "jose";
import type { McpToolDefinition, ToolCallResult } from "../types/mcp.js";
import type { AdapterResponse, ActionReference, MpasApplicationPlugin } from "../types/mpas.js";
import type { ProposerConfig } from "../types/config.js";
import { ActionPackageBuilder } from "../lib/action-package-builder.js";
import { AdapterClient } from "../lib/adapter-client.js";
import { CoordinationClient } from "../lib/coordination-client.js";
import { KeyManager } from "../lib/key-manager.js";
import { PluginToolGenerator } from "../lib/plugin-tool-generator.js";

function log(level: "info" | "warn" | "error", msg: string, data?: object): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  process.stderr.write(`[mpas-bridge] ${JSON.stringify(entry)}\n`);
}

export class ProposerBridge {
  private readonly plugin: MpasApplicationPlugin;
  private readonly toolGenerator: PluginToolGenerator;
  private readonly adapterClient: AdapterClient;
  private readonly coordinationClient?: CoordinationClient;
  private readonly keyManagerPromise: Promise<KeyManager>;
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv2020({ strict: false });

  constructor(private readonly config: ProposerConfig) {
    this.plugin = loadPlugin(config.plugin);
    this.toolGenerator = new PluginToolGenerator(this.plugin);
    this.adapterClient = new AdapterClient({ url: config.adapterUrl });
    this.coordinationClient = config.coordinationUrl ? new CoordinationClient({ url: config.coordinationUrl }) : undefined;
    this.keyManagerPromise = loadKeyManager(config.agentKey);

    for (const tool of this.toolGenerator.generateTools()) {
      this.validators.set(tool.name, this.ajv.compile(tool.inputSchema));
    }
  }

  getToolDefinitions(): McpToolDefinition[] {
    return this.toolGenerator.generateTools();
  }

  async handleToolCall(toolName: string, args: object): Promise<ToolCallResult> {
    log("info", "tool_call_received", { toolName });
    const validation = this.validateToolCall(toolName, args);
    if (!validation.ok) {
      log("warn", "validation_failed", { toolName, message: validation.message });
      return errorResult("VALIDATION_ERROR", validation.message, { toolName, errors: validation.errors });
    }

    const keyManager = await this.keyManagerPromise;
    const builder = new ActionPackageBuilder({
      applicationDid: this.config.applicationDid,
      executionProfile: this.config.executionProfile ?? {
        id: this.plugin.executionProfile.id,
        format: this.plugin.executionProfile.format ?? "mcp.toolsCall",
      },
      keyManager,
      defaultExpirationMinutes: this.config.defaultExpirationMinutes,
    });
    const actionPackage = await builder.buildFromToolCall(toolName, args);
    log("info", "submitting_to_adapter", { toolName, actionId: actionPackage.actionEnvelope.actionId.value });
    const response = await this.adapterClient.submit(actionPackage);
    log("info", "adapter_response", { toolName, result: response.result });

    return this.handleAdapterResponse(response, actionPackage);
  }

  buildMcpServer(): Server {
    const server = new Server(
      {
        name: "@oma3/mpas-bridge",
        version: "0.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.getToolDefinitions(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.handleToolCall(request.params.name, toArgsObject(request.params.arguments)),
    );

    return server;
  }

  private validateToolCall(toolName: string, args: object):
    | {
        ok: true;
      }
    | {
        ok: false;
        message: string;
        errors: unknown;
      } {
    const validator = this.validators.get(toolName);
    if (!validator) {
      return {
        ok: false,
        message: `Unknown tool: ${toolName}`,
        errors: [],
      };
    }

    if (!validator(args)) {
      return {
        ok: false,
        message: this.ajv.errorsText(validator.errors),
        errors: validator.errors,
      };
    }

    return { ok: true };
  }

  private async handleAdapterResponse(response: AdapterResponse, actionPackage: Awaited<ReturnType<ActionPackageBuilder["buildFromToolCall"]>>): Promise<ToolCallResult> {
    if (response.result === "additionalApprovalsRequired") {
      return this.handleAdditionalApprovals(response, actionPackage);
    }
    return mapTerminalResponse(response);
  }

  private async handleAdditionalApprovals(
    response: AdapterResponse,
    actionPackage: Awaited<ReturnType<ActionPackageBuilder["buildFromToolCall"]>>,
  ): Promise<ToolCallResult> {
    const strategy = this.config.approvalStrategy ?? "coordinate";
    log("info", "additional_approvals_required", { strategy, hasCoordinationClient: !!this.coordinationClient });
    let coordinationActionRef: ActionReference | undefined;

    if (strategy === "coordinate" || strategy === "wait") {
      if (!this.coordinationClient) {
        log("error", "coordination_not_configured", { strategy });
        return errorResult("COORDINATION_NOT_CONFIGURED", "Approval strategy requires coordinationUrl.", response);
      }
      if (!response.authorizationRequirements) {
        log("error", "missing_auth_requirements");
        return errorResult("MISSING_AUTH_REQUIREMENTS", "additionalApprovalsRequired without authorizationRequirements.", response);
      }
      log("info", "submitting_to_coordination");
      const coordinationResponse = await this.coordinationClient.submitAction(
        actionPackage,
        response.authorizationRequirements,
      );
      coordinationActionRef = coordinationResponse.actionRef;
      log("info", "coordination_submitted", { actionEnvelopeHash: coordinationActionRef?.actionEnvelopeHash?.value });
    }

    if (strategy === "wait" && this.coordinationClient && coordinationActionRef) {
      log("info", "entering_wait_loop", { timeoutMs: this.config.approvalTimeoutMs ?? 30_000 });
      return this.waitForCoordinatedResult(
        actionPackage,
        coordinationActionRef.actionEnvelopeHash.value,
        response,
      );
    }

    log("info", "returning_pending_immediately", { strategy, hasCoordinationClient: !!this.coordinationClient, hasActionRef: !!coordinationActionRef });
    return {
      content: [
        {
          type: "text",
          text: "Additional approvals required.",
        },
      ],
      structuredContent: {
        status: "pending",
        actionId: actionPackage.actionEnvelope.actionId.value,
        coordinationActionRef,
        authorizationRequirements: response.authorizationRequirements,
      },
    };
  }

  private async waitForCoordinatedResult(
    originalActionPackage: Awaited<ReturnType<ActionPackageBuilder["buildFromToolCall"]>>,
    actionEnvelopeHash: string,
    response: AdapterResponse,
  ): Promise<ToolCallResult> {
    const timeoutMs = this.config.approvalTimeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    const keyManager = await this.keyManagerPromise;
    let pollCount = 0;

    while (Date.now() <= deadline) {
      pollCount++;
      try {
        const poll = await this.coordinationClient?.poll(keyManager.did);
        const update = poll?.actionUpdates.find(
          (candidate) => candidate.actionRef.actionEnvelopeHash.value === actionEnvelopeHash,
        );
        if (pollCount === 1 || pollCount % 50 === 0) {
          log("info", "poll_result", { pollCount, foundUpdate: !!update, state: update?.state, totalUpdates: poll?.actionUpdates?.length ?? 0 });
        }
        if (update?.state === "readyForResubmission" && update.actionPackage) {
          log("info", "resubmitting_approved_action", { pollCount });
          const adapterResponse = await this.adapterClient.submit(update.actionPackage);
          log("info", "resubmission_response", { result: adapterResponse.result });
          return this.handleResubmittedAdapterResponse(adapterResponse);
        }
        if (update?.state === "cancelled") {
          log("warn", "action_cancelled", { pollCount });
          return errorResult("COORDINATED_ACTION_CANCELLED", "Coordinated action was cancelled.", { update });
        }
        if (update?.state === "expired") {
          log("warn", "action_expired", { pollCount });
          return errorResult("COORDINATED_ACTION_EXPIRED", "Coordinated action expired before approvals were collected.", { update });
        }
      } catch (error) {
        log("error", "poll_error", { pollCount, error: error instanceof Error ? error.message : String(error) });
      }

      await sleep(Math.min(2000, Math.max(100, deadline - Date.now())));
    }

    log("warn", "wait_timeout", { pollCount, timeoutMs });
    return {
      content: [
        {
          type: "text",
          text: "Additional approvals still pending.",
        },
      ],
      structuredContent: {
        status: "pending",
        actionId: originalActionPackage.actionEnvelope.actionId.value,
        actionEnvelopeHash,
        authorizationRequirements: response.authorizationRequirements,
      },
    };
  }

  private async handleResubmittedAdapterResponse(response: AdapterResponse): Promise<ToolCallResult> {
    if (response.result === "additionalApprovalsRequired") {
      return {
        content: [
          {
            type: "text",
            text: "Additional approvals still required after resubmission.",
          },
        ],
        structuredContent: {
          status: "pending",
          authorizationRequirements: response.authorizationRequirements,
        },
      };
    }
    return mapTerminalResponse(response);
  }
}

function loadPlugin(plugin: ProposerConfig["plugin"]): MpasApplicationPlugin {
  if (typeof plugin === "string") {
    return JSON.parse(readFileSync(plugin, "utf8")) as MpasApplicationPlugin;
  }

  return plugin;
}

function loadKeyManager(agentKey: ProposerConfig["agentKey"]): Promise<KeyManager> {
  if (typeof agentKey === "string") {
    return KeyManager.fromFile(agentKey);
  }

  return Promise.resolve(KeyManager.fromJwk(agentKey as JWK));
}

function toArgsObject(args: unknown): object {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args;
  }

  return {};
}

/**
 * Map any terminal (non-coordination) ActionResponse result to an MCP tool result.
 * Unknown result values hit an explicit error path — no silent fallthrough.
 */
function mapTerminalResponse(response: AdapterResponse): ToolCallResult {
  switch (response.result) {
    case "executed":
      return relayExecutionResult(response.executionResult);
    case "failed":
      // A tool-level failure (isError: true) carries the verbatim target response,
      // which the agent is built to handle; relay it. Protocol-level failures do not.
      return response.executionResult !== undefined
        ? relayExecutionResult(response.executionResult)
        : errorResult(response.error?.code ?? "EXECUTION_FAILED", response.error?.message ?? "Execution failed definitively.", response);
    case "indeterminate":
      return indeterminateResult(response);
    case "pending":
      return pendingResult(response);
    case "rejected":
      return errorResult(response.error?.code ?? "REJECTED", response.error?.message ?? "Action was rejected.", response);
    case "expired":
      return errorResult(response.error?.code ?? "EXPIRED", response.error?.message ?? "Action Envelope expired; a new Action Envelope is required.", response);
    case "cancelled":
      // Reserved verifier-side cancellation result; terminal, treat as rejected.
      return errorResult(response.error?.code ?? "CANCELLED", response.error?.message ?? "Action was cancelled.", response);
    case "malformed":
      return errorResult(response.error?.code ?? "MALFORMED", response.error?.message ?? "Action Package is malformed.", response);
    case "notSupported":
      return errorResult(response.error?.code ?? "NOT_SUPPORTED", response.error?.message ?? "The Verifier does not support this action (non-retryable configuration error).", response);
    case "policyUnavailable":
      return errorResult(response.error?.code ?? "POLICY_UNAVAILABLE", response.error?.message ?? "The Verifier could not evaluate policy; retry later.", response);
    default:
      return errorResult("UNRECOGNIZED_RESULT", `Adapter returned an unrecognized result: ${String((response as { result?: unknown }).result)}.`, response as unknown as Record<string, unknown>);
  }
}

/** Relay execution-profile-native output verbatim to the agent (MCP tools/call result). */
function relayExecutionResult(result: unknown): ToolCallResult {
  if (isRecord(result) && Array.isArray(result.content)) {
    return {
      content: result.content as ToolCallResult["content"],
      structuredContent: result,
      ...(result.isError === true ? { isError: true } : {}),
    };
  }

  return {
    content: [
      {
        type: "text",
        text: result === undefined ? "Action executed." : JSON.stringify(result),
      },
    ],
    ...(result === undefined ? {} : { structuredContent: isRecord(result) ? result : { value: result } }),
  };
}

function errorResult(code: string, message: string, structuredContent?: object): ToolCallResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${code}: ${message}`,
      },
    ],
    structuredContent: structuredContent as Record<string, unknown> | undefined,
  };
}

function indeterminateResult(response: AdapterResponse): ToolCallResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "INDETERMINATE: Execution was dispatched but the outcome could not be confirmed. Do not automatically retry with the same actionId; reconcile out of band and submit a new Action Envelope if needed.",
      },
    ],
    structuredContent: {
      status: "indeterminate",
      executionReceipt: response.executionReceipt,
    },
  };
}

function pendingResult(response: AdapterResponse): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: "Action is executing or awaiting execution. No second dispatch will occur for an identical resubmission.",
      },
    ],
    structuredContent: {
      status: "pending",
      actionRequestId: response.actionRequestId,
      pollAfter: response.pollAfter,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
