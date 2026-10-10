import { basename, resolve } from "node:path";
import {
  type Account,
  ensureDir,
  exists,
  handMadeKeyFiles,
  homePaths,
  type HomePaths,
  isRole,
  keyFileText,
  newKeyFile,
  parseMode,
  parseSuite,
  readAccount,
  readKeyFile,
  resolveHome,
  type Role,
  roleDirectories,
  roleTitle,
  type VerifierMode,
} from "./account.js";
import { parseInstallerArgs, type ParsedInstallerArgs } from "./args.js";
import { type InstallerContext, printSettings, say, warn } from "./context.js";
import { InstallerError, usageError } from "./errors.js";
import { checkRegistrationOptions, HARNESS_NAMES, parseHarnessName, registerSigner } from "./harness.js";
import { migrationSteps } from "./layout.js";
import { homeFlag, shellQuote } from "./shell.js";
import { commitChanges, type FileChange } from "./txn.js";
import { DEFAULT_ACTION_URL, DEFAULT_COORDINATION_URL, parseDid, parseUrl } from "./values.js";

const INIT_FLAGS = {
  "--home": "value",
  "--suite": "value",
  "--use-key": "value",
  "--coordination": "value",
  "--action": "value",
  "--mode": "value",
  "--verifier-did": "value",
  "--harness": "value",
  "--harness-home": "value",
  "--skill": "value",
  "--add-role": "boolean",
} as const;

/** Which roles accept each init flag. */
const ROLE_FLAGS: Record<string, Role[]> = {
  "--coordination": ["proposer", "maintainer"],
  "--action": ["proposer", "verifier"],
  "--mode": ["verifier"],
  "--verifier-did": ["proposer"],
  "--harness": ["maintainer"],
  "--harness-home": ["maintainer"],
  "--skill": ["maintainer"],
};

interface RoleValues {
  coordinationUrl?: string;
  actionUrl?: string;
  verifierMode?: VerifierMode;
  verifierDid?: string;
  harness?: string;
  /** True when a signer config already existed and init left it as it was. */
  keptSignerConfig?: boolean;
}

export async function runInit(args: string[], ctx: InstallerContext): Promise<number> {
  const parsed = parseInstallerArgs(args, INIT_FLAGS, "mpas init");
  const role = parsed.positionals[0];
  if (!isRole(role) || parsed.positionals.length !== 1) {
    throw usageError("Usage: mpas init proposer|maintainer|verifier [options]");
  }
  for (const [flag, roles] of Object.entries(ROLE_FLAGS)) {
    if (parsed.values.has(flag) && !roles.includes(role)) {
      throw usageError(`${flag} does not apply to the ${roleTitle(role)} role.`);
    }
  }
  const suite = parseSuite(parsed.values.get("--suite"));
  parseMode(parsed.values.get("--mode"));
  const useKey = parsed.values.get("--use-key");
  if (suite && useKey) throw usageError("--suite and --use-key cannot be combined. An existing key file already has its suite.");
  const paths = homePaths(resolveHome(parsed.values.get("--home"), ctx.deps));
  const account = await readAccount(paths);

  if (!account) {
    const handMade = await handMadeKeyFiles(paths);
    if (handMade.length > 0 && !useKey) {
      throw new InstallerError([
        `${paths.home} has key files but no account.json, so it was set up by hand: ${handMade.join(", ")}.`,
        migrationSteps(paths, ctx.deps, handMade.length === 1 ? shellQuote(handMade[0]) : "<one of those files>"),
        "Or use a different --home for a new account.",
      ].join("\n"));
    }
    const adopted = useKey ? await readKeyFile(resolve(useKey)) : undefined;
    const values = await gatherRoleValues(role, parsed, {}, ctx);
    values.keptSignerConfig = role === "maintainer" && (await exists(paths.signerConfig));
    for (const dir of roleDirectories(paths, role)) await ensureDir(dir);
    const key = adopted?.key ?? (await newKeyFile(suite ?? "Ed25519"));
    const created: Account = { version: "1", type: "MpasAccount", did: key.did, roles: [role] };
    applyValues(created, values);
    await commitChanges(paths, [
      { path: paths.key, contents: adopted?.text ?? keyFileText(key), mode: 0o600 },
      { path: paths.account, contents: json(created), mode: 0o600 },
      ...(await roleFiles(role, paths, created)),
    ], ctx.deps);
    if (adopted) {
      say(ctx, `Adopted the key in ${resolve(useKey!)}. The original file is unchanged.`);
      const others = handMade.filter((path) => resolve(path) !== resolve(useKey!));
      if (others.length > 0) say(ctx, `These key files were left alone and are not active: ${others.map((path) => basename(path)).join(", ")}`);
    }
    say(ctx, `Created an MPAS account for the ${roleTitle(role)} role.`);
    printSettings(ctx, paths, created);
    await finishRole(role, paths, created, values, parsed, ctx);
    return 0;
  }

  if (account.roles.includes(role)) {
    if (useKey) {
      throw new InstallerError(`This account already has the ${roleTitle(role)} role and a key. Replace the key with \`mpas key rotate${homeFlag(paths, ctx.deps)} --use-key <file>\`.`);
    }
    say(ctx, `This home is already initialized for the ${roleTitle(role)} role. Nothing changed.`);
    printSettings(ctx, paths, account);
    say(ctx);
    say(ctx, `Change settings with \`mpas config${homeFlag(paths, ctx.deps)}\`. Replace the key with \`mpas key rotate${homeFlag(paths, ctx.deps)}\`.`);
    return 0;
  }

  if (suite || useKey) {
    throw usageError(`--suite and --use-key apply only when a new account is created. This account already has a key; use \`mpas key rotate${homeFlag(paths, ctx.deps)}\` to replace it.`);
  }
  const question = `Add the ${role} role to this account? It uses the existing key ${account.did}.`;
  if (!parsed.booleans.has("--add-role")) {
    if (!ctx.deps.isTerminal) {
      throw new InstallerError(`This account already has the ${account.roles.join(", ")} role. ${question.replace("?", ".")} Pass --add-role to confirm.`);
    }
    if (!(await ctx.asker.confirm(question))) {
      throw new InstallerError("No change. The role was not added.");
    }
  }
  const values = await gatherRoleValues(role, parsed, account, ctx, homeFlag(paths, ctx.deps));
  values.keptSignerConfig = role === "maintainer" && (await exists(paths.signerConfig));
  for (const dir of roleDirectories(paths, role)) await ensureDir(dir);
  const updated: Account = { ...account, roles: [...account.roles, role] };
  applyValues(updated, values);
  await commitChanges(paths, [{ path: paths.account, contents: json(updated), mode: 0o600 }, ...(await roleFiles(role, paths, updated))], ctx.deps);
  const holdsCredentials = updated.roles.includes("verifier") && updated.roles.includes("proposer");
  if (holdsCredentials) {
    warn(ctx, "this account now has the Proposer and Verifier roles. An agent running as this user can read the upstream credentials stored in this home.");
  }
  say(ctx, `Added the ${roleTitle(role)} role. The key is unchanged.`);
  printSettings(ctx, paths, updated);
  await finishRole(role, paths, updated, values, parsed, ctx);
  return 0;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Files a role adds to the account in the same update as account.json. An existing signer config is never replaced. */
async function roleFiles(role: Role, paths: HomePaths, account: Account): Promise<FileChange[]> {
  if (role !== "maintainer" || (await exists(paths.signerConfig))) return [];
  return [{
    path: paths.signerConfig,
    contents: json({ agent: { did: account.did, keyFile: paths.key }, coordination: { url: account.coordinationUrl } }),
  }];
}

function applyValues(account: Account, values: RoleValues): void {
  if (values.coordinationUrl !== undefined) account.coordinationUrl = values.coordinationUrl;
  if (values.actionUrl !== undefined) account.actionUrl = values.actionUrl;
  if (values.verifierMode !== undefined) account.verifierMode = values.verifierMode;
  if (values.verifierDid !== undefined) account.verifierDid = values.verifierDid;
}

/** Collects the values a role needs. Saved values are kept; only unsaved rows are asked or required. */
async function gatherRoleValues(role: Role, parsed: ParsedInstallerArgs, saved: Partial<Account>, ctx: InstallerContext, home = ""): Promise<RoleValues> {
  const values: RoleValues = {};
  if (role === "proposer" || role === "maintainer") {
    values.coordinationUrl = await savedOrAsked(parsed, "--coordination", "Coordination URL", DEFAULT_COORDINATION_URL, saved.coordinationUrl, ctx, home);
  }
  if (role === "proposer" || role === "verifier") {
    values.actionUrl = await savedOrAsked(parsed, "--action", "Action URL", DEFAULT_ACTION_URL, saved.actionUrl, ctx, home);
  }
  if (role === "verifier") {
    // The mode is optional. Without one, the printed adapter instructions show both commands.
    values.verifierMode = parseMode(parsed.values.get("--mode"));
  }
  if (role === "proposer") {
    const flag = parsed.values.get("--verifier-did");
    if (flag !== undefined) {
      values.verifierDid = parseDid(flag, "--verifier-did");
    } else if (saved.verifierDid === undefined && ctx.deps.isTerminal) {
      values.verifierDid = await ctx.asker.optionalDid("Verifier DID");
    }
  }
  if (role === "maintainer") {
    const flag = parsed.values.get("--harness");
    if (flag !== undefined) {
      values.harness = flag;
    } else if (ctx.deps.isTerminal) {
      values.harness = await ctx.asker.required("Harness", [...HARNESS_NAMES, "none"].join(", "), (answer) => parseHarnessName(answer, true));
    } else {
      throw usageError("--harness is required without a terminal. Use --harness none to register nothing.");
    }
    if (values.harness === "none") {
      if (parsed.values.has("--harness-home") || parsed.values.has("--skill")) {
        throw usageError("--harness-home and --skill do not apply with --harness none.");
      }
    } else {
      checkRegistrationOptions(registrationOptions(values.harness, parsed));
    }
  }
  return values;
}

function registrationOptions(harness: string, parsed: ParsedInstallerArgs) {
  return { harness, harnessHome: parsed.values.get("--harness-home"), skill: parsed.values.get("--skill") };
}

async function savedOrAsked(
  parsed: ParsedInstallerArgs,
  flag: string,
  label: string,
  defaultUrl: string,
  saved: string | undefined,
  ctx: InstallerContext,
  home = "",
): Promise<string | undefined> {
  const value = parsed.values.get(flag);
  if (value !== undefined) {
    const url = parseUrl(value, defaultUrl, flag);
    if (saved !== undefined && saved !== url) {
      throw new InstallerError(`This account already has a ${label} (${saved}). Change it with \`mpas config${home} ${flag} <url>\`.`);
    }
    return url;
  }
  if (saved !== undefined) return undefined;
  if (!ctx.deps.isTerminal) {
    throw usageError(`${flag} is required without a terminal. Use ${flag} local for ${defaultUrl}.`);
  }
  return ctx.asker.url(label, defaultUrl);
}

/** Registers the role's harness entry, if any, and prints its next steps. */
async function finishRole(role: Role, paths: HomePaths, account: Account, values: RoleValues, parsed: ParsedInstallerArgs, ctx: InstallerContext): Promise<void> {
  say(ctx);
  if (role === "maintainer") {
    say(ctx, values.keptSignerConfig
      ? `Signer config left unchanged: ${paths.signerConfig}. \`mpas config validate${homeFlag(paths, ctx.deps)}\` reports whether it uses this account's key.`
      : `Signer config: ${paths.signerConfig}`);
    if (values.harness === "none") {
      say(ctx, "No harness was registered. Review approvals from the terminal with:");
      say(ctx, `  mpas action pending --config ${shellQuote(paths.signerConfig)}`);
      return;
    }
    await registerSigner(ctx, paths, account, registrationOptions(values.harness!, parsed));
    return;
  }
  if (role === "proposer") {
    say(ctx, "Next:");
    say(ctx, "  Send your DID to the Verifier's operator.");
    if (!account.verifierDid) say(ctx, `  Store the Verifier's DID: mpas config${homeFlag(paths, ctx.deps)} --verifier-did <did>`);
    say(ctx, `  Add an application bridge: mpas mcp add${homeFlag(paths, ctx.deps)} --app <app> --harness <harness>`);
    return;
  }
  say(ctx, "Next:");
  say(ctx, `  Add an application: mpas mcp add${homeFlag(paths, ctx.deps)} --app <app>`);
  say(ctx, `  Collect the Proposer and Maintainer DIDs and add them with \`mpas signer add${homeFlag(paths, ctx.deps)}\`.`);
}
