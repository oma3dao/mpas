import { readFile, rm, writeFile } from "node:fs/promises";
import { ensureDir, type HomePaths } from "./account.js";
import type { InstallerDependencies } from "./deps.js";
import { InstallerError } from "./errors.js";

interface LockRecord {
  pid: number;
  startedAt: string;
}

async function readLock(path: string): Promise<{ text: string; record?: LockRecord } | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return { text, record: JSON.parse(text) as LockRecord };
  } catch {
    return { text };
  }
}

/**
 * Takes the home's lock so only one `mpas` command works on it at a time.
 * A lock held by a running process stops the command; one left by a process
 * that is no longer running is removed. Returns the release function.
 */
export async function acquireHomeLock(paths: HomePaths, deps: InstallerDependencies): Promise<() => Promise<void>> {
  await ensureDir(paths.home);
  const mine = `${JSON.stringify({ pid: deps.pid, startedAt: deps.now().toISOString() } satisfies LockRecord)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(paths.lock, mine, { flag: "wx", mode: 0o600 });
      return async () => {
        const current = await readLock(paths.lock);
        if (current?.text === mine) await rm(paths.lock, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = await readLock(paths.lock);
    if (!held) continue;
    const pid = held.record?.pid;
    if (typeof pid === "number" && pid !== deps.pid && deps.isProcessAlive(pid)) {
      throw new InstallerError(
        `Another mpas command (process ${pid}) is updating ${paths.home}. Run one command at a time; try again when it finishes.`,
      );
    }
    // The holder is gone. Remove its lock only if it is still the same file, so a lock another command just took survives.
    const again = await readLock(paths.lock);
    if (again?.text === held.text) await rm(paths.lock, { force: true });
  }
  throw new InstallerError(`Could not take the lock on ${paths.home}. Another mpas command may be starting; try again.`);
}
