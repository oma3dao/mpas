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

interface BridgeInstance {
  handleToolCall(toolName: string, args: object): Promise<ToolCallResult>;
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
  it("auto-executes create_issue_demo (pass-through, not in reviewed plugin)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("create_issue_demo", {
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
  it("requires 1 approval for delete_branch_demo (in plugin, threshold 1 policy)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter, coordination } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("delete_branch_demo", {
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
  it("requires 2 approvals for merge_pull_request_demo (in plugin, threshold 2 policy)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("merge_pull_request_demo", {
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
  it("uses operator policy for close_issue_demo (not in plugin, operator-added threshold 1)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("close_issue_demo", {
      owner: "example-org",
      repo: "mpas-demo-repository",
      issueNumber: 7,
    });
    const response = await client.submit(pkg);

    expect(response.result).toBe("additionalApprovalsRequired");
    const authReqs = (response as any).authorizationRequirements;
    expect(authReqs.approvalRequirements.anyOf[0].threshold).toBe(1);
    expect(authReqs.approvalRequirements.anyOf[0].description).toContain("Operator policy (close_issue_demo)");
  });

  // Scenario 5: Action NOT in plugin, NOT in policy, echo server doesn't know it → dispatch fails
  it("returns failed for unknown_tool (pass-through, target rejects)", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-demo-plugin.json"));
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

  // Full approval flow (client profile): the application call returns a
  // deferred result immediately; the workflow advances in the background; the
  // client retrieves the native result through mpas_wait_for_action_result.
  it("full approval flow: deferred delete_branch_demo, signer approval, wait-tool retrieval", async () => {
    const { GeneratedBridge } = await loadBridgeModule();
    const { adapter, coordination } = await startStack();

    const plugin = await readJson(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const proposer = new GeneratedBridge({
      plugin,
      applicationDid: plugin.applicationDid,
      adapterUrl: adapter.address,
      agentKey: join(fixturesDir, "test-keys", "proposer.json"),
      coordinationUrl: coordination.address,
      workflow: { pollIntervalMs: 100 },
    });
    await proposer.start?.();
    try {
      const signer = new SignerServer({
        signerKey: join(fixturesDir, "test-keys", "maintainer-a.json"),
        coordinationUrl: coordination.address,
      });

      // 1. The application call completes immediately with a deferred result.
      const deferred = await proposer.handleToolCall("delete_branch_demo", {
        owner: "example-org",
        repo: "mpas-demo-repository",
        branch: "feature/e2e-coordination",
      });
      expect(deferred.isError).toBeUndefined();
      expect(deferred.structuredContent).toMatchObject({
        version: "1",
        type: "MpasBridgeDeferredResult",
        notificationRequired: true,
        lastActionResponse: { result: "additionalApprovalsRequired" },
      });
      const actionId = (deferred.structuredContent as any).actionRef.actionId.value as string;

      // 2. Maintainer approves out of band.
      const approvalRequest = await waitForApprovalRequest(signer);
      await signer.handleToolCall("mpas_approve", {
        actionId: approvalRequest.actionRef.actionId.value,
      });

      // 3. The client retrieves the native result through the wait tool.
      const result = await proposer.handleToolCall("mpas_wait_for_action_result", {
        actionId,
        timeoutSeconds: 10,
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.mode).toBe("dry_run");
      expect(parsed.simulated_result).toMatchObject({ deleted: true, ref: "feature/e2e-coordination" });

      // 4. Stable result: a repeated wait returns the same native result.
      const again = await proposer.handleToolCall("mpas_wait_for_action_result", {
        actionId,
        timeoutSeconds: 0,
      });
      expect(JSON.parse(again.content[0].text!)).toEqual(parsed);
    } finally {
      proposer.stop?.();
    }
  });

  it("advertises the reserved wait tool and MPAS notices on application tools", async () => {
    const { GeneratedBridge } = await loadBridgeModule();
    const plugin = await readJson(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const proposer = new GeneratedBridge({
      plugin,
      applicationDid: plugin.applicationDid,
      adapterUrl: "http://127.0.0.1:1",
      agentKey: join(fixturesDir, "test-keys", "proposer.json"),
    });

    const tools = (proposer as unknown as { getToolDefinitions(): Array<{ name: string; description?: string }> }).getToolDefinitions();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("mpas_wait_for_action_result");
    const merge = tools.find((tool) => tool.name === "merge_pull_request_demo");
    expect(merge?.description).toContain("mediated by MPAS");
  });

  // Replay detection: same actionId after dispatch → rejected
  it("rejects replay of a dispatched actionId", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const { adapter } = await startStack();

    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const plugin = await readJson(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });

    const pkg = await builder.buildFromToolCall("create_issue_demo", {
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
    confirmPluginUse: async () => true,
  });
  const coordination = await startCoordinationDaemon({ port: 0 });
  startedApps.push(adapter.app, coordination.app);
  return { adapter, coordination };
}

async function waitForApprovalRequest(signer: BridgeInstance): Promise<Record<string, any>> {
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
