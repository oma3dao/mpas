import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeWorkflowState, WorkflowRecord } from "@oma3/mpas";
import { SqliteWorkflowStore } from "../../src/bridge/sqlite-workflow-store.js";

/**
 * SQLite reference implementation of the SDK WorkflowStore contract
 * (feature spec §8–§9, plan §5.2–§5.3).
 *
 * Bridge state is a local, non-authoritative workflow view. The store must
 * provide atomic state transitions, exclusive worker claims, immutable
 * terminal records, and retention-driven purging — all durable across
 * process restarts (reopen of the same database path).
 */

const ACTION_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const OTHER_ID = "urn:uuid:22222222-2222-4222-8222-222222222222";
const HASH = "b64url-envelope-digest";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let dir: string;
let dbPath: string;
let clock: { now: number };
let store: SqliteWorkflowStore;

function openStore(): SqliteWorkflowStore {
  return new SqliteWorkflowStore(dbPath, { now: () => clock.now });
}

function createDefault(store: SqliteWorkflowStore, actionId = ACTION_ID): WorkflowRecord {
  return store.createWorkflow({
    actionId,
    actionEnvelopeHash: HASH,
    toolName: "merge_pull_request_demo",
    actionPackage: { fake: "initial-action-package", actionId },
    expiresAt: EXPIRES_AT,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpas-workflow-store-"));
  dbPath = join(dir, "workflows.db");
  clock = { now: Date.parse("2026-07-26T18:00:00.000Z") };
  store = openStore();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createWorkflow / getWorkflow", () => {
  it("round-trips a new workflow in state created", () => {
    const created = createDefault(store);

    expect(created.state).toBe("created");
    expect(created.actionId).toBe(ACTION_ID);
    expect(created.actionEnvelopeHash).toBe(HASH);
    expect(created.toolName).toBe("merge_pull_request_demo");
    expect(created.expiresAt).toBe(EXPIRES_AT);
    expect(created.createdAt).toBe("2026-07-26T18:00:00.000Z");

    const fetched = store.getWorkflow(ACTION_ID);
    expect(fetched).toBeDefined();
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
});

describe("compareAndSetState", () => {
  it("advances the state only when the expected current state matches", () => {
    createDefault(store);

    expect(store.compareAndSetState(ACTION_ID, "created", "awaitingApprovals")).toBe(true);
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");

    // Stale transition: expected state no longer current.
    expect(store.compareAndSetState(ACTION_ID, "created", "readyForResubmission")).toBe(false);
    expect(store.getWorkflow(ACTION_ID)?.state).toBe("awaitingApprovals");
  });

  it("never transitions out of a terminal state", () => {
    createDefault(store);
    store.resolveWorkflow(ACTION_ID, {
      kind: "resolved",
      actionResponse: { result: "executed" },
    });

    const terminalStates: BridgeWorkflowState[] = ["created", "awaitingApprovals", "submittingToVerifier"];
    for (const target of terminalStates) {
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

  it("lets the same worker renew its own claim", () => {
    createDefault(store);
    expect(store.claimWorkflow(ACTION_ID, "worker-a", HOUR)).toBe(true);
    expect(store.claimWorkflow(ACTION_ID, "worker-a", HOUR)).toBe(true);
  });

  it("lets another worker take over after the lease expires", () => {
    createDefault(store);
    expect(store.claimWorkflow(ACTION_ID, "worker-a", HOUR)).toBe(true);

    clock.now += HOUR + 1;
    expect(store.claimWorkflow(ACTION_ID, "worker-b", HOUR)).toBe(true);
    // And worker-a has lost it.
    expect(store.claimWorkflow(ACTION_ID, "worker-a", HOUR)).toBe(false);
  });
});

describe("workflow material", () => {
  it("persists the coordination reference, completed package, and adapter attempts", () => {
    createDefault(store);

    store.saveCoordinationReference(ACTION_ID, { type: "ActionRef", actionId: { value: ACTION_ID } });
    store.saveCompletedPackage(ACTION_ID, { fake: "completed-action-package" });
    store.saveAdapterAttempt(ACTION_ID, { at: "2026-07-26T18:05:00.000Z", outcome: "networkError" });
    store.saveAdapterAttempt(ACTION_ID, { at: "2026-07-26T18:06:00.000Z", outcome: "submitted" });

    const record = store.getWorkflow(ACTION_ID);
    expect(record?.coordinationRef).toMatchObject({ type: "ActionRef" });
    expect(record?.completedPackage).toEqual({ fake: "completed-action-package" });
    expect(record?.adapterAttempts).toHaveLength(2);
    expect(record?.adapterAttempts[1]).toMatchObject({ outcome: "submitted" });
  });
});

describe("resolveWorkflow (terminal, immutable)", () => {
  it("stores a resolved outcome with the exact terminal material", () => {
    createDefault(store);
    store.resolveWorkflow(ACTION_ID, {
      kind: "resolved",
      actionResponse: { result: "executed", executionResult: { content: [{ type: "text", text: "merged" }] } },
      executionReceipt: { fake: "receipt" },
    });

    const record = store.getWorkflow(ACTION_ID);
    expect(record?.state).toBe("resolved");
    expect(record?.resolvedAt).toBe("2026-07-26T18:00:00.000Z");
    expect(record?.resolution).toMatchObject({
      kind: "resolved",
      actionResponse: { result: "executed" },
    });
  });

  it("stores an unresolvable outcome as a bridge error, never an Action outcome", () => {
    createDefault(store);
    store.resolveWorkflow(ACTION_ID, {
      kind: "unresolvable",
      errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION",
      errorMessage: "The Action expired without a terminal Verifier response.",
    });

    const record = store.getWorkflow(ACTION_ID);
    expect(record?.state).toBe("unresolvable");
    expect(record?.resolution).toMatchObject({ kind: "unresolvable", errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION" });
  });

  it("keeps the first resolution: a second resolve is ignored (stable result)", () => {
    createDefault(store);
    store.resolveWorkflow(ACTION_ID, {
      kind: "resolved",
      actionResponse: { result: "executed" },
    });
    store.resolveWorkflow(ACTION_ID, {
      kind: "resolved",
      actionResponse: { result: "failed" },
    });

    const record = store.getWorkflow(ACTION_ID);
    expect(record?.resolution).toMatchObject({ actionResponse: { result: "executed" } });
  });
});

describe("listRecoverableWorkflows (startup reconciliation)", () => {
  it("lists only non-terminal workflows", () => {
    createDefault(store);
    createDefault(store, OTHER_ID);
    store.compareAndSetState(OTHER_ID, "created", "awaitingApprovals");
    store.resolveWorkflow(ACTION_ID, {
      kind: "resolved",
      actionResponse: { result: "executed" },
    });

    const recoverable = store.listRecoverableWorkflows();
    expect(recoverable.map((w) => w.actionId)).toEqual([OTHER_ID]);
  });
});

describe("durability across restart", () => {
  it("survives close and reopen of the same database path", () => {
    createDefault(store);
    store.compareAndSetState(ACTION_ID, "created", "awaitingApprovals");
    store.saveCoordinationReference(ACTION_ID, { type: "ActionRef" });
    store.close();

    store = openStore();
    const record = store.getWorkflow(ACTION_ID);
    expect(record?.state).toBe("awaitingApprovals");
    expect(record?.coordinationRef).toEqual({ type: "ActionRef" });
    expect(store.listRecoverableWorkflows()).toHaveLength(1);
  });

  it("does not carry worker claims across a restart into fresh exclusivity conflicts", () => {
    createDefault(store);
    expect(store.claimWorkflow(ACTION_ID, "worker-a", HOUR)).toBe(true);
    store.close();

    // Same wall-clock: the lease is still live and must still exclude others.
    store = openStore();
    expect(store.claimWorkflow(ACTION_ID, "worker-b", HOUR)).toBe(false);
    clock.now += HOUR + 1;
    expect(store.claimWorkflow(ACTION_ID, "worker-b", HOUR)).toBe(true);
  });

  it("fails safely on an incompatible schema version", async () => {
    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 999");
    raw.close();

    expect(() => openStore()).toThrow(/schema/i);
    store = { close() {} } as SqliteWorkflowStore; // afterEach cleanup stub
  });
});

describe("purgeExpiredResults (retention, feature spec §9.6)", () => {
  it("retains terminal results until max(expiresAt, resolvedAt + retention)", () => {
    // Resolves now; envelope expires 2030 — retention must hold until expiry.
    createDefault(store);
    store.resolveWorkflow(ACTION_ID, {
      kind: "resolved",
      actionResponse: { result: "executed" },
    });

    clock.now += 2 * DAY;
    expect(store.purgeExpiredResults(DAY)).toBe(0);
    expect(store.getWorkflow(ACTION_ID)).toBeDefined();

    // Past envelope expiry AND past resolvedAt + retention: purged.
    clock.now = Date.parse(EXPIRES_AT) + 1;
    expect(store.purgeExpiredResults(DAY)).toBe(1);
    expect(store.getWorkflow(ACTION_ID)).toBeUndefined();
  });

  it("holds a freshly resolved record for the retention window even after envelope expiry", () => {
    createDefault(store);
    // Resolve just before envelope expiry.
    clock.now = Date.parse(EXPIRES_AT) - 1000;
    store.resolveWorkflow(ACTION_ID, {
      kind: "resolved",
      actionResponse: { result: "executed" },
    });

    // Envelope has expired, but resolvedAt + 24h has not.
    clock.now = Date.parse(EXPIRES_AT) + HOUR;
    expect(store.purgeExpiredResults(DAY)).toBe(0);

    clock.now = Date.parse(EXPIRES_AT) - 1000 + DAY + 1;
    expect(store.purgeExpiredResults(DAY)).toBe(1);
  });

  it("never purges an active workflow", () => {
    createDefault(store);
    store.compareAndSetState(ACTION_ID, "created", "awaitingApprovals");

    // Long past everything: active records are reconciliation's job, not purging's.
    clock.now = Date.parse(EXPIRES_AT) + 10 * DAY;
    expect(store.purgeExpiredResults(DAY)).toBe(0);
    expect(store.getWorkflow(ACTION_ID)).toBeDefined();
  });
});
