import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionId } from "../core/types.js";

/**
 * Dispatch Ledger (MPAS Core Action Lifecycle).
 *
 * The Verifier is stateless with respect to verification: rejections and
 * additionalApprovalsRequired are deterministic responses, never recorded state.
 * The ledger is the Verifier's ONLY protocol state, with one invariant:
 *
 *   an actionId is dispatched AT MOST ONCE.
 *
 * A ledger entry is written only at the moment an action is authorized for
 * dispatch — immediately before transmission (write-ahead). Entries are
 * immutable: the sole permitted transition is `executing -> resolved`.
 */

/** Receipt results producible by a dispatch (the only resolutions the ledger records). */
export type DispatchResolution = "executed" | "failed" | "indeterminate";

export type LedgerEvent =
  | {
      event: "executing";
      actionId: string;
      envelopeHash: string;
      expiresAt: string;
      at: string;
    }
  | {
      event: "resolved";
      actionId: string;
      resolution: DispatchResolution;
      at: string;
    };

export type LedgerCheck =
  | { kind: "absent" }
  | { kind: "pending" }
  | { kind: "reject"; code: "ACTION_ID_HASH_MISMATCH" | "REPLAY_DETECTED"; message: string };

interface LedgerEntry {
  envelopeHash: string;
  status: "executing" | "resolved";
  resolution?: DispatchResolution;
  expiresAt: string;
}

/**
 * Append-only event sink backing the ledger. `executing` events MUST be durably
 * flushed before this method returns (write-ahead); `resolved` events are appended.
 */
export interface DispatchJournal {
  append(event: LedgerEvent): void;
  readAll(): LedgerEvent[];
}

/** Append-only JSONL journal. `executing` events are fsync'd before returning. */
export class FileDispatchJournal implements DispatchJournal {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(event: LedgerEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, line);
      // Write-ahead durability: the executing record MUST survive a crash before
      // transmission. Flushing resolved events too keeps recovery deterministic.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  readAll(): LedgerEvent[] {
    if (!existsSync(this.path)) {
      return [];
    }

    const contents = readFileSync(this.path, "utf8");
    const events: LedgerEvent[] = [];
    for (const line of contents.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      events.push(JSON.parse(line) as LedgerEvent);
    }
    return events;
  }
}

/** In-memory journal for tests and ephemeral deployments. */
export class MemoryDispatchJournal implements DispatchJournal {
  private readonly events: LedgerEvent[] = [];

  constructor(seed: LedgerEvent[] = []) {
    this.events.push(...seed);
  }

  append(event: LedgerEvent): void {
    this.events.push(event);
  }

  readAll(): LedgerEvent[] {
    return [...this.events];
  }
}

export class DispatchLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(
    private readonly journal: DispatchJournal = new MemoryDispatchJournal(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.replay();
    this.recover();
  }

  /**
   * Fast-path lifecycle check. Returns the action to take for a submission whose
   * actionId may already be in the ledger. `absent` means the caller should proceed
   * with full verification; the authoritative gate is {@link authorizeDispatch}.
   */
  check(actionId: ActionId, envelopeHash: string): LedgerCheck {
    const entry = this.entries.get(key(actionId));
    if (!entry) {
      return { kind: "absent" };
    }

    if (entry.status === "resolved") {
      return { kind: "reject", code: "REPLAY_DETECTED", message: "Action has already been dispatched." };
    }

    // executing
    if (entry.envelopeHash === envelopeHash) {
      return { kind: "pending" };
    }

    return {
      kind: "reject",
      code: "ACTION_ID_HASH_MISMATCH",
      message: "Action ID is already dispatching a different Action Envelope.",
    };
  }

  /**
   * Atomic check-and-write gate (Core check-and-write property). Synchronously
   * re-checks the ledger and, only if the actionId is absent, durably writes the
   * `executing` entry. Two submissions of the same actionId can never both receive
   * `{ kind: "absent" }` here, so at most one ever proceeds to transmission.
   */
  authorizeDispatch(actionId: ActionId, envelopeHash: string, expiresAt: string): LedgerCheck {
    const decision = this.check(actionId, envelopeHash);
    if (decision.kind !== "absent") {
      return decision;
    }

    const event: LedgerEvent = {
      event: "executing",
      actionId: key(actionId),
      envelopeHash,
      expiresAt,
      at: new Date(this.now()).toISOString(),
    };
    this.journal.append(event);
    this.entries.set(key(actionId), { envelopeHash, status: "executing", expiresAt });
    return { kind: "absent" };
  }

  /** Immutable transition executing -> resolved. Never rolls back. */
  resolve(actionId: ActionId, resolution: DispatchResolution): void {
    const entry = this.entries.get(key(actionId));
    if (!entry || entry.status === "resolved") {
      return;
    }

    this.journal.append({
      event: "resolved",
      actionId: key(actionId),
      resolution,
      at: new Date(this.now()).toISOString(),
    });
    entry.status = "resolved";
    entry.resolution = resolution;
  }

  size(): number {
    return this.entries.size;
  }

  private replay(): void {
    for (const event of this.journal.readAll()) {
      if (event.event === "executing") {
        this.entries.set(event.actionId, {
          envelopeHash: event.envelopeHash,
          status: "executing",
          expiresAt: event.expiresAt,
        });
        continue;
      }

      const entry = this.entries.get(event.actionId);
      if (entry) {
        entry.status = "resolved";
        entry.resolution = event.resolution;
      }
    }
  }

  /**
   * Restart recovery: any action found `executing` with no `resolved` event MUST NOT
   * be re-dispatched. Resolve it as `indeterminate` and APPEND that resolution so
   * recovery is idempotent across repeated restarts.
   */
  private recover(): void {
    for (const [actionId, entry] of this.entries) {
      if (entry.status === "executing") {
        this.journal.append({
          event: "resolved",
          actionId,
          resolution: "indeterminate",
          at: new Date(this.now()).toISOString(),
        });
        entry.status = "resolved";
        entry.resolution = "indeterminate";
      }
    }
  }
}

function key(actionId: ActionId): string {
  return actionId.scope ? `${actionId.scope}:${actionId.value}` : actionId.value;
}
