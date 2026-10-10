import { type Account, exists, homePaths, type HomePaths, parseMode, readJsonFile, requireAccount, resolveHome } from "./account.js";
import { parseInstallerArgs } from "./args.js";
import { type InstallerContext, printSettings, say } from "./context.js";
import { InstallerError, usageError } from "./errors.js";
import { listBridgeConfigs } from "./files.js";
import { assertManagedConfigs } from "./layout.js";
import { homeFlag } from "./shell.js";
import { printAdapterStart, printRestart } from "./runtime.js";
import { commitChanges, type FileChange } from "./txn.js";
import { DEFAULT_ACTION_URL, DEFAULT_COORDINATION_URL, parseDid, parseUrl } from "./values.js";

const CONFIG_FLAGS = {
  "--home": "value",
  "--coordination": "value",
  "--action": "value",
  "--mode": "value",
  "--verifier-did": "value",
} as const;

type Settings = Pick<Account, "coordinationUrl" | "actionUrl" | "verifierMode" | "verifierDid">;

const LABELS: Record<keyof Settings, string> = {
  coordinationUrl: "Coordination URL",
  actionUrl: "Action URL",
  verifierMode: "Mode",
  verifierDid: "Verifier DID",
};

export async function runConfig(args: string[], ctx: InstallerContext): Promise<number> {
  const parsed = parseInstallerArgs(args, CONFIG_FLAGS, "mpas config");
  if (parsed.positionals.length > 0) {
    throw usageError("Usage: mpas config [--coordination <url>] [--action <url>] [--mode direct|relay] [--verifier-did <did>], or mpas config validate [<app>]");
  }
  const paths = homePaths(resolveHome(parsed.values.get("--home"), ctx.deps));
  const account = await requireAccount(paths, homeFlag(paths, ctx.deps));
  const uses = {
    "--coordination": account.roles.includes("proposer") || account.roles.includes("maintainer"),
    "--action": account.roles.includes("proposer") || account.roles.includes("verifier"),
    "--mode": account.roles.includes("verifier"),
    "--verifier-did": account.roles.includes("proposer"),
  };
  for (const [flag, used] of Object.entries(uses)) {
    if (parsed.values.has(flag) && !used) {
      throw usageError(`${flag} does not apply to this account's roles (${account.roles.join(", ")}).`);
    }
  }

  const changes: Settings = {};
  const coordination = parsed.values.get("--coordination");
  const action = parsed.values.get("--action");
  const verifierDid = parsed.values.get("--verifier-did");
  if (coordination !== undefined) changes.coordinationUrl = parseUrl(coordination, DEFAULT_COORDINATION_URL, "--coordination");
  if (action !== undefined) changes.actionUrl = parseUrl(action, DEFAULT_ACTION_URL, "--action");
  changes.verifierMode = parseMode(parsed.values.get("--mode"));
  if (verifierDid !== undefined) changes.verifierDid = parseDid(verifierDid, "--verifier-did");

  if (parsed.values.size === (parsed.values.has("--home") ? 1 : 0)) {
    printSettings(ctx, paths, account);
    if (account.roles.includes("verifier")) {
      say(ctx, "Start the Credential Adapter with:");
      printAdapterStart(ctx, paths, account);
    }
    if (!ctx.deps.isTerminal) return 0;
    say(ctx);
    if (uses["--coordination"]) changes.coordinationUrl = await ctx.asker.url("Coordination URL", DEFAULT_COORDINATION_URL, account.coordinationUrl);
    if (uses["--action"]) changes.actionUrl = await ctx.asker.url("Action URL", DEFAULT_ACTION_URL, account.actionUrl);
    if (uses["--verifier-did"]) changes.verifierDid = await ctx.asker.optionalDid("Verifier DID", account.verifierDid);
  }
  return applySettings(ctx, paths, account, changes);
}

async function applySettings(ctx: InstallerContext, paths: HomePaths, account: Account, changes: Settings): Promise<number> {
  const changed = (Object.keys(changes) as Array<keyof Settings>).filter(
    (key) => changes[key] !== undefined && changes[key] !== account[key],
  );
  if (changed.length === 0) {
    say(ctx, "No change.");
    return 0;
  }
  const updated: Account = { ...account };
  for (const key of changed) Object.assign(updated, { [key]: changes[key] });

  // Read and parse every file this update rewrites before writing any of them.
  const files: FileChange[] = [{ path: paths.account, contents: json(updated), mode: 0o600 }];
  const rewritten: Array<{ path: string; value: Record<string, any> }> = [];
  if (changed.includes("coordinationUrl") && (await exists(paths.signerConfig))) {
    const signer = await readConfig<Record<string, any>>(paths.signerConfig);
    rewritten.push({ path: paths.signerConfig, value: structuredClone(signer) });
    signer.coordination = { ...signer.coordination, url: updated.coordinationUrl };
    files.push({ path: paths.signerConfig, contents: json(signer) });
  }
  if (changed.some((key) => key === "coordinationUrl" || key === "actionUrl" || key === "verifierDid")) {
    for (const bridge of await listBridgeConfigs(paths)) {
      const config = await readConfig<Record<string, any>>(bridge);
      rewritten.push({ path: bridge, value: structuredClone(config) });
      if (changed.includes("coordinationUrl")) config.coordination = { ...config.coordination, url: updated.coordinationUrl };
      if (changed.includes("actionUrl")) config.actionEndpoint = { ...config.actionEndpoint, url: updated.actionUrl };
      if (changed.includes("verifierDid")) config.actionEndpoint = { ...config.actionEndpoint, verifierDid: updated.verifierDid };
      files.push({ path: bridge, contents: json(config) });
    }
  }
  assertManagedConfigs(paths, account, rewritten, ctx.deps);
  await commitChanges(paths, files, ctx.deps);

  for (const file of files.slice(1)) say(ctx, `Updated ${file.path}`);
  for (const key of changed) say(ctx, `${LABELS[key]}: ${updated[key]}`);
  printRestart(ctx, paths, updated, changed.some((key) => key !== "verifierMode"));
  return 0;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readConfig<T>(path: string): Promise<T> {
  try {
    return await readJsonFile<T>(path);
  } catch (error) {
    throw new InstallerError(`Nothing was changed, because ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}
