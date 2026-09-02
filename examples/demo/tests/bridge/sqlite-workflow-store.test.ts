import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const TASK_ID = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TASK_ID = "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IDEMPOTENCY_KEY = "initial-action-attempt";
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

function createDefault(store: SqliteWorkflowStore, actionId = ACTION_ID, taskId = TASK_ID): WorkflowRecord {
  return store.createWorkflow({
    taskId,
    actionId,
    actionIdempotencyKey: IDEMPOTENCY_KEY,
    actionEnvelopeHash: HASH,
    toolName: "merge_pull_request_mirror",
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
    expect(created.actionIdempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(created.actionEnvelopeHash).toBe(HASH);
    expect(created.toolName).toBe("merge_pull_request_mirror");
    expect(created.expiresAt).toBe(EXPIRES_AT);
    expect(created.createdAt).toBe("2026-07-26T18:00:00.000Z");

    const fetched = store.getWorkflow(TASK_ID);
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

  it("rejects using the same identifier for the Task and Action", () => {
    expect(() => createDefault(store, ACTION_ID, ACTION_ID)).toThrow(/must be distinct/i);
  });
});

describe("compareAndSetState", () => {
  it("advances the state only when the expected current state matches", () => {
    createDefault(store);

    expect(store.compareAndSetState(TASK_ID, "created", "awaitingApprovals")).toBe(true);
    expect(store.getWorkflow(TASK_ID)?.state).toBe("awaitingApprovals");

    // Stale transition: expected state no longer current.
    expect(store.compareAndSetState(TASK_ID, "created", "readyForSubmission")).toBe(false);
    expect(store.getWorkflow(TASK_ID)?.state).toBe("awaitingApprovals");
  });

  it("never transitions out of a terminal state", () => {
    createDefault(store);
    store.resolveWorkflow(TASK_ID, {
      kind: "resolved",
      actionResponse: { result: "executed" },
    });

    const terminalStates: BridgeWorkflowState[] = ["created", "awaitingApprovals", "submittingToVerifier"];
    for (const target of terminalStates) {
      expect(store.compareAndSetState(TASK_ID, "resolved", target)).toBe(false);
    }
    expect(store.getWorkflow(TASK_ID)?.state).toBe("resolved");
  });
});

describe("claimWorkflow (exclusive worker claims)", () => {
  it("grants one worker the claim and refuses a second while the lease is live", () => {
    createDefault(store);

    expect(store.claimWorkflow(TASK_ID, "worker-a", HOUR)).toBe(true);
    expect(store.claimWorkflow(TASK_ID, "worker-b", HOUR)).toBe(false);
  });

  it("lets the same worker renew its own claim", () => {
    createDefault(store);
    expect(store.claimWorkflow(TASK_ID, "worker-a", HOUR)).toBe(true);
    expect(store.claimWorkflow(TASK_ID, "worker-a", HOUR)).toBe(true);
  });

  it("lets another worker take over after the lease expires", () => {
    createDefault(store);
    expect(store.claimWorkflow(TASK_ID, "worker-a", HOUR)).toBe(true);

    clock.now += HOUR + 1;
    expect(store.claimWorkflow(TASK_ID, "worker-b", HOUR)).toBe(true);
    // And worker-a has lost it.
    expect(store.claimWorkflow(TASK_ID, "worker-a", HOUR)).toBe(false);
  });
});

describe("workflow material", () => {
  it("durably replaces the Action without changing the Task correlation key", () => {
    createDefault(store, ACTION_ID, TASK_ID);

    expect(() => store.replaceAction(TASK_ID, {
      fromState: "created",
      actionId: TASK_ID,
      actionIdempotencyKey: "invalid-action-attempt",
      actionEnvelopeHash: "invalid-hash",
      actionPackage: {},
      authorizationRequirements: {},
      expiresAt: EXPIRES_AT,
    })).toThrow(/must be distinct/i);

    store.saveCoordinationReference(TASK_ID, { stale: true });
    store.saveCompletedPackage(TASK_ID, { stale: true });
    const replacement = store.replaceAction(TASK_ID, {
      fromState: "created",
      actionId: OTHER_ID,
      actionIdempotencyKey: "replacement-action-attempt",
      actionEnvelopeHash: "replacement-hash",
      actionPackage: { fake: "replacement-action-package", actionId: OTHER_ID },
      authorizationRequirements: { type: "AuthorizationRequirements", actionEnvelopeHash: "replacement-hash" },
      expiresAt: "2031-01-01T00:00:00.000Z",
    });

    expect(replacement).toMatchObject({
      taskId: TASK_ID,
      actionId: OTHER_ID,
      actionIdempotencyKey: "replacement-action-attempt",
      state: "submittingToCoordination",
    });
    expect(replacement.coordinationRef).toBeUndefined();
    expect(replacement.completedPackage).toBeUndefined();
    expect(store.getWorkflowByActionId(ACTION_ID)?.taskId).toBe(TASK_ID);
    expect(store.getWorkflowByActionId(OTHER_ID)?.taskId).toBe(TASK_ID);

    store.close();
    store = openStore();
    expect(store.getWorkflow(TASK_ID)).toMatchObject({ taskId: TASK_ID, actionId: OTHER_ID });
    expect(store.getWorkflowByActionId(ACTION_ID)?.actionId).toBe(OTHER_ID);
  });

  it("persists the coordination reference, completed package, and adapter attempts", () => {
    createDefault(store);

    store.saveCoordinationReference(TASK_ID, { type: "ActionRef", actionId: { value: ACTION_ID } });
    store.saveCompletedPackage(TASK_ID, { fake: "completed-action-package" });
    store.saveAdapterAttempt(TASK_ID, { at: "2026-07-26T18:05:00.000Z", outcome: "networkError" });
    store.saveAdapterAttempt(TASK_ID, { at: "2026-07-26T18:06:00.000Z", outcome: "submitted" });

    const record = store.getWorkflow(TASK_ID);
    expect(record?.coordinationRef).toMatchObject({ type: "ActionRef" });
    expect(record?.completedPackage).toEqual({ fake: "completed-action-package" });
    expect(record?.adapterAttempts).toHaveLength(2);
    expect(record?.adapterAttempts[1]).toMatchObject({ outcome: "submitted" });
  });
});

describe("resolveWorkflow (terminal, immutable)", () => {
  it("stores a resolved outcome with the exact terminal material", () => {
    createDefault(store);
    store.resolveWorkflow(TASK_ID, {
      kind: "resolved",
      actionResponse: { result: "executed", executionResult: { content: [{ type: "text", text: "merged" }] } },
      executionReceipt: { fake: "receipt" },
    });

    const record = store.getWorkflow(TASK_ID);
    expect(record?.state).toBe("resolved");
    expect(record?.resolvedAt).toBe("2026-07-26T18:00:00.000Z");
    expect(record?.resolution).toMatchObject({
      kind: "resolved",
      actionResponse: { result: "executed" },
    });
  });

  it("stores an unresolvable outcome as a bridge error, never an Action outcome", () => {
    createDefault(store);
    store.resolveWorkflow(TASK_ID, {
      kind: "unresolvable",
      errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION",
      errorMessage: "The Action expired without a terminal Verifier response.",
    });

    const record = store.getWorkflow(TASK_ID);
    expect(record?.state).toBe("unresolvable");
    expect(record?.resolution).toMatchObject({ kind: "unresolvable", errorCode: "ACTION_EXPIRED_BEFORE_RESOLUTION" });
  });

  it("keeps the first resolution: a second resolve is ignored (stable result)", () => {
    createDefault(store);
    store.resolveWorkflow(TASK_ID, {
      kind: "resolved",
      actionResponse: { result: "executed" },
    });
    store.resolveWorkflow(TASK_ID, {
      kind: "resolved",
      actionResponse: { result: "failed" },
    });

    const record = store.getWorkflow(TASK_ID);
    expect(record?.resolution).toMatchObject({ actionResponse: { result: "executed" } });
  });
});

describe("cancelWorkflow (terminal, immutable)", () => {
  it("atomically cancels an active workflow and refuses later terminal writes", () => {
    createDefault(store);

    expect(store.cancelWorkflow(TASK_ID)).toBe(true);
    expect(store.cancelWorkflow(TASK_ID)).toBe(false);
    expect(store.claimWorkflow(TASK_ID, "worker-a", HOUR)).toBe(false);
    store.resolveWorkflow(TASK_ID, {
      kind: "resolved",
      actionResponse: { result: "executed" },
    });

    expect(store.getWorkflow(TASK_ID)).toMatchObject({
      state: "cancelled",
      resolution: { kind: "cancelled" },
    });
  });
});

describe("listRecoverableWorkflows (startup reconciliation)", () => {
  it("lists only non-terminal workflows", () => {
    createDefault(store);
    createDefault(store, OTHER_ID, OTHER_TASK_ID);
    store.compareAndSetState(OTHER_TASK_ID, "created", "awaitingApprovals");
    store.resolveWorkflow(TASK_ID, {
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
    store.compareAndSetState(TASK_ID, "created", "awaitingApprovals");
    store.saveCoordinationReference(TASK_ID, { type: "ActionRef" });
    store.close();

    store = openStore();
    const record = store.getWorkflow(TASK_ID);
    expect(record?.state).toBe("awaitingApprovals");
    expect(record?.coordinationRef).toEqual({ type: "ActionRef" });
    expect(store.listRecoverableWorkflows()).toHaveLength(1);
  });

  it("does not carry worker claims across a restart into fresh exclusivity conflicts", () => {
    createDefault(store);
    expect(store.claimWorkflow(TASK_ID, "worker-a", HOUR)).toBe(true);
    store.close();

    // Same wall-clock: the lease is still live and must still exclude others.
    store = openStore();
    expect(store.claimWorkflow(TASK_ID, "worker-b", HOUR)).toBe(false);
    clock.now += HOUR + 1;
    expect(store.claimWorkflow(TASK_ID, "worker-b", HOUR)).toBe(true);
  });

  it("refuses to open a legacy v1 store with active workflows unless overridden", () => {
    store.close();
    rmSync(dbPath, { force: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE workflows (
        action_id                  TEXT PRIMARY KEY,
        envelope_hash              TEXT NOT NULL,
        tool_name                  TEXT NOT NULL,
        state                      TEXT NOT NULL,
        action_package             TEXT NOT NULL,
        authorization_requirements TEXT,
        coordination_ref           TEXT,
        completed_package          TEXT,
        adapter_attempts           TEXT NOT NULL DEFAULT '[]',
        last_action_response       TEXT,
        expires_at                 TEXT NOT NULL,
        created_at                 TEXT NOT NULL,
        updated_at                 TEXT NOT NULL,
        claimed_by                 TEXT,
        claim_expires_ms           INTEGER,
        resolved_at                TEXT,
        resolution                 TEXT
      );
      PRAGMA user_version = 1;
    `);
    legacy.prepare(
      `INSERT INTO workflows (
         action_id, envelope_hash, tool_name, state, action_package,
         adapter_attempts, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'created', ?, '[]', ?, ?, ?)`,
    ).run(
      ACTION_ID,
      HASH,
      "merge_pull_request_mirror",
      JSON.stringify({ fake: "legacy-action-package", actionId: ACTION_ID }),
      EXPIRES_AT,
      "2026-07-26T18:00:00.000Z",
      "2026-07-26T18:00:00.000Z",
    );
    legacy.close();

    expect(() => openStore()).toThrow(/MPAS_ALLOW_LEGACY_WORKFLOW_RESET/);
    // The error message includes the action ID being discarded.
    expect(() => openStore()).toThrow(ACTION_ID);
    store = { close() {} } as SqliteWorkflowStore;
  });

  it("discards legacy v1 workflow rows when MPAS_ALLOW_LEGACY_WORKFLOW_RESET is set", () => {
    store.close();
    rmSync(dbPath, { force: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE workflows (
        action_id                  TEXT PRIMARY KEY,
        envelope_hash              TEXT NOT NULL,
        tool_name                  TEXT NOT NULL,
        state                      TEXT NOT NULL,
        action_package             TEXT NOT NULL,
        authorization_requirements TEXT,
        coordination_ref           TEXT,
        completed_package          TEXT,
        adapter_attempts           TEXT NOT NULL DEFAULT '[]',
        last_action_response       TEXT,
        expires_at                 TEXT NOT NULL,
        created_at                 TEXT NOT NULL,
        updated_at                 TEXT NOT NULL,
        claimed_by                 TEXT,
        claim_expires_ms           INTEGER,
        resolved_at                TEXT,
        resolution                 TEXT
      );
      PRAGMA user_version = 1;
    `);
    legacy.prepare(
      `INSERT INTO workflows (
         action_id, envelope_hash, tool_name, state, action_package,
         adapter_attempts, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'created', ?, '[]', ?, ?, ?)`,
    ).run(
      ACTION_ID,
      HASH,
      "merge_pull_request_mirror",
      JSON.stringify({ fake: "legacy-action-package", actionId: ACTION_ID }),
      EXPIRES_AT,
      "2026-07-26T18:00:00.000Z",
      "2026-07-26T18:00:00.000Z",
    );
    legacy.close();

    process.env.MPAS_ALLOW_LEGACY_WORKFLOW_RESET = "1";
    try {
      store = openStore();
      expect(store.getWorkflow(ACTION_ID)).toBeUndefined();
      expect(store.listRecoverableWorkflows()).toHaveLength(0);

      store.close();
      const upgraded = new DatabaseSync(dbPath);
      const { user_version } = upgraded.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(user_version).toBe(3);
      upgraded.close();
      store = openStore();
    } finally {
      delete process.env.MPAS_ALLOW_LEGACY_WORKFLOW_RESET;
    }
  });

  it("silently migrates a legacy v1 store with only terminal workflows", () => {
    store.close();
    rmSync(dbPath, { force: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE workflows (
        action_id TEXT PRIMARY KEY, envelope_hash TEXT NOT NULL,
        tool_name TEXT NOT NULL, state TEXT NOT NULL,
        action_package TEXT NOT NULL, adapter_attempts TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        resolved_at TEXT, resolution TEXT
      );
      PRAGMA user_version = 1;
    `);
    legacy.prepare(
      `INSERT INTO workflows (action_id, envelope_hash, tool_name, state, action_package,
       adapter_attempts, expires_at, created_at, updated_at, resolved_at, resolution)
       VALUES (?, ?, ?, 'resolved', '{}', '[]', ?, ?, ?, ?, ?)`,
    ).run(
      ACTION_ID, HASH, "some_tool", EXPIRES_AT,
      "2026-07-26T18:00:00.000Z", "2026-07-26T18:00:00.000Z",
      "2026-07-26T18:01:00.000Z", JSON.stringify({ kind: "resolved", actionResponse: { result: "executed" } }),
    );
    legacy.close();

    // No active workflows → migrates silently without the env var.
    store = openStore();
    expect(store.getWorkflow(ACTION_ID)).toBeUndefined();
    expect(store.listRecoverableWorkflows()).toHaveLength(0);
  });

  it("discards legacy v2 workflow rows including aliases when overridden", () => {
    store.close();
    rmSync(dbPath, { force: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE workflows (
        action_id                  TEXT PRIMARY KEY,
        current_action_id          TEXT NOT NULL,
        envelope_hash              TEXT NOT NULL,
        tool_name                  TEXT NOT NULL,
        state                      TEXT NOT NULL,
        action_package             TEXT NOT NULL,
        adapter_attempts           TEXT NOT NULL DEFAULT '[]',
        expires_at                 TEXT NOT NULL,
        created_at                 TEXT NOT NULL,
        updated_at                 TEXT NOT NULL
      );
      CREATE TABLE workflow_action_aliases (
        action_id TEXT PRIMARY KEY,
        task_id   TEXT NOT NULL REFERENCES workflows(action_id)
      );
      PRAGMA user_version = 2;
    `);
    legacy.prepare(
      `INSERT INTO workflows (
         action_id, current_action_id, envelope_hash, tool_name, state,
         action_package, adapter_attempts, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'awaitingApprovals', ?, '[]', ?, ?, ?)`,
    ).run(
      ACTION_ID,
      OTHER_ID,
      HASH,
      "merge_pull_request_mirror",
      JSON.stringify({ fake: "legacy-v2-package" }),
      EXPIRES_AT,
      "2026-07-26T18:00:00.000Z",
      "2026-07-26T18:00:00.000Z",
    );
    legacy.prepare("INSERT INTO workflow_action_aliases (action_id, task_id) VALUES (?, ?)").run(OTHER_ID, ACTION_ID);
    legacy.close();

    process.env.MPAS_ALLOW_LEGACY_WORKFLOW_RESET = "1";
    try {
      store = openStore();
      expect(store.getWorkflow(ACTION_ID)).toBeUndefined();
      expect(store.getWorkflowByActionId(OTHER_ID)).toBeUndefined();
      expect(store.listRecoverableWorkflows()).toHaveLength(0);
    } finally {
      delete process.env.MPAS_ALLOW_LEGACY_WORKFLOW_RESET;
    }
  });

  it("creates a workflow with distinct taskId and actionId after a legacy upgrade", () => {
    store.close();
    rmSync(dbPath, { force: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE workflows (
        action_id TEXT PRIMARY KEY, envelope_hash TEXT NOT NULL,
        tool_name TEXT NOT NULL, state TEXT NOT NULL,
        action_package TEXT NOT NULL, adapter_attempts TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    legacy.prepare(
      `INSERT INTO workflows (action_id, envelope_hash, tool_name, state, action_package,
       adapter_attempts, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'created', '{}', '[]', ?, ?, ?)`,
    ).run("legacy-action", HASH, "some_tool", EXPIRES_AT, "2026-07-26T18:00:00.000Z", "2026-07-26T18:00:00.000Z");
    legacy.close();

    process.env.MPAS_ALLOW_LEGACY_WORKFLOW_RESET = "1";
    try {
      store = openStore();
      const record = createDefault(store);
      expect(record.taskId).toBe(TASK_ID);
      expect(record.actionId).toBe(ACTION_ID);
      expect(record.taskId).not.toBe(record.actionId);
      expect(store.getWorkflowByActionId(ACTION_ID)?.taskId).toBe(TASK_ID);
    } finally {
      delete process.env.MPAS_ALLOW_LEGACY_WORKFLOW_RESET;
    }
  });

  it("enforces Action-ID uniqueness and alias behavior after a legacy reset", () => {
    store.close();
    rmSync(dbPath, { force: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE workflows (
        action_id TEXT PRIMARY KEY, envelope_hash TEXT NOT NULL,
        tool_name TEXT NOT NULL, state TEXT NOT NULL,
        action_package TEXT NOT NULL, adapter_attempts TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    store = openStore();
    createDefault(store);
    // Replace A1 with A2; both Action IDs should be aliased to the same Task.
    store.replaceAction(TASK_ID, {
      fromState: "created",
      actionId: OTHER_ID,
      actionIdempotencyKey: "replacement-key",
      actionEnvelopeHash: "replacement-hash",
      actionPackage: { fake: "replacement-package" },
      authorizationRequirements: { type: "AuthorizationRequirements" },
      expiresAt: EXPIRES_AT,
    });
    expect(store.getWorkflowByActionId(ACTION_ID)?.taskId).toBe(TASK_ID);
    expect(store.getWorkflowByActionId(OTHER_ID)?.taskId).toBe(TASK_ID);

    // Second workflow must not reuse Action IDs.
    expect(() => store.createWorkflow({
      taskId: OTHER_TASK_ID,
      actionId: OTHER_ID,
      actionIdempotencyKey: "dup-key",
      actionEnvelopeHash: HASH,
      toolName: "merge_pull_request_mirror",
      actionPackage: {},
      expiresAt: EXPIRES_AT,
    })).toThrow(/exists/i);
  });

  it("fails safely on an incompatible schema version", async () => {
    store.close();
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
    store.resolveWorkflow(TASK_ID, {
      kind: "resolved",
      actionResponse: { result: "executed" },
    });

    clock.now += 2 * DAY;
    expect(store.purgeExpiredResults(DAY)).toBe(0);
    expect(store.getWorkflow(TASK_ID)).toBeDefined();

    // Past envelope expiry AND past resolvedAt + retention: purged.
    clock.now = Date.parse(EXPIRES_AT) + 1;
    expect(store.purgeExpiredResults(DAY)).toBe(1);
    expect(store.getWorkflow(TASK_ID)).toBeUndefined();
  });

  it("holds a freshly resolved record for the retention window even after envelope expiry", () => {
    createDefault(store);
    // Resolve just before envelope expiry.
    clock.now = Date.parse(EXPIRES_AT) - 1000;
    store.resolveWorkflow(TASK_ID, {
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
    store.compareAndSetState(TASK_ID, "created", "awaitingApprovals");

    // Long past everything: active records are reconciliation's job, not purging's.
    clock.now = Date.parse(EXPIRES_AT) + 10 * DAY;
    expect(store.purgeExpiredResults(DAY)).toBe(0);
    expect(store.getWorkflow(TASK_ID)).toBeDefined();
  });
});
