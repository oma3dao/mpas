import { join, resolve } from "node:path";
import type { HomePaths } from "./account.js";
import type { InstallerDependencies } from "./deps.js";

const SAFE = /^[A-Za-z0-9_/.:=@%+,-]+$/;

/** Quotes one argument for a POSIX shell, only when it needs it, so ordinary paths stay readable. */
export function shellQuote(arg: string): string {
  return SAFE.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * ` --home <home>` for a printed command that acts on this account. It is left
 * out only for ~/.mpas with $MPAS_HOME unset, the one case where a bare command
 * finds the same account in this shell and in a new one. Commands meant for
 * another participant never use it.
 */
export function homeFlag(paths: HomePaths, deps: InstallerDependencies): string {
  const plainDefault = paths.home === resolve(join(deps.homedir, ".mpas")) && !deps.env.MPAS_HOME;
  return plainDefault ? "" : ` --home ${shellQuote(paths.home)}`;
}
