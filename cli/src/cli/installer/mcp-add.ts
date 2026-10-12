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
  readJsonFile,
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
  harnessServer,
  parseHarnessName,
  type RegistrationOptions,
  registerServer,
  registerSigner,
} from "./harness.js";
import { printAdapterStart } from "./runtime.js";
import { homeFlag, shellQuote } from "./shell.js";
import {
  type ApplicationSource,
  checkApplicationName,
  loadSourceBridge,
  loadSourcePlugin,
  loadSourceTemplate,
  parseSourceUrl,
  type SourcePlugin,
} from "./source.js";
import { commitChanges, type FileChange } from "./txn.js";

const MCP_ADD_FLAGS = {
  "--home": "value",
  "--role": "value",
  "--app": "value",
  "--name": "value",
  "--harness": "value",
  "--harness-home": "value",
  "--skill": "value",
  "--plugin": "value",
  "--config-template": "value",
  "--replace-config": "boolean",
} as const;

const NOT_FOR: Record<Role, string[]> = {
  maintainer: ["--name", "--plugin", "--config-template", "--replace-config"],
  proposer: ["--config-template"],
  verifier: ["--harness", "--harness-home", "--skill"],
};

const USAGE = "Usage: mpas mcp add <url> [--name <name>] [--harness <harness>] [options], where <url> is the application's folder";

export async function runMcpAdd(args: string[], ctx: InstallerContext): Promise<number> {
  const parsed = parseInstallerArgs(args, MCP_ADD_FLAGS, "mpas mcp add");
  if (parsed.values.has("--app")) {
    throw usageError("mpas mcp add takes the URL of the application's folder instead of --app: mpas mcp add <url> [--name <name>]. Find the URL in the application's registry entry (its source field).");
  }
  if (parsed.positionals.length > 1) throw usageError(USAGE);
  const paths = homePaths(resolveHome(parsed.values.get("--home"), ctx.deps));
  const account = await requireAccount(paths, homeFlag(paths, ctx.deps));
  const role = await selectRole(parsed, account, ctx);
  for (const flag of NOT_FOR[role]) {
    if (parsed.values.has(flag) || parsed.booleans.has(flag)) {
      throw usageError(`${flag} does not apply to the ${role} role in mpas mcp add.`);
    }
  }
  if (role === "maintainer") {
    if (parsed.positionals.length > 0) throw usageError("A Maintainer's mpas mcp add registers the signer server and takes no URL.");
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

async function sourceOrAsk(parsed: ParsedInstallerArgs, ctx: InstallerContext): Promise<ApplicationSource> {
  const given = parsed.positionals[0];
  if (given !== undefined) return parseSourceUrl(given);
  if (!ctx.deps.isTerminal) throw usageError(`The application's folder URL is required without a terminal. ${USAGE}`);
  const answer = await ctx.asker.required("Application folder URL", "https://github.com/<owner>/<repo>/tree/<ref>/<path>", (value) => {
    parseSourceUrl(value);
    return value;
  });
  return parseSourceUrl(answer);
}

async function harnessFlagOrAsk(parsed: ParsedInstallerArgs, ctx: InstallerContext): Promise<string> {
  const flag = parsed.values.get("--harness");
  if (flag !== undefined) return flag;
  if (!ctx.deps.isTerminal) throw usageError("--harness is required without a terminal.");
  return ctx.asker.required("Harness", HARNESS_NAMES.join(", "), (answer) => parseHarnessName(answer, false));
}

interface InstalledRecord {
  source?: string;
}

/**
 * Refuses a name this home already uses (spec §9.5). `--replace-config`
 * reinstalls the same source under its name, or takes over an application
 * config set up by hand, which has no install record. Either way a harness
 * server with the name must launch this home's bridge config; anything else
 * there belongs to someone else and is never replaced.
 */
async function checkNameFree(
  ctx: InstallerContext,
  paths: HomePaths,
  name: string,
  source: ApplicationSource,
  replace: boolean,
  harness?: RegistrationOptions,
): Promise<void> {
  const record = (await exists(paths.installed(name))) ? await readJsonFile<InstalledRecord>(paths.installed(name)) : undefined;
  const configs = [
    (await exists(paths.bridgeConfig(name))) && `the bridge config ${paths.bridgeConfig(name)}`,
    (await exists(paths.draftConfig(name))) && `the draft ${paths.draftConfig(name)}`,
    (await exists(paths.liveConfig(name))) && `the deployment config ${paths.liveConfig(name)}`,
  ].filter((use): use is string => Boolean(use));
  const server = harness ? await harnessServer(ctx, "proposer", harness, `${name}-mpas`) : undefined;
  const serverIsOurs = server?.args?.includes(paths.bridgeConfig(name)) ?? false;
  const uses = [
    record && `an installed application from ${record.source ?? "an earlier CLI version"}`,
    ...configs,
    server && (serverIsOurs
      ? `the server ${name}-mpas in ${harness!.harness}`
      : `a server named ${name}-mpas in ${harness!.harness} that does not run this home's bridge config`),
  ].filter((use): use is string => Boolean(use));
  if (uses.length === 0) return;
  const sameSource = record?.source === source.url;
  const takeover = !record && configs.length > 0;
  if (replace && (sameSource || takeover) && (!server || serverIsOurs)) return;
  const reinstall = sameSource && (!server || serverIsOurs) ? ` To reinstall ${source.url} under this name, pass --replace-config.` : "";
  throw new InstallerError(`The name "${name}" is already used in this home: ${uses.join("; ")}. Choose another name with --name <name>.${reinstall}`);
}

async function applicationName(parsed: ParsedInstallerArgs, source: ApplicationSource): Promise<string> {
  return checkApplicationName(parsed.values.get("--name") ?? source.defaultName);
}

function announce(ctx: InstallerContext, source: ApplicationSource, plugin: SourcePlugin): void {
  say(ctx, `Source: ${source.url}`);
  say(ctx, `Plugin artifactDid: ${plugin.artifactDid}`);
  say(ctx, "Installing from a URL trusts whoever controls it. Check that this is the application you meant.");
}

async function addProposerBridge(ctx: InstallerContext, paths: HomePaths, account: Account, parsed: ParsedInstallerArgs): Promise<number> {
  if (!account.verifierDid) {
    throw new InstallerError(`Store the Verifier's DID before adding a bridge: mpas config${homeFlag(paths, ctx.deps)} --verifier-did <did>`);
  }
  const source = await sourceOrAsk(parsed, ctx);
  const harness = await harnessFlagOrAsk(parsed, ctx);
  const options = { harness, harnessHome: parsed.values.get("--harness-home"), skill: parsed.values.get("--skill") };
  const mode = checkRegistrationOptions(options);
  const name = await applicationName(parsed, source);
  await checkNameFree(ctx, paths, name, source, parsed.booleans.has("--replace-config"), options);

  const bridge = await loadSourceBridge(ctx, source);
  const plugin = await loadSourcePlugin(ctx, source, parsed.values.get("--plugin"));
  const published = await ctx.deps.npmVersionExists(bridge.packageName, bridge.version);
  announce(ctx, source, plugin);

  const bridgePath = paths.bridgeConfig(name);
  const pluginPath = paths.plugin(name, plugin.artifactDid);
  await ensureDir(paths.workflows);
  await commitChanges(paths, [
    { path: pluginPath, contents: plugin.bytes },
    {
      path: paths.installed(name),
      contents: json(installRecord(ctx, name, "proposer", source, { plugin: plugin.from, bridgePackage: bridge.from }, plugin, {
        package: bridge.packageName,
        version: bridge.version,
      })),
    },
    {
      path: bridgePath,
      contents: json({
        mode: "proposer",
        plugin: pluginPath,
        agent: { did: account.did, keyFile: paths.key },
        target: { applicationDid: plugin.applicationDid },
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
  say(ctx, `Application README: ${source.readmeUrl}`);
  say(ctx, `Check the setup with: mpas config validate${homeFlag(paths, ctx.deps)} ${shellQuote(name)}`);
  return 0;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** What `mcp add` installed and where it came from, so later checks of this application never download again. */
function installRecord(
  ctx: InstallerContext,
  name: string,
  role: Role,
  source: ApplicationSource,
  files: Record<string, string>,
  plugin: SourcePlugin,
  bridge?: { package: string; version: string },
) {
  return {
    version: "2",
    type: "MpasInstalledApplication",
    name,
    role,
    source: source.url,
    files,
    plugin: { artifactDid: plugin.artifactDid, applicationDid: plugin.applicationDid },
    ...(bridge ? { bridge } : {}),
    cliVersion: ctx.deps.packageVersion,
    installedAt: ctx.deps.now().toISOString(),
  };
}

async function addVerifierApplication(ctx: InstallerContext, paths: HomePaths, account: Account, parsed: ParsedInstallerArgs): Promise<number> {
  const source = await sourceOrAsk(parsed, ctx);
  const name = await applicationName(parsed, source);
  const replace = parsed.booleans.has("--replace-config");
  await checkNameFree(ctx, paths, name, source, replace);
  const plugin = await loadSourcePlugin(ctx, source, parsed.values.get("--plugin"));
  const template = await loadSourceTemplate(ctx, source, parsed.values.get("--config-template"), plugin);
  announce(ctx, source, plugin);

  // Plugin files are named for their artifact, so a newer plugin never replaces the one a live config uses.
  const pluginPath = paths.plugin(name, plugin.artifactDid);
  const draftPath = paths.draftConfig(name);
  const files: FileChange[] = [
    { path: pluginPath, contents: plugin.bytes },
    { path: paths.installed(name), contents: json(installRecord(ctx, name, "verifier", source, { plugin: plugin.from, template: template.from }, plugin)) },
  ];
  const earlier = replace && (await exists(draftPath))
    ? join(paths.drafts, `${name}-adapter-config.${timestamp(ctx.deps)}.json`)
    : undefined;
  if (earlier) files.push({ path: earlier, contents: await readFile(draftPath) });
  template.config.plugin = { ...template.config.plugin, path: pluginPath };
  files.push({ path: draftPath, contents: json(template.config) });
  await commitChanges(paths, files, ctx.deps);

  say(ctx, `Saved the plugin: ${pluginPath}`);
  if (earlier) say(ctx, `The earlier draft was kept as ${earlier}`);
  say(ctx, `Saved a deployment config draft: ${draftPath}`);
  say(ctx);
  say(ctx, "Next:");
  say(ctx, `  1. Follow the application's README for upstream setup, such as credentials or OAuth: ${source.readmeUrl}`);
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
