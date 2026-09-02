import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BridgeWorkflowState,
  CreateWorkflowInput,
  ReplaceWorkflowActionInput,
  WorkflowRecord,
  WorkflowResolution,
  WorkflowStore,
} from "@oma3/mpas";

/**
 * SQLite reference implementation of the SDK's WorkflowStore contract
 * (implementation plan §5.3). This is OMA3's durable store for the GitHub
 * bridge deployment; it lives in the repository rather than the SDK because
 * the MCP Tasks integration does not require any particular persistence mechanism.
 *
 * - one configured database path per bridge deployment;
 * - transactional workflow transitions (single-statement check-and-write);
 * - WAL mode so a persistent worker can share the file with a thin frontend;
 * - schema versioning with fail-safe open;
 * - no credentials or adapter secrets stored.
 */

const SCHEMA_VERSION = 3;

const TERMINAL_STATES: ReadonlySet<BridgeWorkflowState> = new Set(["resolved", "unresolvable", "cancelled"]);

export class SqliteWorkflowStore implements WorkflowStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createWorkflow(input: CreateWorkflowInput): WorkflowRecord {
    if (input.taskId === input.actionId) {
      throw new Error("Task ID and Action ID must be distinct.");
    }
    const at = this.timestamp();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .prepare(
          `INSERT INTO workflows (
             action_id, current_action_id, action_idempotency_key, envelope_hash, tool_name, state, action_package,
             adapter_attempts, expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'created', ?, '[]', ?, ?, ?)`,
        )
        .run(
          input.taskId,
          input.actionId,
          input.actionIdempotencyKey,
          input.actionEnvelopeHash,
          input.toolName,
          toJson(input.actionPackage),
          input.expiresAt,
          at,
          at,
        );
      this.db
        .prepare("INSERT INTO workflow_action_aliases (action_id, task_id) VALUES (?, ?)")
        .run(input.actionId, input.taskId);
      this.db.exec("COMMIT");
    } catch (error) {
      rollback(this.db);
      if (isUniqueViolation(error)) {
        throw new Error(`Workflow already exists for task ${input.taskId} or action ${input.actionId}.`);
      }
      throw error;
    }
    return this.mustGet(input.taskId);
  }

  getWorkflow(taskId: string): WorkflowRecord | undefined {
    const row = this.db.prepare("SELECT * FROM workflows WHERE action_id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getWorkflowByActionId(actionId: string): WorkflowRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT workflows.*
           FROM workflow_action_aliases
           JOIN workflows ON workflows.action_id = workflow_action_aliases.task_id
          WHERE workflow_action_aliases.action_id = ?`,
      )
      .get(actionId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  replaceAction(taskId: string, input: ReplaceWorkflowActionInput): WorkflowRecord {
    if (taskId === input.actionId) {
      throw new Error("Task ID and Action ID must be distinct.");
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .prepare("INSERT INTO workflow_action_aliases (action_id, task_id) VALUES (?, ?)")
        .run(input.actionId, taskId);
      const result = this.db
        .prepare(
          `UPDATE workflows
              SET current_action_id = ?, action_idempotency_key = ?, envelope_hash = ?, action_package = ?,
                  authorization_requirements = ?, coordination_ref = NULL,
                  completed_package = NULL, expires_at = ?,
                  state = 'submittingToCoordination', updated_at = ?
            WHERE action_id = ? AND state = ?`,
        )
        .run(
          input.actionId,
          input.actionIdempotencyKey,
          input.actionEnvelopeHash,
          toJson(input.actionPackage),
          toJson(input.authorizationRequirements),
          input.expiresAt,
          this.timestamp(),
          taskId,
          input.fromState,
        );
      if (result.changes !== 1) {
        throw new Error(`Workflow ${taskId} is not in replacement state ${input.fromState}.`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      rollback(this.db);
      throw error;
    }
    return this.mustGet(taskId);
  }

  compareAndSetState(taskId: string, from: BridgeWorkflowState, to: BridgeWorkflowState): boolean {
    if (TERMINAL_STATES.has(from) || TERMINAL_STATES.has(to)) {
      return false;
    }
    const result = this.db
      .prepare("UPDATE workflows SET state = ?, updated_at = ? WHERE action_id = ? AND state = ?")
      .run(to, this.timestamp(), taskId, from);
    return result.changes === 1;
  }

  claimWorkflow(taskId: string, workerId: string, leaseMs: number): boolean {
    const nowMs = this.now();
    const result = this.db
      .prepare(
        `UPDATE workflows
           SET claimed_by = ?, claim_expires_ms = ?, updated_at = ?
         WHERE action_id = ?
           AND state NOT IN ('resolved', 'unresolvable', 'cancelled')
           AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_ms <= ?)`,
      )
      .run(workerId, nowMs + leaseMs, this.timestamp(), taskId, workerId, nowMs);
    return result.changes === 1;
  }

  saveCoordinationReference(taskId: string, ref: unknown): void {
    this.setColumn(taskId, "coordination_ref", toJson(ref));
  }

  saveCompletedPackage(taskId: string, completedPackage: unknown): void {
    this.setColumn(taskId, "completed_package", toJson(completedPackage));
  }

  saveAuthorizationRequirements(taskId: string, requirements: unknown): void {
    this.setColumn(taskId, "authorization_requirements", toJson(requirements));
  }

  saveLastActionResponse(taskId: string, response: unknown): void {
    this.setColumn(taskId, "last_action_response", toJson(response));
  }

  saveAdapterAttempt(taskId: string, attempt: unknown): void {
    this.db
      .prepare(
        `UPDATE workflows
           SET adapter_attempts = json_insert(adapter_attempts, '$[#]', json(?)), updated_at = ?
         WHERE action_id = ?`,
      )
      .run(toJson(attempt), this.timestamp(), taskId);
  }

  resolveWorkflow(taskId: string, resolution: WorkflowResolution): void {
    const state: BridgeWorkflowState = resolution.kind;
    const at = this.timestamp();
    this.db
      .prepare(
        `UPDATE workflows
           SET state = ?, resolution = ?, resolved_at = ?, updated_at = ?
         WHERE action_id = ?
           AND state NOT IN ('resolved', 'unresolvable', 'cancelled')`,
      )
      .run(state, toJson(resolution), at, at, taskId);
  }

  cancelWorkflow(taskId: string): boolean {
    const at = this.timestamp();
    const resolution: WorkflowResolution = { kind: "cancelled", cancelledAt: at };
    const result = this.db
      .prepare(
        `UPDATE workflows
           SET state = 'cancelled', resolution = ?, resolved_at = ?, updated_at = ?
         WHERE action_id = ?
           AND state NOT IN ('resolved', 'unresolvable', 'cancelled')`,
      )
      .run(toJson(resolution), at, at, taskId);
    return result.changes === 1;
  }

  listRecoverableWorkflows(): WorkflowRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM workflows WHERE state NOT IN ('resolved', 'unresolvable', 'cancelled') ORDER BY created_at")
      .all() as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  purgeExpiredResults(retentionMs: number = 24 * 60 * 60 * 1000): number {
    const rows = this.db
      .prepare("SELECT action_id AS task_id, expires_at, resolved_at FROM workflows WHERE state IN ('resolved', 'unresolvable', 'cancelled')")
      .all() as { task_id: string; expires_at: string; resolved_at: string }[];

    const nowMs = this.now();
    let purged = 0;
    for (const row of rows) {
      const keepUntil = Math.max(Date.parse(row.expires_at), Date.parse(row.resolved_at) + retentionMs);
      if (nowMs > keepUntil) {
        this.db.prepare("DELETE FROM workflow_action_aliases WHERE task_id = ?").run(row.task_id);
        purged += this.db.prepare("DELETE FROM workflows WHERE action_id = ?").run(row.task_id).changes as number;
      }
    }
    return purged;
  }

  private setColumn(
    taskId: string,
    column: "coordination_ref" | "completed_package" | "authorization_requirements" | "last_action_response",
    json: string,
  ): void {
    this.db
      .prepare(`UPDATE workflows SET ${column} = ?, updated_at = ? WHERE action_id = ?`)
      .run(json, this.timestamp(), taskId);
  }

  private mustGet(taskId: string): WorkflowRecord {
    const record = this.getWorkflow(taskId);
    if (!record) {
      throw new Error(`Workflow not found for task ${taskId}.`);
    }
    return record;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private migrate(): void {
    let { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `Workflow store schema version ${version} is newer than supported version ${SCHEMA_VERSION}; refusing to open.`,
      );
    }
    if (version === SCHEMA_VERSION) {
      return;
    }

    // Legacy schemas (v1, v2) used action_id as both Task ID and Action ID.
    // That conflicts with the current model where Task IDs are stable and
    // distinct from Action IDs. These are bridge-local workflow/cache
    // records, not the Coordination Service database, and there are no
    // outstanding legacy workflows — all old Actions have expired.
    //
    // Discard legacy workflow rows and initialize the current schema cleanly
    // rather than inventing synthetic Task IDs for expired workflows.
    if (version >= 1 && version < SCHEMA_VERSION) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS workflow_action_aliases;
        DROP TABLE IF EXISTS workflows;
        COMMIT;
      `);
      version = 0;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        action_id                  TEXT PRIMARY KEY,
        current_action_id          TEXT NOT NULL,
        action_idempotency_key     TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_workflows_state ON workflows (state);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_current_action_id
        ON workflows (current_action_id);
      CREATE TABLE IF NOT EXISTS workflow_action_aliases (
        action_id TEXT PRIMARY KEY,
        task_id   TEXT NOT NULL REFERENCES workflows(action_id)
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_action_aliases_task ON workflow_action_aliases (task_id);
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  return JSON.parse(String(value));
}

function rowToRecord(row: Record<string, unknown>): WorkflowRecord {
  const record: WorkflowRecord = {
    taskId: String(row.action_id),
    actionId: String(row.current_action_id),
    actionIdempotencyKey: String(row.action_idempotency_key),
    actionEnvelopeHash: String(row.envelope_hash),
    toolName: String(row.tool_name),
    state: String(row.state) as BridgeWorkflowState,
    actionPackage: fromJson(row.action_package),
    adapterAttempts: (fromJson(row.adapter_attempts) as unknown[]) ?? [],
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };

  const authorizationRequirements = fromJson(row.authorization_requirements);
  if (authorizationRequirements !== undefined) record.authorizationRequirements = authorizationRequirements;
  const coordinationRef = fromJson(row.coordination_ref);
  if (coordinationRef !== undefined) record.coordinationRef = coordinationRef;
  const completedPackage = fromJson(row.completed_package);
  if (completedPackage !== undefined) record.completedPackage = completedPackage;
  const lastActionResponse = fromJson(row.last_action_response);
  if (lastActionResponse !== undefined) record.lastActionResponse = lastActionResponse;
  if (row.claimed_by != null) record.claimedBy = String(row.claimed_by);
  if (row.claim_expires_ms != null) record.claimExpiresAt = new Date(Number(row.claim_expires_ms)).toISOString();
  if (row.resolved_at != null) record.resolvedAt = String(row.resolved_at);
  const resolution = fromJson(row.resolution);
  if (resolution !== undefined) record.resolution = resolution as WorkflowResolution;

  return record;
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No active transaction.
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
