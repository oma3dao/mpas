import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionPackage, ActionResponse } from "../../src/index.js";
import { MPAS_WAIT_TOOL_NAME, computeHash } from "../../src/index.js";
import { ProposerBridge } from "../../src/lib/bridge-runtime.js";
import { MemoryWorkflowStore } from "../../src/lib/workflow-store.js";
import type { WorkflowAdapter, WorkflowCoordination } from "../../src/lib/workflow-engine.js";

/**
 * Shared proposer-bridge runtime: the MCP-facing surface generated bridges
 * wire their tool definitions and configuration around (plan §5.1, client
 * profile §3–§6).
 */

const UPSTREAM_TOOLS = [
  {
    name: "merge_pull_request",
    description: "Merge a pull request.",
    inputSchema: { type: "object", properties: { pullNumber: { type: "integer" } } },
    outputSchema: { type: "object", properties: { merged: { type: "boolean" } } },
  },
  {
    name: "create_issue",
    description: "Create a new issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
];

let nextActionSerial = 0;

/** Stub package builder: mints a fresh actionId per call, like the real one. */
async function buildPackage(toolName: string, args: object): Promise<ActionPackage> {
  nextActionSerial += 1;
  return {
    version: "1",
    type: "ActionPackage",
    executionPayload: { name: toolName, arguments: args } as unknown as ActionPackage["executionPayload"],
    actionEnvelope: {
      actionId: { value: `urn:uuid:0000000${nextActionSerial}-0000-4000-8000-000000000000` },
      expiresAt: "2030-01-01T00:00:00.000Z",
    } as unknown as ActionPackage["actionEnvelope"],
    approvalBundle: { approvals: [] } as unknown as ActionPackage["approvalBundle"],
  };
}

function response(result: ActionResponse["result"], extra: Partial<ActionResponse> = {}): ActionResponse {
  return { version: "1", type: "ActionResponse", result, ...extra };
}

function fakeAdapter(...script: (ActionResponse | Error)[]): WorkflowAdapter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async submit(pkg: unknown): Promise<ActionResponse> {
      calls.push(pkg);
      const next = script.shift();
      if (!next) throw new Error("fakeAdapter script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const idleCoordination: WorkflowCoordination = {
  async submitAction() {
    return {
      version: "1",
      type: "CoordinationActionResponse",
      actionRef: {
        version: "1",
        type: "ActionRef",
        actionId: { value: "urn:uuid:coordination" },
        actionEnvelopeHash: { alg: "sha-256", value: "hash" },
      },
      state: "awaitingApprovals",
    } as Awaited<ReturnType<WorkflowCoordination["submitAction"]>>;
  },
  async poll() {
    return { version: "1", type: "CoordinationPollResponse", approvalRequests: [], actionUpdates: [] } as Awaited<
      ReturnType<WorkflowCoordination["poll"]>
    >;
  },
};

function makeBridge(adapter: WorkflowAdapter) {
  return new ProposerBridge({
    tools: UPSTREAM_TOOLS,
    buildActionPackage: buildPackage,
    store: new MemoryWorkflowStore(),
    adapter,
    coordination: idleCoordination,
    proposerDid: "did:jwk:proposer",
    resultRetentionSeconds: 86_400,
  });
}

describe("tool surface (profile §3)", () => {
  it("exposes upstream tools with the MPAS notice, output unions, and the reserved wait tool", () => {
    const bridge = makeBridge(fakeAdapter());
    const tools = bridge.getToolDefinitions();

    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["merge_pull_request", "create_issue", MPAS_WAIT_TOOL_NAME]);

    const merge = tools[0];
    expect(merge.description).toContain("Merge a pull request.");
    expect(merge.description).toContain("mediated by MPAS");
    // Upstream schema preserved as the first union branch.
    expect((merge.outputSchema as { anyOf: unknown[] }).anyOf[0]).toEqual(UPSTREAM_TOOLS[0].outputSchema);

    // No upstream outputSchema → none advertised (profile §3.2).
    expect(tools[1].outputSchema).toBeUndefined();

    // Input schemas are untouched.
    expect(merge.inputSchema).toEqual(UPSTREAM_TOOLS[0].inputSchema);
  });
});

describe("application tool calls (profile §4)", () => {
  it("relays a native result verbatim on immediate execution", async () => {
    const nativeResult = { content: [{ type: "text", text: "merged" }] };
    const bridge = makeBridge(fakeAdapter(response("executed", { executionResult: nativeResult })));

    const result = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });
    expect(result).toEqual(nativeResult);
  });

  it("returns a profile deferred result when approvals are required", async () => {
    const bridge = makeBridge(
      fakeAdapter(
        response("additionalApprovalsRequired", {
          authorizationRequirements: { version: "1", type: "AuthorizationRequirements" } as ActionResponse["authorizationRequirements"],
        }),
      ),
    );

    const result = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      version: "1",
      type: "MpasBridgeDeferredResult",
      notificationRequired: true,
      lastActionResponse: { result: "additionalApprovalsRequired" },
    });
  });

  it("proposes a new Action for every call, even with identical arguments", async () => {
    const adapter = fakeAdapter(
      response("additionalApprovalsRequired"),
      response("additionalApprovalsRequired"),
    );
    const bridge = makeBridge(adapter);

    const first = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });
    const second = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });

    const firstId = actionIdOf(first);
    const secondId = actionIdOf(second);
    expect(firstId).not.toEqual(secondId);
    expect(adapter.calls).toHaveLength(2);
  });

  it("rejects an unknown tool with a bridge error", async () => {
    const bridge = makeBridge(fakeAdapter());
    const result = await bridge.handleToolCall("nonexistent_tool", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ type: "MpasBridgeError" });
  });
});

describe("reserved wait tool (profile §6)", () => {
  it("performs a nonblocking check that returns the deferred result again", async () => {
    const bridge = makeBridge(fakeAdapter(response("additionalApprovalsRequired")));
    const deferred = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });
    const actionId = actionIdOf(deferred);

    const checked = await bridge.handleToolCall(MPAS_WAIT_TOOL_NAME, { actionId, timeoutSeconds: 0 });
    expect(checked.structuredContent).toMatchObject({ type: "MpasBridgeDeferredResult" });
    expect(actionIdOf(checked)).toEqual(actionId);
  });

  it("returns ACTION_NOT_FOUND for an unknown Action ID", async () => {
    const bridge = makeBridge(fakeAdapter());
    const result = await bridge.handleToolCall(MPAS_WAIT_TOOL_NAME, {
      actionId: "urn:uuid:99999999-9999-4999-8999-999999999999",
      timeoutSeconds: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ type: "MpasBridgeError", code: "ACTION_NOT_FOUND" });
  });

  it("rejects an out-of-range timeout with INVALID_WAIT_TIMEOUT", async () => {
    const bridge = makeBridge(fakeAdapter());
    const result = await bridge.handleToolCall(MPAS_WAIT_TOOL_NAME, { actionId: "urn:uuid:x", timeoutSeconds: 301 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ type: "MpasBridgeError", code: "INVALID_WAIT_TIMEOUT" });
  });

  it("returns the stored native result after background resolution", async () => {
    const nativeResult = { content: [{ type: "text", text: "merged later" }] };
    const completedPackage = { fake: "completed" };
    const adapter = fakeAdapter(
      response("additionalApprovalsRequired"),
      response("executed", { executionResult: nativeResult }),
    );
    let ready = false;
    let capturedRef: unknown;
    const coordination: WorkflowCoordination = {
      async submitAction(pkg: unknown) {
        const typed = pkg as ActionPackage;
        capturedRef = {
          version: "1",
          type: "ActionRef",
          actionId: typed.actionEnvelope.actionId,
          actionEnvelopeHash: computeHash(typed.actionEnvelope),
        };
        return {
          version: "1",
          type: "CoordinationActionResponse",
          actionRef: capturedRef,
          state: "awaitingApprovals",
        } as Awaited<ReturnType<WorkflowCoordination["submitAction"]>>;
      },
      async poll() {
        return {
          version: "1",
          type: "CoordinationPollResponse",
          approvalRequests: [],
          actionUpdates: ready
            ? [{
                version: "1",
                type: "CoordinationActionUpdate",
                actionRef: capturedRef,
                state: "readyForResubmission",
                expiresAt: "2030-01-01T00:00:00.000Z",
                actionPackage: completedPackage,
              }]
            : [],
        } as Awaited<ReturnType<WorkflowCoordination["poll"]>>;
      },
    };

    const bridge = new ProposerBridge({
      tools: UPSTREAM_TOOLS,
      buildActionPackage: buildPackage,
      store: new MemoryWorkflowStore(),
      adapter,
      coordination,
      proposerDid: "did:jwk:proposer",
      resultRetentionSeconds: 86_400,
    });

    const deferred = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });
    const actionId = actionIdOf(deferred);

    ready = true;
    await bridge.pollOnce();

    const result = await bridge.handleToolCall(MPAS_WAIT_TOOL_NAME, { actionId, timeoutSeconds: 0 });
    expect(result).toEqual(nativeResult);

    // Stable result (profile §7.3): ask again, same answer.
    const again = await bridge.handleToolCall(MPAS_WAIT_TOOL_NAME, { actionId, timeoutSeconds: 5 });
    expect(again).toEqual(nativeResult);
  });
});

describe("ProposerBridge lifecycle and error edges", () => {
  it("returns BRIDGE_UNAVAILABLE when Action Package construction fails", async () => {
    const bridge = new ProposerBridge({
      tools: UPSTREAM_TOOLS,
      buildActionPackage: async () => {
        throw new Error("key material unavailable");
      },
      store: new MemoryWorkflowStore(),
      adapter: fakeAdapter(),
      coordination: idleCoordination,
      proposerDid: "did:jwk:proposer",
      resultRetentionSeconds: 86_400,
    });

    const result = await bridge.handleToolCall("merge_pull_request", { pullNumber: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      type: "MpasBridgeError",
      code: "BRIDGE_UNAVAILABLE",
    });
  });

  it("uses a non-Error throw message fallback for package construction failures", async () => {
    const bridge = new ProposerBridge({
      tools: UPSTREAM_TOOLS,
      buildActionPackage: async () => {
        throw "boom";
      },
      store: new MemoryWorkflowStore(),
      adapter: fakeAdapter(),
      coordination: idleCoordination,
      proposerDid: "did:jwk:proposer",
      resultRetentionSeconds: 86_400,
    });

    const result = await bridge.handleToolCall("merge_pull_request", {});
    expect(result.structuredContent).toMatchObject({
      code: "BRIDGE_UNAVAILABLE",
      message: "Could not construct the Action Package.",
    });
  });

  it("starts and stops the background ticker", async () => {
    const bridge = makeBridge(fakeAdapter(response("pending")));
    await bridge.start();
    await bridge.pollOnce();
    bridge.stop();
    bridge.stop();
  });

  it("runs the background ticker body on the poll interval", async () => {
    vi.useFakeTimers();
    const adapter = fakeAdapter(response("pending"));
    const store = new MemoryWorkflowStore();
    const purgeSpy = vi.spyOn(store, "purgeExpiredResults");
    const bridge = new ProposerBridge({
      tools: UPSTREAM_TOOLS,
      buildActionPackage: buildPackage,
      store,
      adapter,
      coordination: idleCoordination,
      proposerDid: "did:jwk:proposer",
      resultRetentionSeconds: 86_400,
      pollIntervalMs: 10,
    });

    try {
      await bridge.start();
      await vi.advanceTimersByTimeAsync(15);
      expect(purgeSpy).toHaveBeenCalled();
    } finally {
      bridge.stop();
      vi.useRealTimers();
      purgeSpy.mockRestore();
    }
  });

  it("sets notificationRequired false when notification is assigned elsewhere", async () => {
    const bridge = new ProposerBridge({
      tools: UPSTREAM_TOOLS,
      buildActionPackage: buildPackage,
      store: new MemoryWorkflowStore(),
      adapter: fakeAdapter(response("additionalApprovalsRequired")),
      coordination: idleCoordination,
      proposerDid: "did:jwk:proposer",
      resultRetentionSeconds: 86_400,
      notificationAssignedElsewhere: true,
    });

    const result = await bridge.handleToolCall("merge_pull_request", { pullNumber: 1 });
    expect(result.structuredContent).toMatchObject({
      type: "MpasBridgeDeferredResult",
      notificationRequired: false,
    });
  });
});

function actionIdOf(result: { structuredContent?: unknown }): string {
  const structured = result.structuredContent as { actionRef?: { actionId?: { value?: string } } } | undefined;
  const value = structured?.actionRef?.actionId?.value;
  if (!value) throw new Error("result carries no actionRef.actionId.value");
  return value;
}
