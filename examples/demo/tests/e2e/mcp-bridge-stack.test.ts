import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../src/adapter/daemon.js";
import { startCoordinationDaemon } from "../../src/coordination/daemon.js";

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

interface BridgeInstance {
  handleToolCall(toolName: string, args: object): Promise<ToolCallResult>;
}

interface BridgeModule {
  ProposerBridge: new (config: Record<string, unknown>) => BridgeInstance;
  MaintainerBridge: new (config: Record<string, unknown>) => BridgeInstance;
  ActionPackageBuilder: new (config: Record<string, unknown>) => {
    buildFromToolCall(toolName: string, args: object): Promise<Record<string, any>>;
  };
  KeyManager: { fromFile(path: string): Promise<{ did: string }> };
  AdapterClient: new (config: { url: string }) => {
    submit(pkg: Record<string, any>): Promise<{ result: string; error?: { code: string } }>;
  };
}

const fixturesDir = join(process.cwd(), "tests", "fixtures");
const bridgeDir = process.env.MPAS_MCP_BRIDGE_DIR;
const e2eDescribe = bridgeDir ? describe : describe.skip;
const startedApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.allSettled(startedApps.splice(0).map((app) => app.close()));
});

e2eDescribe("MCP bridge, Credential Adapter, and Coordination Service E2E", () => {
  it("collects a signer approval and executes the completed Action Package", async () => {
    const { ProposerBridge, MaintainerBridge } = await loadBridgeModule();
    const adapter = await startDaemon({
      configDir: join(fixturesDir, "configs"),
      credentialDir: await credentialDir(),
      adapterKeyPath: join(fixturesDir, "test-keys", "adapter.json"),
      port: 0,
      journalPath: join(await mkdtemp(join(tmpdir(), "mpas-e2e-journal-")), "dispatch-ledger.jsonl"),
    });
    const coordination = await startCoordinationDaemon({ port: 0 });
    startedApps.push(adapter.app, coordination.app);

    const plugin = await readJson(join(fixturesDir, "plugins", "github-repo.json"));
    const proposer = new ProposerBridge({
      plugin,
      applicationDid: plugin.applicationDid,
      adapterUrl: adapter.address,
      agentKey: join(fixturesDir, "test-keys", "proposer.json"),
      coordinationUrl: coordination.address,
      approvalStrategy: "wait",
      approvalTimeoutMs: 5_000,
    });
    const signer = new MaintainerBridge({
      maintainerKey: join(fixturesDir, "test-keys", "maintainer-a.json"),
      coordinationUrl: coordination.address,
    });

    const proposerResultPromise = proposer.handleToolCall("delete_branch", {
      owner: "example-org",
      repo: "mpas-demo-repository",
      branch: "feature/e2e-coordination",
    });
    const approvalRequest = await waitForApprovalRequest(signer);
    const review = await signer.handleToolCall("mpas_review_action", {
      actionId: approvalRequest.actionRef.actionId.value,
    });
    const approval = await signer.handleToolCall("mpas_approve", {
      actionId: approvalRequest.actionRef.actionId.value,
    });
    const proposerResult = await proposerResultPromise;

    expect(review.isError).toBeUndefined();
    expect(approval.isError).toBeUndefined();
    expect(proposerResult.isError, JSON.stringify(proposerResult)).toBeUndefined();
    // executionResult is the verbatim MCP tools/call result object (not the old dispatch wrapper).
    expect(proposerResult.content[0]?.text).toContain('"mode": "dry_run"');
    const parsed = JSON.parse(proposerResult.content[0].text!);
    expect(parsed.mode).toBe("dry_run");
    expect(parsed.simulated_result).toMatchObject({ deleted: true, ref: "feature/e2e-coordination" });
  });

  it("rejects replay of a dispatched actionId and accepts a fresh one", async () => {
    const { ActionPackageBuilder, KeyManager, AdapterClient } = await loadBridgeModule();
    const adapter = await startDaemon({
      configDir: join(fixturesDir, "configs"),
      credentialDir: await credentialDir(),
      adapterKeyPath: join(fixturesDir, "test-keys", "adapter.json"),
      port: 0,
      journalPath: join(await mkdtemp(join(tmpdir(), "mpas-e2e-journal-")), "dispatch-ledger.jsonl"),
    });
    startedApps.push(adapter.app);

    const plugin = await readJson(join(fixturesDir, "plugins", "github-repo.json"));
    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: plugin.applicationDid,
      executionProfile: { id: plugin.executionProfile.id, format: plugin.executionProfile.format ?? "mcp.toolsCall" },
      keyManager,
    });
    const client = new AdapterClient({ url: adapter.address });
    const args = { owner: "example-org", repo: "mpas-demo-repository", title: "hello from e2e" };

    // Build + sign a package (auto-approved create_issue), dispatch it once.
    const pkg = await builder.buildFromToolCall("create_issue", args);
    const first = await client.submit(pkg);
    expect(first.result, JSON.stringify(first)).toBe("executed");

    // Replaying the exact same package (same actionId, same envelope hash) is rejected.
    const replay = await client.submit(pkg);
    expect(replay.result).toBe("rejected");
    expect(replay.error?.code).toBe("REPLAY_DETECTED");

    // Rebuilding mints a fresh actionId (and re-signs), so it dispatches normally.
    const freshPkg = await builder.buildFromToolCall("create_issue", args);
    expect(freshPkg.actionEnvelope.actionId.value).not.toBe(pkg.actionEnvelope.actionId.value);
    const third = await client.submit(freshPkg);
    expect(third.result, JSON.stringify(third)).toBe("executed");
  });
});

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
  if (!bridgeDir) {
    throw new Error("MPAS_MCP_BRIDGE_DIR is required for MCP bridge E2E tests.");
  }

  const candidates = [join(bridgeDir, "dist", "index.js"), join(bridgeDir, "dist", "src", "index.js")];
  const entrypoint = candidates.find((candidate) => existsSync(candidate));
  if (!entrypoint) {
    throw new Error(`MCP bridge build output not found. Tried: ${candidates.join(", ")}`);
  }

  return import(pathToFileURL(entrypoint).href) as Promise<BridgeModule>;
}

async function credentialDir() {
  const dir = await mkdtemp(join(tmpdir(), "mpas-e2e-credentials-"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "github-test-token.json");
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
