import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The CLI's GitHub bridge must exit when its MCP client goes away, like a
 * generated bridge (feature reduce-polling §2.3 and §6). The bridge is
 * compiled into its own directory, so this test never races the tests that
 * rebuild `dist`.
 */

const cliRoot = fileURLToPath(new URL("../../", import.meta.url));
const SHUTDOWN_GRACE_MS = 2_000;
const MAINTAINER_DID = "did:web:maintainer.example";
const TOOL_CALL = { name: "delete_branch_demo", arguments: { owner: "example", repo: "demo", branch: "review" } };

let workDir: string;
let bridgePath: string;

beforeAll(async () => {
  // A real path: the bridge only runs when import.meta.url matches argv[1].
  workDir = await realpath(await mkdtemp(join(tmpdir(), "mpas-cli-bridge-lifecycle-")));
  await symlink(join(cliRoot, "node_modules"), join(workDir, "node_modules"), "dir");
  await writeFile(join(workDir, "tsconfig.json"), JSON.stringify({
    extends: join(cliRoot, "tsconfig.build.json"),
    compilerOptions: {
      rootDir: join(cliRoot, "src/bridge"),
      outDir: join(workDir, "dist"),
      declaration: false,
      sourceMap: false,
    },
    include: [],
    files: [join(cliRoot, "src/bridge/github-bridge.ts"), join(cliRoot, "src/bridge/sqlite-workflow-store.ts")],
  }));
  execFileSync(process.execPath, [join(cliRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
    cwd: workDir,
    stdio: "pipe",
  });
  bridgePath = join(workDir, "dist/github-bridge.js");
}, 60_000);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("CLI GitHub bridge process lifecycle", () => {
  it.each([
    ["stdin closes", (child: ChildProcessWithoutNullStreams) => child.stdin.end()],
    ["SIGTERM arrives", (child: ChildProcessWithoutNullStreams) => child.kill("SIGTERM")],
  ])("exits with code 0 when %s while a Coordination poll hangs", async (_name, leave) => {
    const services = await startFakeServices();
    const child = spawnBridge(await writeConfig(services.url));
    const rpc = jsonRpc(child);
    try {
      await rpc.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lifecycle-test", version: "0" },
      });
      rpc.notify("notifications/initialized");
      const deferred = await rpc.request("tools/call", TOOL_CALL) as {
        structuredContent: { actionRef: { actionId: { value: string } } };
      };
      const actionId = deferred.structuredContent.actionRef.actionId.value;
      // The tool call returns as soon as approvals are known to be required;
      // observe once the approval request is registered with Coordination.
      await services.workflowCreated;
      await new Promise((resolve) => setTimeout(resolve, 100));
      void rpc.request("tools/call", {
        name: "mpas_wait_for_action_result",
        arguments: { actionId, timeoutSeconds: 120 },
      }).catch(() => {});
      await services.pollStarted;

      const exit = exitOf(child);
      const leftAt = Date.now();
      leave(child);
      const result = await Promise.race([exit, timeout(SHUTDOWN_GRACE_MS + 5_000)]);

      expect(result).toEqual({ code: 0, signal: null });
      expect(Date.now() - leftAt).toBeLessThan(SHUTDOWN_GRACE_MS + 1_000 + 1_000);
      expect(services.polls()).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await services.close();
    }
  }, 30_000);

  it("after a crash, resumes the submission only on observation, then exits on EOF while it is in flight", async () => {
    const services = await startFakeServices("hang");
    // A short claim lease lets the restarted bridge take over the crashed one's
    // workflow. The restarted bridge keeps the default 45-second submission
    // timeout, so only noticing EOF exits it promptly.
    const dbPath = `store-crash-${Date.now()}.db`;
    const first = spawnBridge(await writeConfig(services.url, { dbPath, submissionTimeoutMs: 1_000, claimLeaseMs: 1_500 }));
    const second = { child: undefined as ChildProcessWithoutNullStreams | undefined };
    try {
      // Crash after the workflow is durably recorded and its first submission is in flight.
      const crashed = jsonRpc(first);
      await crashed.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "crash", version: "0" } });
      crashed.notify("notifications/initialized");
      void crashed.request("tools/call", TOOL_CALL).catch(() => {});
      await services.submissionCount(1);
      first.kill("SIGKILL");
      await new Promise((resolve) => first.once("exit", resolve));
      await new Promise((resolve) => setTimeout(resolve, 1_600));

      // The restarted bridge does no remote work at startup.
      second.child = spawnBridge(await writeConfig(services.url, { dbPath }));
      const rpc = jsonRpc(second.child);
      await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "restart", version: "0" } });
      rpc.notify("notifications/initialized");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(services.idempotencyKeys()).toHaveLength(1);

      // Observing the Task resumes the submission with the same key.
      const actionId = pendingActionId(join(workDir, dbPath));
      await rpc.request("tools/call", { name: "mpas_wait_for_action_result", arguments: { actionId, timeoutSeconds: 0 } });
      await services.submissionCount(2);

      const exit = exitOf(second.child);
      const leftAt = Date.now();
      second.child.stdin.end();
      const result = await Promise.race([exit, timeout(SHUTDOWN_GRACE_MS + 5_000)]);

      expect(result).toEqual({ code: 0, signal: null });
      expect(Date.now() - leftAt).toBeLessThan(SHUTDOWN_GRACE_MS + 2_000);
      const keys = services.idempotencyKeys();
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    } finally {
      for (const child of [first, second.child]) {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await services.close();
    }
  }, 30_000);

  it("lets a request already sent finish within the grace and persists its outcome before exiting", async () => {
    const services = await startFakeServices("slow-executed");
    const dbPath = `store-grace-${Date.now()}.db`;
    const child = spawnBridge(await writeConfig(services.url, { dbPath }));
    try {
      const rpc = jsonRpc(child);
      await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grace", version: "0" } });
      rpc.notify("notifications/initialized");
      void rpc.request("tools/call", TOOL_CALL).catch(() => {});
      await services.submissionCount(1);

      const exit = exitOf(child);
      child.stdin.end();
      const result = await Promise.race([exit, timeout(SHUTDOWN_GRACE_MS + 5_000)]);
      expect(result).toEqual({ code: 0, signal: null });
      expect(workflowStates(join(workDir, dbPath))).toEqual(["resolved"]);
      expect(services.idempotencyKeys()).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await services.close();
    }
  }, 30_000);

  it("records a submission cut off by shutdown as interrupted and keeps its Task for a restart", async () => {
    const services = await startFakeServices("hang");
    const dbPath = `store-abort-${Date.now()}.db`;
    const child = spawnBridge(await writeConfig(services.url, { dbPath }));
    try {
      const rpc = jsonRpc(child);
      await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "abort", version: "0" } });
      rpc.notify("notifications/initialized");
      void rpc.request("tools/call", TOOL_CALL).catch(() => {});
      await services.submissionCount(1);

      const exit = exitOf(child);
      child.stdin.end();
      const result = await Promise.race([exit, timeout(SHUTDOWN_GRACE_MS + 5_000)]);
      expect(result).toEqual({ code: 0, signal: null });
      // The Verifier never answered, so the outcome is unknown: the bridge aborts
      // the request and records that, rather than leaving no trace of it.
      expect(workflowAttempts(join(workDir, dbPath))).toEqual([
        { state: "created", outcomes: ["interrupted"] },
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await services.close();
    }
  }, 30_000);

  it("exits with code 0 when stdout breaks (EPIPE)", async () => {
    const services = await startFakeServices();
    const child = spawnBridge(await writeConfig(services.url));
    try {
      const exit = exitOf(child);
      child.stdout.destroy();
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "epipe", version: "0" } },
      })}\n`);
      const result = await Promise.race([exit, timeout(SHUTDOWN_GRACE_MS + 5_000)]);
      expect(result).toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await services.close();
    }
  }, 30_000);
});

/** The Action ID of the bridge store's one unfinished workflow. */
function pendingActionId(dbFile: string): string {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    // The store keys rows by Task ID in action_id; the Action ID is current_action_id.
    const row = db.prepare("SELECT current_action_id FROM workflows WHERE state = 'created'").get() as
      | { current_action_id: string }
      | undefined;
    if (!row) throw new Error("Expected one unfinished workflow.");
    return row.current_action_id;
  } finally {
    db.close();
  }
}

function workflowStates(dbFile: string): string[] {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return (db.prepare("SELECT state FROM workflows").all() as { state: string }[]).map((row) => row.state);
  } finally {
    db.close();
  }
}

function workflowAttempts(dbFile: string): { state: string; outcomes: string[] }[] {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare("SELECT state, adapter_attempts FROM workflows").all() as {
      state: string;
      adapter_attempts: string;
    }[];
    return rows.map((row) => ({
      state: row.state,
      outcomes: (JSON.parse(row.adapter_attempts) as { outcome?: string }[])
        .map((attempt) => attempt.outcome)
        .filter((outcome): outcome is string => outcome !== undefined && outcome !== "idempotencyBound"),
    }));
  } finally {
    db.close();
  }
}

async function writeConfig(url: string, workflow: Record<string, number | string> = {}): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const configPath = join(workDir, `config-${stamp}.json`);
  await writeFile(configPath, JSON.stringify({
    plugin: join(cliRoot, "tests/fixtures/plugins/github-mirror-plugin.json"),
    tools: join(cliRoot, "bridge-tools/github-live-demo-tools.json"),
    agent: { keyFile: join(cliRoot, "tests/fixtures/test-keys/proposer.json") },
    adapter: { url },
    coordination: { url },
    workflow: { dbPath: `store-${stamp}.db`, shutdownGraceMs: SHUTDOWN_GRACE_MS, ...workflow },
  }));
  return configPath;
}

function spawnBridge(configPath: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [bridgePath, "--config", configPath], { cwd: workDir });
}

function exitOf(child: ChildProcessWithoutNullStreams) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function timeout(ms: number) {
  return new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));
}

/**
 * Verifier that requires approvals (or, with `"hang"`, never answers, or with
 * `"slow-executed"`, executes after 500 ms), plus a Coordination Service whose
 * poll never answers.
 */
async function startFakeServices(verifier: "approvals" | "hang" | "slow-executed" = "approvals") {
  let polls = 0;
  let markWorkflowCreated: () => void = () => {};
  const workflowCreated = new Promise<void>((resolve) => {
    markWorkflowCreated = resolve;
  });
  const keys: string[] = [];
  const submissionWaiters: { count: number; resolve(): void }[] = [];
  let markPollStarted: () => void = () => {};
  const pollStarted = new Promise<void>((resolve) => {
    markPollStarted = resolve;
  });
  const server: Server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    const send = (value: unknown) => {
      response.writeHead(200, { "Content-Type": "application/mpas+json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/mpas/v1/coordination/poll") {
      polls += 1;
      markPollStarted();
      return; // Never answer, like the overloaded production service.
    }
    if (request.url === "/mpas/v1/verifier/action") {
      keys.push(String(body.idempotencyKey));
      for (const waiter of submissionWaiters.filter((entry) => keys.length >= entry.count)) waiter.resolve();
      if (verifier === "hang") return;
      if (verifier === "slow-executed") {
        setTimeout(() => send({
          version: "1",
          type: "ActionResponse",
          verifier: { did: MAINTAINER_DID },
          result: "executed",
          executionResult: { content: [{ type: "text", text: "done" }], isError: false },
        }), 500);
        return;
      }
    }
    const actionPackage = body.actionPackage as {
      actionEnvelope: { actionId: unknown };
      approvalBundle: { actionEnvelopeHash: unknown };
    };
    if (request.url === "/mpas/v1/coordination/workflow") {
      markWorkflowCreated();
      send({
        version: "1",
        type: "CoordinationActionResponse",
        actionRef: {
          version: "1",
          type: "ActionRef",
          actionId: actionPackage.actionEnvelope.actionId,
          actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
        },
        state: "awaitingApprovals",
      });
      return;
    }
    send({
      version: "1",
      type: "ActionResponse",
      verifier: { did: MAINTAINER_DID },
      result: "additionalApprovalsRequired",
      authorizationRequirements: {
        version: "1",
        type: "AuthorizationRequirements",
        result: "additionalApprovalsRequired",
        actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
        verifier: { did: MAINTAINER_DID },
        approvalRequirements: { anyOf: [{ type: "threshold", threshold: 1, eligibleSigners: [MAINTAINER_DID] }] },
      },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    pollStarted,
    workflowCreated,
    polls: () => polls,
    idempotencyKeys: () => [...keys],
    submissionCount: (count: number) => new Promise<void>((resolve) => {
      if (keys.length >= count) resolve();
      else submissionWaiters.push({ count, resolve });
    }),
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Newline-delimited JSON-RPC over the child's stdio. */
function jsonRpc(child: ChildProcessWithoutNullStreams) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
      const waiter = message.id === undefined ? undefined : pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id!);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });
  child.once("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("bridge exited"));
    pending.clear();
  });
  return {
    request(method: string, params: object): Promise<unknown> {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method: string): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}
