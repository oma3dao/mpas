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
    buildCoordinationReplacement: async (priorPackage, verifierRequirements) => {
      const payload = priorPackage.executionPayload as { name: string; arguments: object };
      const actionPackage = await buildPackage(
        payload.name,
        payload.arguments,
        options.proposerDid ?? PROPOSER_DID,
      );
      return {
        actionPackage,
        authorizationRequirements: {
          ...structuredClone(verifierRequirements),
          actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
        },
      };
    },
    store: options.store ?? new MemoryWorkflowStore({ now: () => Date.parse("2026-08-14T10:00:00.000Z") }),
    adapter,
    coordination: coordination(),
    proposerDid: options.proposerDid ?? PROPOSER_DID,
    resultRetentionSeconds: 86_400,
  });
}

describe("official MCP Tasks bridge runtime", () => {
  it("rejects construction when a client timeout outlives the claim lease", () => {
    const adapter = Object.assign(fakeAdapter(), { timeoutMs: 120_000 });
    expect(() => makeBridge(adapter)).toThrow(/claimLeaseMs .* must exceed submissionTimeoutMs/);
  });

  it("preserves the upstream tool surface exactly and exposes no wait tool", () => {
    expect(makeBridge(fakeAdapter()).getToolDefinitions()).toEqual(UPSTREAM_TOOLS);
  });

  it("returns the native MCP result directly when the initial Action settles quickly", async () => {
    const native = { content: [{ type: "text", text: "merged" }], isError: false };
    const bridge = makeBridge(fakeAdapter(response("executed", { executionResult: native })));
    const result = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });

    expect(result).toEqual({ ...native, resultType: "complete" });
    expect(result).not.toHaveProperty("taskId");
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

    const result = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });
    if (result.resultType !== "task") throw new Error("Expected deferred Task result.");
    const task = result;
    expect(task).toMatchObject({
      resultType: "task",
      status: "working",
      _meta: {
        "org.oma3/mpas": {
          version: "2",
          actionId: expect.not.stringMatching(task.taskId),
          authorizationState: "authorization_required",
          disclosure: "transparent",
          requirements,
        },
      },
    });
    const meta = task._meta?.["org.oma3/mpas"] as { actionEnvelopeHash: { value: string } };
    expect(meta.actionEnvelopeHash.value).not.toBe("response-hash");
  });

  it("returns terminal MPAS outcomes directly as normal tool-level errors", async () => {
    const bridge = makeBridge(fakeAdapter(response("rejected", { error: { code: "DENIED", message: "denied" } })));
    const result = await bridge.handleToolCall("merge_pull_request", {});
    expect(result).toMatchObject({
      resultType: "complete",
      isError: true,
      structuredContent: { type: "ActionResponse", result: "rejected" },
    });
    expect(result).not.toHaveProperty("taskId");
  });

  it("rejects unknown tools before creating a Task", async () => {
    const bridge = makeBridge(fakeAdapter());
    await expect(bridge.handleToolCall("unknown", {})).rejects.toBeInstanceOf(UnknownBridgeToolError);
  });

  it("acknowledges tasks/update for a visible Task", async () => {
    const bridge = makeBridge(fakeAdapter(response("pending")));
    const result = await bridge.handleToolCall("merge_pull_request", {});
    if (result.resultType !== "task") throw new Error("Expected deferred Task result.");
    expect(bridge.handleTasksUpdate(result.taskId, { ignored: {} })).toEqual({ resultType: "complete" });
  });

  it("cooperatively cancels a working Task and keeps cancellation terminal", async () => {
    const store = new MemoryWorkflowStore({ now: () => Date.parse("2026-08-14T10:00:00.000Z") });
    const bridge = makeBridge(
      fakeAdapter(
        response("additionalApprovalsRequired", {
          authorizationRequirements: {
            version: "1",
            type: "AuthorizationRequirements",
            result: "additionalApprovalsRequired",
            actionEnvelopeHash: { alg: "sha-256", value: "response-hash" },
            verifier: { did: "did:jwk:verifier" as Did },
            approvalRequirements: { anyOf: [] },
          },
        }),
      ),
      { store },
    );
    const result = await bridge.handleToolCall("merge_pull_request", {});
    if (result.resultType !== "task") throw new Error("Expected deferred Task result.");
    expect(store.getWorkflow(result.taskId)).toMatchObject({
      state: "awaitingApprovals",
    });

    await expect(bridge.handleTasksCancel(result.taskId)).resolves.toEqual({ resultType: "complete" });
    expect(bridge.handleTasksGet(result.taskId)).toMatchObject({ status: "cancelled" });
    store.resolveWorkflow(result.taskId, { kind: "resolved", actionResponse: response("executed") });
    expect(bridge.handleTasksGet(result.taskId)).toMatchObject({ status: "cancelled" });
  });

  it("treats unknown and cross-DID Tasks as not found", async () => {
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
    const bridge = makeBridge(fakeAdapter(), { store, proposerDid: PROPOSER_DID });

    expect(() => bridge.handleTasksGet("urn:uuid:missing")).toThrow(TaskNotFoundError);
    expect(() => bridge.handleTasksGet(foreign.actionEnvelope.actionId.value)).toThrow(TaskNotFoundError);
  });
});
