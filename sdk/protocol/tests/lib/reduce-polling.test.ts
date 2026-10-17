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
  ActionEndpointClientError,
  ActionRelayClient,
  ActionRelayResponseError,
  ActionRelayUnavailableError,
  AdapterRequestError,
  CoordinationResponseError,
  CoordinationServiceClient,
  CoordinationUnavailableError,
  CredentialAdapterClient,
  MpasAuthError,
  buildDeliveryEnvelope,
  computeHash,
} from "../../src/index.js";
import { BridgeShuttingDownError, ProposerBridge, SHUTDOWN_SETTLE_MS } from "../../src/lib/bridge-runtime.js";
import { backoffDelayMs, parseRetryAfterMs } from "../../src/lib/retry-backoff.js";
import { bindStdioShutdown, type StdioShutdownHost } from "../../src/lib/stdio-lifecycle.js";
import { BridgeWorkflowEngine, type WorkflowActionEndpoint, type WorkflowCoordinationService } from "../../src/lib/workflow-engine.js";
import { MemoryWorkflowStore } from "../../src/lib/workflow-store.js";

const PROPOSER_DID = "did:jwk:proposer" as Did;
const OTHER_DID = "did:jwk:other-proposer" as Did;
const START = Date.parse("2026-10-16T10:00:00.000Z");
const TOOLS = [{ name: "merge_pull_request", inputSchema: { type: "object" } }];
const REQUIREMENTS = { anyOf: [{ type: "threshold" as const, threshold: 1, eligibleSigners: ["did:jwk:maintainer" as Did] }] };

let serial = 0;

function buildPackage(args: object, expiresAt: string, proposerDid: Did = PROPOSER_DID): ActionPackage {
  serial += 1;
  const actionEnvelope = {
    version: "1" as const,
    type: "ActionEnvelope" as const,
    proposer: { did: proposerDid },
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
function fakeCoordination(
  onPoll: () => Promise<CoordinationPollResponse>,
  onCreate: () => Promise<void> = async () => {},
) {
  const polls: number[] = [];
  const creates: number[] = [];
  const service: WorkflowCoordinationService = {
    async createApprovalWorkflow({ actionPackage }) {
      creates.push(Date.now());
      await onCreate();
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
  return { service, polls, creates };
}

function emptyPoll(updates: CoordinationActionUpdate[] = []): CoordinationPollResponse {
  return { version: "1", type: "CoordinationPollResponse", approvalRequests: [], actionUpdates: updates };
}

function makeBridge(options: {
  endpoint: WorkflowActionEndpoint;
  coordination: WorkflowCoordinationService;
  store?: MemoryWorkflowStore;
  expiresInMs?: number;
  workerId?: string;
  claimLeaseMs?: number;
  submissionTimeoutMs?: number;
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
    ...(options.workerId !== undefined ? { workerId: options.workerId } : {}),
    ...(options.claimLeaseMs !== undefined ? { claimLeaseMs: options.claimLeaseMs } : {}),
    ...(options.submissionTimeoutMs !== undefined ? { submissionTimeoutMs: options.submissionTimeoutMs } : {}),
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

  it.each([
    ["400 without a retryable flag", 400, undefined, false],
    ["409 marked retryable", 409, true, true],
    ["503", 503, undefined, true],
    ["429", 429, undefined, true],
    ["503 marked not retryable", 503, false, false],
  ])("classifies an Action endpoint %s", async (_name, status, declared, expected) => {
    const server = await startServer((res) => {
      res.writeHead(status, { "Content-Type": "application/mpas+json" });
      res.end(JSON.stringify({
        version: "1",
        type: "MpasHttpError",
        error: { code: "fixture", message: "fixture", ...(declared !== undefined ? { retryable: declared } : {}) },
      }));
    });
    try {
      const client = new ActionEndpointClient({ url: server.url });
      const pkg = buildPackage({}, "2030-01-01T00:00:00.000Z");
      const error = await client.submitActionRequest({ version: "1", type: "ActionRequest", actionPackage: pkg })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ActionEndpointClientError);
      expect((error as ActionEndpointClientError).retryable).toBe(expected);
    } finally {
      await server.close();
    }
  });

  it("classifies a malformed success response as not retryable and a network failure as retryable", async () => {
    const server = await startServer((res) => {
      res.writeHead(200, { "Content-Type": "application/mpas+json" });
      res.end(JSON.stringify({ not: "an ActionResponse" }));
    });
    const pkg = buildPackage({}, "2030-01-01T00:00:00.000Z");
    const request = { version: "1" as const, type: "ActionRequest" as const, actionPackage: pkg };
    try {
      const malformed = await new ActionEndpointClient({ url: server.url }).submitActionRequest(request)
        .catch((caught: unknown) => caught);
      expect((malformed as ActionEndpointClientError).retryable).toBe(false);
    } finally {
      await server.close();
    }
    const unreachable = await new ActionEndpointClient({ url: server.url, timeoutMs: 500 }).submitActionRequest(request)
      .catch((caught: unknown) => caught);
    expect((unreachable as ActionEndpointClientError).retryable).toBe(true);
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

  it("makes no Coordination calls without Task observation, and reports expiry on read", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint, requests } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const store = new MemoryWorkflowStore();
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store, expiresInMs: 30 * 60_000 });

    const taskId = await proposeAwaitingApprovals(bridge);
    await bridge.start();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(coordination.polls).toHaveLength(0);
    expect(requests).toHaveLength(1);
    // Nothing ran in the background; expiry is enforced when the Task is read.
    expect(store.getWorkflow(taskId)).toMatchObject({ state: "awaitingApprovals" });

    expect(bridge.handleTasksGet(taskId)).toMatchObject({ status: "completed", result: { isError: true } });
    expect(store.getWorkflow(taskId)).toMatchObject({
      state: "unresolvable",
      resolution: { kind: "unresolvable", errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION" },
    });
    expect(coordination.polls).toHaveLength(0);
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

  it("resumes an interrupted completed submission on observation, not at startup", async () => {
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
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(second.requests).toHaveLength(0);

    restarted.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(10);
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

  it("re-checks a Verifier pending only on observation, backing off up to 60 seconds with the same key", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint, requests } = scriptedEndpoint([], response("pending"));
    const bridge = makeBridge({ endpoint, coordination: coordination.service, expiresInMs: 60 * 60_000 });
    const result = await bridge.handleToolCall("merge_pull_request", {});
    if (result.resultType !== "task") throw new Error("Expected a deferred Task.");

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(requests).toHaveLength(1);

    for (let second = 0; second < 10 * 60; second += 1) {
      bridge.handleTasksGet(result.taskId);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const gaps = requests.slice(1).map((entry, index) => entry.at - requests[index]!.at);
    // Observing every second without backoff would have sent about 600 requests.
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.length).toBeLessThan(25);
    expect(Math.max(...gaps.slice(1))).toBeLessThanOrEqual(61_000);
    expect(gaps[gaps.length - 1]).toBeGreaterThan(50_000);
    expect(new Set(requests.map((entry) => entry.request.idempotencyKey)).size).toBe(1);
    expect(coordination.polls).toHaveLength(0);
    await bridge.shutdown();
  });

  it("retries a failed initial submission only on observation, with backoff", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint, requests } = scriptedEndpoint([], undefined);
    const failing: WorkflowActionEndpoint = {
      submitActionRequest: (request) => {
        void endpoint.submitActionRequest(request).catch(() => {});
        return Promise.reject(new Error("unreachable"));
      },
    };
    const bridge = makeBridge({ endpoint: failing, coordination: coordination.service, expiresInMs: 60 * 60_000 });
    const result = await bridge.handleToolCall("merge_pull_request", {});
    if (result.resultType !== "task") throw new Error("Expected a deferred Task.");

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(requests).toHaveLength(1);

    for (let second = 0; second < 10 * 60; second += 1) {
      bridge.handleTasksGet(result.taskId);
      await vi.advanceTimersByTimeAsync(1_000);
    }
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
    // Grace, then the settle period after aborting.
    await vi.advanceTimersByTimeAsync(1_100 + SHUTDOWN_SETTLE_MS);
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

function readyUpdate(actionPackage: ActionPackage): CoordinationActionUpdate {
  return {
    version: "1",
    type: "CoordinationActionUpdate",
    actionRef: {
      version: "1",
      type: "ActionRef",
      actionId: actionPackage.actionEnvelope.actionId,
      actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
    },
    state: "readyForSubmission",
    expiresAt: actionPackage.actionEnvelope.expiresAt,
    actionPackage,
  };
}

describe("batch A regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not retry without observation, and retries on the first observation after the backoff", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint, requests } = scriptedEndpoint([], response("pending"));
    const bridge = makeBridge({ endpoint, coordination: coordination.service });
    await bridge.start();
    const result = await bridge.handleToolCall("merge_pull_request", {});
    if (result.resultType !== "task") throw new Error("Expected a deferred Task.");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(requests).toHaveLength(1);
    bridge.handleTasksGet(result.taskId);
    await vi.advanceTimersByTimeAsync(10);
    expect(requests).toHaveLength(2);
    await bridge.shutdown();
  });

  it("keeps a Coordination failure's Retry-After when the same pass moved the workflow forward", async () => {
    let createFailures = 1;
    const coordination = fakeCoordination(async () => emptyPoll(), async () => {
      if (createFailures-- > 0) throw new CoordinationUnavailableError("busy", { retryAfterMs: 120_000 });
    });
    const { endpoint } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const store = new MemoryWorkflowStore();
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    const taskId = await proposeAwaitingApprovalsOrDeferred(bridge);
    expect(store.getWorkflow(taskId)).toMatchObject({ state: "submittingToCoordination" });

    for (let observed = 0; observed < 11; observed += 1) {
      bridge.handleTasksGet(taskId);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(coordination.creates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11_000);
    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(10);
    expect(coordination.creates).toHaveLength(2);
    expect(store.getWorkflow(taskId)).toMatchObject({ state: "awaitingApprovals" });
    await bridge.shutdown();
  });

  it("returns a zero-second compatibility wait immediately even while a poll hangs", async () => {
    const coordination = fakeCoordination(() => new Promise(() => {}));
    const { endpoint } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const store = new MemoryWorkflowStore();
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    const taskId = await proposeAwaitingApprovals(bridge);
    const actionId = store.getWorkflow(taskId)!.actionId;

    let settled = false;
    const wait = bridge.handleCompatibilityToolCall("mpas_wait_for_action_result", { actionId, timeoutSeconds: 0 });
    void wait.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(coordination.polls).toHaveLength(1);
    await expect(wait).resolves.toMatchObject({ structuredContent: { type: "MpasBridgeDeferredResult" } });
    const stopped = bridge.shutdown(0);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_SETTLE_MS + 1);
    await stopped;
  });

  it("bounds a short compatibility wait from call entry while a poll hangs", async () => {
    const coordination = fakeCoordination(() => new Promise(() => {}));
    const { endpoint } = scriptedEndpoint([APPROVALS_REQUIRED]);
    const store = new MemoryWorkflowStore();
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    const taskId = await proposeAwaitingApprovals(bridge);
    const actionId = store.getWorkflow(taskId)!.actionId;

    let settled = false;
    void bridge.handleCompatibilityToolCall("mpas_wait_for_action_result", { actionId, timeoutSeconds: 3 })
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
    const stopped = bridge.shutdown(0);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_SETTLE_MS + 1);
    await stopped;
  });

  it("lets a shared poll finish and advance state after an individual wait has returned", async () => {
    let release: (value: CoordinationPollResponse) => void = () => {};
    const coordination = fakeCoordination(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { endpoint, requests } = scriptedEndpoint([
      APPROVALS_REQUIRED,
      response("executed", { executionResult: { content: [], isError: false } }),
    ]);
    const store = new MemoryWorkflowStore();
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    await bridge.start();
    const taskId = await proposeAwaitingApprovals(bridge);
    const record = store.getWorkflow(taskId)!;

    await bridge.handleCompatibilityToolCall("mpas_wait_for_action_result", { actionId: record.actionId, timeoutSeconds: 0 });
    release(emptyPoll([readyUpdate(record.actionPackage as ActionPackage)]));
    await vi.advanceTimersByTimeAsync(10);
    expect(requests).toHaveLength(2);
    expect(store.getWorkflow(taskId)).toMatchObject({ state: "resolved" });
    await bridge.shutdown();
  });

  it("advances every awaiting Task of this proposer from one shared poll, and only this proposer's", async () => {
    const updates: CoordinationActionUpdate[] = [];
    const coordination = fakeCoordination(async () => emptyPoll(updates));
    const executed = response("executed", { executionResult: { content: [], isError: false } });
    const { endpoint, requests } = scriptedEndpoint([APPROVALS_REQUIRED, APPROVALS_REQUIRED, executed, executed]);
    const store = new MemoryWorkflowStore();
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    await bridge.start();
    const first = await proposeAwaitingApprovals(bridge);
    const second = await proposeAwaitingApprovals(bridge);

    const foreign = buildPackage({}, new Date(START + 30 * 60_000).toISOString(), OTHER_DID);
    const foreignTask = "urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff";
    store.createWorkflow({
      taskId: foreignTask,
      actionId: foreign.actionEnvelope.actionId.value,
      actionIdempotencyKey: "foreign-key",
      actionEnvelopeHash: foreign.approvalBundle.actionEnvelopeHash.value,
      toolName: "merge_pull_request",
      actionPackage: foreign,
      expiresAt: foreign.actionEnvelope.expiresAt,
    });
    store.compareAndSetState(foreignTask, "created", "awaitingApprovals");

    for (const taskId of [first, second]) {
      updates.push(readyUpdate(store.getWorkflow(taskId)!.actionPackage as ActionPackage));
    }
    updates.push(readyUpdate(foreign));

    bridge.handleTasksGet(first);
    await vi.advanceTimersByTimeAsync(100);

    expect(coordination.polls).toHaveLength(1);
    expect(store.getWorkflow(first)).toMatchObject({ state: "resolved" });
    expect(store.getWorkflow(second)).toMatchObject({ state: "resolved" });
    expect(store.getWorkflow(foreignTask)).toMatchObject({ state: "awaitingApprovals" });
    expect(requests).toHaveLength(4);
    await bridge.shutdown();
  });

  it("tracks a background retry started by observation during shutdown", async () => {
    const store = new MemoryWorkflowStore();
    const pkg = buildPackage({}, new Date(START + 30 * 60_000).toISOString());
    const taskId = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    store.createWorkflow({
      taskId,
      actionId: pkg.actionEnvelope.actionId.value,
      actionIdempotencyKey: "recorded-before-crash",
      actionEnvelopeHash: pkg.approvalBundle.actionEnvelopeHash.value,
      toolName: "merge_pull_request",
      actionPackage: pkg,
      expiresAt: pkg.actionEnvelope.expiresAt,
    });
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint, requests } = scriptedEndpoint(["hang"]);
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    await bridge.start();
    expect(bridge.handleTasksGet(taskId)).toMatchObject({ status: "working" });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);

    let finished = false;
    void bridge.shutdown(1_000).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(600 + SHUTDOWN_SETTLE_MS);
    expect(finished).toBe(true);
  });

  it("submits a workflow recorded before a crash once, on observation, with its persisted key", async () => {
    const store = new MemoryWorkflowStore();
    const pkg = buildPackage({}, new Date(START + 30 * 60_000).toISOString());
    const taskId = "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    store.createWorkflow({
      taskId,
      actionId: pkg.actionEnvelope.actionId.value,
      actionIdempotencyKey: "recorded-before-crash",
      actionEnvelopeHash: pkg.approvalBundle.actionEnvelopeHash.value,
      toolName: "merge_pull_request",
      actionPackage: pkg,
      expiresAt: pkg.actionEnvelope.expiresAt,
    });
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint, requests } = scriptedEndpoint([
      response("executed", { executionResult: { content: [], isError: false } }),
    ]);
    const bridge = makeBridge({ endpoint, coordination: coordination.service, store });
    await bridge.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(0);

    bridge.handleTasksGet(taskId);
    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(10);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.idempotencyKey).toBe("recorded-before-crash");
    expect(store.getWorkflow(taskId)).toMatchObject({ state: "resolved" });
    expect(coordination.polls).toHaveLength(0);
    await bridge.shutdown();
  });

  it("joins an in-flight attempt and honors its Retry-After instead of retrying right behind it", async () => {
    let release: (error: Error) => void = () => {};
    const { endpoint, requests } = scriptedEndpoint([]);
    const failing: WorkflowActionEndpoint = {
      submitActionRequest: (request) => {
        void endpoint.submitActionRequest(request).catch(() => {});
        return new Promise((_resolve, reject) => {
          release = reject;
        });
      },
    };
    const store = new MemoryWorkflowStore();
    const pkg = buildPackage({}, new Date(START + 30 * 60_000).toISOString());
    const taskId = "urn:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    store.createWorkflow({
      taskId,
      actionId: pkg.actionEnvelope.actionId.value,
      actionIdempotencyKey: "interrupted",
      actionEnvelopeHash: pkg.approvalBundle.actionEnvelopeHash.value,
      toolName: "merge_pull_request",
      actionPackage: pkg,
      expiresAt: pkg.actionEnvelope.expiresAt,
    });
    const coordination = fakeCoordination(async () => emptyPoll());
    const bridge = makeBridge({ endpoint: failing, coordination: coordination.service, store });
    await bridge.start();

    // Two observations while the first attempt is in flight start nothing new.
    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(0);
    bridge.handleTasksGet(taskId);
    bridge.handleTasksGet(taskId);
    expect(requests).toHaveLength(1);

    release(Object.assign(new Error("busy"), { retryAfterMs: 120_000 }));
    await vi.advanceTimersByTimeAsync(0);
    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(119_000);
    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_100);
    bridge.handleTasksGet(taskId);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
    const stopped = bridge.shutdown(0);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_SETTLE_MS + 1);
    await stopped;
  });

  it("retries only the observed Task, never another Task's failure", async () => {
    const coordination = fakeCoordination(async () => emptyPoll());
    const { endpoint, requests } = scriptedEndpoint([], response("pending"));
    const bridge = makeBridge({ endpoint, coordination: coordination.service, expiresInMs: 60 * 60_000 });
    const first = await bridge.handleToolCall("merge_pull_request", { pullNumber: 1 });
    const second = await bridge.handleToolCall("merge_pull_request", { pullNumber: 2 });
    if (first.resultType !== "task" || second.resultType !== "task") throw new Error("Expected deferred Tasks.");
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    bridge.handleTasksGet(first.taskId);
    await vi.advanceTimersByTimeAsync(10);
    const keys = requests.map((entry) => entry.request.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[0]);
    await bridge.shutdown();
  });

});

describe("bindStdioShutdown stdout errors", () => {
  it("absorbs repeated stdout errors such as EPIPE after shutdown starts", async () => {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const signals = new EventEmitter();
    const exits: number[] = [];
    bindStdioShutdown({
      shutdown: async () => {},
      host: {
        stdin: stdin as unknown as StdioShutdownHost["stdin"],
        stdout: stdout as unknown as StdioShutdownHost["stdout"],
        once: (signal, listener) => signals.once(signal, listener),
        off: (signal, listener) => signals.off(signal, listener),
        exit: (code) => {
          exits.push(code);
        },
      },
    });
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => {
      stdout.emit("error", epipe);
      stdout.emit("error", epipe);
    }).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exits).toEqual([0]);
  });
});

/** Propose and return the Task ID whether or not Coordination accepted the workflow yet. */
async function proposeAwaitingApprovalsOrDeferred(bridge: ProposerBridge): Promise<string> {
  const result = await bridge.handleToolCall("merge_pull_request", { pullNumber: 7 });
  if (result.resultType !== "task") throw new Error("Expected a deferred Task.");
  return result.taskId;
}

describe("engine retry eligibility inside the Task lane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run a retry queued behind the initial submission when that submission fails with Retry-After", async () => {
    let fail: (error: Error) => void = () => {};
    const { endpoint, requests } = scriptedEndpoint([]);
    const actionEndpoint: WorkflowActionEndpoint = {
      submitActionRequest: (request) => {
        void endpoint.submitActionRequest(request).catch(() => {});
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      },
    };
    const coordination = fakeCoordination(async () => emptyPoll());
    const engine = new BridgeWorkflowEngine({
      store: new MemoryWorkflowStore(),
      actionEndpoint,
      coordinationService: coordination.service,
      buildCoordinationReplacement: async () => {
        throw new Error("unused");
      },
      proposerDid: PROPOSER_DID,
      random: () => 0.999,
    });
    const pkg = buildPackage({}, new Date(START + 30 * 60_000).toISOString());
    const taskId = "urn:uuid:dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const proposal = engine.propose({
      taskId,
      actionId: pkg.actionEnvelope.actionId.value,
      actionIdempotencyKey: "first-attempt",
      actionEnvelopeHash: pkg.approvalBundle.actionEnvelopeHash.value,
      toolName: "merge_pull_request",
      actionPackage: pkg,
      expiresAt: pkg.actionEnvelope.expiresAt,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);

    // An observation arrives while the initial submission holds the lane.
    const observed = engine.advanceTask(taskId);
    fail(Object.assign(new Error("busy"), { retryAfterMs: 120_000 }));
    await proposal;
    await observed;
    expect(requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(121_000);
    void engine.advanceTask(taskId);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Submission and recovery policy (feature reduce-polling §5.2, §6.2, §6.3)
// ---------------------------------------------------------------------------

type Behavior = ActionResponse | Error | "hang";

/** Arguments marking the interrupted Task (A) and the other observed Task (B). */
const TASK_A = { pullNumber: 1 };
const TASK_B = { pullNumber: 2 };

function pullNumberOf(pkg: ActionPackage): number {
  return (pkg.executionPayload as unknown as { arguments: { pullNumber: number } }).arguments.pullNumber;
}

/** One simulated bridge process: its own clients, aborted by its own lifetime signal. */
function processServices(options: {
  verifier: (pullNumber: number) => Behavior;
  create?: (pullNumber: number) => "ok" | "hang" | Error;
  poll?: () => CoordinationActionUpdate[];
}) {
  const lifetime = new AbortController();
  const verifierRequests: { pullNumber: number; key: string | undefined; body: string }[] = [];
  const creates: { pullNumber: number; actionId: string }[] = [];
  let polls = 0;
  const hang = <T>() => new Promise<T>((_resolve, reject) => {
    lifetime.signal.addEventListener("abort", () => reject(new Error("aborted at shutdown")), { once: true });
  });
  const endpoint: WorkflowActionEndpoint = {
    async submitActionRequest(request) {
      const pullNumber = pullNumberOf(request.actionPackage);
      verifierRequests.push({ pullNumber, key: request.idempotencyKey, body: JSON.stringify(request) });
      const behavior = options.verifier(pullNumber);
      if (behavior === "hang") return hang<ActionResponse>();
      if (behavior instanceof Error) throw behavior;
      return behavior;
    },
  };
  const coordination: WorkflowCoordinationService = {
    async createApprovalWorkflow({ actionPackage }) {
      const pullNumber = pullNumberOf(actionPackage);
      creates.push({ pullNumber, actionId: actionPackage.actionEnvelope.actionId.value });
      const behavior = options.create?.(pullNumber) ?? "ok";
      if (behavior === "hang") await hang<void>();
      if (behavior instanceof Error) throw behavior;
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
    async pollWork() {
      polls += 1;
      return emptyPoll(options.poll?.() ?? []);
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
  return { lifetime, endpoint, coordination, verifierRequests, creates, polls: () => polls };
}

const LEASE = { claimLeaseMs: 2_000, submissionTimeoutMs: 1_000 };

function processBridge(store: MemoryWorkflowStore, services: ReturnType<typeof processServices>, workerId: string) {
  return makeBridge({
    endpoint: services.endpoint,
    coordination: services.coordination,
    store,
    workerId,
    expiresInMs: 30 * 60_000,
    ...LEASE,
  });
}

/** Shut a process down with a 1-second grace, aborting its clients when the grace expires. */
async function shutDownProcess(bridge: ProposerBridge, services: ReturnType<typeof processServices>) {
  const done = bridge.shutdown(1_000, { abortInFlight: () => services.lifetime.abort() });
  await vi.advanceTimersByTimeAsync(1_000 + SHUTDOWN_SETTLE_MS + 1);
  await done;
}

function taskIdFor(store: MemoryWorkflowStore, pullNumber: number): string {
  const match = store.listRecoverableWorkflows()
    .find((record) => pullNumberOf(record.actionPackage as ActionPackage) === pullNumber);
  if (!match) throw new Error(`No unfinished workflow for pull ${pullNumber}.`);
  return match.taskId;
}

function attemptsOf(store: MemoryWorkflowStore, taskId: string): { stage: string; outcome: string; notBefore?: string }[] {
  return store.getWorkflow(taskId)!.adapterAttempts as { stage: string; outcome: string; notBefore?: string }[];
}

const EXECUTED = response("executed", { executionResult: { content: [{ type: "text", text: "done" }], isError: false } });

describe("submission and recovery policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Restart as a new worker, observe B (which may poll), and confirm A is untouched. */
  async function restartAndObserveOther(
    store: MemoryWorkflowStore,
    services: ReturnType<typeof processServices>,
    taskB: string,
  ) {
    await vi.advanceTimersByTimeAsync(LEASE.claimLeaseMs + 100);
    const bridge = processBridge(store, services, "process-2");
    await bridge.start();
    bridge.handleTasksGet(taskB);
    await vi.advanceTimersByTimeAsync(100);
    return bridge;
  }

  it("work never sent: resumes the initial submission only when its own Task is observed", async () => {
    class HookStore extends MemoryWorkflowStore {
      onCreate?: () => void;
      override createWorkflow(input: Parameters<MemoryWorkflowStore["createWorkflow"]>[0]) {
        const record = super.createWorkflow(input);
        this.onCreate?.();
        return record;
      }
    }
    const store = new HookStore();
    const first = processServices({ verifier: (pull) => (pull === 2 ? APPROVALS_REQUIRED : "hang") });
    const bridge1 = processBridge(store, first, "process-1");
    await bridge1.handleToolCall("merge_pull_request", TASK_B);
    // Shutdown begins after A is durably recorded but before it is sent.
    let shutdown: Promise<void> = Promise.resolve();
    store.onCreate = () => {
      store.onCreate = undefined;
      shutdown = bridge1.shutdown(1_000, { abortInFlight: () => first.lifetime.abort() });
    };
    await bridge1.handleToolCall("merge_pull_request", TASK_A);
    await vi.advanceTimersByTimeAsync(10);
    await shutdown;
    const taskA = taskIdFor(store, 1);
    const taskB = taskIdFor(store, 2);
    expect(first.verifierRequests.filter((entry) => entry.pullNumber === 1)).toHaveLength(0);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "created", adapterAttempts: [] });

    const second = processServices({ verifier: () => EXECUTED });
    const bridge2 = await restartAndObserveOther(store, second, taskB);
    expect(second.polls()).toBe(1);
    expect(second.verifierRequests).toHaveLength(0);

    bridge2.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.verifierRequests).toEqual([
      expect.objectContaining({ pullNumber: 1, key: store.getWorkflow(taskA)!.actionIdempotencyKey }),
    ]);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "resolved" });
    await bridge2.shutdown();
  });

  it("initial submission sent, outcome unknown: records an interruption and resends the identical request on its own observation", async () => {
    const store = new MemoryWorkflowStore();
    const first = processServices({ verifier: (pull) => (pull === 2 ? APPROVALS_REQUIRED : "hang") });
    const bridge1 = processBridge(store, first, "process-1");
    await bridge1.handleToolCall("merge_pull_request", TASK_B);
    void bridge1.handleToolCall("merge_pull_request", TASK_A).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await shutDownProcess(bridge1, first);

    const taskA = taskIdFor(store, 1);
    const taskB = taskIdFor(store, 2);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "created" });
    expect(attemptsOf(store, taskA).map((entry) => entry.outcome)).toEqual(["idempotencyBound", "interrupted"]);
    expect(attemptsOf(store, taskA)[1]!.notBefore).toBeUndefined();
    const sentByFirst = first.verifierRequests.find((entry) => entry.pullNumber === 1)!;

    const second = processServices({ verifier: () => EXECUTED });
    const bridge2 = await restartAndObserveOther(store, second, taskB);
    expect(second.verifierRequests).toHaveLength(0);

    bridge2.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.verifierRequests).toHaveLength(1);
    expect(second.verifierRequests[0]!.key).toBe(sentByFirst.key);
    expect(second.verifierRequests[0]!.body).toBe(sentByFirst.body);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "resolved" });
    await bridge2.shutdown();
  });

  it("initial submission sent, outcome unknown: an expired Action is never resent", async () => {
    const store = new MemoryWorkflowStore();
    const first = processServices({ verifier: (pull) => (pull === 2 ? APPROVALS_REQUIRED : "hang") });
    const bridge1 = processBridge(store, first, "process-1");
    await bridge1.handleToolCall("merge_pull_request", TASK_B);
    void bridge1.handleToolCall("merge_pull_request", TASK_A).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await shutDownProcess(bridge1, first);
    const taskA = taskIdFor(store, 1);

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const second = processServices({ verifier: () => EXECUTED });
    const bridge2 = processBridge(store, second, "process-2");
    await bridge2.start();
    expect(bridge2.handleTasksGet(taskA)).toMatchObject({ status: "completed", result: { isError: true } });
    await vi.advanceTimersByTimeAsync(10);
    expect(second.verifierRequests).toHaveLength(0);
    expect(store.getWorkflow(taskA)).toMatchObject({
      state: "unresolvable",
      resolution: { errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION" },
    });
    await bridge2.shutdown();
  });

  it("Verifier response persisted, Coordination creation interrupted: resumes creation, never the Verifier submission", async () => {
    const store = new MemoryWorkflowStore();
    const first = processServices({
      verifier: () => APPROVALS_REQUIRED,
      create: (pull) => (pull === 1 ? "hang" : "ok"),
    });
    const bridge1 = processBridge(store, first, "process-1");
    await bridge1.handleToolCall("merge_pull_request", TASK_B);
    void bridge1.handleToolCall("merge_pull_request", TASK_A).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await shutDownProcess(bridge1, first);

    const taskA = taskIdFor(store, 1);
    const taskB = taskIdFor(store, 2);
    const a2 = store.getWorkflow(taskA)!.actionId;
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "submittingToCoordination" });
    expect(attemptsOf(store, taskA).map((entry) => `${entry.stage}:${entry.outcome}`)).toEqual([
      "initial:idempotencyBound",
      "initial:responded",
      "coordination:interrupted",
    ]);

    const second = processServices({ verifier: () => EXECUTED });
    const bridge2 = await restartAndObserveOther(store, second, taskB);
    expect(second.creates).toHaveLength(0);

    bridge2.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.creates).toEqual([{ pullNumber: 1, actionId: a2 }]);
    expect(second.verifierRequests).toHaveLength(0);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "awaitingApprovals" });
    await bridge2.shutdown();
  });

  it("completed submission sent, outcome unknown: a repeated ready update while observing B does not resend; observing A does", async () => {
    const store = new MemoryWorkflowStore();
    let updates: CoordinationActionUpdate[] = [];
    const first = processServices({
      verifier: (pull) => (pull === 1 && first.verifierRequests.filter((entry) => entry.pullNumber === 1).length > 1
        ? "hang"
        : APPROVALS_REQUIRED),
      poll: () => updates,
    });
    const bridge1 = processBridge(store, first, "process-1");
    await bridge1.handleToolCall("merge_pull_request", TASK_B);
    await bridge1.handleToolCall("merge_pull_request", TASK_A);
    const taskA = taskIdFor(store, 1);
    const taskB = taskIdFor(store, 2);
    updates = [readyUpdate(store.getWorkflow(taskA)!.actionPackage as ActionPackage)];

    // Observing A collects its approval; the completed submission is sent and hangs.
    bridge1.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.verifierRequests.filter((entry) => entry.pullNumber === 1)).toHaveLength(2);
    await shutDownProcess(bridge1, first);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "readyForSubmission" });
    expect(attemptsOf(store, taskA).at(-1)).toMatchObject({ stage: "completed", outcome: "interrupted" });
    const sentByFirst = first.verifierRequests.filter((entry) => entry.pullNumber === 1)[1]!;

    // Coordination still reports A ready on every poll.
    const second = processServices({ verifier: () => EXECUTED, poll: () => updates });
    const bridge2 = await restartAndObserveOther(store, second, taskB);
    expect(second.polls()).toBe(1);
    expect(second.verifierRequests).toHaveLength(0);

    bridge2.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.verifierRequests).toHaveLength(1);
    expect(second.verifierRequests[0]!.key).toBe(sentByFirst.key);
    expect(second.verifierRequests[0]!.body).toBe(sentByFirst.body);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "resolved" });
    await bridge2.shutdown();
  });

  it("definitive outcome persisted: never resubmits after restart", async () => {
    const store = new MemoryWorkflowStore();
    const first = processServices({ verifier: () => EXECUTED });
    const bridge1 = processBridge(store, first, "process-1");
    const result = await bridge1.handleToolCall("merge_pull_request", TASK_A);
    expect(result).toMatchObject({ resultType: "complete" });
    await shutDownProcess(bridge1, first);

    const second = processServices({ verifier: () => EXECUTED });
    await vi.advanceTimersByTimeAsync(LEASE.claimLeaseMs + 100);
    const bridge2 = processBridge(store, second, "process-2");
    await bridge2.start();
    expect(store.listRecoverableWorkflows()).toHaveLength(0);
    expect(second.verifierRequests).toHaveLength(0);
    await bridge2.shutdown();
  });

  it("legacy pending persisted: re-checks after the durable backoff, across a restart, with the same key", async () => {
    const store = new MemoryWorkflowStore();
    const first = processServices({ verifier: () => response("pending") });
    const bridge1 = processBridge(store, first, "process-1");
    const result = await bridge1.handleToolCall("merge_pull_request", TASK_A);
    if (result.resultType !== "task") throw new Error("Expected a deferred Task.");
    await shutDownProcess(bridge1, first);
    expect(attemptsOf(store, result.taskId).at(-1)).toMatchObject({ outcome: "pending" });
    const notBefore = Date.parse(attemptsOf(store, result.taskId).at(-1)!.notBefore!);

    const second = processServices({ verifier: () => EXECUTED });
    const bridge2 = processBridge(store, second, "process-2");
    await vi.advanceTimersByTimeAsync(Math.max(0, notBefore - Date.now() - 200));
    bridge2.handleTasksGet(result.taskId);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.verifierRequests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(LEASE.claimLeaseMs);
    bridge2.handleTasksGet(result.taskId);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.verifierRequests).toHaveLength(1);
    expect(second.verifierRequests[0]!.key).toBe(first.verifierRequests[0]!.key);
    await bridge2.shutdown();
  });

  it("a late Coordination response during shutdown updates durable state but starts no submission", async () => {
    const store = new MemoryWorkflowStore();
    const first = processServices({ verifier: () => APPROVALS_REQUIRED });
    let release: (updates: CoordinationActionUpdate[]) => void = () => {};
    first.coordination.pollWork = () => new Promise((resolve) => {
      release = (updates) => resolve(emptyPoll(updates));
    });
    const bridge1 = processBridge(store, first, "process-1");
    await bridge1.handleToolCall("merge_pull_request", TASK_A);
    const taskA = taskIdFor(store, 1);
    bridge1.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(0);

    let closed = false;
    const shutdown = bridge1.shutdown(1_000, { abortInFlight: () => first.lifetime.abort() }).then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    release([readyUpdate(store.getWorkflow(taskA)!.actionPackage as ActionPackage)]);
    await vi.advanceTimersByTimeAsync(10);
    await shutdown;
    expect(closed).toBe(true);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "readyForSubmission" });
    expect(first.verifierRequests).toHaveLength(1);

    const second = processServices({ verifier: () => EXECUTED });
    await vi.advanceTimersByTimeAsync(LEASE.claimLeaseMs);
    const bridge2 = processBridge(store, second, "process-2");
    bridge2.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.verifierRequests).toHaveLength(1);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "resolved" });
    await bridge2.shutdown();
  });

  it.each([
    ["HTTP 400", new ActionEndpointClientError("Action endpoint returned HTTP 400.", { status: 400, retryable: false })],
    ["an authentication failure", new MpasAuthError(401, "signature_invalid", "unauthenticated")],
    ["an invalid response", new ActionEndpointClientError("Action endpoint did not return a valid ActionResponse.", { retryable: false })],
  ])("stops on %s: the failure is surfaced and never retried", async (_name, error) => {
    const store = new MemoryWorkflowStore();
    const services = processServices({ verifier: () => error });
    const bridge = processBridge(store, services, "process-1");
    const result = await bridge.handleToolCall("merge_pull_request", TASK_A);
    if (result.resultType !== "task") throw new Error("Expected a Task.");
    expect(bridge.handleTasksGet(result.taskId)).toMatchObject({
      status: "completed",
      result: { isError: true, structuredContent: { code: "ACTION_SUBMISSION_REJECTED" } },
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    bridge.handleTasksGet(result.taskId);
    await vi.advanceTimersByTimeAsync(10);
    expect(services.verifierRequests).toHaveLength(1);
    await bridge.shutdown();
  });

  it.each([
    ["a 503 with Retry-After", new ActionEndpointClientError("Action endpoint returned HTTP 503.", { status: 503, retryable: true, retryAfterMs: 120_000 }), 120_000],
    ["an unclassified error (unknown outcome)", new Error("socket hang up"), 5_000],
  ])("retries %s on its own observation after the durable backoff, with the same key", async (_name, error, delay) => {
    const store = new MemoryWorkflowStore();
    let calls = 0;
    const first = processServices({ verifier: () => (calls++ === 0 ? error : EXECUTED) });
    const bridge1 = processBridge(store, first, "process-1");
    const result = await bridge1.handleToolCall("merge_pull_request", TASK_A);
    if (result.resultType !== "task") throw new Error("Expected a Task.");
    expect(attemptsOf(store, result.taskId).at(-1)).toMatchObject({ outcome: "unreachable" });
    await shutDownProcess(bridge1, first);

    // A restarted process honors the backoff recorded by the first one.
    const bridge2 = processBridge(store, first, "process-2");
    await vi.advanceTimersByTimeAsync(LEASE.claimLeaseMs);
    if (delay > LEASE.claimLeaseMs + 2_000) {
      bridge2.handleTasksGet(result.taskId);
      await vi.advanceTimersByTimeAsync(10);
      expect(first.verifierRequests).toHaveLength(1);
    }
    await vi.advanceTimersByTimeAsync(delay);
    bridge2.handleTasksGet(result.taskId);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.verifierRequests).toHaveLength(2);
    expect(first.verifierRequests[1]!.key).toBe(first.verifierRequests[0]!.key);
    expect(first.verifierRequests[1]!.body).toBe(first.verifierRequests[0]!.body);
    expect(store.getWorkflow(result.taskId)).toMatchObject({ state: "resolved" });
    await bridge2.shutdown();
  });

  it.each([
    ["an executed application error", response("executed", { executionResult: { content: [{ type: "text", text: "boom" }], isError: true } })],
    ["a definitive rejection", response("rejected", { error: { code: "POLICY_DENIED", message: "denied" } })],
  ])("treats %s as terminal and never resubmits it", async (_name, outcome) => {
    const store = new MemoryWorkflowStore();
    const services = processServices({ verifier: () => outcome });
    const bridge = processBridge(store, services, "process-1");
    const result = await bridge.handleToolCall("merge_pull_request", TASK_A);
    expect(result).toMatchObject({ resultType: "complete" });
    expect(store.listRecoverableWorkflows()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(services.verifierRequests).toHaveLength(1);
    await bridge.shutdown();
  });

  it("a failed completed submission is retried by its own observation, not by another Task's poll", async () => {
    const store = new MemoryWorkflowStore();
    let updates: CoordinationActionUpdate[] = [];
    let completedCalls = 0;
    const services = processServices({
      verifier: (pull) => {
        if (pull === 1 && services.verifierRequests.filter((entry) => entry.pullNumber === 1).length > 1) {
          return completedCalls++ === 0
            ? new ActionEndpointClientError("Action endpoint returned HTTP 503.", { status: 503, retryable: true })
            : EXECUTED;
        }
        return APPROVALS_REQUIRED;
      },
      poll: () => updates,
    });
    const bridge = processBridge(store, services, "process-1");
    await bridge.handleToolCall("merge_pull_request", TASK_B);
    await bridge.handleToolCall("merge_pull_request", TASK_A);
    const taskA = taskIdFor(store, 1);
    const taskB = taskIdFor(store, 2);
    updates = [readyUpdate(store.getWorkflow(taskA)!.actionPackage as ActionPackage)];

    // Observing B newly collects A's approval: A's first completed submission (fails).
    bridge.handleTasksGet(taskB);
    await vi.advanceTimersByTimeAsync(10);
    const completedRequests = () => services.verifierRequests.filter((entry) => entry.pullNumber === 1).slice(1);
    expect(completedRequests()).toHaveLength(1);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "readyForSubmission" });

    // Later polls from observing B repeat A's ready update; A is not resubmitted.
    for (let index = 0; index < 6; index += 1) {
      await vi.advanceTimersByTimeAsync(11_000);
      bridge.handleTasksGet(taskB);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(services.polls()).toBeGreaterThan(5);
    expect(completedRequests()).toHaveLength(1);

    bridge.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(10);
    expect(completedRequests()).toHaveLength(2);
    expect(completedRequests()[1]!.key).toBe(completedRequests()[0]!.key);
    expect(store.getWorkflow(taskA)).toMatchObject({ state: "resolved" });
    await bridge.shutdown();
  });
});

describe("one HTTP failure classification across every client", () => {
  const CASES: [string, number, boolean | undefined, boolean][] = [
    ["400 without a flag", 400, undefined, false],
    ["409 marked retryable", 409, true, true],
    ["429", 429, undefined, true],
    ["503", 503, undefined, true],
    ["503 marked not retryable", 503, false, false],
  ];

  function failingServer(status: number, declared: boolean | undefined) {
    return startServer((res) => {
      res.writeHead(status, { "Content-Type": "application/mpas+json" });
      res.end(JSON.stringify({
        version: "1",
        type: "MpasHttpError",
        error: { code: "fixture", message: "fixture", ...(declared !== undefined ? { retryable: declared } : {}) },
      }));
    });
  }

  const pkg = buildPackage({}, "2030-01-01T00:00:00.000Z");
  const request = { version: "1" as const, type: "ActionRequest" as const, actionPackage: pkg };

  /** Each client's failure, reduced to "may an identical retry succeed?". */
  const CLIENTS: Record<string, (url: string) => Promise<boolean>> = {
    "direct Action endpoint": async (url) => {
      const error = await new ActionEndpointClient({ url }).submitActionRequest(request).catch((caught: unknown) => caught);
      return (error as ActionEndpointClientError).retryable === true;
    },
    "Action relay": async (url) => {
      const envelope = buildDeliveryEnvelope({ sender: PROPOSER_DID, recipients: ["did:jwk:verifier" as Did], payload: request });
      const error = await new ActionRelayClient({ url, participantDid: PROPOSER_DID }).submitAction(envelope)
        .catch((caught: unknown) => caught);
      if (error instanceof ActionRelayUnavailableError) return true;
      if (error instanceof ActionRelayResponseError) return false;
      throw error;
    },
    "Coordination Service": async (url) => {
      const error = await new CoordinationServiceClient({ url, participantDid: PROPOSER_DID }).pollWork()
        .catch((caught: unknown) => caught);
      if (error instanceof CoordinationUnavailableError) return true;
      if (error instanceof CoordinationResponseError) return false;
      throw error;
    },
    "legacy Credential Adapter submit": async (url) => {
      const error = await new CredentialAdapterClient({ url }).submit(pkg).catch((caught: unknown) => caught);
      return (error as AdapterRequestError).retryable;
    },
  };

  for (const [client, call] of Object.entries(CLIENTS)) {
    it.each(CASES)(`${client}: classifies %s`, async (_name, status, declared, expected) => {
      const server = await failingServer(status, declared);
      try {
        expect(await call(server.url)).toBe(expected);
      } finally {
        await server.close();
      }
    });
  }

  function relayEndpoint(url: string): WorkflowActionEndpoint {
    const client = new ActionRelayClient({ url, participantDid: PROPOSER_DID });
    return {
      submitActionRequest: (actionRequest) => client.submitAction(buildDeliveryEnvelope({
        sender: PROPOSER_DID,
        recipients: ["did:jwk:verifier" as Did],
        payload: actionRequest,
      })),
    };
  }

  it("stops, through the relay, on a 503 marked not retryable", async () => {
    let requests = 0;
    const server = await startServer((res) => {
      requests += 1;
      res.writeHead(503, { "Content-Type": "application/mpas+json" });
      res.end(JSON.stringify({ version: "1", type: "MpasHttpError", error: { code: "fixture", message: "no", retryable: false } }));
    });
    try {
      const store = new MemoryWorkflowStore();
      const bridge = makeBridge({ endpoint: relayEndpoint(server.url), coordination: fakeCoordination(async () => emptyPoll()).service, store });
      const result = await bridge.handleToolCall("merge_pull_request", {});
      if (result.resultType !== "task") throw new Error("Expected a Task.");
      expect(store.getWorkflow(result.taskId)).toMatchObject({
        state: "unresolvable",
        resolution: { errorCode: "ACTION_SUBMISSION_REJECTED" },
      });
      bridge.handleTasksGet(result.taskId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(requests).toBe(1);
      await bridge.shutdown();
    } finally {
      await server.close();
    }
  });

  it("records a retryable failure, through the relay, for a 503 without a flag", async () => {
    const server = await startServer((res) => {
      res.writeHead(503, { "Content-Type": "application/mpas+json" });
      res.end(JSON.stringify({ version: "1", type: "MpasHttpError", error: { code: "timeout", message: "wait" } }));
    });
    try {
      const store = new MemoryWorkflowStore();
      const bridge = makeBridge({ endpoint: relayEndpoint(server.url), coordination: fakeCoordination(async () => emptyPoll()).service, store });
      const result = await bridge.handleToolCall("merge_pull_request", {});
      if (result.resultType !== "task") throw new Error("Expected a Task.");
      expect(store.getWorkflow(result.taskId)).toMatchObject({ state: "created" });
      expect(attemptsOf(store, result.taskId).at(-1)).toMatchObject({ stage: "initial", outcome: "unreachable" });
      await bridge.shutdown();
    } finally {
      await server.close();
    }
  });

  it("stops Coordination creation on a 503 marked not retryable", async () => {
    const server = await startServer((res) => {
      res.writeHead(503, { "Content-Type": "application/mpas+json" });
      res.end(JSON.stringify({ version: "1", type: "MpasHttpError", error: { code: "fixture", message: "no", retryable: false } }));
    });
    try {
      const store = new MemoryWorkflowStore();
      const coordination = new CoordinationServiceClient({ url: server.url, participantDid: PROPOSER_DID });
      const { endpoint } = scriptedEndpoint([APPROVALS_REQUIRED]);
      const bridge = makeBridge({ endpoint, coordination, store });
      const result = await bridge.handleToolCall("merge_pull_request", {});
      if (result.resultType !== "task") throw new Error("Expected a Task.");
      expect(store.getWorkflow(result.taskId)).toMatchObject({
        state: "unresolvable",
        resolution: { errorCode: "COORDINATION_REQUEST_REJECTED" },
      });
      await bridge.shutdown();
    } finally {
      await server.close();
    }
  });
});

describe("responses during the shutdown grace period", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** An endpoint whose first call for each Task waits until the test settles it. */
  function heldEndpoint() {
    const held = new Map<number, { resolve(value: ActionResponse): void; reject(error: unknown): void }>();
    const requests: { pullNumber: number; key: string | undefined }[] = [];
    const later: Behavior[] = [];
    const endpoint: WorkflowActionEndpoint = {
      submitActionRequest(request) {
        const pullNumber = pullNumberOf(request.actionPackage);
        requests.push({ pullNumber, key: request.idempotencyKey });
        if (!held.has(pullNumber)) {
          return new Promise((resolve, reject) => held.set(pullNumber, { resolve, reject }));
        }
        const next = later.shift() ?? EXECUTED;
        if (next === "hang") return new Promise(() => {});
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    };
    return { endpoint, held, requests, later };
  }

  function bridgeFor(store: MemoryWorkflowStore, endpoint: WorkflowActionEndpoint, workerId: string) {
    return makeBridge({
      endpoint,
      coordination: fakeCoordination(async () => emptyPoll()).service,
      store,
      workerId,
      expiresInMs: 30 * 60_000,
      ...LEASE,
    });
  }

  it("keeps a 503's Retry-After when the response arrives during the grace period, across a restart", async () => {
    const store = new MemoryWorkflowStore();
    const first = heldEndpoint();
    const bridge1 = bridgeFor(store, first.endpoint, "process-1");
    void bridge1.handleToolCall("merge_pull_request", TASK_A).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const taskA = taskIdFor(store, 1);

    const shutdown = bridge1.shutdown(1_000, { abortInFlight: () => {} });
    await vi.advanceTimersByTimeAsync(200);
    first.held.get(1)!.reject(new ActionEndpointClientError("Action endpoint returned HTTP 503.", {
      status: 503,
      retryable: true,
      retryAfterMs: 120_000,
    }));
    await vi.advanceTimersByTimeAsync(10);
    await shutdown;

    const last = attemptsOf(store, taskA).at(-1)!;
    expect(last).toMatchObject({ stage: "initial", outcome: "unreachable", retryAfterMs: 120_000 });
    expect(Date.parse(last.notBefore!)).toBe(START + 200 + 120_000);

    // A restarted process honors the recorded delay.
    const second = heldEndpoint();
    second.held.set(1, { resolve: () => {}, reject: () => {} });
    const bridge2 = bridgeFor(store, second.endpoint, "process-2");
    await vi.advanceTimersByTimeAsync(60_000);
    bridge2.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(61_000);
    bridge2.handleTasksGet(taskA);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.requests).toEqual([{ pullNumber: 1, key: first.requests[0]!.key }]);
    await bridge2.shutdown();
  });

  it("records a network failure during the grace period as an ordinary retryable failure", async () => {
    const store = new MemoryWorkflowStore();
    const first = heldEndpoint();
    const bridge1 = bridgeFor(store, first.endpoint, "process-1");
    void bridge1.handleToolCall("merge_pull_request", TASK_A).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const taskA = taskIdFor(store, 1);

    const shutdown = bridge1.shutdown(1_000, { abortInFlight: () => {} });
    await vi.advanceTimersByTimeAsync(200);
    first.held.get(1)!.reject(new Error("connection reset"));
    await vi.advanceTimersByTimeAsync(10);
    await shutdown;

    expect(attemptsOf(store, taskA).at(-1)).toMatchObject({ stage: "initial", outcome: "unreachable" });
    expect(attemptsOf(store, taskA).at(-1)!.notBefore).toBeDefined();
  });

  it("records interrupted only for a call the abort cut short; a response at the abort keeps its classification", async () => {
    const store = new MemoryWorkflowStore();
    const first = heldEndpoint();
    const lifetime = new AbortController();
    // Task A's call has no response when the abort lands; Task B's response
    // (a 503 with Retry-After) is being read at that moment.
    lifetime.signal.addEventListener("abort", () => {
      first.held.get(1)!.reject(new Error("aborted"));
      first.held.get(2)!.reject(new ActionEndpointClientError("Action endpoint returned HTTP 503.", {
        status: 503,
        retryable: true,
        retryAfterMs: 60_000,
      }));
    });
    const bridge1 = bridgeFor(store, first.endpoint, "process-1");
    void bridge1.handleToolCall("merge_pull_request", TASK_A).catch(() => {});
    void bridge1.handleToolCall("merge_pull_request", TASK_B).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const taskA = taskIdFor(store, 1);
    const taskB = taskIdFor(store, 2);

    const shutdown = bridge1.shutdown(1_000, { abortInFlight: () => lifetime.abort() });
    await vi.advanceTimersByTimeAsync(1_000 + SHUTDOWN_SETTLE_MS + 1);
    await shutdown;

    expect(attemptsOf(store, taskA).at(-1)).toMatchObject({ outcome: "interrupted" });
    expect(attemptsOf(store, taskA).at(-1)!.notBefore).toBeUndefined();
    expect(attemptsOf(store, taskB).at(-1)).toMatchObject({ outcome: "unreachable", retryAfterMs: 60_000 });
  });
});
