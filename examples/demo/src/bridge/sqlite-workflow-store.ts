import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BridgeWorkflowState,
  CreateWorkflowInput,
  WorkflowRecord,
  WorkflowResolution,
  WorkflowStore,
} from "@oma3/mpas";

/**
 * SQLite reference implementation of the SDK's WorkflowStore contract
 * (implementation plan §5.3). This is OMA3's durable store for the GitHub
 * bridge deployment; it lives in the repository rather than the SDK because
 * the client profile does not require any particular persistence mechanism.
 *
 * - one configured database path per bridge deployment;
 * - transactional workflow transitions (single-statement check-and-write);
 * - WAL mode so a persistent worker can share the file with a thin frontend;
 * - schema versioning with fail-safe open;
 * - no credentials or adapter secrets stored.
 */

const SCHEMA_VERSION = 1;

const TERMINAL_STATES: ReadonlySet<BridgeWorkflowState> = new Set(["resolved", "unresolvable"]);

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
    const at = this.timestamp();
    try {
      this.db
        .prepare(
          `INSERT INTO workflows (
             action_id, envelope_hash, tool_name, state, action_package,
             adapter_attempts, expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'created', ?, '[]', ?, ?, ?)`,
        )
        .run(input.actionId, input.actionEnvelopeHash, input.toolName, toJson(input.actionPackage), input.expiresAt, at, at);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`Workflow already exists for action ${input.actionId}.`);
      }
      throw error;
    }
    return this.mustGet(input.actionId);
  }

  getWorkflow(actionId: string): WorkflowRecord | undefined {
    const row = this.db.prepare("SELECT * FROM workflows WHERE action_id = ?").get(actionId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  compareAndSetState(actionId: string, from: BridgeWorkflowState, to: BridgeWorkflowState): boolean {
    if (TERMINAL_STATES.has(from) || TERMINAL_STATES.has(to)) {
      return false;
    }
    const result = this.db
      .prepare("UPDATE workflows SET state = ?, updated_at = ? WHERE action_id = ? AND state = ?")
      .run(to, this.timestamp(), actionId, from);
    return result.changes === 1;
  }

  claimWorkflow(actionId: string, workerId: string, leaseMs: number): boolean {
    const nowMs = this.now();
    const result = this.db
      .prepare(
        `UPDATE workflows
           SET claimed_by = ?, claim_expires_ms = ?, updated_at = ?
         WHERE action_id = ?
           AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_ms <= ?)`,
      )
      .run(workerId, nowMs + leaseMs, this.timestamp(), actionId, workerId, nowMs);
    return result.changes === 1;
  }

  saveCoordinationReference(actionId: string, ref: unknown): void {
    this.setColumn(actionId, "coordination_ref", toJson(ref));
  }

  saveCompletedPackage(actionId: string, completedPackage: unknown): void {
    this.setColumn(actionId, "completed_package", toJson(completedPackage));
  }

  saveAuthorizationRequirements(actionId: string, requirements: unknown): void {
    this.setColumn(actionId, "authorization_requirements", toJson(requirements));
  }

  saveLastActionResponse(actionId: string, response: unknown): void {
    this.setColumn(actionId, "last_action_response", toJson(response));
  }

  saveAdapterAttempt(actionId: string, attempt: unknown): void {
    this.db
      .prepare(
        `UPDATE workflows
           SET adapter_attempts = json_insert(adapter_attempts, '$[#]', json(?)), updated_at = ?
         WHERE action_id = ?`,
      )
      .run(toJson(attempt), this.timestamp(), actionId);
  }

  resolveWorkflow(actionId: string, resolution: WorkflowResolution): void {
    const state: BridgeWorkflowState = resolution.kind === "resolved" ? "resolved" : "unresolvable";
    const at = this.timestamp();
    this.db
      .prepare(
        `UPDATE workflows
           SET state = ?, resolution = ?, resolved_at = ?, updated_at = ?
         WHERE action_id = ?
           AND state NOT IN ('resolved', 'unresolvable')`,
      )
      .run(state, toJson(resolution), at, at, actionId);
  }

  listRecoverableWorkflows(): WorkflowRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM workflows WHERE state NOT IN ('resolved', 'unresolvable') ORDER BY created_at")
      .all() as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  purgeExpiredResults(retentionMs: number = 24 * 60 * 60 * 1000): number {
    const rows = this.db
      .prepare("SELECT action_id, expires_at, resolved_at FROM workflows WHERE state IN ('resolved', 'unresolvable')")
      .all() as { action_id: string; expires_at: string; resolved_at: string }[];

    const nowMs = this.now();
    let purged = 0;
    for (const row of rows) {
      const keepUntil = Math.max(Date.parse(row.expires_at), Date.parse(row.resolved_at) + retentionMs);
      if (nowMs > keepUntil) {
        purged += this.db.prepare("DELETE FROM workflows WHERE action_id = ?").run(row.action_id).changes as number;
      }
    }
    return purged;
  }

  private setColumn(
    actionId: string,
    column: "coordination_ref" | "completed_package" | "authorization_requirements" | "last_action_response",
    json: string,
  ): void {
    this.db
      .prepare(`UPDATE workflows SET ${column} = ?, updated_at = ? WHERE action_id = ?`)
      .run(json, this.timestamp(), actionId);
  }

  private mustGet(actionId: string): WorkflowRecord {
    const record = this.getWorkflow(actionId);
    if (!record) {
      throw new Error(`Workflow not found for action ${actionId}.`);
    }
    return record;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `Workflow store schema version ${version} is newer than supported version ${SCHEMA_VERSION}; refusing to open.`,
      );
    }
    if (version === SCHEMA_VERSION) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
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
      CREATE INDEX IF NOT EXISTS idx_workflows_state ON workflows (state);
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
    actionId: String(row.action_id),
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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
