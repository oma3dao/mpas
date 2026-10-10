import { exists, homePaths, type HomePaths, readJsonFile, requireAccount, resolveHome } from "./account.js";
import { parseInstallerArgs } from "./args.js";
import { type InstallerContext, say, warn } from "./context.js";
import { InstallerError, usageError } from "./errors.js";
import { isPlaceholder, updateJsonFile } from "./files.js";
import { loadRegistry, resolveApplication } from "./registry.js";
import { parseDidJwk } from "./values.js";
import { homeFlag, shellQuote } from "./shell.js";

const SIGNER_FLAGS = {
  "--home": "value",
  "--app": "value",
  "--proposer": "value",
  "--maintainer": "value",
  "--group": "value",
  "--label": "value",
} as const;

const ADD_ONLY = ["--proposer", "--maintainer", "--group", "--label"];
const POLICY_ISSUE = "https://github.com/oma3dao/mpas/issues/6 (oma3dao/mpas#6)";

interface SignerConfig {
  policy: { signerGroups: Record<string, string[]> };
  signerKeys: Array<{ did: string; label?: string; [key: string]: unknown }>;
}

interface Target {
  path: string;
  live: boolean;
}

export async function runSigner(args: string[], ctx: InstallerContext): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "add" && subcommand !== "remove" && subcommand !== "list") {
    throw usageError("Usage: mpas signer add|remove|list --app <app> ...");
  }
  const parsed = parseInstallerArgs(rest, SIGNER_FLAGS, `mpas signer ${subcommand}`);
  if (subcommand !== "add") {
    for (const flag of ADD_ONLY) {
      if (parsed.values.has(flag)) throw usageError(`${flag} applies only to mpas signer add.`);
    }
  }
  const expectedPositionals = subcommand === "remove" ? 1 : 0;
  if (parsed.positionals.length !== expectedPositionals) {
    throw usageError(subcommand === "remove" ? "Usage: mpas signer remove --app <app> <did>" : `Usage: mpas signer ${subcommand} --app <app> ...`);
  }

  const paths = homePaths(resolveHome(parsed.values.get("--home"), ctx.deps));
  const account = await requireAccount(paths, homeFlag(paths, ctx.deps));
  if (!account.roles.includes("verifier")) {
    throw new InstallerError("mpas signer requires the Verifier role. Signer DIDs belong to a Verifier's deployment configs.");
  }
  let app = parsed.values.get("--app");
  if (app === undefined) {
    if (!ctx.deps.isTerminal) throw usageError("--app is required without a terminal.");
    app = await ctx.asker.required("Application", "for example github", (answer) => answer);
  }
  const target = await findDeploymentConfig(paths, app, ctx);

  if (subcommand === "list") return listSigners(ctx, target);
  const home = homeFlag(paths, ctx.deps);
  if (subcommand === "remove") return removeSigner(ctx, target, app, parseDidJwk(parsed.positionals[0], "DID"), home);
  return addSigner(ctx, target, app, parsed.values, home);
}

/** The application's draft when one exists, otherwise its live config. */
async function findDeploymentConfig(paths: HomePaths, app: string, ctx: InstallerContext): Promise<Target> {
  const names = [app];
  try {
    names.push(resolveApplication(await loadRegistry(ctx.deps.registryDir), app).applicationPart);
  } catch {
    // Not in the registry; the name is used as given.
  }
  for (const name of names) {
    if (await exists(paths.draftConfig(name))) return { path: paths.draftConfig(name), live: false };
  }
  for (const name of names) {
    if (await exists(paths.liveConfig(name))) return { path: paths.liveConfig(name), live: true };
  }
  throw new InstallerError(`No deployment config for ${app} in ${paths.config}. Run \`mpas mcp add${homeFlag(paths, ctx.deps)} --app ${shellQuote(app)}\` first.`);
}

async function addSigner(ctx: InstallerContext, target: Target, app: string, values: Map<string, string>, home: string): Promise<number> {
  const proposer = values.get("--proposer");
  const maintainer = values.get("--maintainer");
  if ((proposer === undefined) === (maintainer === undefined)) {
    throw usageError("Pass exactly one of --proposer <did> or --maintainer <did>.");
  }
  if (proposer !== undefined && values.has("--group")) {
    throw usageError("--group applies only to --maintainer. Proposer DIDs always go into proposers.");
  }
  const did = parseDidJwk((proposer ?? maintainer)!, proposer !== undefined ? "--proposer" : "--maintainer");
  const config = await readJsonFile<SignerConfig>(target.path);
  const groups = config.policy?.signerGroups;
  if (!groups || !Array.isArray(groups.all)) {
    throw new InstallerError(`${target.path} has no policy.signerGroups.all. Fix the config by hand or see ${POLICY_ISSUE}.`);
  }
  const group = proposer !== undefined
    ? "proposers"
    : values.get("--group") ?? (Array.isArray(groups.maintainers) ? "maintainers" : "approvers");
  if (!Array.isArray(groups[group])) {
    throw new InstallerError(`${target.path} has no signer group "${group}". This command does not create groups; see ${POLICY_ISSUE}.`);
  }
  if (groups[group].includes(did)) {
    say(ctx, `${did} is already in ${group}. Nothing changed.`);
    return 0;
  }

  const label = values.get("--label") ?? (proposer !== undefined ? "Proposer" : "Maintainer");
  await updateJsonFile<SignerConfig>(target.path, (value) => {
    const signerGroups = value.policy.signerGroups;
    const placeholders = signerGroups[group].filter(isPlaceholder);
    signerGroups[group] = signerGroups[group].filter((entry) => !isPlaceholder(entry));
    for (const placeholder of placeholders) {
      const stillListed = Object.entries(signerGroups).some(([name, members]) => name !== "all" && members.includes(placeholder));
      if (!stillListed) {
        signerGroups.all = signerGroups.all.filter((entry) => entry !== placeholder);
        value.signerKeys = value.signerKeys.filter((key) => key.did !== placeholder);
      }
    }
    signerGroups[group].push(did);
    if (!signerGroups.all.includes(did)) signerGroups.all.push(did);
    if (!value.signerKeys.some((key) => key.did === did)) value.signerKeys.push({ did, label });
  });
  say(ctx, `Added ${did} to ${group} in ${target.path}`);
  finishChange(ctx, target, app, home);
  return 0;
}

async function removeSigner(ctx: InstallerContext, target: Target, app: string, did: string, home: string): Promise<number> {
  const config = await readJsonFile<SignerConfig>(target.path);
  const groups = config.policy?.signerGroups ?? {};
  const listed = Object.values(groups).some((members) => members.includes(did)) || config.signerKeys?.some((key) => key.did === did);
  if (!listed) {
    say(ctx, `${did} is not a signer in ${target.path}. Nothing changed.`);
    return 0;
  }
  const emptied: string[] = [];
  await updateJsonFile<SignerConfig>(target.path, (value) => {
    for (const [name, members] of Object.entries(value.policy.signerGroups)) {
      if (!members.includes(did)) continue;
      value.policy.signerGroups[name] = members.filter((entry) => entry !== did);
      if (value.policy.signerGroups[name].length === 0) emptied.push(name);
    }
    value.signerKeys = value.signerKeys.filter((key) => key.did !== did);
  });
  say(ctx, `Removed ${did} from ${target.path}`);
  for (const name of emptied) {
    warn(ctx, `${name} is now empty. Operations that need ${name} can no longer be approved.`);
  }
  finishChange(ctx, target, app, home);
  return 0;
}

async function listSigners(ctx: InstallerContext, target: Target): Promise<number> {
  const config = await readJsonFile<SignerConfig>(target.path);
  const labels = new Map((config.signerKeys ?? []).map((key) => [key.did, key.label]));
  say(ctx, `${target.path} (${target.live ? "live" : "draft"})`);
  for (const [name, members] of Object.entries(config.policy?.signerGroups ?? {})) {
    say(ctx, `${name}:`);
    if (members.length === 0) say(ctx, "  (empty)");
    for (const member of members) {
      if (isPlaceholder(member)) {
        say(ctx, `  ${member} (placeholder)`);
      } else {
        const label = labels.get(member);
        say(ctx, label ? `  ${member} ${label}` : `  ${member}`);
      }
    }
  }
  return 0;
}

function finishChange(ctx: InstallerContext, target: Target, app: string, home: string): void {
  if (target.live) {
    say(ctx, "This is the live config. Restart the Credential Adapter to apply the change.");
  }
  say(ctx, `Check it with: mpas config validate${home} ${shellQuote(app)}`);
}
