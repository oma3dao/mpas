import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { computeArtifactDid, loadDeploymentConfigs } from "../../adapter/config-loader.js";
import { validateConfig } from "../index.js";
import { type Account, assertRuntimeKey, exists, homePaths, type HomePaths, type KeyFile, readJsonFile, requireAccount, resolveHome } from "./account.js";
import { parseInstallerArgs } from "./args.js";
import { type InstallerContext, say } from "./context.js";
import { usageError } from "./errors.js";
import { findPlaceholders, listBridgeConfigs, listFiles } from "./files.js";
import { loadRegistry } from "./registry.js";
import { homeFlag, shellQuote } from "./shell.js";

const VALIDATE_FLAGS = { "--home": "value" } as const;

class Report {
  failures = 0;
  /** Files a `<app>` argument selected. Zero means the argument matched nothing. */
  matched = 0;
  constructor(private readonly ctx: InstallerContext) {}

  info(text: string): void {
    say(this.ctx, `  i ${text}`);
  }

  ok(text: string): void {
    say(this.ctx, `  ✓ ${text}`);
  }

  fail(path: string, problem: string): void {
    this.failures += 1;
    say(this.ctx, `  ✗ ${path}: ${problem}`);
  }
}

export async function runValidate(args: string[], ctx: InstallerContext): Promise<number> {
  const parsed = parseInstallerArgs(args, VALIDATE_FLAGS, "mpas config validate");
  if (parsed.positionals.length > 1) throw usageError("Usage: mpas config validate [<app>]");
  const app = parsed.positionals[0];
  const paths = homePaths(resolveHome(parsed.values.get("--home"), ctx.deps));
  const account = await requireAccount(paths, homeFlag(paths, ctx.deps));
  const report = new Report(ctx);

  say(ctx, `Checking ${paths.home}`);
  await checkKey(paths, account, report);
  if (account.roles.includes("maintainer") && !app) await checkSignerConfig(paths, account, report);
  if (account.roles.includes("proposer")) await checkBridges(paths, account, app, report, ctx);
  if (account.roles.includes("verifier")) await checkDeploymentConfigs(paths, app, report, ctx);
  if (app !== undefined && report.matched === 0) {
    report.fail(paths.home, `no bridge or deployment config is named ${app}, so nothing was checked`);
  }

  say(ctx);
  say(ctx, report.failures === 0 ? "Validation passed." : `Validation failed: ${report.failures} problem${report.failures === 1 ? "" : "s"}.`);
  return report.failures === 0 ? 0 : 1;
}

async function checkKey(paths: HomePaths, account: Account, report: Report): Promise<void> {
  if (!(await exists(paths.key))) {
    report.fail(paths.key, "the signing key is missing");
    return;
  }
  const mode = (await stat(paths.key)).mode & 0o777;
  if (mode !== 0o600) {
    report.fail(paths.key, `mode is ${mode.toString(8)}; it must be 600`);
    return;
  }
  const key = await readJsonFile<KeyFile>(paths.key);
  if (key.did !== account.did) {
    report.fail(paths.key, "the key's DID does not match account.json");
    return;
  }
  try {
    await assertRuntimeKey(paths.key, key.did);
  } catch (error) {
    report.fail(paths.key, `the runtime cannot use this key: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  report.ok(`${paths.key}`);
}

async function checkSignerConfig(paths: HomePaths, account: Account, report: Report): Promise<void> {
  if (!(await exists(paths.signerConfig))) {
    report.fail(paths.signerConfig, "the signer config is missing");
    return;
  }
  const config = await readJsonFile<{ agent?: { did?: string; keyFile?: string }; coordination?: { url?: string } }>(paths.signerConfig);
  const problems = [
    config.agent?.did !== account.did && "agent.did does not match the account DID",
    config.agent?.keyFile !== paths.key && "agent.keyFile is not this account's key",
    config.coordination?.url !== account.coordinationUrl && "coordination.url does not match the account's Coordination URL",
  ].filter((problem): problem is string => Boolean(problem));
  for (const problem of problems) report.fail(paths.signerConfig, problem);
  if (problems.length === 0) report.ok(paths.signerConfig);
}

async function checkBridges(paths: HomePaths, account: Account, app: string | undefined, report: Report, ctx: InstallerContext): Promise<void> {
  const registry = await loadRegistry(ctx.deps.registryDir);
  const bridges = (await listBridgeConfigs(paths)).filter(
    (path) => !app || basename(path) === `${app}-mcp-bridge-config.json` || basename(path) === app,
  );
  report.matched += bridges.length;
  for (const bridge of bridges) {
    let config: Record<string, any>;
    try {
      config = await readJsonFile<Record<string, any>>(bridge);
    } catch (error) {
      report.fail(bridge, `not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const problems = [
      config.agent?.did !== account.did && "agent.did does not match the account DID",
      config.agent?.keyFile !== paths.key && "agent.keyFile is not this account's key",
      config.coordination?.url !== account.coordinationUrl && "coordination.url does not match the account's Coordination URL",
      config.adapter !== undefined && "has an adapter field; bridge configs use actionEndpoint",
      config.actionEndpoint?.url !== account.actionUrl && "actionEndpoint.url does not match the account's Action URL",
      !config.actionEndpoint?.verifierDid && "actionEndpoint.verifierDid is missing",
      config.actionEndpoint?.verifierDid && config.actionEndpoint.verifierDid !== account.verifierDid &&
        `actionEndpoint.verifierDid is ${config.actionEndpoint.verifierDid}, not the account's Verifier DID ${account.verifierDid ?? "(not set)"}`,
    ].filter((problem): problem is string => Boolean(problem));
    for (const problem of problems) report.fail(bridge, problem);

    const pluginPath = typeof config.plugin === "string" ? config.plugin : undefined;
    const applicationDid = config.target?.applicationDid;
    const appName = basename(bridge).replace(/-mcp-bridge-config\.json$/, "");
    const bundled = registry.find((entry) => entry.entry.application.applicationDid === applicationDid);
    // An installed application stays pinned to what it was installed from; a newer bundled registry is only reported.
    const record = (await exists(paths.installed(appName)))
      ? await readJsonFile<{ registryEntry?: { plugin?: { artifactDid?: string } } }>(paths.installed(appName))
      : undefined;
    const expected = record?.registryEntry?.plugin?.artifactDid ?? bundled?.entry.plugin.artifactDid;
    if (!pluginPath || !(await exists(pluginPath))) {
      report.fail(bridge, "plugin file is missing");
    } else if (!expected) {
      report.fail(pluginPath, `no registry artifactDid for ${applicationDid}`);
    } else if ((await computeArtifactDid(await readJsonFile(pluginPath))) !== expected) {
      report.fail(pluginPath, `does not match the artifactDid recorded ${record ? "at install" : "in the registry"}`);
    } else if (problems.length === 0) {
      report.ok(bridge);
    }
    const newer = bundled?.entry.plugin.artifactDid;
    if (record && newer && newer !== expected) {
      report.info(`A newer registry entry for ${appName} is bundled with this CLI. Update with: mpas mcp add${homeFlag(paths, ctx.deps)} --app ${shellQuote(appName)} --replace-config`);
    }
  }
}

async function checkDeploymentConfigs(paths: HomePaths, app: string | undefined, report: Report, ctx: InstallerContext): Promise<void> {
  // `<app>` keeps the original command's meaning: it may also be a config's file name or its `name` field.
  const wanted = (path: string, name?: unknown) =>
    !app || basename(path) === `${app}-adapter-config.json` || basename(path) === app || name === app;
  const live = await listFiles(paths.config, ".json");
  const liveApplications = new Map<string, string>();
  if (live.length > 0) {
    const loaded = await loadDeploymentConfigs(paths.config, { confirmPluginUse: async () => true });
    if (!loaded.ok) {
      report.fail(loaded.error.path, loaded.error.message);
    } else {
      const names = new Map(loaded.configs.map((entry) => [entry.filePath, entry.config.name]));
      for (const entry of loaded.configs) liveApplications.set(entry.config.target.applicationDid, entry.filePath);
      for (const path of live.filter((file) => wanted(file, names.get(file)))) {
        report.matched += 1;
        await checkWithAdapterRules(path, paths.config, paths, report);
      }
    }
  }

  // Earlier drafts kept by `mcp add --replace-config` are renamed with a timestamp and do not end in -adapter-config.json.
  for (const draft of await listFiles(paths.drafts, "-adapter-config.json")) {
    let config: Record<string, any>;
    try {
      config = await readJsonFile<Record<string, any>>(draft);
    } catch (error) {
      if (wanted(draft)) report.fail(draft, `not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (!wanted(draft, config.name)) continue;
    report.matched += 1;
    const placeholders = findPlaceholders(config);
    if (placeholders.length > 0) {
      report.fail(draft, `placeholder values remain. Add signers with \`mpas signer add${homeFlag(paths, ctx.deps)}\` and follow the application's README:`);
      for (const placeholder of placeholders) say(ctx, `      ${placeholder.path}: ${placeholder.value}`);
      continue;
    }
    const liveTarget = join(paths.config, basename(draft));
    const servedBy = liveApplications.get(config.target?.applicationDid);
    if (servedBy && servedBy !== liveTarget) {
      report.fail(draft, `${config.target.applicationDid} is already served by ${servedBy}`);
      continue;
    }
    const tempConfigDir = await mkdtemp(join(tmpdir(), "mpas-validate-"));
    try {
      await copyFile(draft, join(tempConfigDir, basename(draft)));
      if (await checkWithAdapterRules(join(tempConfigDir, basename(draft)), tempConfigDir, paths, report, draft)) {
        say(ctx, "      Ready. Make it live with:");
        say(ctx, `        mv ${shellQuote(draft)} ${shellQuote(liveTarget)}`);
      }
    } finally {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  }
}

/** Runs the Credential Adapter's own config checks, including credentials and signer keys. */
async function checkWithAdapterRules(path: string, configDir: string, paths: HomePaths, report: Report, shownPath = path): Promise<boolean> {
  try {
    const result = await validateConfig(basename(path), { configDir, credentialDir: paths.credentials });
    const failures = [
      ...result.credentials.filter((check) => !check.ok).map((check) => `credential ${check.handle}: ${check.error ?? check.state}`),
      ...result.signerKeys.filter((check) => !check.ok).map((check) => `signer ${check.did}: ${check.error}`),
    ];
    for (const failure of failures) report.fail(shownPath, failure);
    if (failures.length === 0) report.ok(shownPath);
    return failures.length === 0;
  } catch (error) {
    report.fail(shownPath, error instanceof Error ? error.message : String(error));
    return false;
  }
}
