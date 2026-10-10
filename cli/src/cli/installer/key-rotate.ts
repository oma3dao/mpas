import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Account,
  exists,
  homePaths,
  type KeyFile,
  keyFileText,
  keySuite,
  newKeyFile,
  parseSuite,
  readJsonFile,
  readKeyFile,
  requireAccount,
  resolveHome,
  timestamp,
} from "./account.js";
import { parseInstallerArgs } from "./args.js";
import { type InstallerContext, say } from "./context.js";
import { InstallerError, usageError } from "./errors.js";
import { listBridgeConfigs } from "./files.js";
import { assertManagedConfigs } from "./layout.js";
import { homeFlag } from "./shell.js";
import { printAdapterStart } from "./runtime.js";
import { commitChanges, type FileChange } from "./txn.js";

const ROTATE_FLAGS = { "--home": "value", "--suite": "value", "--use-key": "value" } as const;

export async function runKeyRotate(args: string[], ctx: InstallerContext): Promise<number> {
  const parsed = parseInstallerArgs(args, ROTATE_FLAGS, "mpas key rotate");
  if (parsed.positionals.length > 0) throw usageError("Usage: mpas key rotate [--suite Ed25519|P-256 | --use-key <key-file>]");
  const suite = parseSuite(parsed.values.get("--suite"));
  const useKey = parsed.values.get("--use-key");
  if (suite && useKey) throw usageError("--suite and --use-key cannot be combined. A replacement key file already has its suite.");

  const paths = homePaths(resolveHome(parsed.values.get("--home"), ctx.deps));
  const account = await requireAccount(paths, homeFlag(paths, ctx.deps));
  const currentText = await readFile(paths.key, "utf8");
  const current = JSON.parse(currentText) as KeyFile;
  let next: KeyFile;
  let nextText: string;
  if (useKey) {
    ({ key: next, text: nextText } = await readKeyFile(resolve(useKey)));
    if (next.did === current.did) {
      throw new InstallerError(`${resolve(useKey)} holds the current key. Use a new key made with \`mpas key generate\`.`);
    }
  } else {
    next = await newKeyFile(suite ?? keySuite(current));
    nextText = keyFileText(next);
  }

  // Read and parse every config that names the DID before writing anything.
  const updated: Account = { ...account, did: next.did };
  const retired = join(paths.keys, `signing-key.retired-${timestamp(ctx.deps)}.json`);
  const files: FileChange[] = [
    { path: retired, contents: currentText, mode: 0o600 },
    { path: paths.key, contents: nextText, mode: 0o600 },
    { path: paths.account, contents: json(updated), mode: 0o600 },
  ];
  const configs = [...((await exists(paths.signerConfig)) ? [paths.signerConfig] : []), ...(await listBridgeConfigs(paths))];
  const rewritten: Array<{ path: string; value: { agent?: { did?: string; keyFile?: string } } }> = [];
  for (const config of configs) {
    let value: { agent?: { did?: string; keyFile?: string } };
    try {
      value = await readJsonFile<{ agent?: { did?: string; keyFile?: string } }>(config);
    } catch (error) {
      throw new InstallerError(`Nothing was changed, because ${config} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    rewritten.push({ path: config, value: structuredClone(value) });
    value.agent = { ...value.agent, did: next.did };
    files.push({ path: config, contents: json(value) });
  }
  assertManagedConfigs(paths, account, rewritten, ctx.deps);
  await commitChanges(paths, files, ctx.deps);
  if (useKey) await rm(resolve(useKey));

  say(ctx, "Rotated the signing key. The switch is immediate.");
  say(ctx, `Old DID: ${current.did}`);
  say(ctx, `New DID: ${next.did}`);
  say(ctx, `Retired key (kept): ${retired}`);
  for (const config of configs) say(ctx, `Updated agent.did in ${config}`);
  printProcedure(ctx, paths, updated);
  return 0;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The stop, rotate, and restart procedure for the account's roles. Running processes keep the key they loaded at start. */
function printProcedure(ctx: InstallerContext, paths: ReturnType<typeof homePaths>, account: Account): void {
  const agent = account.roles.includes("proposer") || account.roles.includes("maintainer");
  const verifier = account.roles.includes("verifier");
  say(ctx);
  say(ctx, "Rotation procedure. Running processes keep the key they loaded at start.");
  say(ctx, "  Before rotating: let pending work finish, then stop what uses the key.");
  if (agent) {
    say(ctx, "    Proposer or Maintainer: let submitted Actions and reviews in progress finish, then close the harness sessions that run this account's bridges or signer server.");
  }
  if (verifier) say(ctx, "    Verifier: drain in-flight relay deliveries, then stop the Credential Adapter.");
  say(ctx, "  After rotating, which is now:");
  if (agent) say(ctx, "    Start the harness sessions again, so the bridges and signer server load the new key.");
  if (verifier) {
    say(ctx, "    Start the Credential Adapter again. Its relay state file is named for the new DID:");
    printAdapterStart(ctx, paths, account, "      ");
  }
  say(ctx);
  say(ctx, "Follow-up:");
  if (agent) {
    say(ctx, "  Each Verifier that lists this account, and the coordination operator (for example signerset.com),");
    say(ctx, "  must record the new DID. Until they do, actions and approvals signed with the new key are rejected.");
    say(ctx, "  Each Verifier's operator removes the old DID with `mpas signer remove` once no pending Action depends on it,");
    say(ctx, "  and adds the new one with `mpas signer add`.");
  }
  if (verifier) {
    say(ctx, `  Each Proposer that uses this Verifier must run: mpas config --verifier-did ${account.did}`);
  }
  say(ctx, `  To rotate without that gap next time, create the key first with \`mpas key generate\`, register its DID, then run \`mpas key rotate${homeFlag(paths, ctx.deps)} --use-key <file>\`.`);
}
