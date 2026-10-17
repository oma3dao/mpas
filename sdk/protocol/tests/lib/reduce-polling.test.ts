import { EventEmitter } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActionPackage,
  ActionRequest,
  ActionResponse,
  CoordinationActionUpdate,
  CoordinationPollResponse,
  Did,
} from "../../src/index.js";
import {
  ActionEndpointClient,
  CoordinationServiceClient,
  CoordinationUnavailableError,
  computeHash,
} from "../../src/index.js";
import { BridgeShuttingDownError, ProposerBridge } from "../../src/lib/bridge-runtime.js";
import { backoffDelayMs, parseRetryAfterMs } from "../../src/lib/retry-backoff.js";
import { bindStdioShutdown, type StdioShutdownHost } from "../../src/lib/stdio-lifecycle.js";
import type { WorkflowActionEndpoint, WorkflowCoordinationService } from "../../src/lib/workflow-engine.js";
import { MemoryWorkflowStore } from "../../src/lib/workflow-store.js";

const PROPOSER_DID = "did:jwk:proposer" as Did;
const START = Date.parse("2026-10-16T10:00:00.000Z");
const TOOLS = [{ name: "merge_pull_request", inputSchema: { type: "object" } }];
const REQUIREMENTS = { anyOf: [{ type: "threshold" as const, threshold: 1, eligibleSigners: ["did:jwk:maintainer"] }] };

let serial = 0;

function buildPackage(args: object, expiresAt: string): ActionPackage {
  serial += 1;
  const actionEnvelope = {
    version: "1" as const,
    type: "ActionEnvelope" as const,
    proposer: { did: PROPOSER_DID },
    target: { applicationDid: "did:web:example.com" as Did },
    executionProfile: { id: "did:web:example.com:profiles:mcp" as Did, format: "mcp.toolsCall" },
    executionPayloadHash: { alg: "sha-256" as const, value: "payload-hash" },
    actionId: { value: `urn:uuid:${String(serial).padStart(8, "0")}-0000-4000-8000-000000000000` },
    createdAt: new Date(START).toISOString(),
    expiresAt,
  };
  return {
    version: "1",
    type: "ActionPackage",
    executionPayload: { name: "merge_pull_request", arguments: args } as unknown as ActionPackage["executionPayload"],
    actionEnvelope,
    approvalBundle: {
      version: "1",
      type: "ApprovalBundle",
      actionEnvelopeHash: computeHash(actionEnvelope),
      approvals: [],
    },
  };
}

function response(result: ActionResponse["result"], extra: Partial<ActionResponse> = {}): ActionResponse {
  return { version: "1", type: "ActionResponse", result, ...extra };
}

const APPROVALS_REQUIRED = response("additionalApprovalsRequired", {
  authorizationRequirements: {
    version: "1",
    type: "AuthorizationRequirements",
    result: "additionalApprovalsRequired",
    actionEnvelopeHash: { alg: "sha-256", value: "response-hash" },
    verifier: { did: "did:jwk:verifier" as Did },
    approvalRequirements: REQUIREMENTS,
  },
});

/** Action endpoint that answers from a script and records each request. */
function scriptedEndpoint(script: (ActionResponse | Error | "hang")[], fallback?: ActionResponse) {
  const requests: { at: number; request: ActionRequest }[] = [];
  const endpoint: WorkflowActionEndpoint = {
    async submitActionRequest(request) {
      requests.push({ at: Date.now(), request });
      const next = script.length > 0 ? script.shift()! : fallback;
      if (next === undefined) throw new Error("endpoint script exhausted");
      if (next === "hang") return new Promise<ActionResponse>(() => {});
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { endpoint, requests };
}

/** Coordination fake whose poll answers come from `onPoll`. */
function fakeCoordination(onPoll: () => Promise<CoordinationPollResponse>) {
  const polls: number[] = [];
  const service: WorkflowCoordinationService = {
    async createApprovalWorkflow({ actionPackage }) {
      return {
        version: "1",
        type: "CoordinationActionResponse",
        actionRef: {
          version: "1",
          type: "ActionRef",
          actionId: actionPackage.actionEnvelope.actionId,
          actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
        },
        state: "awaitingApprovals",
      };
    },
    pollWork() {
      polls.push(Date.now());
      return onPoll();
    },
    async cancelAction({ actionId }) {
      return {
        version: "1",
        type: "CoordinationActionCancelResponse",
        actionRef: { version: "1", type: "ActionRef", actionId, actionEnvelopeHash: { alg: "sha-256", value: "h" } },
        state: "cancelled",
        cancelledAt: new Date().toISOString(),
      };
    },
  };
  return { service, polls };
}

function emptyPoll(updates: CoordinationActionUpdate[] = []): CoordinationPollResponse {
  return { version: "1", type: "CoordinationPollResponse", approvalRequests: [], actionUpdates: updates };
}

function makeBridge(options: {
  endpoint: WorkflowActionEndpoint;
  coordination: WorkflowCoordinationService;
  store?: MemoryWorkflowStore;
  expiresInMs?: number;
}) {
  const expiresAt = () => new Date(Date.now() + (options.expiresInMs ?? 30 * 60_000)).toISOString();
  return new ProposerBridge({
    tools: TOOLS,
    buildActionPackage: async (_name, args) => buildPackage(args, expiresAt()),
    buildCoordinationReplacement: async (priorPackage, verifierRequirements) => {
      const actionPackage = buildPackage(
        (priorPackage.executionPayload as unknown as { arguments: object }).arguments,
        priorPackage.actionEnvelope.expiresAt,
      );
      return {
        actionPackage,
        authorizationRequirements: {
          ...structuredClone(verifierRequirements),
          actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
        },
      };
    },
    store: options.store ?? new MemoryWorkflowStore(),
    actionEndpoint: options.endpoint,
    coordinationService: options.coordination,
    proposerDid: PROPOSER_DID,
    resultRetentionSeconds: 86_400,
    random: () => 0.999,
  });
}

async function proposeAwaitingApprovals(bridge: ProposerBridge): Promise<string> {
  const result = await bridge.handleToolCall("merge_pull_request", { pullNumber: 42 });
  if (result.resultType !== "task") throw new Error("Expected a deferred Task.");
  return result.taskId;
}

function metaOf(result: { _meta?: Record<string, unknown> }): Record<string, unknown> {
  return result._meta?.["org.oma3/mpas"] as Record<string, unknown>;
}

describe("retry backoff helpers", () => {
  it("grows exponentially up to the cap with full jitter", () => {
    const policy = { baseMs: 5_000, capMs: 300_000 };
    expect(backoffDelayMs(1, policy, () => 0.999)).toBe(4_995);
    expect(backoffDelayMs(3, policy, () => 0.999)).toBe(19_980);
    expect(backoffDelayMs(20, policy, () => 0.999)).toBe(299_700);
    expect(backoffDelayMs(4, policy, () => 0)).toBe(0);
  });

  it("lets Retry-After replace the computed delay, capped at 15 minutes", () => {
    expect(backoffDelayMs(1, { baseMs: 5_000, capMs: 300_000 }, () => 0.5, 42_000)).toBe(42_000);
    expect(backoffDelayMs(1, { baseMs: 5_000, capMs: 300_000 }, () => 0.5, 3_600_000)).toBe(900_000);
  });

  it("parses delay-seconds and HTTP-date Retry-After values", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs("Fri, 16 Oct 2026 10:00:10 GMT", START)).toBe(10_000);
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe("HTTP client Retry-After and lifetime signal", () => {
  it("carries Retry-After on a 429 Coordination response", async () => {
    const server = await startServer((res) => {
      res.writeHead(429, { "Content-Type": "application/mpas+json", "Retry-After": "30" });
      res.end(JSON.stringify({ version: "1", type: "MpasHttpError", error: { code: "rate_limited", message: "slow down" } }));
    });
    try {
      const client = new CoordinationServiceClient({ url: server.url, participantDid: PROPOSER_DID });
      const error = await client.pollWork().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CoordinationUnavailableError);
      expect((error as CoordinationUnavailableError).retryAfterMs).toBe(30_000);
    } finally {
      await server.close();
    }
  });

  it("aborts an in-flight Coordination poll when the lifetime signal aborts", async () => {
    const server = await startServer(() => {
      // Never answer.
    });
    try {
      const lifetime = new AbortController();
      const client = new CoordinationServiceClient({ url: server.url, participantDid: PROPOSER_DID, signal: lifetime.signal });
      const poll = client.pollWork();
      setTimeout(() => lifetime.abort(), 50);
      const started = Date.now();
      await expect(poll).rejects.toBeInstanceOf(CoordinationUnavailableError);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await server.close();
    }
  });

  it("aborts an in-flight Action submission when the lifetime signal aborts", async () => {
    const server = await startServer(() => {
      // Never answer.
    });
    try {
      const lifetime = new AbortController();
      const client = new ActionEndpointClient({ url: server.url, signal: lifetime.signal });
      const pkg = buildPackage({}, "2030-01-01T00:00:00.000Z");
      const submission = client.submitActionRequest({ version: "1", type: "ActionRequest", actionPackage: pkg });
      setTimeout(() => lifetime.abort(), 50);
      await expect(submission).rejects.toThrow(/unavailable/);
    } finally {
      await server.close();
    }
  });
});

describe("on-demand Coordination polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes no Coordination calls without Task observation, even as the Action expires", async () => {
    const completedUpdate: CoordinationActionUpdate[] = [];
    const coordination = fakeCoordination(async () => emptyPoll(completedUpdate));
    const { endpoint, requests } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const store = new MemoryWorkflowStore();
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store, expiresInMs: 30 * 60_000 });

    const taskId = await proposeAwaitingApprovals(bridge);
    await bridge.start();
    await vi.advanceTimersByTimeAsync(31 * 60_000);

    expect(coordination.polls).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(store.getWorkflow(taskId)).toMatchObject({
      state: "unresolvable",
      resolution: { kind: "unresolvable", errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION" },
    });
    await bridge.shutdown();
  });

  it("starts at most one poll per minimum interval and never overlaps polls", async () => {
    let release: (value: CoordinationPollResponse) => void = () => {};
    const coordination = fakeCoordination(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { endpoint } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const bridge = makeBridge({ endpoint, coordination: coordination.service });
    const taskId = await proposeAwaitingApprovals(bridge);

    for (let second = 0; second < 25; second += 1) {
      expect(bridge.handleTasksGet(taskId)).toMatchObject({ status: "working" });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(coordination.polls).toHaveLength(1);

    release(emptyPoll());
    await vi.advanceTimersByTimeAsync(0);
    for (let second = 0; second < 25; second += 1) {
      bridge.handleTasksGet(taskId);
      release(emptyPoll());
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const gaps = coordination.polls.slice(1).map((at, index) => at - coordination.polls[index]!);
    expect(coordination.polls.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10_000);
    await bridge.shutdown();
  });

  it("returns the last known state with coordinationCheckedAt inside the rate limit", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const bridge = makeBridge({ endpoint, coordination: coordination.service });
    const taskId = await proposeAwaitingApprovals(bridge);

    expect(metaOf(bridge.handleTasksGet(taskId))).toMatchObject({ coordinationCheckedAt: null });
    await vi.advanceTimersByTimeAsync(0);
    const checkedAt = new Date(START).toISOString();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(metaOf(bridge.handleTasksGet(taskId))).toMatchObject({
      authorizationState: "authorization_required",
      coordinationCheckedAt: checkedAt,
    });
    expect(coordination.polls).toHaveLength(1);
    await bridge.shutdown();
  });

  it("submits a completed package exactly once when a poll reports readyForSubmission", async () => {
    const store = new MemoryWorkflowStore();
    const native = { content: [{ type: "text", text: "merged" }], isError: false };
    const updates: CoordinationActionUpdate[] = [];
    const coordination = fakeCoordination(async () => emptyPoll(updates));
    const { endpoint, requests } = scriptedEndpoint([APPROVALS_REQUIRED, response("executed", { executionResult: native })]);
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    const taskId = await proposeAwaitingApprovals(bridge);
    await bridge.start();

    const record = store.getWorkflow(taskId)!;
    const completed = record.actionPackage as ActionPackage;
    updates.push({
      version: "1",
      type: "CoordinationActionUpdate",
      actionRef: {
        version: "1",
        type: "ActionRef",
        actionId: completed.actionEnvelope.actionId,
        actionEnvelopeHash: completed.approvalBundle.actionEnvelopeHash,
      },
      state: "readyForSubmission",
      expiresAt: completed.actionEnvelope.expiresAt,
      actionPackage: completed,
    });

    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(100);
    expect(requests).toHaveLength(2);
    expect(bridge.handleTasksGet(taskId)).toMatchObject({ status: "completed", result: native });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(requests).toHaveLength(2);
    await bridge.shutdown();
  });

  it("polls once per compatibility wait call and not again during the wait", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const store = new MemoryWorkflowStore();
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    const taskId = await proposeAwaitingApprovals(bridge);
    const actionId = store.getWorkflow(taskId)!.actionId;

    const wait = bridge.handleCompatibilityToolCall("mpas_wait_for_action_result", { actionId, timeoutSeconds: 60 });
    await vi.advanceTimersByTimeAsync(61_000);
    const result = await wait;

    expect(coordination.polls).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      type: "MpasBridgeDeferredResult",
      coordinationCheckedAt: new Date(START).toISOString(),
    });
    await bridge.shutdown();
  });

  it("finishes an interrupted completed submission at startup without polling", async () => {
    const store = new MemoryWorkflowStore();
    const coordination = fakeCoordination(async () => emptyPoll());
    const first = scriptedEndpoint([APPROVALS_REQUIRED]);
    const taskId = await proposeAwaitingApprovals(
      makeBridge({ endpoint: first.endpoint, coordination: coordination.service, store }),
    );
    store.saveCompletedPackage(taskId, store.getWorkflow(taskId)!.actionPackage);
    expect(store.compareAndSetState(taskId, "awaitingApprovals", "readyForSubmission")).toBe(true);

    const second = scriptedEndpoint([response("executed", { executionResult: { content: [], isError: false } })]);
    const restarted = makeBridge({ endpoint: second.endpoint, coordination: coordination.service, store });
    await restarted.start();

    expect(second.requests).toHaveLength(1);
    expect(store.getWorkflow(taskId)).toMatchObject({ state: "resolved" });
    expect(coordination.polls).toHaveLength(0);
    await restarted.shutdown();
  });

  it("backs off a failed poll and honors Retry-After", async () => {
    let failures = 1;
    const coordination = fakeCoordination(async () => {
      if (failures-- > 0) {
        throw new CoordinationUnavailableError("busy", { retryAfterMs: 60_000 });
      }
      return emptyPoll();
    });
    const { endpoint } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const bridge = makeBridge({ endpoint, coordination: coordination.service });
    const taskId = await proposeAwaitingApprovals(bridge);

    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(15_000);
    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(30_000);
    bridge.handleTasksGet(taskId);
    expect(coordination.polls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(16_000);
    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(0);
    expect(coordination.polls).toHaveLength(2);
    expect(coordination.polls[1]! - coordination.polls[0]!).toBeGreaterThanOrEqual(60_000);
    expect(metaOf(bridge.handleTasksGet(taskId)).coordinationCheckedAt).not.toBeNull();
    await bridge.shutdown();
  });
});

describe("paced remote retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off Verifier pending re-checks up to 60 seconds with the same idempotency key", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint, requests } = scriptedEndpoint([], response("pending"));
    const bridge = makeBridge({ endpoint, coordination: coordination.service, expiresInMs: 60 * 60_000 });
    await bridge.handleToolCall("merge_pull_request", {});
    await bridge.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    const gaps = requests.slice(1).map((entry, index) => entry.at - requests[index]!.at);
    // A fixed 2-second tick would have sent about 300 requests.
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.length).toBeLessThan(20);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);
    expect(gaps[gaps.length - 1]).toBeGreaterThan(50_000);
    expect(new Set(requests.map((entry) => entry.request.idempotencyKey)).size).toBe(1);
    expect(coordination.polls).toHaveLength(0);
    await bridge.shutdown();
  });

  it("backs off failed initial submissions instead of retrying every tick", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint, requests } = scriptedEndpoint([], undefined);
    const failing: WorkflowActionEndpoint = {
      submitActionRequest: (request) => {
        void endpoint.submitActionRequest(request).catch(() => {});
        return Promise.reject(new Error("unreachable"));
      },
    };
    const bridge = makeBridge({ endpoint: failing, coordination: coordination.service, expiresInMs: 60 * 60_000 });
    await bridge.handleToolCall("merge_pull_request", {});
    await bridge.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(requests.length).toBeGreaterThan(3);
    expect(requests.length).toBeLessThan(15);
    await bridge.shutdown();
  });
});

describe("bridge shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops serving, waits up to the grace period for in-flight work, and is idempotent", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint } = scriptedEndpoint(["hang"]);
    const bridge = makeBridge({ endpoint, coordination: coordination.service });
    await bridge.start();
    void bridge.handleToolCall("merge_pull_request", {}).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    let finished = false;
    const shutdown = bridge.shutdown(2_000);
    void shutdown.then(() => {
      finished = true;
    });
    expect(bridge.shutdown()).toBe(shutdown);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(finished).toBe(true);

    expect(() => bridge.handleTasksGet("urn:uuid:any")).toThrow(BridgeShuttingDownError);
    await expect(bridge.handleToolCall("merge_pull_request", {})).rejects.toBeInstanceOf(BridgeShuttingDownError);
  });

  it("answers in-flight compatibility waits at once instead of holding shutdown", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const store = new MemoryWorkflowStore();
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    const taskId = await proposeAwaitingApprovals(bridge);
    const actionId = store.getWorkflow(taskId)!.actionId;
    const wait = bridge.handleCompatibilityToolCall("mpas_wait_for_action_result", { actionId, timeoutSeconds: 300 });
    await vi.advanceTimersByTimeAsync(0);

    let finished = false;
    void bridge.shutdown(5_000).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    await expect(wait).resolves.toMatchObject({ structuredContent: { type: "MpasBridgeDeferredResult" } });
  });
});

describe("bindStdioShutdown", () => {
  function fakeHost() {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const signals = new EventEmitter();
    const exits: number[] = [];
    const host: StdioShutdownHost = {
      stdin: stdin as unknown as StdioShutdownHost["stdin"],
      stdout: stdout as unknown as StdioShutdownHost["stdout"],
      once: (signal, listener) => signals.once(signal, listener),
      off: (signal, listener) => signals.off(signal, listener),
      exit: (code) => {
        exits.push(code);
      },
    };
    return { host, stdin, stdout, signals, exits };
  }

  it.each([
    ["stdin end", (h: ReturnType<typeof fakeHost>) => h.stdin.emit("end")],
    ["stdin close", (h: ReturnType<typeof fakeHost>) => h.stdin.emit("close")],
    ["stdout error", (h: ReturnType<typeof fakeHost>) => h.stdout.emit("error", new Error("EPIPE"))],
    ["SIGTERM", (h: ReturnType<typeof fakeHost>) => h.signals.emit("SIGTERM")],
    ["SIGINT", (h: ReturnType<typeof fakeHost>) => h.signals.emit("SIGINT")],
    ["SIGHUP", (h: ReturnType<typeof fakeHost>) => h.signals.emit("SIGHUP")],
  ])("shuts down once and exits 0 on %s", async (_name, fire) => {
    const fake = fakeHost();
    const shutdown = vi.fn(async () => {});
    bindStdioShutdown({ shutdown, host: fake.host });
    fire(fake);
    fake.stdin.emit("close");
    fake.signals.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(fake.exits).toEqual([0]);
  });

  it("exits 1 when shutdown fails or exceeds the deadline", async () => {
    const failing = fakeHost();
    bindStdioShutdown({ shutdown: async () => Promise.reject(new Error("boom")), host: failing.host });
    failing.stdin.emit("end");
    await new Promise((resolve) => setImmediate(resolve));
    expect(failing.exits).toEqual([1]);

    vi.useFakeTimers();
    try {
      const hanging = fakeHost();
      bindStdioShutdown({ shutdown: () => new Promise(() => {}), host: hanging.host, forceExitAfterMs: 1_000 });
      hanging.stdin.emit("end");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(hanging.exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes its listeners when disposed", () => {
    const fake = fakeHost();
    const shutdown = vi.fn(async () => {});
    const dispose = bindStdioShutdown({ shutdown, host: fake.host });
    dispose();
    fake.stdin.emit("end");
    fake.signals.emit("SIGTERM");
    expect(shutdown).not.toHaveBeenCalled();
    expect(fake.stdin.listenerCount("end")).toBe(0);
    expect(fake.signals.listenerCount("SIGTERM")).toBe(0);
  });
});

async function startServer(handler: (response: ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, res) => {
    request.resume();
    request.on("end", () => handler(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
