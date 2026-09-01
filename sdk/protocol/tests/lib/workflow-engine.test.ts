import { describe, expect, it } from "vitest";
import {
  CoordinationResponseError,
  CoordinationUnavailableError,
  computeHash,
  MpasAuthError,
  type ActionResponse,
  type CoordinationActionUpdate,
} from "../../src/index.js";
import { MemoryWorkflowStore, type WorkflowStore } from "../../src/lib/workflow-store.js";
import {
  BridgeWorkflowEngine,
  type WorkflowActionEndpoint,
  type WorkflowAdapter,
  type WorkflowCoordination,
} from "../../src/lib/workflow-engine.js";

/**
 * Proposer-bridge workflow engine (feature spec §6 bridge track, §9.4, §11).
 *
 * The engine owns the bridge track: initial submission, coordination handoff,
 * replacement-Action submission, terminal storage, startup reconciliation,
 * and expiry. Result recovery is best effort: a crash window that loses the
 * terminal response resolves to `unresolvable`, never to a fabricated
 * Action outcome.
 */

const TASK_ID = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTION_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const REPLACEMENT_ACTION_ID = "urn:uuid:22222222-2222-4222-8222-222222222222";
const HASH = "b64url-envelope-digest";
const IDEMPOTENCY_KEY = "initial-action-attempt";
const PROPOSER_DID = "did:jwk:proposer";
const REPLACEMENT_HASH = computeHash({
  proposer: { did: PROPOSER_DID },
  actionId: { value: REPLACEMENT_ACTION_ID },
  expiresAt: "2030-01-01T00:00:00.000Z",
}).value;
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

function response(result: ActionResponse["result"], extra: Partial<ActionResponse> = {}): ActionResponse {
  return {
    version: "1",
    type: "ActionResponse",
    result,
    ...(result === "additionalApprovalsRequired" && extra.authorizationRequirements === undefined
      ? {
          authorizationRequirements: {
            version: "1" as const,
            type: "AuthorizationRequirements" as const,
            actionEnvelopeHash: { alg: "sha-256" as const, value: HASH },
            result: "additionalApprovalsRequired" as const,
            verifier: { did: "did:jwk:verifier" as const },
            approvalRequirements: {
              anyOf: [{ type: "threshold" as const, threshold: 1, eligibleSigners: ["did:jwk:signer" as const] }],
            },
          },
        }
      : {}),
    ...extra,
  };
}

function actionRef(actionId = REPLACEMENT_ACTION_ID, hash = REPLACEMENT_HASH) {
  return {
    version: "1" as const,
    type: "ActionRef" as const,
    actionId: { value: actionId },
    actionEnvelopeHash: { alg: "sha-256" as const, value: hash },
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
  cancelled: string[];
} {
  const submitted: unknown[] = [];
  const cancelled: string[] = [];
  return {
    submitted,
    cancelled,
    async submitAction(pkg: unknown) {
      submitted.push(pkg);
      const actionPackage = pkg as { actionEnvelope: { actionId: { value: string } }; approvalBundle: { actionEnvelopeHash: { value: string } } };
      return {
        version: "1" as const,
        type: "CoordinationActionResponse" as const,
        actionRef: actionRef(actionPackage.actionEnvelope.actionId.value, actionPackage.approvalBundle.actionEnvelopeHash.value),
        state: "awaitingApprovals" as const,
      };
    },
    async poll() {
      return { version: "1" as const, type: "CoordinationPollResponse" as const, approvalRequests: [], actionUpdates: updates() };
    },
    async cancelAction(actionId) {
      cancelled.push(actionId.value);
      return {
        version: "1" as const,
        type: "CoordinationActionCancelResponse" as const,
        actionRef: actionRef(actionId.value),
        state: "cancelled" as const,
        cancelledAt: "2026-08-14T10:00:00.000Z",
      };
    },
  };
}

function makeEngine(opts: {
  adapter?: WorkflowAdapter;
  actionEndpoint?: WorkflowActionEndpoint;
  coordination?: WorkflowCoordination;
  store?: WorkflowStore;
  now?: () => number;
}) {
  const store = opts.store ?? new MemoryWorkflowStore({ now: opts.now });
  const engine = new BridgeWorkflowEngine({
    store,
    ...(opts.actionEndpoint !== undefined
      ? { actionEndpoint: opts.actionEndpoint }
      : { adapter: opts.adapter! }),
    coordination: opts.coordination ?? fakeCoordination(),
    proposerDid: PROPOSER_DID,
    buildCoordinationReplacement: async (priorPackage, verifierRequirements) => {
      const prior = priorPackage;
      const actionPackage = {
        ...structuredClone(prior),
        fake: "replacement-package",
        actionEnvelope: {
          ...structuredClone(prior.actionEnvelope),
          actionId: { value: REPLACEMENT_ACTION_ID },
          expiresAt: EXPIRES_AT,
        },
        approvalBundle: {
          version: "1",
          type: "ApprovalBundle",
          actionEnvelopeHash: { alg: "sha-256", value: REPLACEMENT_HASH },
          approvals: [],
        },
      };
      return {
        actionPackage,
        authorizationRequirements: {
          ...structuredClone(verifierRequirements),
          actionEnvelopeHash: { alg: "sha-256", value: REPLACEMENT_HASH },
        },
      };
    },
    workerId: "test-worker",
    now: opts.now,
  });
  return { engine, store };
}

function proposalInput() {
  return {
    taskId: TASK_ID,
    actionId: ACTION_ID,
    actionIdempotencyKey: IDEMPOTENCY_KEY,
    actionEnvelopeHash: HASH,
    toolName: "merge_pull_request",
    actionPackage: {
      fake: "initial-package",
      actionEnvelope: { proposer: { did: PROPOSER_DID }, actionId: { value: ACTION_ID } },
    },
    expiresAt: EXPIRES_AT,
  };
}

describe("propose", () => {
  it("rejects a Task ID reused as the Action ID", async () => {
    const { engine } = makeEngine({ adapter: fakeAdapter(response("executed")) });

    await expect(engine.propose({ ...proposalInput(), taskId: ACTION_ID })).rejects.toThrow(
      /must be distinct/i,
    );
  });

  it("reuses one idempotency key for retries of the same Action", async () => {
    const requests: Parameters<WorkflowActionEndpoint["submitActionRequest"]>[0][] = [];
    let attempt = 0;
    const actionEndpoint: WorkflowActionEndpoint = {
      async submitActionRequest(request) {
        requests.push(request);
        attempt += 1;
        if (attempt === 1) throw new Error("connect ECONNREFUSED");
        return response("executed");
      },
    };
    const { engine } = makeEngine({ actionEndpoint });

    await engine.propose(proposalInput());
    await engine.pollOnce();

    expect(requests.map((request) => request.idempotencyKey)).toEqual([
      IDEMPOTENCY_KEY,
      IDEMPOTENCY_KEY,
    ]);
  });

  it("uses a new durable idempotency key for the replacement Action", async () => {
    const requests: Parameters<WorkflowActionEndpoint["submitActionRequest"]>[0][] = [];
    const actionEndpoint: WorkflowActionEndpoint = {
      async submitActionRequest(request) {
        requests.push(request);
        return requests.length === 1
          ? response("additionalApprovalsRequired")
          : response("executed");
      },
    };
    const coordination = fakeCoordination(() => [{
      version: "1",
      type: "CoordinationActionUpdate",
      actionRef: actionRef(),
      state: "readyForSubmission",
      actionPackage: { fake: "completed-replacement-package" },
    }]);
    const { engine, store } = makeEngine({ actionEndpoint, coordination });

    await engine.propose(proposalInput());
    const replacementKey = store.getWorkflow(TASK_ID)?.actionIdempotencyKey;
    await engine.pollOnce();

    expect(replacementKey).toBeTruthy();
    expect(replacementKey).not.toBe(IDEMPOTENCY_KEY);
    expect(requests.map((request) => request.idempotencyKey)).toEqual([
      IDEMPOTENCY_KEY,
      replacementKey,
    ]);
  });

  it("settles immediately when the adapter returns a terminal response", async () => {
    const adapter = fakeAdapter(response("executed", { executionResult: { content: [] } }));
    const { engine, store } = makeEngine({ adapter });

    const outcome = await engine.propose(proposalInput());

    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") {
      expect(outcome.actionResponse.result).toBe("executed");
    }
    expect(store.getWorkflow(TASK_ID)?.state).toBe("resolved");
  });

  it("defers on additionalApprovalsRequired and hands the action to coordination", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination();
    const { engine, store } = makeEngine({ adapter, coordination });

    const outcome = await engine.propose(proposalInput());

    expect(outcome.kind).toBe("deferred");
    expect(coordination.submitted).toHaveLength(1);
    const record = store.getWorkflow(TASK_ID);
    expect(record?.state).toBe("awaitingApprovals");
    expect(record?.taskId).toBe(TASK_ID);
    expect(record?.actionId).toBe(REPLACEMENT_ACTION_ID);
    expect(record?.actionId).not.toBe(ACTION_ID);
    expect(record?.actionEnvelopeHash).toBe(REPLACEMENT_HASH);
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
    const record = store.getWorkflow(TASK_ID);
    expect(record?.state).toBe("created");
    expect(record?.adapterAttempts.length).toBeGreaterThan(0);
  });

  it("defers on a Verifier pending response", async () => {
    const adapter = fakeAdapter(response("pending"));
    const { engine, store } = makeEngine({ adapter });

    const outcome = await engine.propose(proposalInput());

    expect(outcome.kind).toBe("deferred");
    expect(store.getWorkflow(TASK_ID)?.state).toBe("awaitingVerifierResult");
  });

  it("stops retrying when coordination rejects the proposer", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination();
    coordination.submitAction = async (pkg: unknown) => {
      coordination.submitted.push(pkg);
      throw new MpasAuthError(403, "permission_denied", "Coordination request authorization failed.");
    };
    const { engine, store } = makeEngine({ adapter, coordination });

    const outcome = await engine.propose(proposalInput());

    expect(outcome.kind).toBe("deferred");
    expect(store.getWorkflow(TASK_ID)).toMatchObject({
      state: "unresolvable",
      resolution: {
        kind: "unresolvable",
        errorCode: "COORDINATION_AUTHORIZATION_FAILED",
      },
    });
    expect(store.getWorkflow(TASK_ID)?.coordinationRef).toBeUndefined();
    await engine.pollOnce();
    expect(adapter.calls).toHaveLength(1);
    expect(coordination.submitted).toHaveLength(1);
  });

  it("treats a non-retryable coordination request rejection as terminal", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination();
    coordination.submitAction = async () => {
      throw new CoordinationResponseError("Coordination Service rejected the request with HTTP 400.");
    };
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());

    expect(store.getWorkflow(TASK_ID)?.resolution).toMatchObject({
      kind: "unresolvable",
      errorCode: "COORDINATION_REQUEST_REJECTED",
    });
  });

  it("retries a transient coordination outage without resubmitting to the Verifier", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination();
    let attempts = 0;
    coordination.submitAction = async (pkg: unknown) => {
      coordination.submitted.push(pkg);
      attempts += 1;
      if (attempts === 1) {
        throw new CoordinationUnavailableError("Coordination Service returned HTTP 503.");
      }
      return {
        version: "1",
        type: "CoordinationActionResponse",
        actionRef: actionRef(),
        state: "awaitingApprovals",
      };
    };
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());
    expect(store.getWorkflow(TASK_ID)?.state).toBe("submittingToCoordination");
    await engine.pollOnce();

    expect(store.getWorkflow(TASK_ID)?.state).toBe("awaitingApprovals");
    expect(adapter.calls).toHaveLength(1);
    expect(coordination.submitted).toHaveLength(2);
  });
});

describe("pollOnce (bridge track advancement)", () => {
  it("retries created workflows even when Coordination polling is unavailable", async () => {
    const adapter = fakeAdapter(new Error("adapter down"), response("executed"));
    const coordination: WorkflowCoordination = {
      ...fakeCoordination(),
      async poll() {
        throw new Error("coordination down");
      },
    };
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());
    expect(store.getWorkflow(TASK_ID)?.state).toBe("created");
    await engine.pollOnce();
    expect(store.getWorkflow(TASK_ID)?.state).toBe("resolved");
  });

  it("submits completed A2 when coordination reports readyForSubmission", async () => {
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
        state: "readyForSubmission",
        expiresAt: EXPIRES_AT,
        actionPackage: completedPackage as CoordinationActionUpdate["actionPackage"],
      },
    ]);
    const { engine, store } = makeEngine({ adapter, coordination });

    await engine.propose(proposalInput());
    await engine.pollOnce();

    const record = store.getWorkflow(TASK_ID);
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

    const record = store.getWorkflow(TASK_ID);
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

    expect(store.getWorkflow(TASK_ID)?.resolution).toMatchObject({
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

    expect(store.getWorkflow(TASK_ID)?.resolution).toMatchObject({
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

    const record = store.getWorkflow(TASK_ID);
    expect(record?.state).toBe("unresolvable");
    expect(record?.resolution).toMatchObject({ errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION" });
  });
});

describe("cancel", () => {
  it("atomically stops future work and best-effort cancels Coordination", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const coordination = fakeCoordination();
    const { engine, store } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());

    const cancelled = await engine.cancel(TASK_ID);
    expect(cancelled?.state).toBe("cancelled");
    expect(coordination.cancelled).toEqual([REPLACEMENT_ACTION_ID]);
    await engine.pollOnce();
    expect(store.getWorkflow(TASK_ID)?.state).toBe("cancelled");
    expect(adapter.calls).toHaveLength(1);
  });

  it("forwards cancellation that races an in-flight Coordination submission", async () => {
    let finishSubmission: (() => void) | undefined;
    let submissionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      submissionStarted = resolve;
    });
    const coordination = fakeCoordination();
    coordination.submitAction = async (pkg: unknown) => {
      coordination.submitted.push(pkg);
      submissionStarted?.();
      await new Promise<void>((resolve) => {
        finishSubmission = resolve;
      });
      return {
        version: "1",
        type: "CoordinationActionResponse",
        actionRef: actionRef(),
        state: "awaitingApprovals",
      };
    };
    const { engine, store } = makeEngine({
      adapter: fakeAdapter(response("additionalApprovalsRequired")),
      coordination,
    });

    const proposing = engine.propose(proposalInput());
    await started;
    await engine.cancel(TASK_ID);
    finishSubmission?.();
    await proposing;

    expect(store.getWorkflow(TASK_ID)?.state).toBe("cancelled");
    expect(coordination.cancelled).toEqual([REPLACEMENT_ACTION_ID]);
  });

  it("does not reveal a workflow owned by another proposer DID", async () => {
    const { engine, store } = makeEngine({ adapter: fakeAdapter() });
    store.createWorkflow({
      ...proposalInput(),
      actionPackage: { actionEnvelope: { proposer: { did: "did:jwk:other" } } },
    });
    expect(await engine.cancel(TASK_ID)).toBeUndefined();
    expect(store.getWorkflow(TASK_ID)?.state).toBe("created");
  });
});

describe("reconcile (startup recovery, feature spec §9.4)", () => {
  it("retries the initial submission for a workflow stranded in created", async () => {
    const adapter = fakeAdapter(new Error("down during propose"), response("executed"));
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());
    expect(store.getWorkflow(TASK_ID)?.state).toBe("created");

    await engine.reconcile();

    expect(store.getWorkflow(TASK_ID)?.state).toBe("resolved");
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
    store.saveCompletedPackage(TASK_ID, { fake: "completed-package" });
    store.compareAndSetState(TASK_ID, "awaitingApprovals", "submittingToVerifier");

    await engine.reconcile();

    const record = store.getWorkflow(TASK_ID);
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
    store.saveCompletedPackage(TASK_ID, { fake: "completed-package" });
    store.compareAndSetState(TASK_ID, "awaitingApprovals", "submittingToVerifier");

    await engine.reconcile();

    expect(store.getWorkflow(TASK_ID)?.state).toBe("awaitingVerifierResult");
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
    expect(store.getWorkflow(TASK_ID)?.lastActionResponse).toEqual(verifierResponse);
  });

  it("stores the exact pending response and leaves it absent when no Verifier response exists", async () => {
    const adapter = fakeAdapter(response("pending"));
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());
    expect(store.getWorkflow(TASK_ID)?.lastActionResponse).toEqual(response("pending"));

    const downAdapter = fakeAdapter(new Error("down"));
    const second = makeEngine({ adapter: downAdapter });
    await second.engine.propose({
      ...proposalInput(),
      taskId: "urn:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      actionId: "urn:uuid:33333333-3333-4333-8333-333333333333",
    });
    expect(second.store.getWorkflow("urn:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc")?.lastActionResponse).toBeUndefined();
  });
});

describe("waitForResult (client track observation)", () => {
  it("returns immediately for an already-terminal workflow", async () => {
    const adapter = fakeAdapter(response("executed"));
    const { engine } = makeEngine({ adapter });
    await engine.propose(proposalInput());

    const record = await engine.waitForResult(TASK_ID, 0);
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
        state: "readyForSubmission",
        expiresAt: EXPIRES_AT,
        actionPackage: completedPackage as CoordinationActionUpdate["actionPackage"],
      },
    ]);
    const { engine } = makeEngine({ adapter, coordination });
    await engine.propose(proposalInput());

    const waiter = engine.waitForResult(TASK_ID, 5_000);
    await engine.pollOnce();

    const record = await waiter;
    expect(record?.state).toBe("resolved");
  });

  it("returns the nonterminal record when the wait times out", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const { engine } = makeEngine({ adapter });
    await engine.propose(proposalInput());

    const record = await engine.waitForResult(TASK_ID, 10);
    expect(record?.state).toBe("awaitingApprovals");
  });

  it("observation never advances the workflow (client profile §6.4)", async () => {
    const adapter = fakeAdapter(response("additionalApprovalsRequired"));
    const { engine, store } = makeEngine({ adapter });
    await engine.propose(proposalInput());

    await engine.waitForResult(TASK_ID, 10);
    await engine.waitForResult(TASK_ID, 0);

    // No further adapter submissions happened because of waiting.
    expect(adapter.calls).toHaveLength(1);
    expect(store.getWorkflow(TASK_ID)?.state).toBe("awaitingApprovals");
  });
});
