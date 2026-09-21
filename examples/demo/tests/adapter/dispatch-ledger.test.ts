import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { parseDispatchRecord, serializeDispatchRecord, type ActionResponse, type HashObject } from "@oma3/mpas";
import { DispatchLedger, FileDispatchJournal, MemoryDispatchJournal, MemoryDispatchStore } from "../../src/adapter/dispatch-ledger.js";

const demoRoot = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
let ledgerBuildDir: string | undefined;
let ledgerEntryPromise: Promise<string> | undefined;

function compiledLedgerEntry(): Promise<string> {
  // Child Node processes need real compiled production code even before the demo build.
  ledgerEntryPromise ??= (async () => {
    ledgerBuildDir = await mkdtemp(join(demoRoot, ".ledger-test-build-"));
    try {
      const args = [join(demoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", ledgerBuildDir];
      console.log(JSON.stringify({ case: "ledger child compilation", executable: process.execPath, args, cwd: demoRoot }));
      const { stdout, stderr } = await execFileAsync(process.execPath, args, { cwd: demoRoot });
      const entry = join(ledgerBuildDir, "adapter", "dispatch-ledger.js");
      console.log(JSON.stringify({ case: "ledger child compiled entry", entry, stdout, stderr }));
      return entry;
    } catch (error) {
      await rm(ledgerBuildDir, { recursive: true, force: true });
      throw error;
    }
  })();
  return ledgerEntryPromise;
}

beforeAll(async () => { await compiledLedgerEntry(); }, 15_000);
afterAll(async () => {
  await ledgerEntryPromise?.catch(() => {});
  // afterEach has stopped child processes and closed every store before this removal.
  if (ledgerBuildDir) await rm(ledgerBuildDir, { recursive: true, force: true });
});

const id = { value: "urn:uuid:durable-dispatch" };
const hash: HashObject = { alg: "sha-256", value: "hashA" };
const expiry = "2030-01-01T00:00:00.000Z";
const response: ActionResponse = {
  version: "1", type: "ActionResponse", verifier: { did: "did:jwk:synthetic" },
  actionEnvelopeHash: hash, result: "executed", createdAt: "2026-09-04T00:00:00.000Z",
  executionResult: { content: [{ type: "text", text: "durable nonempty target result" }] },
};
const stores: FileDispatchJournal[] = [];
const children: ChildProcess[] = [];
const databasePath = () => join(mkdtempSync(join(realpathSync(tmpdir()), "mpas-dispatch-")), "dispatch-ledger.jsonl");
function open(path: string): FileDispatchJournal {
  const store = new FileDispatchJournal(path); stores.push(store); return store;
}
function native(store: FileDispatchJournal): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit"); child.kill("SIGKILL"); await done;
    }
  }
  for (const store of stores.splice(0)) store.close();
});

describe("durable SQLite dispatch reference", () => {
  it("uses the one Core engine and memory alias", () => {
    expect(MemoryDispatchJournal).toBe(MemoryDispatchStore);
  });

  it("probes built-in capability and verifies every selected PRAGMA", () => {
    const path = databasePath(), store = open(path), db = native(store);
    const values = Object.fromEntries(["journal_mode", "synchronous", "fullfsync", "busy_timeout"].map(key =>
      [key, Object.values(db.prepare("PRAGMA " + key).get()!)[0]]));
    expect(values).toEqual({ journal_mode: "delete", synchronous: 3, fullfsync: 1, busy_timeout: 5000 });
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    console.log(JSON.stringify({ case: "SQLite capability", node: process.version, values, path }));
  });

  it("reopens exact canonical records and immutable full responses", () => {
    const path = databasePath(), first = new DispatchLedger(open(path));
    first.authorizeDispatch(id, hash, expiry);
    first.resolve(id, "executed", response);
    first.close();
    const store = open(path), reopened = new DispatchLedger(store);
    expect(reopened.recoveryFor(id, hash)?.response).toEqual(response);
    expect(reopened.resolve(id, "failed", { ...response, result: "failed" })?.response).toEqual(response);
    const [key, bytes] = store.entries()[0];
    expect(key).toBe(JSON.stringify(id));
    expect(serializeDispatchRecord(parseDispatchRecord(bytes))).toBe(bytes);
    expect(store.insertIfAbsent(key, bytes)).toBe(false);
    expect(reopened.check(id, hash)).toMatchObject({ code: "REPLAY_DETECTED" });
    console.log(JSON.stringify({ case: "canonical reopen", path, key, bytes, storedResponse: reopened.recoveryFor(id, hash)?.response }));
  });

  it("joining a second real connection preserves live pending state", () => {
    const path = databasePath(), a = new DispatchLedger(open(path));
    a.authorizeDispatch(id, hash, expiry);
    const b = new DispatchLedger(open(path));
    expect(b.check(id, hash).kind).toBe("pending");
    a.resolve(id, "executed", response);
    expect(b.recoveryFor(id, hash)?.response).toEqual(response);
  });

  it("keeps delimiter identities distinct and compares complete hashes on real storage", () => {
    const ledger = new DispatchLedger(open(databasePath()));
    for (const actionId of [{ scope: "a", value: "b:c" }, { scope: "a:b", value: "c" }, { value: "a:b:c" }]) {
      expect(ledger.authorizeDispatch(actionId, hash, expiry).kind).toBe("absent");
    }
    expect(ledger.check({ value: "a:b:c" }, { ...hash, alg: "sha-512" })).toMatchObject({ code: "ACTION_ID_HASH_MISMATCH" });
  });

  it("fails closed on real query-only database writes", () => {
    const store = open(databasePath()), ledger = new DispatchLedger(store);
    native(store).exec("PRAGMA query_only = ON");
    expect(() => ledger.authorizeDispatch(id, hash, expiry)).toThrow(/readonly/i);
    expect(ledger.size()).toBe(0);
  });

  it("rejects real read-only files and symlink paths without changing data", () => {
    const path = databasePath(), store = open(path);
    new DispatchLedger(store).authorizeDispatch(id, hash, expiry); store.close();
    const bytes = readFileSync(path);
    chmodSync(path, 0o400);
    try { expect(() => open(path)).toThrow(); } finally { chmodSync(path, 0o600); }
    expect(readFileSync(path)).toEqual(bytes);
    const link = path + ".link"; symlinkSync(path, link);
    expect(() => open(link)).toThrow();
    const parentLink = path + ".dir"; symlinkSync(join(path, ".."), parentLink);
    expect(() => open(join(parentLink, "other.db"))).toThrow();
    expect(() => open(":memory:")).toThrow();
    expect(() => open(join(path, ".."))).toThrow();
  });

  it.each([
    '{"event":"executing","actionId":"legacy"}\n',
    'not a database',
    'SQLite format 3\0damaged',
  ])("preserves legacy/corrupt input bytes %# and does not select another path", contents => {
    const path = databasePath(); writeFileSync(path, contents);
    const before = readFileSync(path);
    expect(() => open(path)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it.each(["foreign", "version", "trigger"])("rejects unknown %s schema without changing bytes", mode => {
    const path = databasePath();
    if (mode === "foreign") {
      const db = new DatabaseSync(path); db.exec("CREATE TABLE unrelated(value TEXT)"); db.close();
    } else {
      open(path).close();
      const db = new DatabaseSync(path);
      db.exec(mode === "version" ? "PRAGMA user_version = 2" : "CREATE TRIGGER extra AFTER DELETE ON dispatch_ledger BEGIN SELECT 1; END");
      db.close();
    }
    const before = readFileSync(path);
    expect(() => open(path)).toThrow(/schema|version/);
    expect(readFileSync(path)).toEqual(before);
  });

  it("fails closed on corrupted canonical record bytes, closing the failed ledger store", () => {
    const path = databasePath(), store = open(path);
    store.insertIfAbsent(JSON.stringify(id), '{"version":"1","version":"2"}');
    const before = readFileSync(path);
    expect(() => new DispatchLedger(store)).toThrow();
    expect(() => store.get(JSON.stringify(id))).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it("prunes only eligible resolved records with real conditional deletion", () => {
    const path = databasePath(), store = open(path);
    let clock = Date.parse("2026-09-04T00:00:00.000Z");
    const ledger = new DispatchLedger(store, () => clock, 1000);
    ledger.authorizeDispatch(id, hash, expiry); ledger.resolve(id, "executed", response);
    ledger.authorizeDispatch({ value: "live" }, hash, expiry);
    clock = Date.parse(expiry) + 1000;
    expect(ledger.prune()).toBe(0);
    const [key, stale] = store.entries().find(([key]) => key === JSON.stringify(id))!;
    expect(store.deleteIfMatch(key, stale + " ")).toBe(false);
    clock++;
    expect(ledger.prune()).toBe(1);
    expect(ledger.size()).toBe(1);
  });

  it("ambiguous commit injection retains executing and never returns a grant", () => {
    const path = databasePath(), store = open(path), ledger = new DispatchLedger(store);
    const insert = store.insertIfAbsent.bind(store);
    vi.spyOn(store, "insertIfAbsent").mockImplementation((key, value) => {
      insert(key, value); throw new Error("injected ambiguous commit");
    });
    let calls = 0;
    expect(() => { if (ledger.authorizeDispatch(id, hash, expiry).kind === "absent") calls++; }).toThrow("ambiguous commit");
    expect(calls).toBe(0);
    store.close();
    const restarted = new DispatchLedger(open(path));
    expect(restarted.check(id, hash).kind).toBe("pending");
    expect(restarted.recoverExecuting()).toBe(1);
    expect(restarted.check(id, hash)).toMatchObject({ code: "REPLAY_DETECTED" });
  });

  it("closes database handles on normal close and failed startup", () => {
    const store = open(databasePath());
    store.close(); store.close();
    expect(() => store.entries()).toThrow();
  });

  it("two simultaneous child-process connections transmit to one real target at most once", async () => {
    const path = databasePath(); open(path).close();
    const calls: string[] = [];
    const target = createServer((request, reply) => { calls.push(request.url!); reply.end("synthetic-target-ok"); });
    target.listen(0, "127.0.0.1"); await once(target, "listening");
    try {
      const port = (target.address() as { port: number }).port;
      const a = await launchLedgerChild(path, "race", "http://127.0.0.1:" + port);
      const b = await launchLedgerChild(path, "race", "http://127.0.0.1:" + port);
      const aExit = once(a, "exit"), bExit = once(b, "exit");
      const aResult = nextMessage(a), bResult = nextMessage(b);
      a.send("go"); b.send("go");
      const results = await Promise.all([aResult, bResult]);
      const exits = await Promise.all([aExit, bExit]);
      expect(exits).toEqual([[0, null], [0, null]]);
      expect(calls).toEqual(["/"]);
      expect(results.filter((r: any) => r.kind === "absent")).toHaveLength(1);
      const recovered = new DispatchLedger(open(path)).recoveryFor(id, hash);
      expect(recovered?.response?.executionResult).toEqual({ text: "synthetic-target-ok" });
      console.log(JSON.stringify({ case: "simultaneous processes", pids: [a.pid, b.pid], results, exits, targetCalls: calls.length, path, recovered }));
    } finally { await new Promise<void>(resolve => target.close(() => resolve())); }
  });

  it("kills a process after durable executing, then restarts indeterminate with zero target calls", async () => {
    const path = databasePath(); open(path).close();
    let calls = 0;
    const target = createServer((_request, reply) => { calls++; reply.end("unexpected"); });
    target.listen(0, "127.0.0.1"); await once(target, "listening");
    try {
      const child = await launchLedgerChild(path, "crash", "http://127.0.0.1:" + (target.address() as { port: number }).port);
      const durable = nextMessage(child); child.send("go");
      expect(await durable).toEqual({ kind: "executing" });
      const live = new DispatchLedger(open(path));
      expect(live.check(id, hash).kind).toBe("pending");
      const exited = once(child, "exit"); child.kill("SIGKILL");
      expect(await exited).toEqual([null, "SIGKILL"]);
      live.close();
      const restarted = new DispatchLedger(open(path));
      expect(restarted.recoverExecuting()).toBe(1);
      expect(restarted.recoverExecuting()).toBe(0);
      expect(restarted.authorizeDispatch(id, hash, expiry)).toMatchObject({ code: "REPLAY_DETECTED" });
      expect(calls).toBe(0);
      const recovered = restarted.recoveryFor(id, hash);
      console.log(JSON.stringify({ case: "killed-after-executing", pid: child.pid, signal: "SIGKILL", path, targetCalls: calls, recovered }));
    } finally { await new Promise<void>(resolve => target.close(() => resolve())); }
  });
});

function nextMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Child message timed out")); }, 10000);
    const message = (value: unknown) => { cleanup(); resolve(value); };
    const exit = (code: number | null) => { cleanup(); reject(new Error("Child exited before message: " + code)); };
    function cleanup() { clearTimeout(timeout); child.off("message", message); child.off("exit", exit); }
    child.once("message", message); child.once("exit", exit);
  });
}
async function launchLedgerChild(path: string, mode: string, target: string): Promise<ChildProcess> {
  const file = join(mkdtempSync(join(realpathSync(tmpdir()), "mpas-dispatch-child-")), "child.mjs");
  const moduleUrl = pathToFileURL(await compiledLedgerEntry()).href;
  writeFileSync(file, `
+import { DispatchLedger, FileDispatchJournal } from ${JSON.stringify(moduleUrl)};
+const ledger = new DispatchLedger(new FileDispatchJournal(${JSON.stringify(path)}));
+const id = ${JSON.stringify(id)}, hash = ${JSON.stringify(hash)};
+process.send({kind:"ready"});
+process.once("message", async () => {
+ try {
+  const decision = ledger.authorizeDispatch(id, hash, ${JSON.stringify(expiry)});
+  if (${JSON.stringify(mode)} === "crash") { process.send({kind:"executing"}); return; }
+  if (decision.kind === "absent") {
+   const result = await fetch(${JSON.stringify(target)}, {method:"POST"});
+   ledger.resolve(id, "executed", {...${JSON.stringify(response)}, executionResult: {text: await result.text()}});
+  }
+  ledger.close(); process.send(decision); process.disconnect();
+ } catch(error) { console.error(error); ledger.close(); process.exit(1); }
+});
+`.replace(/^\+/gm, ""));
  const child = fork(file, [], { execArgv: [], cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ["ignore", "inherit", "inherit", "ipc"] });
  children.push(child);
  expect(await nextMessage(child)).toEqual({ kind: "ready" });
  return child;
}
