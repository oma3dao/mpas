import { describe, expect, it } from "vitest";
import { DispatchLedger, MemoryDispatchJournal, type LedgerEvent } from "../../src/adapter/dispatch-ledger.js";

const actionId = { value: "urn:uuid:11111111-1111-4111-8111-111111111111" };
const expiresAt = "2030-01-01T00:00:00.000Z";

describe("DispatchLedger", () => {
  it("treats an unknown actionId as absent (full verification proceeds)", () => {
    const ledger = new DispatchLedger();
    expect(ledger.check(actionId, "hashA").kind).toBe("absent");
  });

  it("only one of two same-actionId submissions can authorize dispatch", () => {
    const ledger = new DispatchLedger();
    const first = ledger.authorizeDispatch(actionId, "hashA", expiresAt);
    const second = ledger.authorizeDispatch(actionId, "hashA", expiresAt);

    expect(first.kind).toBe("absent"); // authorized to dispatch
    expect(second.kind).toBe("pending"); // executing + same hash
  });

  it("rejects a different envelope hash once an actionId is in the ledger", () => {
    const ledger = new DispatchLedger();
    ledger.authorizeDispatch(actionId, "hashA", expiresAt);

    const check = ledger.check(actionId, "hashB");
    expect(check).toMatchObject({ kind: "reject", code: "ACTION_ID_HASH_MISMATCH" });
  });

  it("rejects any resubmission once the actionId is resolved (replay)", () => {
    const ledger = new DispatchLedger();
    ledger.authorizeDispatch(actionId, "hashA", expiresAt);
    ledger.resolve(actionId, "executed");

    expect(ledger.check(actionId, "hashA")).toMatchObject({ kind: "reject", code: "REPLAY_DETECTED" });
    expect(ledger.check(actionId, "hashB")).toMatchObject({ kind: "reject", code: "REPLAY_DETECTED" });
  });

  it("never rolls back: resolve is the only transition out of executing", () => {
    const ledger = new DispatchLedger();
    ledger.authorizeDispatch(actionId, "hashA", expiresAt);
    ledger.resolve(actionId, "failed");
    ledger.resolve(actionId, "executed"); // ignored — already resolved
    expect(ledger.check(actionId, "hashA")).toMatchObject({ kind: "reject", code: "REPLAY_DETECTED" });
  });

  it("on restart, an executing entry with no resolution recovers as indeterminate and is never re-dispatched", () => {
    // Simulate a crash mid-dispatch: an executing event was written but no resolved event.
    const seed: LedgerEvent[] = [
      { event: "executing", actionId: actionId.value, envelopeHash: "hashA", expiresAt, at: "2026-06-12T00:00:00.000Z" },
    ];
    const journal = new MemoryDispatchJournal(seed);
    const ledger = new DispatchLedger(journal);

    // Recovery resolved it (as replay/terminal), so a resubmission is rejected, not re-dispatched.
    expect(ledger.check(actionId, "hashA")).toMatchObject({ kind: "reject", code: "REPLAY_DETECTED" });

    // Recovery appended an indeterminate resolution, and is idempotent across restarts.
    const events = journal.readAll();
    expect(events.filter((e) => e.event === "resolved" && e.resolution === "indeterminate")).toHaveLength(1);

    const reloaded = new DispatchLedger(journal);
    expect(reloaded.check(actionId, "hashA")).toMatchObject({ kind: "reject", code: "REPLAY_DETECTED" });
    expect(journal.readAll().filter((e) => e.event === "resolved")).toHaveLength(1);
  });
});
