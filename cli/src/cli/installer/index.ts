import { existsSync } from "node:fs";
import type { CliIo, CliResult } from "../index.js";
import { homePaths, resolveHome } from "./account.js";
import { runConfig } from "./config.js";
import { createContext, type InstallerContext } from "./context.js";
import { defaultInstallerDependencies, type InstallerDependencies } from "./deps.js";
import { InstallerError } from "./errors.js";
import { runInit } from "./init.js";
import { runKeyRotate } from "./key-rotate.js";
import { acquireHomeLock } from "./lock.js";
import { runMcpAdd } from "./mcp-add.js";
import { runSigner } from "./signer.js";
import { recoverInterruptedUpdate } from "./txn.js";
import { runValidate } from "./validate.js";

export type { InstallerDependencies } from "./deps.js";

type InstallerCommand = (args: string[], ctx: InstallerContext) => Promise<number>;

const INSTALLER_ROOTS = new Set(["init", "config", "key", "mcp", "signer"]);
const LEGACY_VALIDATE_FLAGS = ["--config-dir", "--credential-dir", "--bridge-dir"];

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Returns the installer command for these arguments, or undefined when another CLI command handles them. */
function selectCommand(args: string[], deps: InstallerDependencies): { command: InstallerCommand; rest: string[] } | undefined {
  const [first, second] = args;
  if (first === "init") return { command: runInit, rest: args.slice(1) };
  if (first === "signer") return { command: runSigner, rest: args.slice(1) };
  if (first === "key" && second === "rotate") return { command: runKeyRotate, rest: args.slice(2) };
  if (first === "mcp" && second === "add") return { command: runMcpAdd, rest: args.slice(2) };
  if (first === "config" && second === "validate") {
    // The original command keeps its meaning whenever its flags or environment select the configs.
    if (LEGACY_VALIDATE_FLAGS.some((flag) => args.includes(flag))) return undefined;
    if (deps.env.MPAS_CONFIG_DIR || deps.env.MPAS_CREDENTIAL_DIR) return undefined;
    const paths = homePaths(resolveHome(flagValue(args, "--home"), deps));
    return existsSync(paths.account) ? { command: runValidate, rest: args.slice(2) } : undefined;
  }
  if (first === "config" && (second === undefined || second.startsWith("--"))) return { command: runConfig, rest: args.slice(1) };
  return undefined;
}

/**
 * Runs `mpas init`, `mpas config`, `mpas config validate`, `mpas key rotate`,
 * `mpas mcp add`, and `mpas signer`. Returns undefined for every other command.
 */
export async function runInstallerCommand(
  args: string[],
  io: CliIo,
  overrides: Partial<InstallerDependencies> | undefined,
): Promise<CliResult | undefined> {
  if (!INSTALLER_ROOTS.has(args[0] ?? "")) return undefined;
  const deps = { ...defaultInstallerDependencies(), ...overrides };
  const selected = selectCommand(args, deps);
  if (!selected) return undefined;
  const ctx = createContext(deps, io);
  const paths = homePaths(resolveHome(flagValue(args, "--home"), deps));
  let release: (() => Promise<void>) | undefined;
  try {
    // One command at a time per home. A home that does not exist yet has nothing to protect, except from init.
    if (selected.command === runInit || existsSync(paths.home)) {
      release = await acquireHomeLock(paths, deps);
      const recovered = await recoverInterruptedUpdate(paths);
      if (recovered) io.stderr.write(`Note: ${recovered}\n`);
    }
    return { exitCode: await selected.command(selected.rest, ctx) };
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: error instanceof InstallerError ? error.exitCode : 1 };
  } finally {
    await release?.();
  }
}
