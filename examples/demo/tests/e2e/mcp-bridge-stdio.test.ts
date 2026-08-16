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

let client: JsonRpcStdioClient;

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

  client = new JsonRpcStdioClient(
    process.execPath,
    [join(demoRoot, "dist", "bridge", "github-bridge.js"), "--config", configPath],
  );
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("MCP 2026 stdio transport smoke test", () => {
  it("allows discovery and exact tool listing before negotiation", async () => {
    const discovery = await client.request("server/discover");
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

    const listed = await client.request("tools/list");
    const tools = listed.tools as Array<{ name: string; description?: string; inputSchema: object }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "create_issue_demo",
      "delete_branch_demo",
      "merge_pull_request_demo",
    ]);
    expect(tools.find((tool) => tool.name === "merge_pull_request_demo")?.description).toBe("Merge a pull request.");
  });

  it("creates and retrieves a flat official Task", async () => {
    const created = await client.request("tools/call", {
      name: "delete_branch_demo",
      arguments: { owner: "example-org", repo: "mpas-demo-repository", branch: "smoke-test" },
      _meta: TASK_META,
    });
    expect(created).toMatchObject({
      resultType: "task",
      status: "working",
      _meta: { "org.oma3/mpas": { version: "2", authorizationState: "submitted" } },
    });

    const current = await client.request("tasks/get", { taskId: created.taskId, _meta: TASK_META });
    expect(current).toMatchObject({ resultType: "complete", taskId: created.taskId, status: "working" });
  });

  it("returns protocol errors for missing Tasks and capabilities", async () => {
    await expect(
      client.request("tasks/get", {
        taskId: "urn:uuid:99999999-9999-4999-8999-999999999999",
        _meta: TASK_META,
      }),
    ).rejects.toMatchObject({ code: -32602, message: "Task not found" });

    await expect(client.request("tools/call", { name: "delete_branch_demo", arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });

    await expect(
      client.request("tools/call", {
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

  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.kill();
    });
  }
}
