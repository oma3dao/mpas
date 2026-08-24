import { describe, expect, it, vi } from "vitest";
import type { ActionPackage, ActionResponse, Did } from "../../src/index.js";
import { computeHash } from "../../src/index.js";
import { ProposerBridge } from "../../src/lib/bridge-runtime.js";
import {
  MCP_COMPATIBILITY_DEFAULT_PROTOCOL_VERSION,
  MpasCompatibilityServer,
} from "../../src/lib/mcp-compatibility-server.js";
import { MpasProtocolServer } from "../../src/lib/mcp-protocol-server.js";
import { MCP_TASKS_PROTOCOL_VERSION } from "../../src/lib/mcp-tasks-server.js";
import { MemoryWorkflowStore } from "../../src/lib/workflow-store.js";

const DID = "did:jwk:protocol-proposer" as Did;
const TASK_META = {
  "io.modelcontextprotocol/protocolVersion": MCP_TASKS_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: {
      "io.modelcontextprotocol/tasks": {},
      "org.oma3/mpas": { version: "2" },
    },
  },
};

async function buildPackage(toolName: string, args: object): Promise<ActionPackage> {
  const actionEnvelope = {
    version: "1" as const,
    type: "ActionEnvelope" as const,
    proposer: { did: DID },
    target: { applicationDid: "did:web:example.com" as Did },
    executionProfile: { id: "did:web:example.com:profiles:mcp" as Did, format: "mcp.toolsCall" },
    executionPayloadHash: { alg: "sha-256" as const, value: "payload" },
    actionId: { value: "urn:uuid:22222222-2222-4222-8222-222222222222" },
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

function makeBridge(): ProposerBridge {
  return new ProposerBridge({
    tools: [{ name: "deploy", description: "Deploy.", inputSchema: { type: "object" } }],
    buildActionPackage: buildPackage,
    store: new MemoryWorkflowStore(),
    adapter: {
      async submit(): Promise<ActionResponse> {
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
          cancelledAt: "2026-08-23T10:00:00.000Z",
        };
      },
    },
    proposerDid: DID,
    resultRetentionSeconds: 86_400,
  });
}

function request(id: number, method: string, params?: Record<string, unknown>) {
  return { jsonrpc: "2.0" as const, id, method, ...(params === undefined ? {} : { params }) };
}

describe("conventional MCP compatibility server", () => {
  it("initializes supported versions and lists the compatibility surface", async () => {
    const server = new MpasCompatibilityServer({
      bridge: makeBridge(),
      serverInfo: { name: "test", version: "1.0.0" },
    });
    expect(await server.handleMessage(request(1, "initialize", { protocolVersion: "2024-11-05" }))).toMatchObject({
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "test", version: "1.0.0" },
      },
    });
    await expect(
      server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).resolves.toBeUndefined();
    expect(server.state).toEqual({ initialized: true, initializedNotificationReceived: true });

    const listed = await server.handleMessage(request(2, "tools/list"));
    expect((listed as any).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "deploy",
      "mpas_wait_for_action_result",
    ]);
  });

  it("negotiates its default for an unsupported requested version", async () => {
    const server = new MpasCompatibilityServer({
      bridge: makeBridge(),
      serverInfo: { name: "test", version: "1.0.0" },
    });
    expect(await server.handleMessage(request(1, "initialize", { protocolVersion: "future-version" }))).toMatchObject({
      result: { protocolVersion: MCP_COMPATIBILITY_DEFAULT_PROTOCOL_VERSION },
    });
  });

  it("requires initialization and validates conventional tool calls", async () => {
    const server = new MpasCompatibilityServer({
      bridge: makeBridge(),
      serverInfo: { name: "test", version: "1.0.0" },
    });
    expect(await server.handleMessage(request(1, "tools/list"))).toMatchObject({ error: { code: -32002 } });
    await server.handleMessage(request(2, "initialize", { protocolVersion: "2025-11-25" }));
    expect(await server.handleMessage(request(3, "tools/call", { name: "deploy", arguments: [] as any }))).toMatchObject({
      error: { code: -32602 },
    });
    expect(await server.handleMessage(request(4, "tools/call", { name: "deploy", arguments: {} }))).toMatchObject({
      result: { structuredContent: { type: "MpasBridgeDeferredResult" } },
    });
  });
});

describe("locked MCP protocol selector", () => {
  it("keeps ping neutral then selects compatibility from initialize", async () => {
    const onmode = vi.fn();
    const server = new MpasProtocolServer({
      bridge: makeBridge(),
      serverInfo: { name: "test", version: "1.0.0" },
      onmode,
    });
    expect(await server.handleMessage(request(1, "ping"))).toMatchObject({ result: {} });
    expect(server.mode).toBeUndefined();

    expect(await server.handleMessage(request(2, "initialize", { protocolVersion: "2024-11-05" }))).toMatchObject({
      result: { protocolVersion: "2024-11-05" },
    });
    expect(server.mode).toBe("compatibility");
    expect(onmode).toHaveBeenCalledOnce();
    expect(onmode).toHaveBeenCalledWith("compatibility", "initialize");

    expect(await server.handleMessage(request(3, "server/discover"))).toMatchObject({ error: { code: -32601 } });
    expect(server.mode).toBe("compatibility");
  });

  it("selects Tasks from discovery and never falls back on initialize", async () => {
    const server = new MpasProtocolServer({
      bridge: makeBridge(),
      serverInfo: { name: "test", version: "1.0.0" },
    });
    expect(await server.handleMessage(request(1, "server/discover"))).toMatchObject({
      result: { supportedVersions: [MCP_TASKS_PROTOCOL_VERSION] },
    });
    expect(server.mode).toBe("tasks");
    expect(await server.handleMessage(request(2, "initialize", { protocolVersion: "2024-11-05" }))).toMatchObject({
      error: { code: -32601 },
    });
    expect(server.mode).toBe("tasks");
  });

  it("preserves Tasks missing-capability errors without downgrade", async () => {
    const server = new MpasProtocolServer({
      bridge: makeBridge(),
      serverInfo: { name: "test", version: "1.0.0" },
    });
    await server.handleMessage(request(1, "server/discover"));
    expect(await server.handleMessage(request(2, "tools/call", { name: "deploy", arguments: {} }))).toMatchObject({
      error: { code: -32602 },
    });
    expect(server.mode).toBe("tasks");
  });

  it("selects Tasks from modern metadata or pre-discovery tools/list", async () => {
    const metadataServer = new MpasProtocolServer({
      bridge: makeBridge(),
      serverInfo: { name: "test", version: "1.0.0" },
    });
    expect(
      await metadataServer.handleMessage(request(1, "tools/call", { name: "deploy", arguments: {}, _meta: TASK_META })),
    ).toMatchObject({ result: { resultType: "task" } });
    expect(metadataServer.mode).toBe("tasks");

    const listingServer = new MpasProtocolServer({
      bridge: makeBridge(),
      serverInfo: { name: "test", version: "1.0.0" },
    });
    const listed = await listingServer.handleMessage(request(1, "tools/list"));
    expect((listed as any).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["deploy"]);
    expect(listingServer.mode).toBe("tasks");
  });

  it("fails unknown initial methods without selecting a mode", async () => {
    const server = new MpasProtocolServer({
      bridge: makeBridge(),
      serverInfo: { name: "test", version: "1.0.0" },
    });
    expect(await server.handleMessage(request(1, "future/discover"))).toMatchObject({
      error: { code: -32601, message: "Unsupported MCP handshake" },
    });
    expect(server.mode).toBeUndefined();
  });
});
