import { describe, expect, it } from "vitest";
import type { ActionResponse, Did } from "@oma3/mpas";
import { DispatchLedger, MemoryDispatchJournal, type LedgerEvent } from "../../src/adapter/dispatch-ledger.js";

const actionId = { value: "urn:uuid:11111111-1111-4111-8111-111111111111" };
const expiresAt = "2030-01-01T00:00:00.000Z";
const terminalResponse: ActionResponse = {
  version: "1",
  type: "ActionResponse",
  verifier: { did: "did:jwk:verifier" as Did },
  actionEnvelopeHash: { alg: "sha-256", value: "hashA" },
  result: "executed",
  createdAt: "2026-08-28T12:00:00.000Z",
};

describe("DispatchLedger", () => {
  it("tracks the same local identifier independently in two deployment scopes", () => {
    const ledger = new DispatchLedger();
    const first = { scope: "workspace A", value: "42" };
    const second = { scope: "workspace B", value: "42" };
    ledger.authorizeDispatch(first, "hashA", expiresAt);
    expect(ledger.check(second, "hashB").kind).toBe("absent");
    expect(ledger.check(first, "hashA").kind).toBe("pending");
  });

  it("treats an unknown actionId as absent (full verification proceeds)", () => {
    const ledger = new DispatchLedger();
    expect(ledger.check(actionId, "hashA").kind).toBe("absent");
  });

  it("keeps delimiter-containing scope and ID pairs separate across restart", () => {
    const journal = new MemoryDispatchJournal();
    const ledger = new DispatchLedger(journal);
    const first = { scope: "workspace:child", value: "42" };
    const second = { scope: "workspace", value: "child:42" };
    expect(ledger.authorizeDispatch(first, "hashA", expiresAt).kind).toBe("absent");
    expect(ledger.authorizeDispatch(second, "hashB", expiresAt).kind).toBe("absent");
    ledger.resolve(first, "executed");
    ledger.resolve(second, "failed");

    const reloaded = new DispatchLedger(journal);
    expect(reloaded.size()).toBe(2);
    expect(reloaded.recoveryFor(first, "hashA")).toEqual({ resolution: "executed" });
    expect(reloaded.recoveryFor(second, "hashB")).toEqual({ resolution: "failed" });
  });

  it("distinguishes an unscoped DID from a scoped value with the same former flattened key", () => {
    const ledger = new DispatchLedger();
    ledger.authorizeDispatch({ value: "did:example:42" }, "hashA", expiresAt);
    expect(ledger.check({ scope: "did:example", value: "42" }, "hashB").kind).toBe("absent");
  });

  it("conservatively preserves replay rejection for ambiguous legacy scoped entries", () => {
    const journal = new MemoryDispatchJournal([
      { event: "executing", actionId: "workspace:child:42", envelopeHash: "hashA", expiresAt, at: "2026-06-12T00:00:00.000Z" },
    ]);
    const first = { scope: "workspace:child", value: "42" };
    const second = { scope: "workspace", value: "child:42" };
    for (const ledger of [new DispatchLedger(journal), new DispatchLedger(journal)]) {
      expect(ledger.check(first, "hashA")).toMatchObject({ kind: "reject", code: "REPLAY_DETECTED" });
      expect(ledger.check(second, "hashB")).toMatchObject({ kind: "reject", code: "REPLAY_DETECTED" });
    }
    expect(journal.readAll().filter((event) => event.event === "resolved")).toHaveLength(1);
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

  it("retains the exact terminal response for internal delivery recovery without changing replay rejection", () => {
    const journal = new MemoryDispatchJournal();
    const ledger = new DispatchLedger(journal);
    ledger.authorizeDispatch(actionId, "hashA", expiresAt);
    ledger.resolve(actionId, "executed", terminalResponse);

    expect(ledger.check(actionId, "hashA")).toMatchObject({ kind: "reject", code: "REPLAY_DETECTED" });
    expect(ledger.recoveryFor(actionId, "hashA")).toEqual({
      resolution: "executed",
      response: terminalResponse,
    });
    expect(new DispatchLedger(journal).recoveryFor(actionId, "hashA")).toEqual({
      resolution: "executed",
      response: terminalResponse,
    });
    expect(ledger.recoveryFor(actionId, "different-hash")).toBeUndefined();
  });

  it("a legacy resolved entry without response material remains unrecoverable", () => {
    const ledger = new DispatchLedger();
    ledger.authorizeDispatch(actionId, "hashA", expiresAt);
    ledger.resolve(actionId, "executed");

    const check = ledger.check(actionId, "hashA");
    // Older journal entries contain only the resolution. Public replay rejection
    // still carries no terminal result material.
    expect(Object.keys(check).sort()).toEqual(["code", "kind", "message"]);
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

  it("can attach an indeterminate recovery response after restart recovery", () => {
    const journal = new MemoryDispatchJournal([
      { event: "executing", actionId: actionId.value, envelopeHash: "hashA", expiresAt, at: "2026-06-12T00:00:00.000Z" },
    ]);
    const ledger = new DispatchLedger(journal);
    const response: ActionResponse = { ...terminalResponse, result: "indeterminate" };

    expect(ledger.recoveryFor(actionId, "hashA")).toEqual({ resolution: "indeterminate" });
    ledger.resolve(actionId, "indeterminate", response);

    expect(ledger.recoveryFor(actionId, "hashA")).toEqual({ resolution: "indeterminate", response });
    expect(new DispatchLedger(journal).recoveryFor(actionId, "hashA")).toEqual({
      resolution: "indeterminate",
      response,
    });
  });
});
