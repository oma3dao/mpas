import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Account,
  ensureDir,
  exists,
  homePaths,
  type HomePaths,
  isRole,
  requireAccount,
  resolveHome,
  type Role,
  timestamp,
} from "./account.js";
import { parseInstallerArgs, type ParsedInstallerArgs } from "./args.js";
import { type InstallerContext, say } from "./context.js";
import { InstallerError, usageError } from "./errors.js";
import {
  bridgeEntry,
  checkRegistrationOptions,
  finishAgentSetup,
  HARNESS_NAMES,
  parseHarnessName,
  registerServer,
  registerSigner,
} from "./harness.js";
import { fetchVerifiedPlugin, fetchVerifiedTemplate, requireBridge, type ResolvedInstall, resolveInstall } from "./install-data.js";
import { printAdapterStart } from "./runtime.js";
import { homeFlag, shellQuote } from "./shell.js";
import { commitChanges, type FileChange } from "./txn.js";

const MCP_ADD_FLAGS = {
  "--home": "value",
  "--role": "value",
  "--app": "value",
  "--harness": "value",
  "--harness-home": "value",
  "--skill": "value",
  "--plugin": "value",
  "--config-template": "value",
  "--replace-config": "boolean",
} as const;

const NOT_FOR: Record<Role, string[]> = {
  maintainer: ["--app", "--plugin", "--config-template", "--replace-config"],
  proposer: ["--config-template"],
  verifier: ["--harness", "--harness-home", "--skill"],
};

export async function runMcpAdd(args: string[], ctx: InstallerContext): Promise<number> {
  const parsed = parseInstallerArgs(args, MCP_ADD_FLAGS, "mpas mcp add");
  if (parsed.positionals.length > 0) throw usageError("Usage: mpas mcp add [--role <role>] [--app <app>] [--harness <harness>] [options]");
  const paths = homePaths(resolveHome(parsed.values.get("--home"), ctx.deps));
  const account = await requireAccount(paths, homeFlag(paths, ctx.deps));
  const role = await selectRole(parsed, account, ctx);
  for (const flag of NOT_FOR[role]) {
    if (parsed.values.has(flag) || parsed.booleans.has(flag)) {
      throw usageError(`${flag} does not apply to the ${role} role in mpas mcp add.`);
    }
  }
  if (role === "maintainer") {
    const harness = await harnessFlagOrAsk(parsed, ctx);
    await registerSigner(ctx, paths, account, {
      harness,
      harnessHome: parsed.values.get("--harness-home"),
      skill: parsed.values.get("--skill"),
    });
    return 0;
  }
  if (role === "proposer") return addProposerBridge(ctx, paths, account, parsed);
  return addVerifierApplication(ctx, paths, account, parsed);
}

async function selectRole(parsed: ParsedInstallerArgs, account: Account, ctx: InstallerContext): Promise<Role> {
  const flag = parsed.values.get("--role");
  if (flag !== undefined) {
    if (!isRole(flag)) throw usageError("--role must be proposer, maintainer, or verifier.");
    if (!account.roles.includes(flag)) throw new InstallerError(`This account does not have the ${flag} role.`);
    return flag;
  }
  if (account.roles.length === 1) return account.roles[0];
  if (!ctx.deps.isTerminal) throw usageError(`This account has more than one role (${account.roles.join(", ")}). Pass --role.`);
  return (await ctx.asker.required("Role", account.roles.join(", "), (answer) => {
    if (!isRole(answer) || !account.roles.includes(answer)) throw usageError(`Choose one of: ${account.roles.join(", ")}.`);
    return answer;
  })) as Role;
}

async function appFlagOrAsk(parsed: ParsedInstallerArgs, ctx: InstallerContext): Promise<string> {
  const flag = parsed.values.get("--app");
  if (flag !== undefined) return flag;
  if (!ctx.deps.isTerminal) throw usageError("--app is required without a terminal.");
  return ctx.asker.required("Application", "for example github", (answer) => answer);
}

async function harnessFlagOrAsk(parsed: ParsedInstallerArgs, ctx: InstallerContext): Promise<string> {
  const flag = parsed.values.get("--harness");
  if (flag !== undefined) return flag;
  if (!ctx.deps.isTerminal) throw usageError("--harness is required without a terminal.");
  return ctx.asker.required("Harness", HARNESS_NAMES.join(", "), (answer) => parseHarnessName(answer, false));
}

async function addProposerBridge(ctx: InstallerContext, paths: HomePaths, account: Account, parsed: ParsedInstallerArgs): Promise<number> {
  if (!account.verifierDid) {
    throw new InstallerError(`Store the Verifier's DID before adding a bridge: mpas config${homeFlag(paths, ctx.deps)} --verifier-did <did>`);
  }
  const app = await appFlagOrAsk(parsed, ctx);
  const harness = await harnessFlagOrAsk(parsed, ctx);
  const options = { harness, harnessHome: parsed.values.get("--harness-home"), skill: parsed.values.get("--skill") };
  const mode = checkRegistrationOptions(options);

  const resolved = await resolveInstall(ctx, app);
  const name = resolved.entry.applicationPart;
  const bridgePath = paths.bridgeConfig(name);
  if ((await exists(bridgePath)) && !parsed.booleans.has("--replace-config")) {
    throw new InstallerError(`${bridgePath} already exists. Pass --replace-config to rewrite it.`);
  }
  const bridge = requireBridge(resolved);
  const plugin = await fetchVerifiedPlugin(ctx, resolved, parsed.values.get("--plugin"));
  const published = await ctx.deps.npmVersionExists(bridge.packageName, bridge.version);

  const pluginPath = paths.plugin(name, resolved.entry.entry.plugin.artifactDid!);
  await ensureDir(paths.workflows);
  await commitChanges(paths, [
    { path: pluginPath, contents: plugin },
    { path: paths.installed(name), contents: json(installRecord(ctx, resolved)) },
    {
      path: bridgePath,
      contents: json({
        mode: "proposer",
        plugin: pluginPath,
        agent: { did: account.did, keyFile: paths.key },
        target: { applicationDid: resolved.entry.entry.application.applicationDid },
        coordination: { url: account.coordinationUrl },
        actionEndpoint: { url: account.actionUrl, verifierDid: account.verifierDid },
        workflow: { dbPath: paths.workflowDb(name) },
      }),
    },
  ], ctx.deps);
  say(ctx, `Saved the plugin: ${pluginPath}`);
  say(ctx, `Saved the bridge config: ${bridgePath}`);
  if (!published) {
    throw new InstallerError(
      `The bridge package ${bridge.packageName}@${bridge.version} is not published on npm. The plugin and bridge config were saved, but ${name}-mpas was not registered.`,
    );
  }

  const registered = await registerServer(ctx, "proposer", options, `${name}-mpas`, () =>
    bridgeEntry(ctx, bridge.packageName, bridge.version, bridgePath));
  await finishAgentSetup(ctx, paths, "proposer", registered, options, mode);
  say(ctx);
  if (resolved.manifest.readme) say(ctx, `Application README: ${resolved.manifest.readme}`);
  say(ctx, `Check the setup with: mpas config validate${homeFlag(paths, ctx.deps)} ${shellQuote(name)}`);
  return 0;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** What `mcp add` ingested, so later checks of this application do not depend on the CLI's bundled registry. */
function installRecord(ctx: InstallerContext, resolved: ResolvedInstall) {
  return {
    version: "1",
    type: "MpasInstalledApplication",
    app: resolved.entry.applicationPart,
    registryName: resolved.entry.name,
    registryEntry: resolved.entry.entry,
    manifest: resolved.manifest,
    cliVersion: ctx.deps.packageVersion,
    installedAt: ctx.deps.now().toISOString(),
  };
}

async function addVerifierApplication(ctx: InstallerContext, paths: HomePaths, account: Account, parsed: ParsedInstallerArgs): Promise<number> {
  const app = await appFlagOrAsk(parsed, ctx);
  const resolved = await resolveInstall(ctx, app);
  const name = resolved.entry.applicationPart;
  const draftPath = paths.draftConfig(name);
  const livePath = paths.liveConfig(name);
  const replace = parsed.booleans.has("--replace-config");
  if (!replace && ((await exists(draftPath)) || (await exists(livePath)))) {
    throw new InstallerError(`${name} already has a deployment config. Pass --replace-config to write a new draft.`);
  }
  const plugin = await fetchVerifiedPlugin(ctx, resolved, parsed.values.get("--plugin"));
  const template = await fetchVerifiedTemplate(ctx, resolved, parsed.values.get("--config-template"));

  // Plugin files are named for their artifact, so a newer plugin never replaces the one a live config uses.
  const pluginPath = paths.plugin(name, resolved.entry.entry.plugin.artifactDid!);
  const files: FileChange[] = [
    { path: pluginPath, contents: plugin },
    { path: paths.installed(name), contents: json(installRecord(ctx, resolved)) },
  ];
  const readme = resolved.manifest.readme ?? "(the publisher's README)";
  if (!template) {
    await commitChanges(paths, files, ctx.deps);
    say(ctx, `Saved the plugin: ${pluginPath}`);
    throw new InstallerError(`${resolved.entry.name} publishes no deployment config template. Set up the config by following ${readme}`);
  }

  const earlier = replace && (await exists(draftPath))
    ? join(paths.drafts, `${name}-adapter-config.${timestamp(ctx.deps)}.json`)
    : undefined;
  if (earlier) files.push({ path: earlier, contents: await readFile(draftPath) });
  template.plugin = { ...template.plugin, path: pluginPath };
  files.push({ path: draftPath, contents: json(template) });
  await commitChanges(paths, files, ctx.deps);

  say(ctx, `Saved the plugin: ${pluginPath}`);
  if (earlier) say(ctx, `The earlier draft was kept as ${earlier}`);
  say(ctx, `Saved a deployment config draft: ${draftPath}`);
  say(ctx);
  say(ctx, "Next:");
  say(ctx, `  1. Follow the application's README for upstream setup, such as credentials or OAuth: ${readme}`);
  say(ctx, "  2. Add each signer:");
  const home = homeFlag(paths, ctx.deps);
  say(ctx, `       mpas signer add${home} --app ${shellQuote(name)} --proposer <did>`);
  say(ctx, `       mpas signer add${home} --app ${shellQuote(name)} --maintainer <did> --label <name>`);
  say(ctx, `  3. Check the draft: mpas config validate${home} ${shellQuote(name)}`);
  say(ctx, `  4. When it passes, move it into ${paths.config}, as the check prints.`);
  say(ctx, account.verifierMode ? `  5. Start the Credential Adapter (${account.verifierMode} mode):` : "  5. Start the Credential Adapter:");
  printAdapterStart(ctx, paths, account, "       ");
  return 0;
}
