import { chmodSync, closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import type { DispatchStore } from "@oma3/mpas";

export { DispatchLedger, MemoryDispatchStore, MemoryDispatchStore as MemoryDispatchJournal } from "@oma3/mpas";
export type { DispatchStore, DispatchRecord, DispatchResolution, DispatchRecovery, LedgerCheck } from "@oma3/mpas";

const SCHEMA = "CREATE TABLE dispatch_ledger(action_key TEXT PRIMARY KEY, record TEXT NOT NULL)";

/**
 * Reference durable byte store. The historical construction name and configured
 * filename are retained. The store rejects nonempty JSONL; it never converts it.
 * Daemon startup first moves aside a legacy journal whose Actions have all
 * expired (retireExpiredLegacyJournal).
 * Requires built-in SQLite (unflagged Node 22.13+, tested on Node 22.22.3).
 */
export class FileDispatchJournal implements DispatchStore {
  private readonly db: Database;
  private closed = false;

  constructor(path: string) {
    let DatabaseSync: typeof Database;
    try {
      DatabaseSync = (createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
      if (typeof DatabaseSync !== "function") throw new Error("DatabaseSync is unavailable.");
    } catch (error) {
      throw new Error("The durable dispatch backend requires Node built-in SQLite (Node 22.13+).", { cause: error });
    }
    validateDatabasePath(path);
    const existed = existsSync(path);
    // O_NOFOLLOW rejects a final-component symlink, including a dangling one.
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    let empty: boolean;
    try {
      empty = statSync(path).size === 0;
      if (!empty) {
        const header = Buffer.alloc(16);
        if (readSync(fd, header, 0, 16, 0) !== 16 || header.toString("binary") !== "SQLite format 3\0") {
          throw new Error("Nonempty legacy or invalid dispatch database; migration is not supported.");
        }
      }
    } finally { closeSync(fd); }

    const db = new DatabaseSync(path);
    this.db = db;
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      // Read the existing schema before any persistent PRAGMA or schema write.
      // An unrelated SQLite database must remain unchanged.
      if (!empty) this.validateSchema();
      db.exec("PRAGMA journal_mode = DELETE");
      db.exec("PRAGMA synchronous = EXTRA");
      db.exec("PRAGMA fullfsync = ON");
      for (const [pragma, expected] of [["journal_mode", "delete"], ["synchronous", 3], ["fullfsync", 1], ["busy_timeout", 5000]] as const) {
        const row = db.prepare(`PRAGMA ${pragma}`).get();
        if (!row || Object.values(row)[0] !== expected) throw new Error(`Dispatch SQLite did not enforce ${pragma}.`);
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const schema = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
        const version = db.prepare("PRAGMA user_version").get()?.user_version;
        if (empty && schema.length === 0 && version === 0) {
          db.exec(SCHEMA);
          db.exec("PRAGMA user_version = 1");
        }
        this.validateSchema();
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
      if (!existed) chmodSync(path, 0o600);
    } catch (error) {
      db.close();
      this.closed = true;
      throw error;
    }
  }

  get(key: string): string | undefined {
    const row = this.db.prepare("SELECT record FROM dispatch_ledger WHERE action_key = ?").get(key);
    return row ? row.record as string : undefined;
  }

  insertIfAbsent(key: string, value: string): boolean {
    return this.db.prepare("INSERT INTO dispatch_ledger(action_key, record) VALUES (?, ?) ON CONFLICT(action_key) DO NOTHING")
      .run(key, value).changes === 1;
  }

  compareAndSwap(key: string, expected: string, value: string): boolean {
    return this.db.prepare("UPDATE dispatch_ledger SET record = ? WHERE action_key = ? AND record = ?")
      .run(value, key, expected).changes === 1;
  }

  entries(): ReadonlyArray<[string, string]> {
    return this.db.prepare("SELECT action_key, record FROM dispatch_ledger ORDER BY action_key").all()
      .map(row => [row.action_key as string, row.record as string]);
  }

  deleteIfMatch(key: string, expected: string): boolean {
    return this.db.prepare("DELETE FROM dispatch_ledger WHERE action_key = ? AND record = ?")
      .run(key, expected).changes === 1;
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private validateSchema(): void {
    const objects = this.db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (this.db.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
        objects.length !== 1 || objects[0].type !== "table" ||
        objects[0].name !== "dispatch_ledger" || objects[0].sql !== SCHEMA) {
      throw new Error("Unknown dispatch SQLite schema or version; migration is not supported.");
    }
  }
}

/**
 * Host startup step for a journal path that still holds the JSONL event log of
 * an earlier adapter. That log is not converted. Its records only block replay
 * until each recorded Action Envelope expires, and an expired envelope is
 * rejected before any dispatch. Once every recorded Action has expired, the file
 * is moved aside (never deleted) and the new path is returned, so the SQLite
 * store can start. Otherwise startup is refused and the file is left unchanged.
 * Absent, empty, SQLite, symlinked and relative paths are left to
 * FileDispatchJournal, which validates them.
 */
export function retireExpiredLegacyJournal(path: string, now: number): string | undefined {
  if (!isAbsolute(path) || resolve(path) !== path) return undefined;
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.size === 0) return undefined;
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 16).toString("binary") === "SQLite format 3\0") return undefined;

  let latestExpiry = Number.NEGATIVE_INFINITY;
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event: { event?: unknown; expiresAt?: unknown } | null;
    try { event = JSON.parse(line) as { event?: unknown; expiresAt?: unknown } | null; } catch { event = null; }
    if (event?.event === "resolved") continue;
    const expiry = event?.event === "executing" && typeof event.expiresAt === "string" ? Date.parse(event.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiry)) {
      throw new Error(`Dispatch journal ${path} is neither a dispatch database nor a readable legacy JSONL journal. Startup refused; the file is unchanged.`);
    }
    latestExpiry = Math.max(latestExpiry, expiry);
  }
  if (!(now > latestExpiry)) {
    throw new Error(`Legacy JSONL dispatch journal ${path} still blocks replay of Actions that expire at ${new Date(latestExpiry).toISOString()}. ` +
      "Startup refused; the file is unchanged. Start again after that time and the file will be moved aside.");
  }
  const archived = `${path}.legacy-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
  linkSync(path, archived); // Fails rather than overwrite an existing file.
  unlinkSync(path);
  return archived;
}

/** Private new directories; no symlink traversal, device, URL or memory database. */
function validateDatabasePath(path: string): void {
  if (!path || !isAbsolute(path) || path.includes("\0") || resolve(path) !== path) throw new Error("Invalid dispatch database path.");
  const parent = dirname(path);
  let current = "/";
  for (const part of parent.split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid dispatch database directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Invalid dispatch database file.");
  }
}
