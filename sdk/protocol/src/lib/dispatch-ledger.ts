import { canonicalize } from "json-canonicalize";
import type { ActionId, ActionResponse, HashObject } from "../types/mpas.js";
import { strictJsonParse } from "../utils/strict-json.js";
import { parseActionResponse, requireTimestamp } from "./routing.js";

export type DispatchResolution = "executed" | "failed" | "indeterminate";

interface DispatchIdentity {
  version: "1";
  type: "DispatchLedgerEntry";
  actionId: ActionId;
  envelopeHash: HashObject;
  expiresAt: string;
  startedAt: string;
}

export type DispatchRecord = DispatchIdentity & (
  | { status: "executing" }
  | { status: "resolved"; resolution: DispatchResolution; resolvedAt: string; response?: ActionResponse }
);
export type DispatchRecovery = Extract<DispatchRecord, { status: "resolved" }>;

export type LedgerCheck =
  | { kind: "absent" }
  | { kind: "pending" }
  | { kind: "reject"; code: "ACTION_ID_HASH_MISMATCH" | "REPLAY_DETECTED"; message: string };

/**
 * Atomic byte store. Successful writes MUST be durable before returning;
 * failures throw and comparison conflicts return false. Memory is not durable.
 */
export interface DispatchStore {
  get(key: string): string | undefined;
  insertIfAbsent(key: string, value: string): boolean;
  compareAndSwap(key: string, expected: string, value: string): boolean;
  entries(): ReadonlyArray<[string, string]>;
  deleteIfMatch(key: string, expected: string): boolean;
  close(): void;
}

/** Deterministic atomic reference for tests, without restart durability. */
export class MemoryDispatchStore implements DispatchStore {
  private readonly records = new Map<string, string>();

  get(key: string): string | undefined { return this.records.get(key); }
  insertIfAbsent(key: string, value: string): boolean {
    if (this.records.has(key)) return false;
    this.records.set(key, value);
    return true;
  }
  compareAndSwap(key: string, expected: string, value: string): boolean {
    if (this.records.get(key) !== expected) return false;
    this.records.set(key, value);
    return true;
  }
  entries(): ReadonlyArray<[string, string]> { return [...this.records]; }
  deleteIfMatch(key: string, expected: string): boolean {
    if (this.records.get(key) !== expected) return false;
    return this.records.delete(key);
  }
  close(): void { /* No external resources. */ }
}

/** Canonical, closed record encoding. No event replay or caller-owned references. */
export function serializeDispatchRecord(record: DispatchRecord): string {
  validateRecord(record);
  return canonicalize(record);
}

/** Parse and validate canonical stored bytes; malformed or noncanonical data throws. */
export function parseDispatchRecord(bytes: string): DispatchRecord {
  const value = strictJsonParse(bytes);
  validateRecord(value);
  if (canonicalize(value) !== bytes) throw new Error("Dispatch record is not canonical JSON.");
  return value;
}

/**
 * Core at-most-once lifecycle. Only an absent result from authorizeDispatch
 * grants transmission. Opening another view never recovers a live dispatch.
 */
export class DispatchLedger {
  constructor(
    private readonly store: DispatchStore = new MemoryDispatchStore(),
    private readonly now: () => number = () => Date.now(),
    private readonly timestampToleranceMs = 0,
  ) {
    try {
      if (!Number.isFinite(timestampToleranceMs) || timestampToleranceMs < 0) {
        throw new Error("Invalid dispatch timestamp tolerance.");
      }
      this.timestamp();
      this.records();
    } catch (error) {
      store.close();
      throw error;
    }
  }

  /** Advisory full-identity lookup; only authorizeDispatch can grant a target call. */
  check(actionId: ActionId, envelopeHash: HashObject): LedgerCheck {
    validateHash(envelopeHash);
    const entry = this.read(actionKey(actionId));
    if (!entry) return { kind: "absent" };
    if (entry.record.status === "resolved") {
      return { kind: "reject", code: "REPLAY_DETECTED", message: "Action has already been dispatched." };
    }
    if (canonicalize(entry.record.envelopeHash) === canonicalize(envelopeHash)) return { kind: "pending" };
    return {
      kind: "reject", code: "ACTION_ID_HASH_MISMATCH",
      message: "Action ID is already dispatching a different Action Envelope.",
    };
  }

  /** Durably insert executing before transmission; expiry, validation and I/O errors throw. */
  authorizeDispatch(actionId: ActionId, envelopeHash: HashObject, expiresAt: string): LedgerCheck {
    const key = actionKey(actionId);
    validateHash(envelopeHash);
    const decision = this.check(actionId, envelopeHash);
    if (decision.kind !== "absent") return decision;
    const startedAt = this.timestamp();
    requireTimestamp(expiresAt, "$.expiresAt");
    this.retentionDeadline(expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(startedAt)) throw new Error("Cannot dispatch an expired Action.");
    const bytes = serializeDispatchRecord({
      version: "1", type: "DispatchLedgerEntry", actionId, envelopeHash,
      expiresAt, startedAt, status: "executing",
    });
    // A uniqueness conflict is not permission, even if a concurrent prune removed
    // the winner before the following read. Fail closed instead of granting.
    if (this.store.insertIfAbsent(key, bytes)) return { kind: "absent" };
    const current = this.check(actionId, envelopeHash);
    if (current.kind === "absent") throw new Error("Dispatch record disappeared during authorization.");
    return current;
  }

  /** Persist a first terminal result or once-only response; return the winning copied record. */
  resolve(actionId: ActionId, resolution: DispatchResolution, response?: ActionResponse): DispatchRecovery | undefined {
    const key = actionKey(actionId);
    validateResolution(resolution);
    for (;;) {
      const entry = this.read(key);
      if (!entry) return undefined;
      const record = entry.record;
      if (response !== undefined) validateResponse(response, record.envelopeHash, resolution);
      if (record.status === "resolved" &&
          (record.resolution !== resolution || record.response !== undefined || response === undefined)) return record;
      const resolved: DispatchRecovery = record.status === "resolved"
        ? { ...record, response: response! }
        : { ...record, status: "resolved", resolution, resolvedAt: this.timestamp(), ...(response === undefined ? {} : { response }) };
      const bytes = serializeDispatchRecord(resolved);
      if (this.store.compareAndSwap(key, entry.bytes, bytes)) return parseDispatchRecord(bytes) as DispatchRecovery;
      // Only executing -> resolved -> response attachment is possible. Read the
      // competing winner; never return the losing caller's result or receipt.
    }
  }

  /** Internal full-hash recovery only; public replay remains rejected by check. */
  recoveryFor(actionId: ActionId, envelopeHash: HashObject): DispatchRecovery | undefined {
    validateHash(envelopeHash);
    const entry = this.read(actionKey(actionId));
    return entry?.record.status === "resolved" &&
      canonicalize(entry.record.envelopeHash) === canonicalize(envelopeHash) ? entry.record : undefined;
  }

  /** Host startup only, after prior dispatch workers have stopped. */
  recoverExecuting(): number {
    let recovered = 0;
    const at = this.timestamp();
    for (const [key, bytes, record] of this.records()) {
      if (record.status !== "executing") continue;
      const resolved = serializeDispatchRecord({ ...record, status: "resolved", resolution: "indeterminate", resolvedAt: at });
      if (this.store.compareAndSwap(key, bytes, resolved)) recovered++;
    }
    return recovered;
  }

  /** Explicit retention operation, never a timer or a grant to replay old input. */
  prune(): number {
    const now = Date.parse(this.timestamp());
    let removed = 0;
    for (const [key, bytes, record] of this.records()) {
      const deadline = this.retentionDeadline(record.expiresAt);
      if (record.status === "resolved" && now > deadline && this.store.deleteIfMatch(key, bytes)) removed++;
    }
    return removed;
  }

  size(): number { return this.records().length; }
  close(): void { this.store.close(); }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new Error("Invalid dispatch clock.");
    const stamp = new Date(value).toISOString();
    requireTimestamp(stamp, "$.clock");
    if (!Number.isFinite(value + this.timestampToleranceMs) ||
        Math.abs(value + this.timestampToleranceMs) > Number.MAX_SAFE_INTEGER) throw new Error("Dispatch tolerance overflows the clock.");
    return stamp;
  }

  private retentionDeadline(expiresAt: string): number {
    const value = Date.parse(expiresAt) + this.timestampToleranceMs;
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || !Number.isFinite(new Date(value).getTime())) {
      throw new Error("Dispatch retention deadline overflows.");
    }
    return value;
  }

  private read(key: string): { bytes: string; record: DispatchRecord } | undefined {
    const bytes = this.store.get(key);
    if (bytes === undefined) return undefined;
    const record = parseDispatchRecord(bytes);
    if (actionKey(record.actionId) !== key) throw new Error("Dispatch key does not match its record.");
    this.retentionDeadline(record.expiresAt);
    return { bytes, record };
  }

  private records(): Array<[string, string, DispatchRecord]> {
    const seen = new Set<string>();
    return this.store.entries().map(([key, bytes]) => {
      const record = parseDispatchRecord(bytes);
      if (seen.has(key) || actionKey(record.actionId) !== key) throw new Error("Invalid or duplicate dispatch key.");
      seen.add(key);
      this.retentionDeadline(record.expiresAt);
      return [key, bytes, record];
    });
  }
}

function actionKey(value: ActionId): string {
  const object = closedObject(value, ["value", "scope"]);
  if (typeof object.value !== "string" || !object.value ||
      ("scope" in object && (typeof object.scope !== "string" || !object.scope))) {
    throw new Error("Invalid dispatch Action ID.");
  }
  requireJson(value);
  return canonicalize(value);
}

function validateHash(value: unknown): void {
  const hash = closedObject(value, ["alg", "value"]);
  if (!["sha-256", "sha-384", "sha-512", "sha3-256", "sha3-384", "sha3-512"].includes(hash.alg as string) ||
      typeof hash.value !== "string" || !/^[A-Za-z0-9_-]+$/.test(hash.value)) throw new Error("Invalid dispatch hash.");
}

function validateResolution(value: unknown): void {
  if (value !== "executed" && value !== "failed" && value !== "indeterminate") throw new Error("Invalid dispatch resolution.");
}

function validateResponse(value: unknown, hash: HashObject, resolution: DispatchResolution): void {
  requireJson(value);
  const response = parseActionResponse(value);
  validateHash(response.actionEnvelopeHash);
  if (response.result !== resolution || canonicalize(response.actionEnvelopeHash) !== canonicalize(hash)) {
    throw new Error("Terminal ActionResponse does not match the dispatch ledger resolution.");
  }
}

function validateRecord(value: unknown): asserts value is DispatchRecord {
  const record = closedObject(value, [
    "version", "type", "actionId", "envelopeHash", "expiresAt", "startedAt", "status",
    ...(typeof value === "object" && value !== null && "status" in value && value.status === "resolved"
      ? ["resolution", "resolvedAt", "response"] : []),
  ]);
  requireJson(record);
  if (record.version !== "1" || record.type !== "DispatchLedgerEntry") throw new Error("Unsupported dispatch record.");
  actionKey(record.actionId as ActionId);
  validateHash(record.envelopeHash);
  requireTimestamp(record.expiresAt, "$.expiresAt");
  requireTimestamp(record.startedAt, "$.startedAt");
  if (Date.parse(record.expiresAt as string) <= Date.parse(record.startedAt as string)) throw new Error("Invalid dispatch expiry.");
  if (record.status === "resolved") {
    validateResolution(record.resolution);
    requireTimestamp(record.resolvedAt, "$.resolvedAt");
    if (Date.parse(record.resolvedAt as string) < Date.parse(record.startedAt as string)) throw new Error("Dispatch resolution predates dispatch.");
    if ("response" in record) validateResponse(record.response, record.envelopeHash as HashObject, record.resolution as DispatchResolution);
  } else if (record.status !== "executing") throw new Error("Invalid dispatch status.");
}

function closedObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key))) {
    throw new Error("Invalid or undeclared dispatch record member.");
  }
  return value as Record<string, unknown>;
}

/** Do not let serialization silently discard undefined, getters or non-JSON data. */
function requireJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("Invalid JSON Unicode.");
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)) throw new Error("Invalid JSON dispatch data.");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid JSON dispatch object.");
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Invalid JSON dispatch property.");
    requireJson(key, seen);
    requireJson(descriptor.value, seen);
  }
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new Error("Invalid JSON dispatch array.");
    }
  }
  seen.delete(value);
}
