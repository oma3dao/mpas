import { describe, expect, it } from "vitest";
import type { ActionPackage, ActionResponse, Did } from "../../src/index.js";
import { computeHash } from "../../src/index.js";
import {
  ProposerBridge,
  TaskNotFoundError,
  UnknownBridgeToolError,
} from "../../src/lib/bridge-runtime.js";
import { MemoryWorkflowStore } from "../../src/lib/workflow-store.js";
import type { WorkflowAdapter, WorkflowCoordination } from "../../src/lib/workflow-engine.js";

const PROPOSER_DID = "did:jwk:proposer" as Did;
const OTHER_DID = "did:jwk:other" as Did;
const UPSTREAM_TOOLS = [
  {
    name: "merge_pull_request",
    description: "Merge a pull request.",
    inputSchema: { type: "object", properties: { pullNumber: { type: "integer" } } },
    outputSchema: { type: "object", properties: { merged: { type: "boolean" } } },
  },
];

let serial = 0;

async function buildPackage(toolName: string, args: object, proposerDid: Did = PROPOSER_DID): Promise<ActionPackage> {
  serial += 1;
  const actionEnvelope = {
    version: "1" as const,
    type: "ActionEnvelope" as const,
    proposer: { did: proposerDid },
    target: { applicationDid: "did:web:example.com" as Did },
    executionProfile: { id: "did:web:example.com:profiles:mcp" as Did, format: "mcp.toolsCall" },
    executionPayloadHash: { alg: "sha-256" as const, value: "payload-hash" },
    actionId: { value: `urn:uuid:0000000${serial}-0000-4000-8000-000000000000` },
    createdAt: "2026-08-14T10:00:00.000Z",
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

function fakeAdapter(...script: (ActionResponse | Error)[]): WorkflowAdapter {
  return {
    async submit(): Promise<ActionResponse> {
      const next = script.shift();
      if (!next) throw new Error("fakeAdapter script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function coordination(): WorkflowCoordination & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    cancelled,
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
      cancelled.push(actionId.value);
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
        cancelledAt: "2026-08-14T10:01:00.000Z",
      };
    },
  };
}

function makeBridge(adapter: WorkflowAdapter, options: { store?: MemoryWorkflowStore; proposerDid?: Did } = {}) {
  return new ProposerBridge({
    tools: UPSTREAM_TOOLS,
    buildActionPackage: (name, args) => buildPackage(name, args, options.proposerDid ?? PROPOSER_DID),
    store: options.store ?? new MemoryWorkflowStore({ now: () => Date.parse("2026-08-14T10:00:00.000Z") }),
    adapter,
    coordination: coordination(),
    proposerDid: options.proposerDid ?? PROPOSER_DID,
    resultRetentionSeconds: 86_400,
  });
}

describe("official MCP Tasks bridge runtime", () => {
  it("preserves the upstream tool surface exactly and exposes no wait tool", () => {
    expect(makeBridge(fakeAdapter()).getToolDefinitions()).toEqual(UPSTREAM_TOOLS);
  });

  it("returns a flat completed Task and exposes the native result through tasks/get", async () => {
    const native = { content: [{ type: "text", text: "merged" }], isError: false };
    const bridge = makeBridge(fakeAdapter(response("executed", { executionResult: native })));
    const created = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });

    expect(created).toMatchObject({ resultType: "task", status: "completed" });
    expect(created.taskId).toMatch(/^urn:uuid:/);
    expect(bridge.handleTasksGet(created.taskId)).toMatchObject({
      resultType: "complete",
      status: "completed",
      result: native,
    });
  });

  it("returns transparent MPAS metadata from the signed Action Package while working", async () => {
    const requirements = {
      anyOf: [{ type: "threshold" as const, threshold: 2, eligibleSigners: [PROPOSER_DID] }],
    };
    const bridge = makeBridge(
      fakeAdapter(
        response("additionalApprovalsRequired", {
          authorizationRequirements: {
            version: "1",
            type: "AuthorizationRequirements",
            result: "additionalApprovalsRequired",
            actionEnvelopeHash: { alg: "sha-256", value: "response-hash" },
            verifier: { did: "did:jwk:verifier" as Did },
            approvalRequirements: requirements,
          },
        }),
      ),
    );

    const task = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });
    expect(task).toMatchObject({
      resultType: "task",
      status: "working",
      _meta: {
        "org.oma3/mpas": {
          version: "1",
          actionId: task.taskId,
          authorizationState: "authorization_required",
          disclosure: "transparent",
          requirements,
        },
      },
    });
    const meta = task._meta?.["org.oma3/mpas"] as { actionEnvelopeHash: { value: string } };
    expect(meta.actionEnvelopeHash.value).not.toBe("response-hash");
  });

  it("completes terminal MPAS outcomes as tool-level error results", async () => {
    const bridge = makeBridge(fakeAdapter(response("rejected", { error: { code: "DENIED", message: "denied" } })));
    const created = await bridge.handleToolCall("merge_pull_request", {});
    expect(bridge.handleTasksGet(created.taskId)).toMatchObject({
      status: "completed",
      result: { isError: true, structuredContent: { type: "ActionResponse", result: "rejected" } },
    });
  });

  it("rejects unknown tools before creating a Task", async () => {
    const bridge = makeBridge(fakeAdapter());
    await expect(bridge.handleToolCall("unknown", {})).rejects.toBeInstanceOf(UnknownBridgeToolError);
  });

  it("acknowledges tasks/update for a visible Task", async () => {
    const bridge = makeBridge(fakeAdapter(response("pending")));
    const created = await bridge.handleToolCall("merge_pull_request", {});
    expect(bridge.handleTasksUpdate(created.taskId, { ignored: {} })).toEqual({ resultType: "complete" });
  });

  it("cooperatively cancels a working Task and keeps cancellation terminal", async () => {
    const store = new MemoryWorkflowStore({ now: () => Date.parse("2026-08-14T10:00:00.000Z") });
    const bridge = makeBridge(fakeAdapter(response("additionalApprovalsRequired")), { store });
    const created = await bridge.handleToolCall("merge_pull_request", {});

    await expect(bridge.handleTasksCancel(created.taskId)).resolves.toEqual({ resultType: "complete" });
    expect(bridge.handleTasksGet(created.taskId)).toMatchObject({ status: "cancelled" });
    store.resolveWorkflow(created.taskId, { kind: "resolved", actionResponse: response("executed") });
    expect(bridge.handleTasksGet(created.taskId)).toMatchObject({ status: "cancelled" });
  });

  it("treats unknown and cross-DID Tasks as not found", async () => {
    const store = new MemoryWorkflowStore();
    const foreign = await buildPackage("merge_pull_request", {}, OTHER_DID);
    store.createWorkflow({
      actionId: foreign.actionEnvelope.actionId.value,
      actionEnvelopeHash: foreign.approvalBundle.actionEnvelopeHash.value,
      toolName: "merge_pull_request",
      actionPackage: foreign,
      expiresAt: foreign.actionEnvelope.expiresAt,
    });
    const bridge = makeBridge(fakeAdapter(), { store, proposerDid: PROPOSER_DID });

    expect(() => bridge.handleTasksGet("urn:uuid:missing")).toThrow(TaskNotFoundError);
    expect(() => bridge.handleTasksGet(foreign.actionEnvelope.actionId.value)).toThrow(TaskNotFoundError);
  });
});
