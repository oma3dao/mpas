import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Document, parseDocument } from "yaml";
import { type Account, ensureDir, exists, type HomePaths, type Role, writeJsonAtomic } from "./account.js";
import { type InstallerContext, say } from "./context.js";
import { InstallerError, usageError } from "./errors.js";
import { extractPreamble } from "./skills.js";
import { shellQuote } from "./shell.js";

export const HARNESS_NAMES = ["claude-code", "claude-desktop", "codex", "cursor", "hermes", "openclaw"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];
type AgentRole = Extract<Role, "proposer" | "maintainer">;
export type SkillMode = "install" | "print";

const SKILL_FOLDER_HARNESSES: readonly string[] = ["claude-code", "codex", "cursor", "hermes"];

export function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value);
}

export function parseHarnessName(value: string, allowNone: boolean): string {
  if (allowNone && value === "none") return value;
  if (!isHarnessName(value)) {
    throw new InstallerError(`Unknown harness "${value}". Use one of: ${[...HARNESS_NAMES, ...(allowNone ? ["none"] : [])].join(", ")}.`, 2);
  }
  return value;
}

/** A harness MCP server entry: started directly, never through a shell. */
export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RegistrationOptions {
  harness: string;
  harnessHome?: string;
  skill?: string;
}

/**
 * Checks harness options before anything is written. An unknown harness name
 * is not rejected here: like any other registration failure, it fails after
 * the account and application files are saved.
 */
export function checkRegistrationOptions(options: RegistrationOptions): SkillMode {
  if (options.harnessHome !== undefined && options.harness === "openclaw") {
    throw usageError("--harness-home does not apply to openclaw, which keeps its own configuration.");
  }
  if (options.skill !== undefined && options.skill !== "install" && options.skill !== "print") {
    throw usageError("--skill must be install or print.");
  }
  const mode = (options.skill as SkillMode | undefined) ?? (SKILL_FOLDER_HARNESSES.includes(options.harness) ? "install" : "print");
  if (mode === "install" && isHarnessName(options.harness) && !SKILL_FOLDER_HARNESSES.includes(options.harness)) {
    throw usageError(`--skill install is not available for ${options.harness}. Use --skill print.`);
  }
  return mode;
}

function launchEnv(ctx: InstallerContext): Record<string, string> {
  return { PATH: [dirname(ctx.deps.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":") };
}

function npxScript(ctx: InstallerContext): string {
  if (!ctx.deps.npxScriptPath) {
    throw new InstallerError(`npm's npx script was not found next to ${ctx.deps.execPath}. Install npm with this Node, or add the entry by hand.`);
  }
  return ctx.deps.npxScriptPath;
}

export function signerEntry(ctx: InstallerContext, paths: HomePaths): ServerEntry {
  const tail = ["signer-server", "start", "--config", paths.signerConfig];
  const args = ctx.deps.startedViaNpx
    ? [npxScript(ctx), "-y", "--package", `@oma3/mpas-cli@${ctx.deps.packageVersion}`, "mpas", ...tail]
    : [ctx.deps.mpasScriptPath, ...tail];
  return { command: ctx.deps.execPath, args, env: launchEnv(ctx) };
}

export function bridgeEntry(ctx: InstallerContext, packageName: string, version: string, bridgeConfig: string): ServerEntry {
  return {
    command: ctx.deps.execPath,
    args: [npxScript(ctx), "-y", `${packageName}@${version}`, "--config", bridgeConfig],
    env: launchEnv(ctx),
  };
}

function harnessHome(ctx: InstallerContext, harness: HarnessName, role: AgentRole, flag: string | undefined): string {
  const home = ctx.deps.homedir;
  switch (harness) {
    case "codex":
      return flag ?? join(home, `.codex-${role}`);
    case "claude-code":
      return flag ?? join(home, ".claude");
    case "cursor":
      return flag ?? join(home, ".cursor");
    case "hermes":
      return flag ?? join(home, ".hermes");
    case "claude-desktop":
      return flag ?? join(home, "Library", "Application Support", "Claude");
    case "openclaw":
      return "";
  }
}

async function runHarnessCli(ctx: InstallerContext, command: string, args: string[], env: Record<string, string> = {}) {
  try {
    return await ctx.deps.runCommand(command, args, { env });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InstallerError(`${command} is not installed or not on PATH.`);
    }
    throw error;
  }
}

async function requireSuccess(ctx: InstallerContext, command: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const result = await runHarnessCli(ctx, command, args, env);
  if (result.exitCode !== 0) {
    throw new InstallerError(`\`${command} ${args.slice(0, 3).join(" ")}\` failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

async function readJsonObject(path: string): Promise<Record<string, any>> {
  if (!(await exists(path))) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  } catch (error) {
    throw new InstallerError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readYamlDocument(path: string): Promise<Document> {
  if (!(await exists(path))) return new Document({});
  const doc = parseDocument(await readFile(path, "utf8"));
  if (doc.errors.length > 0) throw new InstallerError(`Could not read ${path}: ${doc.errors[0].message}`);
  return doc;
}

/** The arguments of each MCP server entry already in the harness location, or the raw config text when it cannot be parsed structurally. */
async function existingEntries(ctx: InstallerContext, harness: HarnessName, home: string, flag: string | undefined): Promise<string[][] | string> {
  const argsOf = (servers: Record<string, any> | undefined) =>
    Object.values(servers ?? {}).map((server) => (Array.isArray(server?.args) ? server.args.map(String) : []));
  switch (harness) {
    case "cursor":
      return argsOf((await readJsonObject(join(home, "mcp.json"))).mcpServers);
    case "claude-desktop":
      return argsOf((await readJsonObject(join(home, "claude_desktop_config.json"))).mcpServers);
    case "claude-code":
      return argsOf((await readJsonObject(flag ? join(flag, ".claude.json") : join(ctx.deps.homedir, ".claude.json"))).mcpServers);
    case "hermes":
      return argsOf((await readYamlDocument(join(home, "config.yaml"))).toJS()?.mcp_servers);
    case "codex": {
      const path = join(home, "config.toml");
      return (await exists(path)) ? readFile(path, "utf8") : [];
    }
    case "openclaw": {
      const result = await runHarnessCli(ctx, "openclaw", ["config", "get", "mcp.servers", "--json"]);
      if (result.exitCode !== 0) return [];
      try {
        return argsOf(JSON.parse(result.stdout) as Record<string, any>);
      } catch {
        return result.stdout;
      }
    }
  }
}

/** Refuses to put a Proposer bridge and the Maintainer signer in one agent, judged by the config file each entry launches. */
async function checkOneRolePerAgent(ctx: InstallerContext, harness: HarnessName, role: AgentRole, home: string, flag: string | undefined): Promise<void> {
  const entries = await existingEntries(ctx, harness, home, flag);
  const conflictSuffix = role === "maintainer" ? "-mcp-bridge-config.json" : "maintainer-signer-config.json";
  const conflict = typeof entries === "string"
    ? entries.includes(conflictSuffix)
    : entries.some((args) => args.some((arg) => arg.endsWith(conflictSuffix)));
  if (conflict) {
    const other = role === "maintainer" ? "a Proposer bridge" : "the Maintainer signer";
    throw new InstallerError(
      `This ${harness} location already runs ${other}. Each agent has one MPAS role. Use --harness-home to register in a separate location.`,
    );
  }
}

async function writeEntry(ctx: InstallerContext, harness: HarnessName, home: string, flag: string | undefined, name: string, entry: ServerEntry): Promise<void> {
  switch (harness) {
    case "cursor":
    case "claude-desktop": {
      const file = join(home, harness === "cursor" ? "mcp.json" : "claude_desktop_config.json");
      if (harness === "claude-desktop" && ctx.deps.platform !== "darwin") {
        say(ctx, "Claude Desktop's config location is known only on macOS. Add this to its claude_desktop_config.json:");
        say(ctx, JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
        return;
      }
      const config = await readJsonObject(file);
      config.mcpServers = { ...config.mcpServers, [name]: entry };
      const mode = (await exists(file)) ? (await stat(file)).mode & 0o777 : 0o644;
      await writeJsonAtomic(file, config, mode);
      say(ctx, `Registered ${name} in ${file}`);
      return;
    }
    case "hermes": {
      const file = join(home, "config.yaml");
      const doc = await readYamlDocument(file);
      doc.setIn(["mcp_servers", name], doc.createNode(entry));
      await ensureDir(home);
      await writeFile(file, doc.toString());
      say(ctx, `Registered ${name} in ${file}`);
      return;
    }
    case "codex": {
      await ensureDir(home);
      const env = { CODEX_HOME: home };
      await runHarnessCli(ctx, "codex", ["mcp", "remove", name], env);
      const envFlags = Object.entries(entry.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      await requireSuccess(ctx, "codex", ["mcp", "add", name, ...envFlags, "--", entry.command, ...entry.args], env);
      say(ctx, `Registered ${name} with codex in ${home}`);
      return;
    }
    case "claude-code": {
      const env: Record<string, string> = flag ? { CLAUDE_CONFIG_DIR: flag } : {};
      await runHarnessCli(ctx, "claude", ["mcp", "remove", "--scope", "user", name], env);
      await requireSuccess(ctx, "claude", ["mcp", "add-json", "--scope", "user", name, JSON.stringify({ type: "stdio", ...entry })], env);
      say(ctx, `Registered ${name} with Claude Code at user scope${flag ? ` in ${flag}` : ""}`);
      return;
    }
    case "openclaw": {
      await requireSuccess(ctx, "openclaw", ["config", "set", `mcp.servers.${name}`, JSON.stringify(entry), "--strict-json"]);
      say(ctx, `Registered ${name} with openclaw`);
      const allow = await runHarnessCli(ctx, "openclaw", ["config", "get", "tools.allow", "--json"]);
      if (allow.exitCode !== 0) return;
      let list: unknown;
      try {
        list = JSON.parse(allow.stdout);
      } catch {
        return;
      }
      const pattern = `${name}__*`;
      if (Array.isArray(list) && !list.includes(pattern)) {
        await requireSuccess(ctx, "openclaw", ["config", "set", "tools.allow", JSON.stringify([...list, pattern]), "--strict-json"]);
        say(ctx, `Added ${pattern} to tools.allow`);
      }
      return;
    }
  }
}

function reloadHint(harness: HarnessName, home: string): string {
  switch (harness) {
    case "codex":
      return `Start Codex with: CODEX_HOME=${shellQuote(home)} codex`;
    case "claude-code":
      return "Start a new Claude Code session to load the server.";
    case "cursor":
      return "Restart Cursor, or reload its MCP servers, to load the server.";
    case "hermes":
      return "Run /reload-mcp in Hermes, or restart it, to load the server.";
    case "claude-desktop":
      return "Restart Claude Desktop to load the server.";
    case "openclaw":
      return "Restart the gateway to load the server: openclaw gateway restart";
  }
}

function instructionFile(harness: HarnessName): string {
  switch (harness) {
    case "claude-code":
      return "CLAUDE.md";
    case "claude-desktop":
      return "Claude Desktop's project or user instructions";
    case "openclaw":
      return "the agent workspace's AGENTS.md";
    default:
      return "AGENTS.md";
  }
}

/**
 * Adds or replaces one named server in a harness. Every failure, including an
 * unknown harness, reports the entry so the operator can add it by hand.
 */
export async function registerServer(
  ctx: InstallerContext,
  role: AgentRole,
  options: RegistrationOptions,
  name: string,
  buildEntry: () => ServerEntry,
): Promise<HarnessName> {
  let entry: ServerEntry | undefined;
  try {
    entry = buildEntry();
    const harness = parseHarnessName(options.harness, false) as HarnessName;
    const home = harnessHome(ctx, harness, role, options.harnessHome);
    await checkOneRolePerAgent(ctx, harness, role, home, options.harnessHome);
    await writeEntry(ctx, harness, home, options.harnessHome, name, entry);
    say(ctx, reloadHint(harness, home));
    return harness;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const manual = entry
      ? `\nAdd it by hand:\n  name: ${name}\n  command: ${entry.command}\n  args: ${entry.args.join(" ")}\n  env: ${Object.entries(entry.env).map(([key, value]) => `${key}=${value}`).join(" ")}`
      : "";
    throw new InstallerError(`Could not register ${name} in ${options.harness}: ${reason}${manual}`);
  }
}

/** Copies the role skill into the home, installs or describes it for the harness, and prints the role preamble. */
export async function finishAgentSetup(
  ctx: InstallerContext,
  paths: HomePaths,
  role: AgentRole,
  harness: HarnessName,
  options: RegistrationOptions,
  mode: SkillMode,
): Promise<void> {
  const skill = `mpas-${role}`;
  const source = join(ctx.deps.skillsDir, skill);
  const local = join(paths.skills, skill);
  await ensureDir(paths.skills);
  await rm(local, { recursive: true, force: true });
  await cp(source, local, { recursive: true });

  const home = harnessHome(ctx, harness, role, options.harnessHome);
  const skillsFolder = harness === "openclaw" || harness === "claude-desktop" ? "" : join(home, "skills");
  say(ctx);
  if (mode === "install") {
    await ensureDir(skillsFolder);
    await rm(join(skillsFolder, skill), { recursive: true, force: true });
    await cp(source, join(skillsFolder, skill), { recursive: true });
    say(ctx, `Installed the ${skill} skill in ${join(skillsFolder, skill)}`);
  } else if (harness === "claude-desktop") {
    const zip = join(paths.skills, `${skill}.zip`);
    if (ctx.deps.platform === "darwin") {
      await rm(zip, { force: true });
      await requireSuccess(ctx, "ditto", ["-c", "-k", "--keepParent", local, zip]);
      say(ctx, `Skill package: ${zip}`);
      say(ctx, "Upload it in Claude Desktop: Settings > Capabilities > Skills.");
    } else {
      say(ctx, `Zip ${local} and upload it in Claude Desktop: Settings > Capabilities > Skills.`);
    }
  } else if (harness === "openclaw") {
    say(ctx, `Copy ${local} into the agent's workspace skills folder, for example ~/.openclaw/workspace/skills/.`);
  } else {
    say(ctx, `Copy ${local} into ${skillsFolder}`);
  }

  const preamble = extractPreamble(await readFile(join(source, "SKILL.md"), "utf8"));
  say(ctx);
  say(ctx, `Paste this role preamble into ${instructionFile(harness)}. This command does not edit instruction files.`);
  say(ctx);
  say(ctx, "```markdown");
  ctx.io.stdout.write(preamble);
  say(ctx, "```");
}

/** Registers the Maintainer's signer server and finishes the agent setup. */
export async function registerSigner(ctx: InstallerContext, paths: HomePaths, _account: Account, options: RegistrationOptions): Promise<void> {
  const mode = checkRegistrationOptions(options);
  const harness = await registerServer(ctx, "maintainer", options, "mpas-coordination", () => signerEntry(ctx, paths));
  await finishAgentSetup(ctx, paths, "maintainer", harness, options, mode);
}
