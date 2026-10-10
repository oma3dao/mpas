import { createServer, type Server } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Real stdio smoke test for MCP 2026 discovery and official Tasks messages. */

const demoRoot = process.cwd();
const TASK_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: {
      "io.modelcontextprotocol/tasks": {},
      "org.oma3/mpas": { version: "2" },
    },
  },
};

let authorizationClient: JsonRpcStdioClient;
let authorizationServer: Server;
const required = { anyOf: [{ type: "threshold", threshold: 1, eligibleSigners: ["did:web:maintainer.example"] }] };

let tasksClient: JsonRpcStdioClient;
let compatibilityClient: JsonRpcStdioClient;

beforeAll(async () => {
  execSync("npm run build", { cwd: demoRoot, stdio: "ignore" });

  const configDir = await mkdtemp(join(tmpdir(), "mpas-stdio-smoke-"));
  const configPath = join(configDir, "bridge-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      plugin: join(demoRoot, "tests", "fixtures", "plugins", "github-mirror-plugin.json"),
      adapter: { url: "http://127.0.0.1:9" },
      agent: { keyFile: join(demoRoot, "tests", "fixtures", "test-keys", "proposer.json") },
      workflow: { pollIntervalMs: 60_000 },
    }),
  );

  authorizationServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (req.url === "/mpas/v1/verifier/action") {
      res.end(JSON.stringify({
        version: "1", type: "ActionResponse", result: "additionalApprovalsRequired",
        verifier: { did: "did:web:verifier.example" },
        authorizationRequirements: {
          version: "1", type: "AuthorizationRequirements", result: "additionalApprovalsRequired",
          verifier: { did: "did:web:verifier.example" },
          actionEnvelopeHash: body.actionPackage.approvalBundle.actionEnvelopeHash,
          approvalRequirements: required,
        },
      }));
    } else if (req.url === "/mpas/v1/coordination/workflow") {
      res.end(JSON.stringify({
        version: "1", type: "CoordinationActionResponse", state: "pendingApprovals",
        actionRef: { actionId: body.actionPackage.actionEnvelope.actionId },
      }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(resolve => authorizationServer.listen(0, "127.0.0.1", resolve));
  const address = authorizationServer.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const url = `http://127.0.0.1:${address.port}`;
  const authorizationConfig = join(configDir, "authorization-config.json");
  await writeFile(authorizationConfig, JSON.stringify({
    plugin: join(demoRoot, "tests/fixtures/plugins/github-mirror-plugin.json"),
    adapter: { url }, coordination: { url },
    agent: { keyFile: join(demoRoot, "tests/fixtures/test-keys/proposer.json") },
    workflow: { pollIntervalMs: 60_000 },
  }));
  authorizationClient = new JsonRpcStdioClient(process.execPath,
    [join(demoRoot, "dist/bridge/github-bridge.js"), "--config", authorizationConfig]);

  const bridgeArgs = [join(demoRoot, "dist", "bridge", "github-bridge.js"), "--config", configPath];
  tasksClient = new JsonRpcStdioClient(
    process.execPath,
    bridgeArgs,
  );
  compatibilityClient = new JsonRpcStdioClient(process.execPath, bridgeArgs);
}, 120_000);

afterAll(async () => {
  await Promise.all([tasksClient?.close(), compatibilityClient?.close(), authorizationClient?.close()]);
  authorizationServer?.closeAllConnections();
  await new Promise<void>(resolve => authorizationServer ? authorizationServer.close(() => resolve()) : resolve());
});

describe("MCP 2026 stdio transport smoke test", () => {
  it("allows discovery and exact tool listing before negotiation", async () => {
    const discovery = await tasksClient.request("server/discover");
    expect(discovery).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/tasks": {},
          "org.oma3/mpas": { version: "2", disclosure: "transparent" },
        },
      },
    });

    const listed = await tasksClient.request("tools/list");
    const tools = listed.tools as Array<{ name: string; description?: string; inputSchema: object }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "create_issue_demo",
      "delete_branch_demo",
      "merge_pull_request_demo",
    ]);
    expect(tools.find((tool) => tool.name === "merge_pull_request_demo")?.description).toBe("Merge a pull request.");
  });

  it("exposes authorization-required requirements over real stdio without client signature transport", async () => {
    const created = await authorizationClient.request("tools/call", {
      name: "delete_branch_demo", arguments: { owner: "example", repo: "demo", branch: "review" }, _meta: TASK_META,
    });
    expect(created).toMatchObject({ resultType: "task", status: "working" });
    await expect.poll(async () => authorizationClient.request("tasks/get", {
      taskId: created.taskId, _meta: TASK_META,
    }), { timeout: 5000 }).toMatchObject({ taskId: created.taskId, status: "working",
      _meta: { "org.oma3/mpas": { authorizationState: "authorization_required", requirements: required } } });
  });

  it("creates and retrieves a flat official Task", async () => {
    const created = await tasksClient.request("tools/call", {
      name: "delete_branch_demo",
      arguments: { owner: "example-org", repo: "mpas-demo-repository", branch: "smoke-test" },
      _meta: TASK_META,
    });
    expect(created).toMatchObject({
      resultType: "task",
      status: "working",
      _meta: { "org.oma3/mpas": { version: "2", authorizationState: "submitted" } },
    });

    const current = await tasksClient.request("tasks/get", { taskId: created.taskId, _meta: TASK_META });
    expect(current).toMatchObject({ resultType: "complete", taskId: created.taskId, status: "working" });
  });

  it("returns protocol errors for missing Tasks and capabilities", async () => {
    await expect(
      tasksClient.request("tasks/get", {
        taskId: "urn:uuid:99999999-9999-4999-8999-999999999999",
        _meta: TASK_META,
      }),
    ).rejects.toMatchObject({ code: -32602, message: "Task not found" });

    await expect(tasksClient.request("tools/call", { name: "delete_branch_demo", arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });

    await expect(
      tasksClient.request("tools/call", {
        name: "delete_branch_demo",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: -32021,
      data: {
        requiredCapabilities: {
          extensions: { "org.oma3/mpas": { version: "2" } },
        },
      },
    });
  });
});

describe("conventional MCP stdio compatibility smoke test", () => {
  it("initializes and lists the legacy wait-tool surface", async () => {
    const initialized = await compatibilityClient.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "compatibility-smoke", version: "1.0.0" },
    });
    expect(initialized).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "mpas-demo-github-server-mpas-bridge", version: "1.0.0" },
    });
    compatibilityClient.notify("notifications/initialized");

    const listed = await compatibilityClient.request("tools/list");
    const tools = listed.tools as Array<{ name: string; description?: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "create_issue_demo",
      "delete_branch_demo",
      "merge_pull_request_demo",
      "mpas_wait_for_action_result",
    ]);
    expect(tools.find((tool) => tool.name === "merge_pull_request_demo")?.description).toContain(
      "may return a deferred Action reference",
    );
  });

  it("creates and observes a deferred Action without switching protocol", async () => {
    const created = await compatibilityClient.request("tools/call", {
      name: "delete_branch_demo",
      arguments: { owner: "example-org", repo: "mpas-demo-repository", branch: "compatibility-smoke" },
    });
    expect(created).toMatchObject({
      structuredContent: {
        type: "MpasBridgeDeferredResult",
        actionRef: { actionId: { value: expect.stringMatching(/^urn:uuid:/) } },
      },
    });
    const actionId = created.structuredContent.actionRef.actionId.value as string;

    const observed = await compatibilityClient.request("tools/call", {
      name: "mpas_wait_for_action_result",
      arguments: { actionId, timeoutSeconds: 0 },
    });
    expect(observed).toMatchObject({
      structuredContent: { type: "MpasBridgeDeferredResult", actionRef: { actionId: { value: actionId } } },
    });
    await expect(compatibilityClient.request("server/discover")).rejects.toMatchObject({ code: -32601 });
  });
});

class JsonRpcStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (result: Record<string, any>) => void; reject: (error: Record<string, any>) => void }
  >();
  private nextId = 1;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        result?: Record<string, any>;
        error?: Record<string, any>;
      };
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result ?? {});
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const message = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.kill();
    });
  }
}
