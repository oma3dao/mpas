/**
 * Durable proposer-bridge workflow store contract.
 *
 * Bridge workflow state is a local, non-authoritative view (feature spec §8).
 * The authoritative Action outcome is always the Verifier's ActionResponse;
 * a store only records what the bridge has observed and what it must do next.
 *
 * The SDK defines the contract and a dependency-free in-memory reference.
 * Durable implementations (for example the SQLite reference store in the
 * repository's demo) live outside the SDK: the normative client profile does
 * not require any particular persistence mechanism, and the protocol package
 * carries no database dependency.
 */

export type BridgeWorkflowState =
  | "created"
  | "awaitingApprovals"
  | "readyForResubmission"
  | "submittingToVerifier"
  | "awaitingVerifierResult"
  | "resolved"
  | "unresolvable";

export const TERMINAL_WORKFLOW_STATES: ReadonlySet<BridgeWorkflowState> = new Set(["resolved", "unresolvable"]);

export type WorkflowResolution =
  | { kind: "resolved"; actionResponse: unknown; executionReceipt?: unknown }
  | { kind: "unresolvable"; errorCode: string; errorMessage: string };

export interface CreateWorkflowInput {
  actionId: string;
  actionEnvelopeHash: string;
  toolName: string;
  /** Initial Action Package (or Execution Payload) as submitted. */
  actionPackage: unknown;
  /** Action Envelope expiration (ISO 8601). */
  expiresAt: string;
}

export interface WorkflowRecord {
  actionId: string;
  actionEnvelopeHash: string;
  toolName: string;
  state: BridgeWorkflowState;
  actionPackage: unknown;
  authorizationRequirements?: unknown;
  coordinationRef?: unknown;
  completedPackage?: unknown;
  adapterAttempts: unknown[];
  /**
   * Exact last nonterminal Verifier ActionResponse (client profile §5.1).
   * Absent until the first Verifier response arrives. Preserved verbatim —
   * the bridge never edits or synthesizes it.
   */
  lastActionResponse?: unknown;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  resolvedAt?: string;
  resolution?: WorkflowResolution;
}

/**
 * Store contract (implementation plan §5.2). Implementations MUST provide
 * atomic state transitions, exclusive worker claims, immutable first-wins
 * terminal resolutions, and retention-driven purging. Durable implementations
 * MUST additionally survive process restarts.
 */
export interface WorkflowStore {
  createWorkflow(input: CreateWorkflowInput): WorkflowRecord;
  getWorkflow(actionId: string): WorkflowRecord | undefined;

  /**
   * Atomic state transition. Succeeds only when `from` is the current state.
   * Terminal states are set exclusively by {@link resolveWorkflow} and are
   * never left.
   */
  compareAndSetState(actionId: string, from: BridgeWorkflowState, to: BridgeWorkflowState): boolean;

  /**
   * Exclusive worker claim with a lease. Grants when the workflow is
   * unclaimed, the previous lease expired, or the same worker renews; refuses
   * while another worker holds a live lease. The check-and-write MUST be
   * atomic so two workers can never both acquire a claim.
   */
  claimWorkflow(actionId: string, workerId: string, leaseMs: number): boolean;

  saveCoordinationReference(actionId: string, ref: unknown): void;
  saveCompletedPackage(actionId: string, completedPackage: unknown): void;
  saveAuthorizationRequirements(actionId: string, requirements: unknown): void;
  /** Preserve the exact last nonterminal Verifier ActionResponse verbatim. */
  saveLastActionResponse(actionId: string, response: unknown): void;
  saveAdapterAttempt(actionId: string, attempt: unknown): void;

  /**
   * Terminal, immutable resolution. The first resolution wins; later calls
   * are ignored so repeated result retrievals observe the same stored outcome
   * (client profile §7.3).
   */
  resolveWorkflow(actionId: string, resolution: WorkflowResolution): void;

  /** Non-terminal workflows, for startup reconciliation (feature spec §9.4). */
  listRecoverableWorkflows(): WorkflowRecord[];

  /**
   * Retention purge (feature spec §9.6): terminal records are removed only
   * after max(envelope expiry, resolvedAt + retention); active records are
   * never purged. Returns the number of purged records.
   */
  purgeExpiredResults(retentionMs?: number): number;

  close(): void;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

interface MemoryEntry {
  record: WorkflowRecord;
  claimExpiresMs?: number;
}

/**
 * In-memory reference implementation of the {@link WorkflowStore} contract.
 * Suitable for tests and ephemeral deployments; provides every contract
 * guarantee except durability across process restarts.
 */
export class MemoryWorkflowStore implements WorkflowStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  close(): void {
    // Nothing to release.
  }

  createWorkflow(input: CreateWorkflowInput): WorkflowRecord {
    if (this.entries.has(input.actionId)) {
      throw new Error(`Workflow already exists for action ${input.actionId}.`);
    }
    const at = this.timestamp();
    const record: WorkflowRecord = {
      actionId: input.actionId,
      actionEnvelopeHash: input.actionEnvelopeHash,
      toolName: input.toolName,
      state: "created",
      actionPackage: clone(input.actionPackage),
      adapterAttempts: [],
      expiresAt: input.expiresAt,
      createdAt: at,
      updatedAt: at,
    };
    this.entries.set(input.actionId, { record });
    return clone(record);
  }

  getWorkflow(actionId: string): WorkflowRecord | undefined {
    const entry = this.entries.get(actionId);
    return entry ? clone(entry.record) : undefined;
  }

  compareAndSetState(actionId: string, from: BridgeWorkflowState, to: BridgeWorkflowState): boolean {
    if (TERMINAL_WORKFLOW_STATES.has(from) || TERMINAL_WORKFLOW_STATES.has(to)) {
      return false;
    }
    const entry = this.entries.get(actionId);
    if (!entry || entry.record.state !== from) {
      return false;
    }
    entry.record.state = to;
    entry.record.updatedAt = this.timestamp();
    return true;
  }

  claimWorkflow(actionId: string, workerId: string, leaseMs: number): boolean {
    const entry = this.entries.get(actionId);
    if (!entry) {
      return false;
    }
    const nowMs = this.now();
    const { record } = entry;
    const held = record.claimedBy !== undefined && record.claimedBy !== workerId && (entry.claimExpiresMs ?? 0) > nowMs;
    if (held) {
      return false;
    }
    record.claimedBy = workerId;
    entry.claimExpiresMs = nowMs + leaseMs;
    record.claimExpiresAt = new Date(nowMs + leaseMs).toISOString();
    record.updatedAt = this.timestamp();
    return true;
  }

  saveCoordinationReference(actionId: string, ref: unknown): void {
    this.mutate(actionId, (record) => {
      record.coordinationRef = clone(ref);
    });
  }

  saveCompletedPackage(actionId: string, completedPackage: unknown): void {
    this.mutate(actionId, (record) => {
      record.completedPackage = clone(completedPackage);
    });
  }

  saveAuthorizationRequirements(actionId: string, requirements: unknown): void {
    this.mutate(actionId, (record) => {
      record.authorizationRequirements = clone(requirements);
    });
  }

  saveLastActionResponse(actionId: string, response: unknown): void {
    this.mutate(actionId, (record) => {
      record.lastActionResponse = clone(response);
    });
  }

  saveAdapterAttempt(actionId: string, attempt: unknown): void {
    this.mutate(actionId, (record) => {
      record.adapterAttempts.push(clone(attempt));
    });
  }

  resolveWorkflow(actionId: string, resolution: WorkflowResolution): void {
    const entry = this.entries.get(actionId);
    if (!entry || TERMINAL_WORKFLOW_STATES.has(entry.record.state)) {
      return;
    }
    const at = this.timestamp();
    entry.record.state = resolution.kind === "resolved" ? "resolved" : "unresolvable";
    entry.record.resolution = clone(resolution);
    entry.record.resolvedAt = at;
    entry.record.updatedAt = at;
  }

  listRecoverableWorkflows(): WorkflowRecord[] {
    return [...this.entries.values()]
      .filter((entry) => !TERMINAL_WORKFLOW_STATES.has(entry.record.state))
      .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
      .map((entry) => clone(entry.record));
  }

  purgeExpiredResults(retentionMs: number = DEFAULT_RETENTION_MS): number {
    const nowMs = this.now();
    let purged = 0;
    for (const [actionId, entry] of this.entries) {
      const { record } = entry;
      if (!TERMINAL_WORKFLOW_STATES.has(record.state) || record.resolvedAt === undefined) {
        continue;
      }
      const keepUntil = Math.max(Date.parse(record.expiresAt), Date.parse(record.resolvedAt) + retentionMs);
      if (nowMs > keepUntil) {
        this.entries.delete(actionId);
        purged += 1;
      }
    }
    return purged;
  }

  private mutate(actionId: string, apply: (record: WorkflowRecord) => void): void {
    const entry = this.entries.get(actionId);
    if (!entry) {
      return;
    }
    apply(entry.record);
    entry.record.updatedAt = this.timestamp();
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
