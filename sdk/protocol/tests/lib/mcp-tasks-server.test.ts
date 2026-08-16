import { describe, expect, it } from "vitest";
import type { ActionPackage, Did } from "../../src/index.js";
import { computeHash } from "../../src/index.js";
import { ProposerBridge } from "../../src/lib/bridge-runtime.js";
import {
  MCP_TASKS_PROTOCOL_VERSION,
  MpasTasksServer,
} from "../../src/lib/mcp-tasks-server.js";
import { MemoryWorkflowStore } from "../../src/lib/workflow-store.js";

const DID = "did:jwk:proposer" as Did;
const META = {
  "io.modelcontextprotocol/protocolVersion": MCP_TASKS_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: {
      "io.modelcontextprotocol/tasks": {},
      "org.oma3/mpas": { version: "2" },
    },
  },
};

async function packageFor(): Promise<ActionPackage> {
  const actionEnvelope = {
    version: "1" as const,
    type: "ActionEnvelope" as const,
    proposer: { did: DID },
    target: { applicationDid: "did:web:example.com" as Did },
    executionProfile: { id: "did:web:example.com:profiles:mcp" as Did },
    executionPayloadHash: { alg: "sha-256" as const, value: "payload" },
    actionId: { value: "urn:uuid:11111111-1111-4111-8111-111111111111" },
    createdAt: "2026-08-14T10:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  return {
    version: "1",
    type: "ActionPackage",
    executionPayload: { name: "merge_pull_request", arguments: {} } as unknown as ActionPackage["executionPayload"],
    actionEnvelope,
    approvalBundle: {
      version: "1",
      type: "ApprovalBundle",
      actionEnvelopeHash: computeHash(actionEnvelope),
      approvals: [],
    },
  };
}

function makeServer(): MpasTasksServer {
  const bridge = new ProposerBridge({
    tools: [{ name: "merge_pull_request", description: "Merge.", inputSchema: { type: "object" } }],
    buildActionPackage: packageFor,
    store: new MemoryWorkflowStore({ now: () => Date.parse("2026-08-14T10:00:00.000Z") }),
    adapter: {
      async submit() {
        return { version: "1", type: "ActionResponse", result: "pending" };
      },
    },
    coordination: {
      async submitAction() {
        throw new Error("unused");
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
          cancelledAt: "2026-08-14T10:00:00.000Z",
        };
      },
    },
    proposerDid: DID,
    resultRetentionSeconds: 86_400,
  });
  return new MpasTasksServer({ bridge, serverInfo: { name: "test-bridge", version: "1.0.0" } });
}

function request(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0" as const, id, method, params: { ...params, _meta: META } };
}

describe("MpasTasksServer modern dispatcher", () => {
  it("allows discovery, tool listing, and ping before protocol negotiation", async () => {
    const server = makeServer();
    expect(await server.handleMessage({ jsonrpc: "2.0", id: 0, method: "ping" })).toMatchObject({ result: {} });
    expect(await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "server/discover" })).toMatchObject({
      result: { supportedVersions: ["2026-07-28"] },
    });
    expect(await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toMatchObject({
      result: { tools: [{ name: "merge_pull_request" }] },
    });
  });

  it("advertises the official Tasks extension and MPAS profile extension", async () => {
    const response = await makeServer().handleMessage(request(1, "server/discover"));
    expect(response).toMatchObject({
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/tasks": {},
            "org.oma3/mpas": { version: "2", disclosure: "transparent" },
          },
        },
      },
    });
  });

  it("preserves tools and returns flat Tasks from tools/call", async () => {
    const server = makeServer();
    const listed = await server.handleMessage(request(1, "tools/list"));
    expect(listed).toMatchObject({ result: { tools: [{ name: "merge_pull_request", description: "Merge." }] } });

    const called = await server.handleMessage(request(2, "tools/call", { name: "merge_pull_request", arguments: {} }));
    expect(called).toMatchObject({ result: { resultType: "task", status: "working" } });
    const taskId = (called as { result: { taskId: string } }).result.taskId;
    expect(await server.handleMessage(request(3, "tasks/get", { taskId }))).toMatchObject({
      result: { resultType: "complete", status: "working" },
    });
  });

  it("returns structured missing-capability errors", async () => {
    const params = {
      name: "merge_pull_request",
      arguments: {},
      _meta: {
        ...META,
        "io.modelcontextprotocol/clientCapabilities": { extensions: {} },
      },
    };
    expect(await makeServer().handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params })).toMatchObject({
      error: { code: -32021, data: { requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } } },
    });

    const wrongMpasVersion = {
      ...params,
      _meta: {
        ...META,
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: {
            "io.modelcontextprotocol/tasks": {},
            "org.oma3/mpas": { version: "1" },
          },
        },
      },
    };
    expect(
      await makeServer().handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: wrongMpasVersion }),
    ).toMatchObject({
      error: {
        code: -32021,
        data: { requiredCapabilities: { extensions: { "org.oma3/mpas": { version: "2" } } } },
      },
    });
  });

  it("supports update and cooperative cancellation acknowledgements", async () => {
    const server = makeServer();
    const called = await server.handleMessage(request(1, "tools/call", { name: "merge_pull_request" }));
    const taskId = (called as { result: { taskId: string } }).result.taskId;
    expect(await server.handleMessage(request(2, "tasks/update", { taskId, inputResponses: {} }))).toMatchObject({
      result: { resultType: "complete" },
    });
    expect(await server.handleMessage(request(3, "tasks/cancel", { taskId }))).toMatchObject({
      result: { resultType: "complete" },
    });
    expect(await server.handleMessage(request(4, "tasks/get", { taskId }))).toMatchObject({
      result: { status: "cancelled" },
    });
  });

  it("maps missing tasks and methods to JSON-RPC errors", async () => {
    const server = makeServer();
    expect(await server.handleMessage(request(1, "tasks/get", { taskId: "missing" }))).toMatchObject({
      error: { code: -32602, message: "Task not found" },
    });
    expect(await server.handleMessage(request(2, "tasks/result"))).toMatchObject({ error: { code: -32601 } });
  });
});
