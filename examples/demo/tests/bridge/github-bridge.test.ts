import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeFromConfig, GeneratedBridge, runBridge } from "../../src/bridge/github-bridge.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const bridgeToolsDir = fileURLToPath(new URL("../../bridge-tools/", import.meta.url));

const bridges: Array<{ stop: () => void }> = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) {
    bridge.stop();
  }
});

async function writeBridgeConfig(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mpas-bridge-cfg-"));
  const config = {
    mode: "proposer",
    plugin: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
    tools: join(bridgeToolsDir, "github-mirror-tools.json"),
    adapter: { url: "http://127.0.0.1:7544" },
    agent: { keyFile: join(fixturesDir, "test-keys", "proposer.json") },
    ...overrides,
  };
  const path = join(dir, "bridge.json");
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

describe("createBridgeFromConfig", () => {
  it("loads a proposer bridge with tool definitions", async () => {
    const bridge = await createBridgeFromConfig(await writeBridgeConfig());
    bridges.push(bridge);

    const tools = bridge.getToolDefinitions().map((tool) => tool.name);
    expect(tools).toContain("mpas_wait_for_action_result");
    expect(tools.length).toBeGreaterThan(1);
  });

  it("accepts deprecated approvalStrategy without failing", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const bridge = await createBridgeFromConfig(
        await writeBridgeConfig({ approvalStrategy: "poll", approvalTimeoutMs: 1000 }),
      );
      bridges.push(bridge);
      expect(bridge.getToolDefinitions().length).toBeGreaterThan(0);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("deprecated_config_ignored"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects maintainer mode", async () => {
    await expect(createBridgeFromConfig(await writeBridgeConfig({ mode: "maintainer" }))).rejects.toThrow(
      /Maintainer\/signer mode is not supported/,
    );
  });

  it("requires plugin", async () => {
    await expect(
      createBridgeFromConfig(await writeBridgeConfig({ plugin: undefined })),
    ).rejects.toThrow(/requires "plugin"/);
  });

  it("requires adapter.url", async () => {
    await expect(
      createBridgeFromConfig(
        await writeBridgeConfig({
          adapter: undefined,
          adapterUrl: undefined,
        }),
      ),
    ).rejects.toThrow(/requires "adapter.url"/);
  });

  it("starts, stops, and builds an MCP server", async () => {
    const bridge = await createBridgeFromConfig(
      await writeBridgeConfig({
        coordination: { url: "http://127.0.0.1:1" },
        defaultExpirationMinutes: 30,
      }),
    );
    bridges.push(bridge);

    await bridge.start();
    const server = bridge.buildMcpServer();
    expect(server).toBeDefined();
    bridge.stop();
  });

  it("uses SqliteWorkflowStore when workflow.dbPath is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-bridge-db-"));
    const bridge = await createBridgeFromConfig(
      await writeBridgeConfig({
        workflow: { dbPath: join(dir, "workflow.db") },
      }),
    );
    bridges.push(bridge);
    expect(bridge.getToolDefinitions().length).toBeGreaterThan(0);
  });

  it("requires agent.keyFile", async () => {
    await expect(
      createBridgeFromConfig(
        await writeBridgeConfig({
          agent: undefined,
          agentKey: undefined,
        }),
      ),
    ).rejects.toThrow(/requires "agent.keyFile"/);
  });

  it("loads default tools when tools path is omitted", async () => {
    const bridge = await createBridgeFromConfig(
      await writeBridgeConfig({
        tools: undefined,
        applicationDid: "did:web:github-live-demo.example",
      }),
    );
    bridges.push(bridge);
    const names = bridge.getToolDefinitions().map((tool) => tool.name);
    expect(names.some((name) => name.includes("demo") || name.includes("issue"))).toBe(true);
  });

  it("accepts flat adapterUrl/agentKey and workflow tuning knobs", async () => {
    const bridge = await createBridgeFromConfig(
      await writeBridgeConfig({
        adapter: undefined,
        adapterUrl: "http://127.0.0.1:7544",
        agent: undefined,
        agentKey: join(fixturesDir, "test-keys", "proposer.json"),
        target: { applicationDid: "did:web:github-mirror.example" },
        workflow: {
          pollIntervalMs: 50,
          resultRetentionSeconds: 60,
          notificationAssignedElsewhere: true,
        },
      }),
    );
    bridges.push(bridge);
    await bridge.start();
    expect(bridge.getToolDefinitions().length).toBeGreaterThan(0);
  });

  it("handleToolCall defers when the adapter is unreachable", async () => {
    const bridge = await createBridgeFromConfig(
      await writeBridgeConfig({
        adapter: { url: "http://127.0.0.1:9" },
        workflow: { pollIntervalMs: 60_000 },
      }),
    );
    bridges.push(bridge);
    await bridge.start();

    const result = await bridge.handleToolCall("create_issue_mirror", {
      owner: "oma3dao",
      repo: "app-registry",
      title: "coverage",
    });

    expect(result).toMatchObject({
      structuredContent: {
        type: "MpasBridgeDeferredResult",
      },
    });
  });

  it("buildMcpServer returns a configured MCP server", async () => {
    const bridge = await createBridgeFromConfig(
      await writeBridgeConfig({
        adapter: { url: "http://127.0.0.1:9" },
        workflow: { pollIntervalMs: 60_000 },
      }),
    );
    bridges.push(bridge);
    expect(bridge.buildMcpServer()).toBeDefined();
  });

  it("runBridge requires --config", async () => {
    await expect(runBridge([])).rejects.toThrow(/Usage: mpas-bridge --config/);
  });

  it("runBridge reads --config then fails when the file is missing", async () => {
    await expect(runBridge(["--config", join(tmpdir(), "missing-mpas-bridge.json")])).rejects.toThrow();
  });

  it("runBridge starts the workflow loop and connects stdio when --config is valid", async () => {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const connect = vi.spyOn(Server.prototype, "connect").mockResolvedValue(undefined as never);
    const originalStart = GeneratedBridge.prototype.start;
    const start = vi.spyOn(GeneratedBridge.prototype, "start").mockImplementation(async function (this: GeneratedBridge) {
      bridges.push(this);
      return originalStart.call(this);
    });

    try {
      await runBridge(["--config", await writeBridgeConfig({ workflow: { pollIntervalMs: 60_000 } })]);
      expect(connect).toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      start.mockRestore();
    }
  });

  it("wait tool returns a deferred result for an in-flight action", async () => {
    const bridge = await createBridgeFromConfig(
      await writeBridgeConfig({
        adapter: { url: "http://127.0.0.1:9" },
        workflow: { pollIntervalMs: 60_000 },
      }),
    );
    bridges.push(bridge);
    await bridge.start();

    const deferred = await bridge.handleToolCall("create_issue_mirror", {
      owner: "oma3dao",
      repo: "app-registry",
      title: "wait-me",
    });
    const actionId = (deferred.structuredContent as { actionRef?: { actionId?: { value?: string } } })?.actionRef
      ?.actionId?.value;
    expect(actionId).toBeDefined();

    const waited = await bridge.handleToolCall("mpas_wait_for_action_result", {
      actionId,
      timeoutSeconds: 0,
    });
    expect(waited.structuredContent).toMatchObject({ type: "MpasBridgeDeferredResult" });
  });

  it("buildMcpServer handlers list tools and coerce non-object CallTool arguments", async () => {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const handlers: Array<(request?: unknown) => unknown> = [];
    const setSpy = vi.spyOn(Server.prototype, "setRequestHandler").mockImplementation(function (_schema, handler) {
      handlers.push(handler as (request?: unknown) => unknown);
      return undefined as never;
    });

    try {
      const bridge = await createBridgeFromConfig(
        await writeBridgeConfig({
          adapter: { url: "http://127.0.0.1:9" },
          workflow: { pollIntervalMs: 60_000 },
        }),
      );
      bridges.push(bridge);
      handlers.length = 0;
      bridge.buildMcpServer();
      expect(handlers.length).toBeGreaterThanOrEqual(2);
      const listHandler = handlers[handlers.length - 2]!;
      const callHandler = handlers[handlers.length - 1]!;

      const listed = await listHandler();
      expect(listed).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "create_issue_mirror" })]),
      });

      await bridge.start();
      const coerced = await callHandler({
        params: { name: "create_issue_mirror", arguments: null },
      });
      expect(coerced).toMatchObject({
        structuredContent: { type: "MpasBridgeDeferredResult" },
      });

      const objectArgs = await callHandler({
        params: {
          name: "create_issue_mirror",
          arguments: { owner: "oma3dao", repo: "app-registry", title: "object-args" },
        },
      });
      expect(objectArgs).toMatchObject({
        structuredContent: { type: "MpasBridgeDeferredResult" },
      });
    } finally {
      setSpy.mockRestore();
    }
  });

  it("constructs GeneratedBridge from an inline plugin and JWK", async () => {
    const plugin = JSON.parse(
      await readFile(join(fixturesDir, "plugins", "github-mirror-plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const proposer = JSON.parse(await readFile(join(fixturesDir, "test-keys", "proposer.json"), "utf8")) as {
      privateJwk: Record<string, unknown>;
    };

    const bridge = new GeneratedBridge({
      plugin: plugin as never,
      applicationDid: "did:web:github-mirror.example",
      adapterUrl: "http://127.0.0.1:9",
      agentKey: proposer.privateJwk as never,
      defaultExpirationMinutes: 15,
      tools: join(bridgeToolsDir, "github-mirror-tools.json"),
      workflow: { pollIntervalMs: 60_000 },
    });
    bridges.push(bridge);
    await bridge.start();

    const result = await bridge.handleToolCall("create_issue_mirror", {
      owner: "oma3dao",
      repo: "app-registry",
      title: "inline",
    });
    expect(result.structuredContent).toMatchObject({ type: "MpasBridgeDeferredResult" });
  });

  it("uses the unconfigured coordination stub when coordination.url is omitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            version: "1",
            type: "ActionResponse",
            result: "additionalApprovalsRequired",
            authorizationRequirements: { version: "1", type: "AuthorizationRequirements" },
          }),
          { status: 200, headers: { "content-type": "application/mpas+json" } },
        ),
      ),
    );

    try {
      const bridge = await createBridgeFromConfig(
        await writeBridgeConfig({
          adapter: { url: "http://127.0.0.1:7544" },
          workflow: { pollIntervalMs: 60_000 },
        }),
      );
      bridges.push(bridge);
      await bridge.start();

      const result = await bridge.handleToolCall("create_issue_mirror", {
        owner: "oma3dao",
        repo: "app-registry",
        title: "needs-approvals",
      });
      expect(result.structuredContent).toMatchObject({ type: "MpasBridgeDeferredResult" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("polls the unconfigured coordination stub from the workflow ticker", async () => {
    const bridge = await createBridgeFromConfig(
      await writeBridgeConfig({
        adapter: { url: "http://127.0.0.1:9" },
        workflow: { pollIntervalMs: 20 },
      }),
    );
    bridges.push(bridge);
    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});
