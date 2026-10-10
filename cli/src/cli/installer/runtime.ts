import type { Account, HomePaths, VerifierMode } from "./account.js";
import { type InstallerContext, say } from "./context.js";
import { homeFlag, shellQuote } from "./shell.js";

/** The `mpas adapter start` command for a Verifier in one mode. The mode, not the URL's host, decides the relay flags. */
export function adapterStartLines(paths: HomePaths, account: Account, mode: VerifierMode): string[] {
  const lines = [
    "mpas adapter start",
    `--config-dir ${shellQuote(paths.config)}`,
    `--credential-dir ${shellQuote(paths.credentials)}`,
    `--adapter-key ${shellQuote(paths.key)}`,
    `--journal-path ${shellQuote(paths.ledger)}`,
  ];
  if (mode === "relay" && account.actionUrl) {
    lines.push(
      `--verifier-relay-url ${shellQuote(account.actionUrl)}`,
      `--verifier-relay-state ${shellQuote(paths.relayState(account.actionUrl, account.did))}`,
    );
  }
  return lines;
}

function printCommand(ctx: InstallerContext, lines: string[], indent: string): void {
  say(ctx, `${indent}${lines.join(` \\\n${indent}  `)}`);
}

/** Prints the command for the saved mode, or both commands when no mode is saved. */
export function printAdapterStart(ctx: InstallerContext, paths: HomePaths, account: Account, indent = "  "): void {
  const directNote = `Proposers submit to this adapter at ${account.actionUrl}. It listens on 127.0.0.1:7544 unless you add --host and --port.`;
  if (account.verifierMode === "relay") {
    printCommand(ctx, adapterStartLines(paths, account, "relay"), indent);
  } else if (account.verifierMode === "direct") {
    printCommand(ctx, adapterStartLines(paths, account, "direct"), indent);
    say(ctx, `${indent}${directNote}`);
  } else {
    say(ctx, `${indent}No mode is saved, so both commands are shown. Record your choice with: mpas config${homeFlag(paths, ctx.deps)} --mode direct|relay`);
    say(ctx, `${indent}If Proposers submit to this adapter directly at ${account.actionUrl}:`);
    printCommand(ctx, adapterStartLines(paths, account, "direct"), `${indent}  `);
    say(ctx, `${indent}  It listens on 127.0.0.1:7544 unless you add --host and --port.`);
    say(ctx, `${indent}If this adapter polls a relay at ${account.actionUrl}:`);
    printCommand(ctx, adapterStartLines(paths, account, "relay"), `${indent}  `);
  }
}

/** Says which running processes must restart to pick up a changed URL, mode, or key. */
export function printRestart(ctx: InstallerContext, paths: HomePaths, account: Account, serviceChanged = false): void {
  say(ctx);
  if (serviceChanged) {
    say(ctx, "If this moves the account to a different Coordination service, Action service, or Verifier, let pending work finish first, before restarting: running processes keep using the old one until they restart.");
  }
  say(ctx, "Running processes read this only at start:");
  if (account.roles.includes("proposer") || account.roles.includes("maintainer")) {
    say(ctx, "  Restart the harness sessions that run this account's bridges or signer server.");
  }
  if (account.roles.includes("verifier")) {
    say(ctx, "  Restart the Credential Adapter with:");
    printAdapterStart(ctx, paths, account, "    ");
  }
}
