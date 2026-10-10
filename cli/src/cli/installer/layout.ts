import { resolve } from "node:path";
import type { Account, HomePaths } from "./account.js";
import { InstallerError } from "./errors.js";
import type { InstallerDependencies } from "./deps.js";
import { homeFlag } from "./shell.js";

interface AgentConfig {
  agent?: { did?: string; keyFile?: string };
}

/** The steps that bring a home set up by hand into the managed layout without changing its DID. */
export function migrationSteps(paths: HomePaths, deps: InstallerDependencies, keyFileHint = "<this participant's key file>"): string {
  const home = homeFlag(paths, deps);
  return [
    "To bring the home into the managed layout without changing its DID:",
    `  1. Back up ${paths.home} and stop the processes that use it.`,
    `  2. Keep the participant's existing key at ${paths.key}. For a home without account.json, run \`mpas init <role>${home} --use-key ${keyFileHint}\`, which copies the key there; if the key is already there, pass that path.`,
    `  3. Point each bridge and signer config at that key: agent.keyFile ${paths.key} and agent.did the account's DID. Or regenerate a bridge config with \`mpas mcp add${home} --app <app> --replace-config\`. A config that belongs to another participant moves to that participant's own home.`,
    `  4. Run \`mpas config validate${home}\`, then restart the processes.`,
  ].join("\n");
}

/**
 * Refuses an update that would rewrite a bridge or signer config outside the
 * managed layout: every such config must use this account's key file and DID.
 */
export function assertManagedConfigs(paths: HomePaths, account: Account, configs: Array<{ path: string; value: AgentConfig }>, deps: InstallerDependencies): void {
  const problems: string[] = [];
  for (const { path, value } of configs) {
    const keyFile = value.agent?.keyFile;
    if (!keyFile || resolve(keyFile) !== paths.key) problems.push(`  ${path}: agent.keyFile is ${keyFile ?? "(missing)"}`);
    if (value.agent?.did !== account.did) problems.push(`  ${path}: agent.did is ${value.agent?.did ?? "(missing)"}`);
  }
  if (problems.length === 0) return;
  throw new InstallerError([
    `Nothing was changed. These configs do not use this account's key (${paths.key}, DID ${account.did}):`,
    ...problems,
    migrationSteps(paths, deps),
  ].join("\n"));
}
