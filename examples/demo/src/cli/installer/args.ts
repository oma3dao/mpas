import { usageError } from "./errors.js";

export type FlagKind = "value" | "boolean";

export interface ParsedInstallerArgs {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

/**
 * Parses one installer command strictly: an option the command does not
 * declare is a usage error, so a mistyped or misplaced flag never runs.
 */
export function parseInstallerArgs(args: string[], spec: Record<string, FlagKind>, command: string): ParsedInstallerArgs {
  const parsed: ParsedInstallerArgs = { positionals: [], values: new Map(), booleans: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }
    const kind = spec[arg];
    if (!kind) {
      throw usageError(`${command} does not accept ${arg}.`);
    }
    if (kind === "boolean") {
      parsed.booleans.add(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`${arg} requires a value.`);
    }
    if (parsed.values.has(arg)) {
      throw usageError(`${arg} may be given only once.`);
    }
    parsed.values.set(arg, value);
    index += 1;
  }
  return parsed;
}
