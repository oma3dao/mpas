import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGenerate } from "../src/generate.js";

/**
 * Reproduces the 2026-10-15 incident shape (feature reduce-polling §2.3): a
 * generated bridge with an Action awaiting approvals and a Coordination poll
 * that never answers must still exit when its MCP client goes away.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const SHUTDOWN_GRACE_MS = 2_000;
const APPLICATION_DID = "did:web:lifecycle-probe.example";

let outDir: string;
let bridgeDir: string;
let maintainerDid: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "mpas-generated-lifecycle-"));
  await runGenerate({
    appName: "lifecycle-probe", outDir, upstreamCommand: "fixture", upstreamArgs: [],
    applicationDid: APPLICATION_DID, log: () => {},
    discover: async () => ({ command: "fixture", args: [], serverName: "fixture", protocolVersion: "2024-11-05", tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
  });
  bridgeDir = join(outDir, "lifecycle-probe/bridge");
  const modules = join(bridgeDir, "node_modules");
  await mkdir(join(modules, "@oma3"), { recursive: true });
  await mkdir(join(modules, "@modelcontextprotocol"), { recursive: true });
  await mkdir(join(modules, "@types"), { recursive: true });
  await symlink(join(root, "sdk/protocol"), join(modules, "@oma3/mpas"), "dir");
  await symlink(join(root, "sdk/protocol/node_modules/@modelcontextprotocol/server"), join(modules, "@modelcontextprotocol/server"), "dir");
  await symlink(join(root, "sdk/protocol/node_modules/@types/node"), join(modules, "@types/node"), "dir");
  execFileSync(process.execPath, [join(root, "bridge-generator/node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: bridgeDir, stdio: "pipe" });
  await copyFile(join(bridgeDir, "src/tools.json"), join(bridgeDir, "dist/tools.json"));

  const sdk = await import(pathToFileURL(join(root, "sdk/protocol/dist/index.js")).href) as {
    generateP256Key(): Promise<{ did: string }>;
  };
  await writeFile(join(bridgeDir, "agent-key.json"), JSON.stringify(await sdk.generateP256Key()));
  maintainerDid = (await sdk.generateP256Key()).did;
}, 60_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("generated bridge process lifecycle", () => {
  it.each([
    ["stdin closes", (child: ChildProcessWithoutNullStreams) => child.stdin.end()],
    ["SIGTERM arrives", (child: ChildProcessWithoutNullStreams) => child.kill("SIGTERM")],
  ])("exits with code 0 when %s while a Coordination poll hangs", async (_name, leave) => {
    const services = await startFakeServices(maintainerDid);
    const child = spawnBridge(await writeConfig(services.url));
    const rpc = jsonRpc(child);
    try {
      await rpc.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lifecycle-test", version: "0" },
      });
      rpc.notify("notifications/initialized");
      const deferred = await rpc.request("tools/call", { name: "echo", arguments: {} }) as {
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
    const services = await startFakeServices(maintainerDid, "hang");
    // A short claim lease lets the restarted bridge take over the crashed one's
    // workflow. The restarted bridge keeps the default 30-second submission
    // timeout, so only noticing EOF exits it promptly.
    const dbPath = `store-crash-${Date.now()}.db`;
    const first = spawnBridge(await writeConfig(services.url, { dbPath, submissionTimeoutMs: 1_000, claimLeaseMs: 1_500 }));
    const second = { child: undefined as ChildProcessWithoutNullStreams | undefined };
    try {
      // Crash after the workflow is durably recorded and its first submission is in flight.
      const crashed = jsonRpc(first);
      await crashed.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "crash", version: "0" } });
      crashed.notify("notifications/initialized");
      void crashed.request("tools/call", { name: "echo", arguments: {} }).catch(() => {});
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
      const actionId = pendingActionId(join(bridgeDir, dbPath));
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
    const services = await startFakeServices(maintainerDid, "slow-executed");
    const dbPath = `store-grace-${Date.now()}.db`;
    const child = spawnBridge(await writeConfig(services.url, { dbPath }));
    try {
      const rpc = jsonRpc(child);
      await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grace", version: "0" } });
      rpc.notify("notifications/initialized");
      void rpc.request("tools/call", { name: "echo", arguments: {} }).catch(() => {});
      await services.submissionCount(1);

      const exit = exitOf(child);
      child.stdin.end();
      const result = await Promise.race([exit, timeout(SHUTDOWN_GRACE_MS + 5_000)]);
      expect(result).toEqual({ code: 0, signal: null });
      expect(workflowStates(join(bridgeDir, dbPath))).toEqual(["resolved"]);
      expect(services.idempotencyKeys()).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await services.close();
    }
  }, 30_000);

  it("exits with code 0 when stdout breaks (EPIPE)", async () => {
    const services = await startFakeServices(maintainerDid);
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

async function writeConfig(url: string, workflow: Record<string, number | string> = {}): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const configPath = join(bridgeDir, `config-${stamp}.json`);
  await writeFile(configPath, JSON.stringify({
    plugin: "../plugin.json",
    agent: { keyFile: "agent-key.json" },
    adapter: { url },
    coordination: { url },
    workflow: { dbPath: `store-${stamp}.db`, shutdownGraceMs: SHUTDOWN_GRACE_MS, ...workflow },
  }));
  return configPath;
}

function spawnBridge(configPath: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["dist/index.js", "--config", configPath], { cwd: bridgeDir });
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
 * Verifier that requires approvals (or, with `"hang"`, never answers), plus a
 * Coordination Service whose poll never answers.
 */
async function startFakeServices(maintainer: string, verifier: "approvals" | "hang" | "slow-executed" = "approvals") {
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
          verifier: { did: maintainer },
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
      verifier: { did: maintainer },
      result: "additionalApprovalsRequired",
      authorizationRequirements: {
        version: "1",
        type: "AuthorizationRequirements",
        result: "additionalApprovalsRequired",
        actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
        verifier: { did: maintainer },
        approvalRequirements: { anyOf: [{ type: "threshold", threshold: 1, eligibleSigners: [maintainer] }] },
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
