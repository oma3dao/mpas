import { describe, expect, it, vi } from "vitest";
import type { ActionResponse, CoordinationActionUpdate } from "../../src/index.js";
import { MemoryWorkflowStore, type WorkflowStore } from "../../src/lib/workflow-store.js";
import {
  BridgeWorkflowEngine,
  type WorkflowAdapter,
  type WorkflowCoordination,
} from "../../src/lib/workflow-engine.js";

/**
 * Proposer-bridge workflow engine (feature spec §6 bridge track, §9.4, §11).
 *
 * The engine owns the bridge track: initial submission, coordination handoff,
 * completed-package resubmission, terminal storage, startup reconciliation,
 * and expiry. Result recovery is best effort: a crash window that loses the
 * terminal response resolves to `unresolvable`, never to a fabricated
 * Action outcome.
 */

const ACTION_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const HASH = "b64url-envelope-digest";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";
const PROPOSER_DID = "did:jwk:proposer";

function response(result: ActionResponse["result"], extra: Partial<ActionResponse> = {}): ActionResponse {
  return { version: "1", type: "ActionResponse", result, ...extra };
}

function actionRef(actionId = ACTION_ID) {
  return {
    version: "1" as const,
    type: "ActionRef" as const,
    actionId: { value: actionId },
    actionEnvelopeHash: { alg: "sha-256" as const, value: HASH },
  };
}

/** Scripted adapter: shift one scripted reply per submit; record every call. */
function fakeAdapter(...script: (ActionResponse | Error)[]): WorkflowAdapter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async submit(pkg: unknown): Promise<ActionResponse> {
      calls.push(pkg);
      const next = script.shift();
      if (!next) throw new Error("fakeAdapter script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function fakeCoordination(updates: () => CoordinationActionUpdate[] = () => []): WorkflowCoordination & {
  submitted: unknown[];
} {
  const submitted: unknown[] = [];
  return {
    submitted,
    async submitAction(pkg: unknown) {
      submitted.push(pkg);
      return { version: "1" as const, type: "CoordinationActionResponse" as const, actionRef: actionRef(), state: "awaitingApprovals" as const };
    },
    async poll() {
      return { version: "1" as const, type: "CoordinationPollResponse" as const, approvalRequests: [], actionUpdates: updates() };
    },
  };
}

function makeEngine(opts: {
  adapter: WorkflowAdapter;
  coordination?: WorkflowCoordination;
  store?: WorkflowStore;
  now?: () => number;
  workerId?: string;
}) {
  const store = opts.store ?? new MemoryWorkflowStore({ now: opts.now });
  const engine = new BridgeWorkflowEngine({
    store,
    adapter: opts.adapter,
    coordination: opts.coordination ?? fakeCoordination(),
    proposerDid: PROPOSER_DID,
    workerId: opts.workerId ?? "test-worker",
    now: opts.now,
  });
  return { engine, store };
}

function proposalInput() {
  return {
    actionId: ACTION_ID,
    actionEnvelopeHash: HASH,
    toolName: "merge_pull_request",
    actionPackage: { fake: "initial-package", actionId: ACTION_ID },
    expiresAt: EXPIRES_AT,
  };
}

describe("propose", () => {
  it("settles immediately when the adapter returns a terminal response", async () => {
    const adapter = fakeAdapter(response("executed", { executionResult: { content: [] } }));
    const { engine, store } = makeEngine({ adapter });

    const outcome = await engine.propose(proposalInput());

    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") {
      expect(outcome.actionResponse.result).toBe("executed");
    }
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("resolved");
  });

  it("defers on additionalApprovalsRequired and hands the action to coordination", async () => {
    const authReqs = { version: "1", type: "AuthorizationRequirements" };
    const adapter = fakeAdapter(response("additionalApprovalsRequired", { authorizationRequirements: authReqs as ActionResponse["authorizationRequirements"] }));
    const coordination = fakeCoordination();
    const { engine, store } = makeEngine({ adapter, coordination });

    const outcome = await engine.propose(proposalInput());

    expect(outcome.kind).toBe("deferred");
    expect(coordination.submitted).toHaveLength(1);
    const record = store.getWorkflow(ACTION_ID);
    expect(record?.state).toBe("awaitingApprovals");
    expect(record?.authorizationRequirements).toMatchObject({ type: "AuthorizationRequirements" });
    expect(record?.coordinationRef).toMatchObject({ type: "ActionRef" });
    if (outcome.kind === "deferred") {
      expect(outcome.record.state).toBe("awaitingApprovals");
    }
  });

  it("defers with the workflow durably created when the adapter is unreachable", async () => {
    const adapter = fakeAdapter(new Error("connect ECONNREFUSED"));
    const { engine, store } = makeEngine({ adapter });

    const outcome = await engine.propose(proposalInput());

    // Client profile §4.2: the deferred result may be returned as soon as the
    // Action is durably recorded, with no Verifier response yet.
    expect(outcome.kind).toBe("deferred");
    const record = store.getWorkflow(ACTION_ID);
    expect(record?.state).toBe("created");
    expect(record?.adapterAttempts.length).toBeGreaterThan(0);
  });

  it("throws when the workflow disappears after an unreachable adapter attempt", async () => {
    const adapter = fakeAdapter(new Error("connect ECONNREFUSED"));
    const store = new MemoryWorkflowStore();
    const originalGet = store.getWorkflow.bind(store);
    const originalSave = store.saveAdapterAttempt.bind(store);
    let hide = false;
    vi.spyOn(store, "getWorkflow").mockImplementation((actionId) => (hide ? undefined : originalGet(actionId)));
    vi.spyOn(store, "saveAdapterAttempt").mockImplementation((actionId, attempt) => {
      originalSave(actionId, attempt);
      hide = true;
    });

    const { engine } = makeEngine({ adapter, store });
    try {
      await expect(engine.propose(proposalInput())).rejects.toThrow(/Workflow not found/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("defers on a Verifier pending response", async () => {
    const adapter = fakeAdapter(response("pending"));
    const { engine, store } = makeEngine({ adapter });

    const outcome = await engine.propose(proposalInput());

    expect(outcome.kind).toBe("deferred");
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingVerifierResult");
  });
});

describe("pollOnce (bridge track advancement)", () => {
  it("submits the completed package when coordination reports readyForResubmission", async () => {
    const completedPackage = { fake: "completed-package" };
    const adapter = fakeAdapter(
      response("additionalApprovalsRequired"),
      response("executed", { executionResult: { content: [] } }),
    );
    const coordination = fakeCoordination(() => [
      {
        version: "1",
        type: "CoordinationActionUpdate",
        actionRef: actionRef(),
        state: "readyForResubmission",
        expiresAt: EXPIRES_AT,
        actionPackage: completedPackage as CoordinationActionUpdate["actionPackage"],
      },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());
    await engine.pollOnce();

    const record = store.getWorkflow(ACTION_ID);
    expect(record?.state).toBe("resolved");
    expect(record?.completedPackage).toEqual(completedPackage);
    expect(record?.resolution).toMatchObject({ kind: "resolved", actionResponse: { result: "executed" } });
    // Second adapter call was the completed package, not the initial one.
    expect(adapter.calls[1]).toEqual(completedPackage);
  });

  it("marks a coordination-expired workflow unresolvable, never a fabricated outcome", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination(() => [
      { version: "1", type: "CoordinationActionUpdate", actionRef: actionRef(), state: "expired", expiresAt: EXPIRES_AT },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());
    await engine.pollOnce();

    const record = store.getWorkflow(ACTION_ID);
    expect(record?.state).toBe("unresolvable");
    expect(record?.resolution).toMatchObject({ kind: "unresolvable", errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION" });
  });

  it("marks a coordination-rejected workflow unresolvable, not authoritatively rejected", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination(() => [
      { version: "1", type: "CoordinationActionUpdate", actionRef: actionRef(), state: "rejected", expiresAt: EXPIRES_AT },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());
    await engine.pollOnce();

    expect(store.getWorkflow(ACTION_ID)?.resolution).toMatchObject({
      kind: "unresolvable",
      errorCode: "COORDINATION_REJECTED",
    });
  });

  it("does not fabricate a result when coordination reports executed", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination(() => [
      { version: "1", type: "CoordinationActionUpdate", actionRef: actionRef(), state: "executed", expiresAt: EXPIRES_AT },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());
    await engine.pollOnce();

    expect(store.getWorkflow(ACTION_ID)?.resolution).toMatchObject({
      kind: "unresolvable",
      errorCode: "RESULT_UNAVAILABLE",
    });
  });

  it("marks an envelope-expired active workflow unresolvable during the sweep", async () => {
    const clock = { now: Date.parse("2026-07-26T18:00:00.000Z") };
    const adapter = fakeAdapter(new Error("adapter down"));
    const { engine, store } = makeEngine({ adapter, now: () => clock.now });

    await engine.propose({ ...proposalInput(), expiresAt: "2026-07-26T19:00:00.000Z" });
    clock.now = Date.parse("2026-07-26T19:00:01.000Z");
    await engine.pollOnce();

    const record = store.getWorkflow(ACTION_ID);
    expect(record?.state).toBe("unresolvable");
    expect(record?.resolution).toMatchObject({ errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION" });
  });

  it("marks a coordination-cancelled workflow unresolvable", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination(() => [
      { version: "1", type: "CoordinationActionUpdate", actionRef: actionRef(), state: "cancelled" },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());
    await engine.pollOnce();

    expect(store.getWorkflow(ACTION_ID)?.resolution).toMatchObject({
      kind: "unresolvable",
      errorCode: "ACTION_CANCELLED",
    });
  });

  it("swallows coordination poll failures and retries later", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = {
      submitted: [] as unknown[],
      async submitAction(pkg: unknown) {
        coordination.submitted.push(pkg);
        return {
          version: "1" as const,
          type: "CoordinationActionResponse" as const,
          actionRef: actionRef(),
          state: "awaitingApprovals" as const,
        };
      },
      async poll() {
        throw new Error("coordination down");
      },
    };
    const { engine, store } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());
    await engine.pollOnce();
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
  });

  it("returns a completed package to awaitingApprovals when policy still requires more", async () => {
    const completedPackage = { fake: "completed-package" };
    const adapter = fakeAdapter(
      response("additionalApprovalsRequired"),
      response("additionalApprovalsRequired"),
    );
    const coordination = fakeCoordination(() => [
      {
        version: "1",
        type: "CoordinationActionUpdate",
        actionRef: actionRef(),
        state: "readyForResubmission",
        actionPackage: completedPackage as CoordinationActionUpdate["actionPackage"],
      },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());
    await engine.pollOnce();

    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
  });

  it("treats ACTION_ID_HASH_MISMATCH like a lost terminal result", async () => {
    const adapter = fakeAdapter(
      response("additionalApprovalsRequired"),
      response("rejected", { error: { code: "ACTION_ID_HASH_MISMATCH", message: "hash mismatch" } }),
    );
    const coordination = fakeCoordination();
    const { engine, store } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());
    store.saveCompletedPackage(ACTION_ID, { fake: "completed-package" });
    store.compareAndSetState(ACTION_ID, "awaitingApprovals", "submittingToVerifier");

    await engine.reconcile();

    expect(store.getWorkflow(ACTION_ID)?.resolution).toMatchObject({
      kind: "unresolvable",
      errorCode: "RESULT_UNAVAILABLE",
    });
  });

  it("retries when completed-package submission is unreachable", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"), new Error("adapter down"));
    const coordination = fakeCoordination(() => [
      {
        version: "1",
        type: "CoordinationActionUpdate",
        actionRef: actionRef(),
        state: "readyForResubmission",
        actionPackage: { fake: "completed" } as CoordinationActionUpdate["actionPackage"],
      },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());
    await engine.pollOnce();

    expect(store.getWorkflow(ACTION_ID)?.state).toBe("readyForResubmission");
    expect(store.getWorkflow(ACTION_ID)?.adapterAttempts.at(-1)).toMatchObject({
      stage: "completed",
      outcome: "unreachable",
    });
  });

  it("keeps the workflow awaitingApprovals when coordination handoff fails", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = {
      submitted: [] as unknown[],
      async submitAction() {
        throw new Error("coordination submit failed");
      },
      async poll() {
        return {
          version: "1" as const,
          type: "CoordinationPollResponse" as const,
          approvalRequests: [],
          actionUpdates: [],
        };
      },
    };
    const { engine, store } = makeEngine({ adapter, coordination });
    const outcome = await engine.propose(proposalInput());

    expect(outcome.kind).toBe("deferred");
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("created");
  });

  it("ignores coordination updates for unknown or terminal workflows", async () => {
    const adapter = fakeAdapter(response("executed"));
    const coordination = fakeCoordination(() => [
      { version: "1", type: "CoordinationActionUpdate", actionRef: actionRef("urn:uuid:missing"), state: "expired" },
      { version: "1", type: "CoordinationActionUpdate", actionRef: actionRef(), state: "cancelled" },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("resolved");

    await engine.pollOnce();
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("resolved");
  });
});

describe("reconcile (startup recovery, feature spec §9.4)", () => {
  it("retries the initial submission for a workflow stranded in created", async () => {
    const adapter = fakeAdapter(new Error("down during propose"), response("executed"));
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("created");

    await engine.reconcile();

    expect(store.getWorkflow(ACTION_ID)?.state).toBe("resolved");
  });

  it("resolves a replay-rejected recovery as unresolvable RESULT_UNAVAILABLE (best effort)", async () => {
    // Crash window: completed package was dispatched, terminal response lost.
    // On recovery the identical resubmission is rejected as a replay; the
    // bridge must NOT present that rejection as the Action's outcome.
    const adapter = fakeAdapter(
      response("additionalApprovalsRequired"),
      response("rejected", { error: { code: "REPLAY_DETECTED", message: "Action has already been dispatched." } }),
    );
    const coordination = fakeCoordination();
    const { engine, store } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());
    store.saveCompletedPackage(ACTION_ID, { fake: "completed-package" });
    store.compareAndSetState(ACTION_ID, "awaitingApprovals", "submittingToVerifier");

    await engine.reconcile();

    const record = store.getWorkflow(ACTION_ID);
    expect(record?.state).toBe("unresolvable");
    expect(record?.resolution).toMatchObject({ kind: "unresolvable", errorCode: "RESULT_UNAVAILABLE" });
  });

  it("continues waiting when the identical resubmission reports pending", async () => {
    const adapter = fakeAdapter(
      response("additionalApprovalsRequired"),
      response("pending"),
    );
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());
    store.saveCompletedPackage(ACTION_ID, { fake: "completed-package" });
    store.compareAndSetState(ACTION_ID, "awaitingApprovals", "submittingToVerifier");

    await engine.reconcile();

    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingVerifierResult");
  });

  it("resubmits readyForResubmission and awaitingVerifierResult workflows on reconcile", async () => {
    const adapter = fakeAdapter(
      response("additionalApprovalsRequired"),
      response("executed"),
      response("additionalApprovalsRequired"),
      response("executed"),
    );
    const coordination = fakeCoordination();
    const { engine, store } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());

    store.saveCompletedPackage(ACTION_ID, { fake: "completed-package" });
    store.compareAndSetState(ACTION_ID, "awaitingApprovals", "readyForResubmission");
    await engine.reconcile();
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("resolved");

    const secondId = "urn:uuid:22222222-2222-4222-8222-222222222222";
    await engine.propose({ ...proposalInput(), actionId: secondId });
    store.saveCompletedPackage(secondId, { fake: "completed-2" });
    store.compareAndSetState(secondId, "awaitingApprovals", "awaitingVerifierResult");
    await engine.reconcile();
    expect(store.getWorkflow(secondId)?.state).toBe("resolved");
  });

  it("skips workflows already claimed by another worker during reconcile", async () => {
    const adapter = fakeAdapter(new Error("down"));
    const store = new MemoryWorkflowStore();
    const engine = makeEngine({ adapter, store, workerId: "worker-a" }).engine;
    await engine.propose(proposalInput());
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("created");

    expect(store.claimWorkflow(ACTION_ID, "worker-b", 60_000)).toBe(true);
    await engine.reconcile();
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("created");
    expect(adapter.calls).toHaveLength(1);
  });

  it("skips readyForResubmission claimed by another worker during pollOnce", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"), response("executed"));
    const store = new MemoryWorkflowStore();
    const { engine } = makeEngine({ adapter, store, workerId: "worker-a" });
    await engine.propose(proposalInput());

    store.saveCompletedPackage(ACTION_ID, { fake: "completed-package" });
    store.compareAndSetState(ACTION_ID, "awaitingApprovals", "readyForResubmission");
    expect(store.claimWorkflow(ACTION_ID, "worker-b", 60_000)).toBe(true);

    await engine.pollOnce();

    expect(store.getWorkflow(ACTION_ID)?.state).toBe("readyForResubmission");
    expect(adapter.calls).toHaveLength(1);
  });

  it("treats awaitingApprovals as a no-op during reconcile", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");

    await engine.reconcile();
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
    expect(adapter.calls).toHaveLength(1);
  });

  it("sweeps locally expired workflows without waiting for coordination", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    let now = Date.parse("2026-07-01T00:00:00.000Z");
    const { engine, store } = makeEngine({
      adapter,
      now: () => now,
    });
    await engine.propose({ ...proposalInput(), expiresAt: "2026-07-01T00:00:01.000Z" });
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");

    now = Date.parse("2026-07-01T00:00:02.000Z");
    await engine.pollOnce();

    expect(store.getWorkflow(ACTION_ID)?.state).toBe("unresolvable");
    expect(store.getWorkflow(ACTION_ID)?.resolution).toMatchObject({
      kind: "unresolvable",
      errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION",
    });
  });

  it("defers without storing authorizationRequirements when the verifier omits them", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
    expect(store.getWorkflow(ACTION_ID)?.authorizationRequirements).toBeUndefined();
  });

  it("ignores readyForResubmission updates that omit the completed package", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination(() => [
      {
        version: "1",
        type: "CoordinationActionUpdate",
        actionRef: actionRef(),
        state: "readyForResubmission",
      },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());
    await engine.pollOnce();
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
  });

  it("treats awaitingApprovals coordination updates as a no-op", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination(() => [
      {
        version: "1",
        type: "CoordinationActionUpdate",
        actionRef: actionRef(),
        state: "awaitingApprovals",
      },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());
    await engine.pollOnce();
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
    expect(adapter.calls).toHaveLength(1);
  });

  it("records non-Error adapter failures as string messages", async () => {
    const adapter = {
      calls: [] as unknown[],
      async submit(pkg: unknown) {
        adapter.calls.push(pkg);
        throw "string-failure";
      },
    };
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());
    const attempts = store.getWorkflow(ACTION_ID)?.adapterAttempts as Array<{ message?: string }> | undefined;
    expect(attempts?.at(-1)?.message).toBe("string-failure");
  });

  it("skips submitCompleted when compareAndSetState loses the race", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"), response("executed"));
    const store = new MemoryWorkflowStore();
    const { engine } = makeEngine({ adapter, store });
    await engine.propose(proposalInput());
    store.saveCompletedPackage(ACTION_ID, { fake: "completed-package" });
    store.compareAndSetState(ACTION_ID, "awaitingApprovals", "readyForResubmission");

    const original = store.compareAndSetState.bind(store);
    store.compareAndSetState = ((actionId, expected, next) => {
      if (expected === "readyForResubmission" && next === "submittingToVerifier") {
        return false;
      }
      return original(actionId, expected, next);
    }) as typeof store.compareAndSetState;

    await engine.pollOnce();
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("readyForResubmission");
    expect(adapter.calls).toHaveLength(1);
  });

  it("skips sweepExpired when another worker already holds the claim", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    let now = Date.parse("2026-07-01T00:00:00.000Z");
    const store = new MemoryWorkflowStore({ now: () => now });
    const { engine } = makeEngine({ adapter, store, now: () => now, workerId: "worker-a" });
    await engine.propose({ ...proposalInput(), expiresAt: "2026-07-01T00:00:01.000Z" });
    expect(store.claimWorkflow(ACTION_ID, "worker-b", 60_000)).toBe(true);

    now = Date.parse("2026-07-01T00:00:02.000Z");
    await engine.pollOnce();
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
  });
});

describe("lastActionResponse preservation (client profile §5.1)", () => {
  it("stores the exact nonterminal Verifier response on an approvals-gated proposal", async () => {
    const verifierResponse = response("additionalApprovalsRequired", {
      authorizationRequirements: { version: "1", type: "AuthorizationRequirements" } as ActionResponse["authorizationRequirements"],
      createdAt: "2026-07-26T18:00:00.000Z",
    });
    const adapter = fakeAdapter(verifierResponse);
    const { engine, store } = makeEngine({ adapter });

    await engine.propose(proposalInput());

    // Preserved exactly — same members, same values, no synthesis.
    expect(store.getWorkflow(ACTION_ID)?.lastActionResponse).toEqual(verifierResponse);
  });

  it("stores the exact pending response and leaves it absent when no Verifier response exists", async () => {
    const adapter = fakeAdapter(response("pending"));
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());
    expect(store.getWorkflow(ACTION_ID)?.lastActionResponse).toEqual(response("pending"));

    const downAdapter = fakeAdapter(new Error("down"));
    const second = makeEngine({ adapter: downAdapter });
    await second.engine.propose({ ...proposalInput(), actionId: "urn:uuid:33333333-3333-4333-8333-333333333333" });
    expect(
      second.store.getWorkflow("urn:uuid:33333333-3333-4333-8333-333333333333")?.lastActionResponse,
    ).toBeUndefined();
  });
});

describe("waitForResult (client track observation)", () => {
  it("returns immediately for an already-terminal workflow", async () => {
    const adapter = fakeAdapter(response("executed"));
    const { engine } = makeEngine({ adapter });
    await engine.propose(proposalInput());

    const record = await engine.waitForResult(ACTION_ID, 0);
    expect(record?.state).toBe("resolved");
  });

  it("returns undefined for an unknown action", async () => {
    const { engine } = makeEngine({ adapter: fakeAdapter() });
    expect(await engine.waitForResult("urn:uuid:unknown", 0)).toBeUndefined();
  });

  it("wakes a pending waiter when the workflow resolves", async () => {
    const completedPackage = { fake: "completed-package" };
    const adapter = fakeAdapter(response("additionalApprovalsRequired"), response("executed"));
    const coordination = fakeCoordination(() => [
      {
        version: "1",
        type: "CoordinationActionUpdate",
        actionRef: actionRef(),
        state: "readyForResubmission",
        expiresAt: EXPIRES_AT,
        actionPackage: completedPackage as CoordinationActionUpdate["actionPackage"],
      },
    ]);
    const { engine } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());

    const waiter = engine.waitForResult(ACTION_ID, 5_000);
    await engine.pollOnce();

    const record = await waiter;
    expect(record?.state).toBe("resolved");
  });

  it("returns the nonterminal record when the wait times out", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const { engine } = makeEngine({ adapter });
    await engine.propose(proposalInput());

    const record = await engine.waitForResult(ACTION_ID, 10);
    expect(record?.state).toBe("awaitingApprovals");
  });

  it("observation never advances the workflow (client profile §6.4)", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());

    await engine.waitForResult(ACTION_ID, 10);
    await engine.waitForResult(ACTION_ID, 0);

    // No further adapter submissions happened because of waiting.
    expect(adapter.calls).toHaveLength(1);
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
  });
});
