import { describe, expect, it, vi } from "vitest";
import {
  DispatchLedger, MemoryDispatchStore, parseDispatchRecord, serializeDispatchRecord,
  type ActionResponse, type DispatchRecord, type HashObject,
} from "../../src/index.js";

const id = { value: "urn:uuid:dispatch-test" };
const hash: HashObject = { alg: "sha-256", value: "hashA" };
const start = "2026-09-04T00:00:00.000Z";
const expiry = "2026-09-04T01:00:00.000Z";
const now = () => Date.parse(start);
const response: ActionResponse = {
  version: "1", type: "ActionResponse", verifier: { did: "did:jwk:synthetic" },
  result: "executed", actionEnvelopeHash: hash, createdAt: start,
  executionResult: { content: [{ type: "text", text: "nonempty retained result" }] },
};
const executing = (): DispatchRecord => ({
  version: "1", type: "DispatchLedgerEntry", actionId: id, envelopeHash: hash,
  expiresAt: expiry, startedAt: start, status: "executing",
});

describe("Core DispatchLedger public contract", () => {
  it("grants only the first atomic insert; checks do not consume identity", () => {
    const ledger = new DispatchLedger(new MemoryDispatchStore(), now);
    expect(ledger.check(id, hash)).toEqual({ kind: "absent" });
    expect(ledger.size()).toBe(0);
    expect(ledger.authorizeDispatch(id, hash, expiry)).toEqual({ kind: "absent" });
    expect(ledger.authorizeDispatch(id, hash, expiry)).toEqual({ kind: "pending" });
    expect(ledger.check(id, { ...hash, value: "different" })).toMatchObject({ code: "ACTION_ID_HASH_MISMATCH" });
    expect(ledger.check(id, { ...hash, alg: "sha-512" })).toMatchObject({ code: "ACTION_ID_HASH_MISMATCH" });
    expect(ledger.size()).toBe(1);
  });

  it("uses complete canonical identities, with no delimiter or absent-scope collision", () => {
    const store = new MemoryDispatchStore();
    const ledger = new DispatchLedger(store, now);
    for (const actionId of [{ scope: "a", value: "b:c" }, { scope: "a:b", value: "c" }, { value: "a:b:c" }, { value: "c" }]) {
      expect(ledger.authorizeDispatch(actionId, hash, expiry).kind).toBe("absent");
    }
    expect(ledger.size()).toBe(4);
    expect(store.entries().map(([key]) => key)).toContain('{"scope":"a","value":"b:c"}');
  });

  it("preserves every supported hash algorithm without collapsing to its value", () => {
    for (const alg of ["sha-256", "sha-384", "sha-512", "sha3-256", "sha3-384", "sha3-512"] as const) {
      const record = { ...executing(), envelopeHash: { alg, value: "a_-B9" } };
      expect(parseDispatchRecord(serializeDispatchRecord(record)).envelopeHash).toEqual(record.envelopeHash);
    }
  });

  it("keeps first resolution, time and response immutable across views and retries", () => {
    const store = new MemoryDispatchStore();
    const ledger = new DispatchLedger(store, now);
    ledger.authorizeDispatch(id, hash, expiry);
    const winner = ledger.resolve(id, "executed", response);
    const before = store.entries();
    expect(ledger.resolve(id, "failed", { ...response, result: "failed" })).toEqual(winner);
    expect(ledger.resolve(id, "executed", { ...response, createdAt: expiry })).toEqual(winner);
    expect(store.entries()).toEqual(before);
    expect(new DispatchLedger(store, now).recoveryFor(id, hash)).toEqual(winner);
    expect(ledger.check(id, hash)).toMatchObject({ code: "REPLAY_DETECTED" });
    expect(ledger.check(id, { ...hash, value: "different" })).toMatchObject({ code: "REPLAY_DETECTED" });
    expect(ledger.recoveryFor(id, { ...hash, alg: "sha-512" })).toBeUndefined();
    expect(ledger.resolve({ value: "unknown" }, "executed")).toBeUndefined();
  });

  it("does not retain caller-owned identities, hashes, results or recovered objects", () => {
    const store = new MemoryDispatchStore(), ledger = new DispatchLedger(store, now);
    const inputId = { ...id }, inputHash = { ...hash }, inputResponse = structuredClone(response);
    ledger.authorizeDispatch(inputId, inputHash, expiry);
    inputId.value = "changed"; inputHash.value = "changed";
    const winner = ledger.resolve(id, "executed", inputResponse)!;
    inputResponse.result = "failed";
    winner.response!.result = "indeterminate"; winner.envelopeHash.alg = "sha-512";
    expect(ledger.recoveryFor(id, hash)?.response).toEqual(response);
  });

  it("opening a joining view leaves live work pending; explicit recovery is idempotent", () => {
    const store = new MemoryDispatchStore(), first = new DispatchLedger(store, now);
    first.authorizeDispatch(id, hash, expiry);
    const joined = new DispatchLedger(store, now);
    expect(joined.check(id, hash).kind).toBe("pending");
    expect(joined.recoverExecuting()).toBe(1);
    expect(first.recoverExecuting()).toBe(0);
    expect(first.recoveryFor(id, hash)?.resolution).toBe("indeterminate");
    const terminal = { ...response, result: "indeterminate" as const };
    const winner = joined.resolve(id, "indeterminate", terminal);
    expect(joined.resolve(id, "indeterminate", { ...terminal, createdAt: expiry })).toEqual(winner);
    expect(first.authorizeDispatch(id, hash, expiry)).toMatchObject({ code: "REPLAY_DETECTED" });
  });

  it("re-reads a competing result and attaches a matching response only once", () => {
    const store = new MemoryDispatchStore(), ledger = new DispatchLedger(store, now);
    ledger.authorizeDispatch(id, hash, expiry);
    const cas = store.compareAndSwap.bind(store);
    vi.spyOn(store, "compareAndSwap").mockImplementationOnce((key, expected) => {
      const winner = serializeDispatchRecord({ ...executing(), status: "resolved", resolution: "indeterminate", resolvedAt: start });
      expect(cas(key, expected, winner)).toBe(true);
      return false;
    });
    expect(ledger.resolve(id, "executed", response)?.resolution).toBe("indeterminate");
    expect(ledger.recoveryFor(id, hash)?.response).toBeUndefined();
    expect(ledger.resolve(id, "indeterminate", { ...response, result: "indeterminate" })?.response?.result).toBe("indeterminate");
  });

  it("raw duplicate inserts and stale replacements cannot replace a winning record", () => {
    const store = new MemoryDispatchStore(), ledger = new DispatchLedger(store, now);
    ledger.authorizeDispatch(id, hash, expiry);
    const [key, before] = store.entries()[0];
    ledger.resolve(id, "executed", response);
    expect(store.insertIfAbsent(key, before)).toBe(false);
    expect(store.compareAndSwap(key, before, before)).toBe(false);
    expect(ledger.recoveryFor(id, hash)?.response).toEqual(response);
  });

  it.each([
    { ...response, result: "failed" },
    { ...response, actionEnvelopeHash: { ...hash, alg: "sha-512" } },
    { ...response, actionEnvelopeHash: { ...hash, value: "different" } },
    { ...response, version: "2" },
    { ...response, type: "NotActionResponse" },
  ])("rejects unbound or malformed terminal response %# before mutation", invalid => {
    const store = new MemoryDispatchStore(), ledger = new DispatchLedger(store, now);
    ledger.authorizeDispatch(id, hash, expiry);
    const before = store.entries();
    expect(() => ledger.resolve(id, "executed", invalid as ActionResponse)).toThrow();
    expect(store.entries()).toEqual(before);
  });

  it("serializes deterministically and requires the exact canonical representation on read", () => {
    const a = serializeDispatchRecord(executing());
    const b = serializeDispatchRecord({ status: "executing", startedAt: start, expiresAt: expiry,
      envelopeHash: { value: hash.value, alg: hash.alg }, actionId: { ...id }, type: "DispatchLedgerEntry", version: "1" });
    expect(a).toBe(b);
    expect(parseDispatchRecord(a)).toEqual(executing());
    expect(() => parseDispatchRecord(a + "\n")).toThrow();
    expect(() => parseDispatchRecord(a.slice(0, -1))).toThrow();
    expect(() => parseDispatchRecord(a.replace('"status":"executing"', '"status":"executing","status":"resolved"'))).toThrow();
  });

  it.each([
    { ...executing(), extra: true },
    { ...executing(), version: "2" },
    { ...executing(), status: "unknown" },
    { ...executing(), resolution: "failed" },
    { ...executing(), actionId: { value: "a", scope: "" } },
    { ...executing(), actionId: { value: "a", extra: 1 } },
    { ...executing(), envelopeHash: { ...hash, extra: 1 } },
    { ...executing(), envelopeHash: { ...hash, alg: "md5" } },
    { ...executing(), expiresAt: "2026-02-30T00:00:00.000Z" },
    { ...executing(), startedAt: "2026-09-04T00:00:00Z" },
    { ...executing(), status: "resolved", resolution: "executed" },
    { ...executing(), status: "resolved", resolution: "cancelled", resolvedAt: start },
    { ...executing(), status: "resolved", resolution: "executed", resolvedAt: "2025-01-01T00:00:00.000Z" },
  ])("rejects invalid durable schema %# at serialization and startup", value => {
    expect(() => serializeDispatchRecord(value as DispatchRecord)).toThrow();
    const store = new MemoryDispatchStore();
    store.insertIfAbsent(JSON.stringify(id), JSON.stringify(value));
    const close = vi.spyOn(store, "close");
    expect(() => new DispatchLedger(store, now)).toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects undefined, nonfinite, cyclic, accessor and invalid Unicode JSON values", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, "value", { get: () => "x", enumerable: true });
    const sparseWithExtra = Object.assign(new Array(1), { extra: "not an array element" });
    for (const value of [undefined, NaN, Infinity, cyclic, accessor, "\uD800", new Date(), [, 1], sparseWithExtra]) {
      expect(() => serializeDispatchRecord({ ...executing(), status: "resolved", resolution: "executed",
        resolvedAt: start, response: { ...response, executionResult: value } })).toThrow();
    }
  });

  it("rejects record/key identity mismatch and duplicate entry snapshots", () => {
    const store = new MemoryDispatchStore();
    store.insertIfAbsent('{"value":"wrong"}', serializeDispatchRecord(executing()));
    expect(() => new DispatchLedger(store, now)).toThrow();
    const other = new MemoryDispatchStore();
    vi.spyOn(other, "entries").mockReturnValue([[JSON.stringify(id), serializeDispatchRecord(executing())], [JSON.stringify(id), serializeDispatchRecord(executing())]]);
    expect(() => new DispatchLedger(other, now)).toThrow();
  });

  it("retains executing and terminal recovery records through expiry plus tolerance equality", () => {
    let clock = now();
    const store = new MemoryDispatchStore(), ledger = new DispatchLedger(store, () => clock, 100);
    ledger.authorizeDispatch(id, hash, expiry); ledger.resolve(id, "executed", response);
    ledger.authorizeDispatch({ value: "live" }, hash, expiry);
    ledger.authorizeDispatch({ value: "future" }, hash, "2026-09-05T00:00:00.000Z");
    ledger.resolve({ value: "future" }, "failed");
    clock = Date.parse(expiry) + 100;
    expect(ledger.prune()).toBe(0);
    expect(ledger.recoveryFor(id, hash)?.response).toEqual(response);
    clock++;
    expect(ledger.prune()).toBe(1);
    expect(ledger.size()).toBe(2);
    expect(ledger.check({ value: "live" }, hash).kind).toBe("pending");
    expect(() => ledger.authorizeDispatch(id, hash, expiry)).toThrow(/expired/);
  });

  it("retains restarted indeterminate records until eligible; stale deletion cannot remove an attachment", () => {
    let clock = now();
    const store = new MemoryDispatchStore(), ledger = new DispatchLedger(store, () => clock);
    ledger.authorizeDispatch(id, hash, expiry); ledger.recoverExecuting();
    const remove = store.deleteIfMatch.bind(store);
    vi.spyOn(store, "deleteIfMatch").mockImplementationOnce((key, expected) => {
      ledger.resolve(id, "indeterminate", { ...response, result: "indeterminate" });
      return remove(key, expected);
    });
    clock = Date.parse(expiry);
    expect(ledger.prune()).toBe(0);
    clock++;
    expect(ledger.prune()).toBe(0);
    expect(ledger.recoveryFor(id, hash)?.response).toBeDefined();
    expect(ledger.prune()).toBe(1);
  });

  it("allows finite fractional tolerance and rejects invalid or overflowed clocks/tolerance", () => {
    expect(() => new DispatchLedger(new MemoryDispatchStore(), now, 0.5)).not.toThrow();
    for (const tolerance of [-1, NaN, Infinity, Number.MAX_VALUE]) {
      expect(() => new DispatchLedger(new MemoryDispatchStore(), now, tolerance)).toThrow();
    }
    for (const clock of [NaN, Infinity, Number.MAX_VALUE, 0.5]) {
      expect(() => new DispatchLedger(new MemoryDispatchStore(), () => clock)).toThrow();
    }
    let clock = now();
    const ledger = new DispatchLedger(new MemoryDispatchStore(), () => clock);
    ledger.authorizeDispatch(id, hash, expiry);
    clock--;
    expect(() => ledger.resolve(id, "failed")).toThrow(/predates/);
  });

  it.each(["write", "fsync", "commit"])("injected %s failure grants zero transmissions", phase => {
    const store = new MemoryDispatchStore(), ledger = new DispatchLedger(store, now);
    vi.spyOn(store, "insertIfAbsent").mockImplementation(() => { throw new Error("injected " + phase); });
    let transmissions = 0;
    expect(() => { if (ledger.authorizeDispatch(id, hash, expiry).kind === "absent") transmissions++; }).toThrow("injected " + phase);
    expect(transmissions).toBe(0);
  });
});
