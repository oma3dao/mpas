import { chmod, copyFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir, exists, type HomePaths } from "./account.js";
import type { InstallerDependencies } from "./deps.js";
import { InstallerError } from "./errors.js";

/** One file a multi-file update creates or replaces. */
export interface FileChange {
  path: string;
  contents: string | Uint8Array;
  mode?: number;
}

interface PendingUpdate {
  version: "1";
  type: "MpasPendingUpdate";
  /** True once every rename completed, so recovery finishes the update instead of undoing it. */
  committed: boolean;
  files: Array<{ path: string; existed: boolean }>;
}

const staged = (path: string) => `${path}.mpas-new`;
const kept = (path: string) => `${path}.mpas-old`;

/** Writes the marker through a temporary file and a rename, so it is never partly written. */
async function writeMarker(paths: HomePaths, update: PendingUpdate, deps: InstallerDependencies): Promise<void> {
  (deps.failpoint ?? (() => {}))("marker", paths.updateMarker);
  const temp = `${paths.updateMarker}.tmp`;
  await writeFile(temp, `${JSON.stringify(update, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, paths.updateMarker);
}

/**
 * Commits several files together. Every new file is written beside its
 * target first, each replaced file is kept as a copy, and a marker records the
 * set before any rename. A failure undoes what was committed; a process that
 * stops part way is recovered by `recoverInterruptedUpdate`. Callers read and
 * parse every file they rewrite before building the changes.
 */
export async function commitChanges(paths: HomePaths, changes: FileChange[], deps: InstallerDependencies): Promise<void> {
  const fail = deps.failpoint ?? (() => {});
  const files = await Promise.all(changes.map(async (change) => ({ change, existed: await exists(change.path) })));
  const cleanupStaged = async () => {
    for (const { change } of files) await rm(staged(change.path), { force: true });
  };
  const cleanupKept = async () => {
    for (const { change } of files) await rm(kept(change.path), { force: true });
  };

  try {
    for (const { change, existed } of files) {
      fail("stage", change.path);
      await ensureDir(dirname(change.path));
      const mode = change.mode ?? (existed ? (await stat(change.path)).mode & 0o777 : 0o644);
      await writeFile(staged(change.path), change.contents, { mode });
      await chmod(staged(change.path), mode);
    }
    for (const { change, existed } of files) {
      if (!existed) continue;
      fail("backup", change.path);
      await copyFile(change.path, kept(change.path));
      await chmod(kept(change.path), (await stat(change.path)).mode & 0o777);
    }
  } catch (error) {
    await cleanupStaged();
    await cleanupKept();
    throw error;
  }

  const update: PendingUpdate = {
    version: "1",
    type: "MpasPendingUpdate",
    committed: false,
    files: files.map(({ change, existed }) => ({ path: change.path, existed })),
  };
  try {
    await writeMarker(paths, update, deps);
  } catch (error) {
    await cleanupStaged();
    await cleanupKept();
    await rm(`${paths.updateMarker}.tmp`, { force: true });
    await rm(paths.updateMarker, { force: true });
    throw error;
  }
  try {
    for (const { change } of files) {
      fail("commit", change.path);
      await rename(staged(change.path), change.path);
    }
    await writeMarker(paths, { ...update, committed: true }, deps);
  } catch (error) {
    // Undo every rename, including when only the finished-commit record failed, so the home matches the marker's absence.
    await rollBack(update);
    await rm(`${paths.updateMarker}.tmp`, { force: true });
    await rm(paths.updateMarker, { force: true });
    throw error;
  }
  await cleanupKept();
  await rm(paths.updateMarker, { force: true });
}

async function rollBack(update: PendingUpdate): Promise<void> {
  for (const file of update.files) {
    if (file.existed) {
      if (await exists(kept(file.path))) await rename(kept(file.path), file.path);
    } else {
      await rm(file.path, { force: true });
    }
    await rm(staged(file.path), { force: true });
  }
}

/** Undoes, or finishes, an update a stopped process left behind. Returns a message when it did either. */
export async function recoverInterruptedUpdate(paths: HomePaths): Promise<string | undefined> {
  await rm(`${paths.updateMarker}.tmp`, { force: true });
  if (!(await exists(paths.updateMarker))) return undefined;
  let update: PendingUpdate;
  try {
    update = JSON.parse(await readFile(paths.updateMarker, "utf8")) as PendingUpdate;
    if (!Array.isArray(update.files)) throw new Error("no file list");
  } catch {
    const copies = (await readdir(paths.home, { recursive: true }))
      .map(String)
      .filter((name) => name.endsWith(".mpas-old"))
      .map((name) => join(paths.home, name));
    throw new InstallerError([
      `The update marker ${paths.updateMarker} cannot be read, so an interrupted update cannot be recovered automatically.`,
      copies.length > 0
        ? `Each of these copies holds a file's earlier contents. Rename each over the file without the .mpas-old ending: ${copies.join(", ")}.`
        : "No kept copies were found, so no file was replaced before the interruption.",
      `Then delete ${paths.updateMarker} and any files ending in .mpas-new.`,
    ].join("\n"));
  }
  if (update.committed) {
    for (const file of update.files) {
      await rm(kept(file.path), { force: true });
      await rm(staged(file.path), { force: true });
    }
    await rm(paths.updateMarker, { force: true });
    return `An interrupted update was completed: ${update.files.length} file(s) already had their new contents.`;
  }
  await rollBack(update);
  await rm(paths.updateMarker, { force: true });
  return `An interrupted update was rolled back: ${update.files.length} file(s) restored to their earlier contents.`;
}
