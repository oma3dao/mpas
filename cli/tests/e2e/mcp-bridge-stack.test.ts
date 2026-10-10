import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../src/adapter/daemon.js";
import { startCoordinationDaemon } from "../../src/coordination/daemon.js";
import { SignerServer } from "../../src/signer-server/index.js";

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

interface ToolHandler {
  handleToolCall(toolName: string, args: object): Promise<Record<string, any>>;
}

interface TaskServer {
  handleMessage(message: unknown): Promise<{ result?: Record<string, any>; error?: Record<string, any> } | undefined>;
}

interface BridgeInstance extends ToolHandler {
  buildMcpServer(): Promise<{
    handleMessage(message: unknown): Promise<{ result?: Record<string, any>; error?: Record<string, any> } | undefined>;
  }>;
  getToolDefinitions(): Array<{ name: string; description?: string }>;
  start?(): Promise<void>;
  stop?(): void;
}

interface BridgeModule {
  GeneratedBridge: new (config: Record<string, unknown>) => BridgeInstance;
  ActionPackageBuilder: new (config: Record<string, unknown>) => {
    buildFromToolCall(toolName: string, args: object): Promise<Record<string, any>>;
  };
  KeyManager: { fromFile(path: string): Promise<{ did: string }> };
  AdapterClient: new (config: { url: string }) => {
    submit(pkg: Record<string, any>): Promise<Record<string, any>>;
  };
}

const fixturesDir = join(process.cwd(), "tests", "fixtures");
const e2eConfigDir = join(fixturesDir, "configs", "e2e");
const startedApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.allSettled(startedApps.splice(0).map((app) => app.close()));
});

describe("MPAS E2E: Policy routing and dispatch", () => {
  // Scenario 1: Action not in plugin or policy → pass-through
  it("auto-executes create_issue_mirror (pass-through, not in reviewed plugin)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("create_issue_mirror", {
      owner: "example-org",
      repo: "mpas-demo-repository",
      title: "E2E: proposerOnly action",
    });
    const response = await client.submit(pkg);

    expect(response.result).toBe("executed");
    const text = (response as any).executionResult?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.simulated_result.title).toBe("E2E: proposerOnly action");
  });

  // Scenario 2: Action in plugin with threshold 1 policy → needs 1 approval
  it("requires 1 approval for delete_branch_mirror (in plugin, threshold 1 policy)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter, coordination } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("delete_branch_mirror", {
      owner: "example-org",
      repo: "mpas-demo-repository",
      branch: "feature/e2e-test",
    });
    const response = await client.submit(pkg);

    expect(response.result).toBe("additionalApprovalsRequired");
    const authReqs = (response as any).authorizationRequirements;
    expect(authReqs.approvalRequirements.anyOf[0].threshold).toBe(1);
    expect(authReqs.approvalRequirements.anyOf[0].description).toContain("Branch deletion");
  });

  // Scenario 3: Action in plugin with threshold 2 policy → needs 2 approvals
  it("requires 2 approvals for merge_pull_request_mirror (in plugin, threshold 2 policy)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("merge_pull_request_mirror", {
      owner: "example-org",
      repo: "mpas-demo-repository",
      pullNumber: 42,
      baseRef: "main",
      expectedHeadSha: "abc123",
      mergeMethod: "squash",
    });
    const response = await client.submit(pkg);

    expect(response.result).toBe("additionalApprovalsRequired");
    const authReqs = (response as any).authorizationRequirements;
    expect(authReqs.approvalRequirements.anyOf[0].threshold).toBe(2);
    expect(authReqs.approvalRequirements.anyOf[0].description).toContain("PR merge");
  });

  // Scenario 4: Action NOT in plugin, but operator added a policy → uses operator policy
  it("uses operator policy for close_issue_mirror (not in plugin, operator-added threshold 1)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("close_issue_mirror", {
      owner: "example-org",
      repo: "mpas-demo-repository",
      issueNumber: 7,
    });
    const response = await client.submit(pkg);

    expect(response.result).toBe("additionalApprovalsRequired");
    const authReqs = (response as any).authorizationRequirements;
    expect(authReqs.approvalRequirements.anyOf[0].threshold).toBe(1);
    expect(authReqs.approvalRequirements.anyOf[0].description).toContain("Operator policy (close_issue_mirror)");
  });

  // Scenario 5: Action NOT in plugin, NOT in policy, echo server doesn't know it → dispatch fails
  it("returns failed for unknown_tool (pass-through, target rejects)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("unknown_tool", {
      owner: "example-org",
      repo: "mpas-demo-repository",
    });
    const response = await client.submit(pkg);

    expect(response.result).toBe("failed");
  });

  // Full approval flow: the application call returns an official Task; the
  // workflow advances in the background; tasks/get returns the native result.
  it("full approval flow: Task creation, signer approval, tasks/get retrieval", async () => {
    const { GeneratedBridge } = await loadBridgeModule();
    const { adapter, coordination } = await startStack();

    const plugin = await readJson(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
    const proposer = new GeneratedBridge({
      plugin,
      applicationDid: plugin.applicationDid,
      adapterUrl: adapter.address,
      agentKey: join(fixturesDir, "test-keys", "proposer.json"),
      coordinationUrl: coordination.address,
      tools: join(process.cwd(), "bridge-tools", "github-mirror-tools.json"),
      workflow: { pollIntervalMs: 100 },
    });
    await proposer.start?.();
    try {
      const signer = new SignerServer({
        signerKey: join(fixturesDir, "test-keys", "maintainer-a.json"),
        coordinationUrl: coordination.address,
      });

      const server = await proposer.buildMcpServer();

      // 1. The application call completes immediately with a working Task.
      const task = await proposer.handleToolCall("delete_branch_mirror", {
        owner: "example-org",
        repo: "mpas-demo-repository",
        branch: "feature/e2e-coordination",
      });
      expect(task).toMatchObject({
        resultType: "task",
        status: "working",
        _meta: {
          "org.oma3/mpas": {
            version: "2",
            authorizationState: "authorization_required",
            disclosure: "transparent",
          },
        },
      });
      const taskId = task.taskId as string;

      // 2. Maintainer approves out of band.
      const approvalRequest = await waitForApprovalRequest(signer);
      await signer.handleToolCall("mpas_approve", {
        actionId: approvalRequest.actionRef.actionId.value,
      });

      // 3. The client observes the native result through read-only tasks/get.
      const completed = await waitForTask(server, taskId);
      expect(completed).toMatchObject({ resultType: "complete", status: "completed" });
      const parsed = JSON.parse(completed.result.content[0].text);
      expect(parsed.mode).toBe("dry_run");
      expect(parsed.simulated_result).toMatchObject({ deleted: true, ref: "feature/e2e-coordination" });

      // 4. Stable result: repeated tasks/get returns the same native result.
      const again = await taskRequest(server, "tasks/get", { taskId });
      expect(JSON.parse(again.result.content[0].text)).toEqual(parsed);
    } finally {
      proposer.stop?.();
    }
  });

  it("advertises the exact upstream tool surface without a wait tool", async () => {
    const { GeneratedBridge } = await loadBridgeModule();
    const plugin = await readJson(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
    const proposer = new GeneratedBridge({
      plugin,
      applicationDid: plugin.applicationDid,
      adapterUrl: "http://127.0.0.1:1",
      agentKey: join(fixturesDir, "test-keys", "proposer.json"),
      tools: join(process.cwd(), "bridge-tools", "github-mirror-tools.json"),
    });

    const tools = proposer.getToolDefinitions();
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("mpas_wait_for_action_result");
    const merge = tools.find((tool) => tool.name === "merge_pull_request_mirror");
    expect(merge?.description).toBe("Merge a pull request.");
  });

  // Replay detection: same actionId after dispatch → rejected
  it("rejects replay of a dispatched actionId", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("create_issue_mirror", {
      owner: "example-org",
      repo: "mpas-demo-repository",
      title: "replay test",
    });

    const first = await client.submit(pkg);
    expect(first.result).toBe("executed");

    const replay = await client.submit(pkg);
    expect(replay.result).toBe("rejected");
    expect((replay as any).error?.code).toBe("REPLAY_DETECTED");
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startStack() {
  const adapter = await startDaemon({
    configDir: e2eConfigDir,
    credentialDir: await credentialDir(),
    adapterKeyPath: join(fixturesDir, "test-keys", "adapter.json"),
    port: 0,
    journalPath: join(await mkdtemp(join(tmpdir(), "mpas-e2e-journal-")), "dispatch-ledger.jsonl"),
    trustContext: null,
    confirmPluginUse: async () => true,
  });
  const coordination = await startCoordinationDaemon({ port: 0 });
  startedApps.push(adapter.app, coordination.app);
  return { adapter, coordination };
}

async function waitForApprovalRequest(signer: ToolHandler): Promise<Record<string, any>> {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    const result = await signer.handleToolCall("mpas_list_pending", {});
    const approvalRequests = (result.structuredContent?.approvalRequests as Array<Record<string, any>> | undefined) ?? [];
    if (approvalRequests.length > 0) {
      return approvalRequests[0];
    }
    await sleep(50);
  }

  throw new Error("Timed out waiting for signer approval request.");
}

async function waitForTask(server: TaskServer, taskId: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const task = await taskRequest(server, "tasks/get", { taskId });
    if (task.status === "completed" || task.status === "cancelled" || task.status === "failed") {
      return task;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for Task ${taskId}.`);
}

async function taskRequest(server: TaskServer, method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: {
            "io.modelcontextprotocol/tasks": {},
            "org.oma3/mpas": { version: "2" },
          },
        },
      },
    },
  });
  if (!response?.result) {
    throw new Error(`Task request ${method} failed: ${JSON.stringify(response?.error)}`);
  }
  return response.result;
}

async function loadBridgeModule(): Promise<BridgeModule> {
  const bridge = await import("../../src/bridge/github-bridge.js");
  const mpas = await import("@oma3/mpas");
  return {
    GeneratedBridge: bridge.GeneratedBridge,
    ActionPackageBuilder: mpas.ActionPackageBuilder,
    KeyManager: mpas.KeyManager,
    AdapterClient: mpas.AdapterClient,
  } as unknown as BridgeModule;
}

async function credentialDir() {
  const dir = await mkdtemp(join(tmpdir(), "mpas-e2e-credentials-"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "github-mirror-token.json");
  await writeFile(path, `${JSON.stringify({ value: "ghp_e2e" })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return dir;
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
