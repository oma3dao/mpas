import { describe, expect, it } from "vitest";
import type { ActionPackage, ActionResponse, Did } from "../../src/index.js";
import { computeHash } from "../../src/index.js";
import { MPAS_WAIT_TOOL_NAME } from "../../src/lib/bridge-compatibility.js";
import { ProposerBridge } from "../../src/lib/bridge-runtime.js";
import { MemoryWorkflowStore } from "../../src/lib/workflow-store.js";
import type { WorkflowAdapter, WorkflowCoordination } from "../../src/lib/workflow-engine.js";

const PROPOSER_DID = "did:jwk:compatibility-proposer" as Did;
const OTHER_DID = "did:jwk:other" as Did;

let serial = 0;

async function buildPackage(toolName: string, args: object, proposerDid = PROPOSER_DID): Promise<ActionPackage> {
  serial += 1;
  const actionEnvelope = {
    version: "1" as const,
    type: "ActionEnvelope" as const,
    proposer: { did: proposerDid },
    target: { applicationDid: "did:web:example.com" as Did },
    executionProfile: { id: "did:web:example.com:profiles:mcp" as Did, format: "mcp.toolsCall" },
    executionPayloadHash: { alg: "sha-256" as const, value: "payload-hash" },
    actionId: { value: `urn:uuid:1000000${serial}-0000-4000-8000-000000000000` },
    createdAt: "2026-08-23T10:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  return {
    version: "1",
    type: "ActionPackage",
    executionPayload: { name: toolName, arguments: args } as unknown as ActionPackage["executionPayload"],
    actionEnvelope,
    approvalBundle: {
      version: "1",
      type: "ApprovalBundle",
      actionEnvelopeHash: computeHash(actionEnvelope),
      approvals: [],
    },
  };
}

function response(result: ActionResponse["result"], extra: Partial<ActionResponse> = {}): ActionResponse {
  return { version: "1", type: "ActionResponse", result, ...extra };
}

function adapter(...script: (ActionResponse | Error)[]): WorkflowAdapter {
  return {
    async submit() {
      const next = script.shift();
      if (!next) throw new Error("adapter script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function coordination(): WorkflowCoordination {
  return {
    async submitAction(pkg: unknown) {
      const actionPackage = pkg as ActionPackage;
      return {
        version: "1",
        type: "CoordinationActionResponse",
        actionRef: {
          version: "1",
          type: "ActionRef",
          actionId: actionPackage.actionEnvelope.actionId,
          actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
        },
        state: "awaitingApprovals",
      };
    },
    async poll() {
      return { version: "1", type: "CoordinationPollResponse", approvalRequests: [], actionUpdates: [] };
    },
    async cancelAction(actionId) {
      return {
        version: "1",
        type: "CoordinationActionCancelResponse",
        actionRef: {
          version: "1",
          type: "ActionRef",
          actionId,
          actionEnvelopeHash: { alg: "sha-256", value: "hash" },
        },
        state: "cancelled",
        cancelledAt: "2026-08-23T10:01:00.000Z",
      };
    },
  };
}

function makeBridge(
  workflowAdapter: WorkflowAdapter,
  options: { store?: MemoryWorkflowStore; tools?: Array<Record<string, any>>; buildFails?: boolean } = {},
) {
  return new ProposerBridge({
    tools: (options.tools ?? [
      {
        name: "merge_pull_request",
        description: "Merge a pull request.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { merged: { type: "boolean" } } },
      },
    ]) as any,
    buildActionPackage: options.buildFails
      ? async () => {
          throw new Error("secret-bearing internal error");
        }
      : buildPackage,
    buildCoordinationReplacement: async (priorPackage, verifierRequirements) => ({
      actionPackage: priorPackage,
      authorizationRequirements: verifierRequirements,
    }),
    store: options.store ?? new MemoryWorkflowStore({ now: () => Date.parse("2026-08-23T10:00:00.000Z") }),
    adapter: workflowAdapter,
    coordination: coordination(),
    proposerDid: PROPOSER_DID,
    resultRetentionSeconds: 86_400,
    maxWaitTimeoutSeconds: 30,
    now: () => Date.parse("2026-08-23T10:00:00.000Z"),
  });
}

function actionId(result: Record<string, any>): string {
  return result.structuredContent.actionRef.actionId.value as string;
}

function taskId(result: Record<string, any>): string {
  return result.structuredContent.taskId as string;
}

describe("legacy MCP compatibility bridge surface", () => {
  it("adds the wait tool and modifies only compatibility definitions", () => {
    const bridge = makeBridge(adapter());
    expect(bridge.getToolDefinitions()).toEqual([
      expect.objectContaining({ name: "merge_pull_request", description: "Merge a pull request." }),
    ]);

    const tools = bridge.getCompatibilityToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual(["merge_pull_request", MPAS_WAIT_TOOL_NAME]);
    expect(tools[0]?.description).toContain("may return a deferred Action reference");
    expect((tools[0]?.outputSchema?.anyOf as Array<Record<string, unknown>>)[0]).toEqual({
      type: "object",
      properties: { merged: { type: "boolean" } },
    });
    expect(tools[1]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("reserves the wait-tool name against an upstream collision", () => {
    expect(() =>
      makeBridge(adapter(), {
        tools: [
          { name: MPAS_WAIT_TOOL_NAME, description: "hostile", inputSchema: { type: "object" } },
          { name: "safe", inputSchema: { type: "object" } },
        ],
      }),
    ).toThrow(/reserved compatibility tool name/);
  });

  it("returns a deferred result and observes it without advancing the workflow", async () => {
    const bridge = makeBridge(adapter(response("pending")));
    const proposed = await bridge.handleCompatibilityToolCall("merge_pull_request", { pullNumber: 42 });
    expect(proposed).toMatchObject({
      structuredContent: {
        version: "1",
        type: "MpasBridgeDeferredResult",
        lastActionResponse: { result: "pending" },
      },
    });

    const observed = await bridge.handleCompatibilityToolCall(MPAS_WAIT_TOOL_NAME, {
      actionId: actionId(proposed),
      timeoutSeconds: 0,
    });
    expect(observed).toMatchObject({
      structuredContent: { type: "MpasBridgeDeferredResult", actionRef: { actionId: { value: actionId(proposed) } } },
    });
  });

  it("returns native completed results verbatim", async () => {
    const native = { content: [{ type: "text" as const, text: "merged" }], structuredContent: { merged: true } };
    const bridge = makeBridge(adapter(response("executed", { executionResult: native })));
    await expect(bridge.handleCompatibilityToolCall("merge_pull_request", {})).resolves.toEqual(native);
  });

  it("maps cancelled records to a terminal compatibility error", async () => {
    const bridge = makeBridge(adapter(response("pending")));
    const proposed = await bridge.handleCompatibilityToolCall("merge_pull_request", {});
    await bridge.handleTasksCancel(taskId(proposed));

    await expect(
      bridge.handleCompatibilityToolCall(MPAS_WAIT_TOOL_NAME, {
        actionId: actionId(proposed),
        timeoutSeconds: 0,
      }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { type: "MpasBridgeError", code: "ACTION_CANCELLED", retryable: false },
    });
  });

  it("validates waits and hides unknown or cross-DID workflows", async () => {
    const store = new MemoryWorkflowStore();
    const foreign = await buildPackage("merge_pull_request", {}, OTHER_DID);
    store.createWorkflow({
      taskId: "urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff",
      actionId: foreign.actionEnvelope.actionId.value,
      actionIdempotencyKey: "foreign-action-attempt",
      actionEnvelopeHash: foreign.approvalBundle.actionEnvelopeHash.value,
      toolName: "merge_pull_request",
      actionPackage: foreign,
      expiresAt: foreign.actionEnvelope.expiresAt,
    });
    const bridge = makeBridge(adapter(), { store });

    await expect(bridge.handleCompatibilityToolCall(MPAS_WAIT_TOOL_NAME, {})).resolves.toMatchObject({
      structuredContent: { code: "INVALID_WAIT_TOOL_INPUT" },
    });
    await expect(
      bridge.handleCompatibilityToolCall(MPAS_WAIT_TOOL_NAME, {
        actionId: "missing",
        timeoutSeconds: 0,
      }),
    ).resolves.toMatchObject({ structuredContent: { code: "ACTION_NOT_FOUND" } });
    await expect(
      bridge.handleCompatibilityToolCall(MPAS_WAIT_TOOL_NAME, {
        actionId: foreign.actionEnvelope.actionId.value,
        timeoutSeconds: 0,
      }),
    ).resolves.toMatchObject({ structuredContent: { code: "ACTION_NOT_FOUND" } });
  });

  it("does not expose action-construction failures", async () => {
    const bridge = makeBridge(adapter(), { buildFails: true });
    const result = await bridge.handleCompatibilityToolCall("merge_pull_request", {});
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "BRIDGE_UNAVAILABLE", retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain("secret-bearing");
  });
});
