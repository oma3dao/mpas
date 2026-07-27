import { execSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Transport smoke test: the bridge as a real MCP stdio server.
 *
 * Everything else in this suite drives GeneratedBridge in-process. This test
 * spawns the built bridge binary and speaks MCP to it through the official
 * client SDK, catching serialization and handshake bugs the in-process tests
 * structurally cannot: tool-list wire format, structuredContent round-trips,
 * and the human-readable degradation story for clients that ignore
 * structuredContent.
 *
 * The adapter URL points at an unreachable port on purpose. Per the client
 * profile §4.2 the application call still returns a deferred result — the
 * Action is durably recorded and reconciliation owns the retry — which lets
 * this test exercise a full CallTool round trip with no backing stack.
 */

const demoRoot = process.cwd();
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  // The spawned server runs from dist; build it (SDK dist is a file: link,
  // already built by its own suite).
  execSync("npm run build", { cwd: demoRoot, stdio: "ignore" });

  const configDir = await mkdtemp(join(tmpdir(), "mpas-stdio-smoke-"));
  const configPath = join(configDir, "bridge-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      plugin: join(demoRoot, "tests", "fixtures", "plugins", "github-demo-plugin.json"),
      adapter: { url: "http://127.0.0.1:9" },
      agent: { keyFile: join(demoRoot, "tests", "fixtures", "test-keys", "proposer.json") },
      workflow: { pollIntervalMs: 60_000 },
    }),
  );

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(demoRoot, "dist", "bridge", "github-bridge.js"), "--config", configPath],
    stderr: "ignore",
  });
  client = new Client({ name: "mpas-smoke-client", version: "0.0.0" });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("MCP stdio transport smoke test", () => {
  it("serves the profile tool surface over the wire", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(["create_issue_demo", "delete_branch_demo", "merge_pull_request_demo", "mpas_wait_for_action_result"]);

    const merge = tools.find((tool) => tool.name === "merge_pull_request_demo")!;
    expect(merge.description).toContain("Merge a pull request.");
    expect(merge.description).toContain("mediated by MPAS");
    // Upstream input schema unchanged after JSON round-trip.
    expect(merge.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["pullNumber"]) });

    const wait = tools.find((tool) => tool.name === "mpas_wait_for_action_result")!;
    expect(wait.inputSchema).toMatchObject({
      type: "object",
      required: ["actionId", "timeoutSeconds"],
      properties: { timeoutSeconds: { type: "integer", minimum: 0, maximum: 300 } },
    });
    expect(wait.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("returns a deferred result for an application call, with readable content", async () => {
    const result = (await client.callTool({
      name: "delete_branch_demo",
      arguments: { owner: "example-org", repo: "mpas-demo-repository", branch: "smoke-test" },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      version: "1",
      type: "MpasBridgeDeferredResult",
      notificationRequired: false,
      actionRef: { type: "ActionRef" },
    });
    // Adapter unreachable → durably recorded, no Verifier response yet.
    expect(result.structuredContent).not.toHaveProperty("lastActionResponse");
    // Degradation story: an older client that ignores structuredContent still
    // sees a meaningful text response.
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text?.length ?? 0).toBeGreaterThan(10);

    // The Action is observable through the wait tool on the same session.
    const actionId = (result.structuredContent as { actionRef: { actionId: { value: string } } }).actionRef.actionId.value;
    const checked = (await client.callTool({
      name: "mpas_wait_for_action_result",
      arguments: { actionId, timeoutSeconds: 0 },
    })) as { structuredContent?: Record<string, unknown> };
    expect(checked.structuredContent).toMatchObject({ type: "MpasBridgeDeferredResult" });
  });

  it("returns profile errors as tool results, not protocol errors", async () => {
    const notFound = (await client.callTool({
      name: "mpas_wait_for_action_result",
      arguments: { actionId: "urn:uuid:99999999-9999-4999-8999-999999999999", timeoutSeconds: 0 },
    })) as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
    expect(notFound.isError).toBe(true);
    expect(notFound.structuredContent).toMatchObject({ type: "MpasBridgeError", code: "ACTION_NOT_FOUND" });
    expect(notFound.content[0]?.text?.length ?? 0).toBeGreaterThan(10);

    const badTimeout = (await client.callTool({
      name: "mpas_wait_for_action_result",
      arguments: { actionId: "urn:uuid:x", timeoutSeconds: 400 },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(badTimeout.isError).toBe(true);
    expect(badTimeout.structuredContent).toMatchObject({ type: "MpasBridgeError", code: "INVALID_WAIT_TIMEOUT" });
  });
});
