import { beforeEach, describe, expect, it } from "vitest";
import {
  MemoryWorkflowStore,
  type BridgeWorkflowState,
  type WorkflowRecord,
  type WorkflowStore,
} from "../../src/lib/workflow-store.js";

/**
 * WorkflowStore contract, exercised against the SDK's in-memory reference
 * implementation (feature spec §8–§9, plan §5.2). Durable implementations —
 * for example the SQLite reference store in examples/demo — must additionally
 * survive restarts; those tests live with that implementation.
 */

const ACTION_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const OTHER_ID = "urn:uuid:22222222-2222-4222-8222-222222222222";
const HASH = "b64url-envelope-digest";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let clock: { now: number };
let store: WorkflowStore;

function createDefault(target: WorkflowStore, actionId = ACTION_ID): WorkflowRecord {
  return target.createWorkflow({
    actionId,
    actionEnvelopeHash: HASH,
    toolName: "merge_pull_request",
    actionPackage: { fake: "initial-action-package", actionId },
    expiresAt: EXPIRES_AT,
  });
}

beforeEach(() => {
  clock = { now: Date.parse("2026-07-26T18:00:00.000Z") };
  store = new MemoryWorkflowStore({ now: () => clock.now });
});

describe("createWorkflow / getWorkflow", () => {
  it("round-trips a new workflow in state created", () => {
    const created = createDefault(store);

    expect(created.state).toBe("created");
    expect(created.actionId).toBe(ACTION_ID);
    expect(created.actionEnvelopeHash).toBe(HASH);
    expect(created.createdAt).toBe("2026-07-26T18:00:00.000Z");

    const fetched = store.getWorkflow(ACTION_ID);
    expect(fetched).toMatchObject({
      actionId: ACTION_ID,
      state: "created",
      actionPackage: { fake: "initial-action-package", actionId: ACTION_ID },
    });
  });

  it("returns undefined for an unknown actionId", () => {
    expect(store.getWorkflow("urn:uuid:unknown")).toBeUndefined();
  });

  it("rejects a second create for the same actionId", () => {
    createDefault(store);
    expect(() => createDefault(store)).toThrow(/exists/i);
  });

  it("returns copies: mutating a fetched record does not corrupt the store", () => {
    createDefault(store);
    const fetched = store.getWorkflow(ACTION_ID);
    (fetched!.actionPackage as Record<string, unknown>).fake = "tampered";
    expect((store.getWorkflow(ACTION_ID)?.actionPackage as Record<string, unknown>).fake).toBe(
      "initial-action-package",
    );
  });
});

describe("compareAndSetState", () => {
  it("advances the state only when the expected current state matches", () => {
    createDefault(store);

    expect(store.compareAndSetState(ACTION_ID, "created", "awaitingApprovals")).toBe(true);
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");

    expect(store.compareAndSetState(ACTION_ID, "created", "readyForResubmission")).toBe(false);
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
  });

  it("never transitions out of a terminal state", () => {
    createDefault(store);
    store.resolveWorkflow(ACTION_ID, { kind: "resolved", actionResponse: { result: "executed" } });

    const targets: BridgeWorkflowState[] = ["created", "awaitingApprovals", "submittingToVerifier"];
    for (const target of targets) {
      expect(store.compareAndSetState(ACTION_ID, "resolved", target)).toBe(false);
    }
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("resolved");
  });
});

describe("claimWorkflow (exclusive worker claims)", () => {
  it("grants one worker the claim and refuses a second while the lease is live", () => {
    createDefault(store);
    expect(store.claimWorkflow(ACTION_ID, "worker-a", HOUR)).toBe(true);
    expect(store.claimWorkflow(ACTION_ID, "worker-b", HOUR)).toBe(false);
  });

  it("lets the same worker renew and another worker take over after expiry", () => {
    createDefault(store);
    expect(store.claimWorkflow(ACTION_ID, "worker-a", HOUR)).toBe(true);
    expect(store.claimWorkflow(ACTION_ID, "worker-a", HOUR)).toBe(true);

    clock.now += HOUR + 1;
    expect(store.claimWorkflow(ACTION_ID, "worker-b", HOUR)).toBe(true);
    expect(store.claimWorkflow(ACTION_ID, "worker-a", HOUR)).toBe(false);
  });
});

describe("workflow material", () => {
  it("persists coordination reference, completed package, attempts, and lastActionResponse", () => {
    createDefault(store);

    store.saveCoordinationReference(ACTION_ID, { type: "ActionRef" });
    store.saveCompletedPackage(ACTION_ID, { fake: "completed-action-package" });
    store.saveAdapterAttempt(ACTION_ID, { outcome: "networkError" });
    store.saveAdapterAttempt(ACTION_ID, { outcome: "submitted" });
    store.saveLastActionResponse(ACTION_ID, { type: "ActionResponse", result: "additionalApprovalsRequired" });

    const record = store.getWorkflow(ACTION_ID);
    expect(record?.coordinationRef).toEqual({ type: "ActionRef" });
    expect(record?.completedPackage).toEqual({ fake: "completed-action-package" });
    expect(record?.adapterAttempts).toHaveLength(2);
    expect(record?.lastActionResponse).toMatchObject({ result: "additionalApprovalsRequired" });
  });
});

describe("resolveWorkflow (terminal, immutable)", () => {
  it("stores resolved and unresolvable outcomes with their exact material", () => {
    createDefault(store);
    createDefault(store, OTHER_ID);

    store.resolveWorkflow(ACTION_ID, { kind: "resolved", actionResponse: { result: "executed" } });
    store.resolveWorkflow(OTHER_ID, {
      kind: "unresolvable",
      errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION",
      errorMessage: "expired",
    });

    expect(store.getWorkflow(ACTION_ID)).toMatchObject({
      state: "resolved",
      resolvedAt: "2026-07-26T18:00:00.000Z",
      resolution: { kind: "resolved", actionResponse: { result: "executed" } },
    });
    expect(store.getWorkflow(OTHER_ID)).toMatchObject({
      state: "unresolvable",
      resolution: { errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION" },
    });
  });

  it("keeps the first resolution: a second resolve is ignored (stable result)", () => {
    createDefault(store);
    store.resolveWorkflow(ACTION_ID, { kind: "resolved", actionResponse: { result: "executed" } });
    store.resolveWorkflow(ACTION_ID, { kind: "resolved", actionResponse: { result: "failed" } });

    expect(store.getWorkflow(ACTION_ID)?.resolution).toMatchObject({ actionResponse: { result: "executed" } });
  });
});

describe("cancelWorkflow (terminal, immutable)", () => {
  it("atomically cancels an active workflow and records its terminal time", () => {
    createDefault(store);
    expect(store.cancelWorkflow(ACTION_ID)).toBe(true);
    expect(store.getWorkflow(ACTION_ID)).toMatchObject({
      state: "cancelled",
      resolvedAt: "2026-07-26T18:00:00.000Z",
      resolution: { kind: "cancelled", cancelledAt: "2026-07-26T18:00:00.000Z" },
    });
  });

  it("preserves the first terminal write", () => {
    createDefault(store);
    expect(store.cancelWorkflow(ACTION_ID)).toBe(true);
    expect(store.cancelWorkflow(ACTION_ID)).toBe(false);
    store.resolveWorkflow(ACTION_ID, { kind: "resolved", actionResponse: { result: "executed" } });
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("cancelled");
  });
});

describe("listRecoverableWorkflows", () => {
  it("lists only non-terminal workflows", () => {
    createDefault(store);
    createDefault(store, OTHER_ID);
    store.compareAndSetState(OTHER_ID, "created", "awaitingApprovals");
    store.resolveWorkflow(ACTION_ID, { kind: "resolved", actionResponse: { result: "executed" } });

    expect(store.listRecoverableWorkflows().map((w) => w.actionId)).toEqual([OTHER_ID]);
  });
});

describe("purgeExpiredResults (retention, feature spec §9.6)", () => {
  it("retains terminal results until max(expiresAt, resolvedAt + retention)", () => {
    createDefault(store);
    store.resolveWorkflow(ACTION_ID, { kind: "resolved", actionResponse: { result: "executed" } });

    clock.now += 2 * DAY;
    expect(store.purgeExpiredResults(DAY)).toBe(0);

    clock.now = Date.parse(EXPIRES_AT) + 1;
    expect(store.purgeExpiredResults(DAY)).toBe(1);
    expect(store.getWorkflow(ACTION_ID)).toBeUndefined();
  });

  it("never purges an active workflow", () => {
    createDefault(store);
    store.compareAndSetState(ACTION_ID, "created", "awaitingApprovals");

    clock.now = Date.parse(EXPIRES_AT) + 10 * DAY;
    expect(store.purgeExpiredResults(DAY)).toBe(0);
    expect(store.getWorkflow(ACTION_ID)).toBeDefined();
  });
});
