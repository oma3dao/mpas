import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionId, ActionResponse } from "../core/types.js";

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
 * immutable: the sole state transition is `executing -> resolved`. An exact
 * terminal response may be attached once so an internal relay can recover it.
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
      /** Exact terminal response retained for internal delivery recovery. */
      response?: ActionResponse;
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
  response?: ActionResponse;
  expiresAt: string;
}

export interface DispatchRecovery {
  resolution: DispatchResolution;
  response?: ActionResponse;
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
    const fd = openSync(this.path, "a", 0o600);
    try {
      chmodSync(this.path, 0o600);
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
  resolve(actionId: ActionId, resolution: DispatchResolution, response?: ActionResponse): void {
    const entry = this.entries.get(key(actionId));
    if (!entry) {
      return;
    }
    if (
      response &&
      (response.result !== resolution || response.actionEnvelopeHash?.value !== entry.envelopeHash)
    ) {
      throw new Error("Terminal ActionResponse does not match the dispatch ledger resolution.");
    }

    if (entry.status === "resolved") {
      if (entry.resolution !== resolution || entry.response || !response) return;
      this.journal.append({
        event: "resolved",
        actionId: key(actionId),
        resolution,
        response,
        at: new Date(this.now()).toISOString(),
      });
      entry.response = response;
      return;
    }

    this.journal.append({
      event: "resolved",
      actionId: key(actionId),
      resolution,
      ...(response ? { response } : {}),
      at: new Date(this.now()).toISOString(),
    });
    entry.status = "resolved";
    entry.resolution = resolution;
    entry.response = response;
  }

  /**
   * Returns internally recoverable terminal material for the exact Action
   * Envelope. This does not alter the public resolved-replay rejection rule.
   */
  recoveryFor(actionId: ActionId, envelopeHash: string): DispatchRecovery | undefined {
    const entry = this.entries.get(key(actionId));
    if (!entry || entry.status !== "resolved" || entry.envelopeHash !== envelopeHash || !entry.resolution) {
      return undefined;
    }
    return {
      resolution: entry.resolution,
      ...(entry.response ? { response: entry.response } : {}),
    };
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
        entry.response = event.response;
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
