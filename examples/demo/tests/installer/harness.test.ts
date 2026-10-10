import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CommandRecord, initAccount, readJson, repoRoot, run, snapshot, tempDir, testDeps } from "./helpers.js";

type Json = Record<string, any>;
const nodePath = "/opt/node/bin/node";
const pathEnv = { PATH: "/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" };
const mpasScript = "/opt/node/lib/node_modules/@oma3/mpas-cli/dist/cli/index.js";
const npxScript = "/opt/node/lib/node_modules/npm/bin/npx-cli.js";

async function maintainerInit(harness: string, homedir: string, extra: string[] = [], deps = testDeps({ homedir })) {
  const home = join(await tempDir(), "home");
  const result = await run(["init", "maintainer", "--home", home, "--coordination", "local", "--harness", harness, ...extra], deps);
  return { home, result, deps, signerConfig: join(home, "mcp-server-configs", "maintainer-signer-config.json") };
}

function signerEntry(signerConfig: string) {
  return { command: nodePath, args: [mpasScript, "signer-server", "start", "--config", signerConfig], env: pathEnv };
}

async function skillSource(role: "proposer" | "maintainer") {
  return readFile(join(repoRoot, "integrations", "skills", `mpas-${role}`, "SKILL.md"));
}

describe("Phase 3: harness registration", () => {
  it("registers the signer in Cursor at Maintainer init, keeping other servers, and installs the skill", async () => {
    const homedir = await tempDir();
    await mkdir(join(homedir, ".cursor"), { recursive: true });
    await writeFile(join(homedir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other-server" } } }));
    const { home, result, signerConfig } = await maintainerInit("cursor", homedir);

    expect(result.exitCode, result.stderr).toBe(0);
    const servers = (await readJson<Json>(join(homedir, ".cursor", "mcp.json"))).mcpServers;
    expect(servers.other).toEqual({ command: "other-server" });
    expect(servers["mpas-coordination"]).toEqual(signerEntry(signerConfig));
    expect(Object.keys(servers).some((name) => name.endsWith("-mpas"))).toBe(false);
    expect(result.stdout).toContain("## Prime Directive — MPAS Maintainer");
    expect(result.stdout).toContain("AGENTS.md");
    expect(await readFile(join(homedir, ".cursor", "skills", "mpas-maintainer", "SKILL.md"))).toEqual(await skillSource("maintainer"));
    expect(await readFile(join(home, "skills", "mpas-maintainer", "SKILL.md"))).toEqual(await skillSource("maintainer"));
  });

  it("launches the signer through a pinned npx package when mpas itself came from npx", async () => {
    const homedir = await tempDir();
    const { result, signerConfig } = await maintainerInit("cursor", homedir, [], testDeps({ homedir, startedViaNpx: true }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect((await readJson<Json>(join(homedir, ".cursor", "mcp.json"))).mcpServers["mpas-coordination"]).toEqual({
      command: nodePath,
      args: [npxScript, "-y", "--package", "@oma3/mpas-cli@0.1.0-alpha.1", "mpas", "signer-server", "start", "--config", signerConfig],
      env: pathEnv,
    });
  });

  it("uses codex mcp add with a role-specific CODEX_HOME, never ~/.codex by default", async () => {
    const homedir = await tempDir();
    const { result, deps, signerConfig } = await maintainerInit("codex", homedir);
    expect(result.exitCode, result.stderr).toBe(0);
    const codexHome = join(homedir, ".codex-maintainer");
    const add = deps.commands.find((command) => command.command === "codex" && command.args[1] === "add");
    expect(add).toEqual({
      command: "codex",
      args: ["mcp", "add", "mpas-coordination", "--env", `PATH=${pathEnv.PATH}`, "--", nodePath, ...signerEntry(signerConfig).args],
      env: { CODEX_HOME: codexHome },
    });
    expect(deps.commands.every((command) => command.env?.CODEX_HOME !== join(homedir, ".codex"))).toBe(true);
    expect(result.stdout).toContain(`CODEX_HOME=${codexHome} codex`);
    expect(await readFile(join(codexHome, "skills", "mpas-maintainer", "SKILL.md"))).toEqual(await skillSource("maintainer"));

    const custom = join(await tempDir(), "codex");
    const withHome = await maintainerInit("codex", homedir, ["--harness-home", custom]);
    expect(withHome.deps.commands.find((command) => command.args[1] === "add")?.env).toEqual({ CODEX_HOME: custom });
  });

  it("uses claude mcp add-json at user scope, with --harness-home as CLAUDE_CONFIG_DIR", async () => {
    const homedir = await tempDir();
    const { result, deps, signerConfig } = await maintainerInit("claude-code", homedir);
    expect(result.exitCode, result.stderr).toBe(0);
    const add = deps.commands.find((command) => command.command === "claude" && command.args[1] === "add-json")!;
    expect(add.args.slice(0, 5)).toEqual(["mcp", "add-json", "--scope", "user", "mpas-coordination"]);
    expect(JSON.parse(add.args[5])).toEqual({ type: "stdio", ...signerEntry(signerConfig) });
    expect(add.env ?? {}).toEqual({});
    expect(result.stdout).toContain("CLAUDE.md");
    expect(await readFile(join(homedir, ".claude", "skills", "mpas-maintainer", "SKILL.md"))).toEqual(await skillSource("maintainer"));

    const configDir = join(await tempDir(), "claude");
    const custom = await maintainerInit("claude-code", homedir, ["--harness-home", configDir]);
    expect(custom.deps.commands.find((command) => command.args[1] === "add-json")?.env).toEqual({ CLAUDE_CONFIG_DIR: configDir });
    expect(await readFile(join(configDir, "skills", "mpas-maintainer", "SKILL.md"))).toEqual(await skillSource("maintainer"));
  });

  it("sets one OpenClaw server, extends an existing tools.allow, and leaves an unset one alone", async () => {
    for (const allow of [["read"], undefined]) {
      const homedir = await tempDir();
      const commands: CommandRecord[] = [];
      const deps = testDeps({
        homedir,
        runCommand: async (command, args, options = {}) => {
          commands.push({ command, args, env: options.env });
          if (args[0] === "config" && args[1] === "get" && args[2] === "mcp.servers") return { exitCode: 0, stdout: "{}", stderr: "" };
          if (args[0] === "config" && args[1] === "get" && args[2] === "tools.allow") {
            return allow ? { exitCode: 0, stdout: JSON.stringify(allow), stderr: "" } : { exitCode: 1, stdout: "", stderr: "Config path not found" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      const { result, signerConfig } = await maintainerInit("openclaw", homedir, [], deps);
      expect(result.exitCode, result.stderr).toBe(0);
      const set = commands.find((command) => command.args[1] === "set" && command.args[2] === "mcp.servers.mpas-coordination")!;
      expect(JSON.parse(set.args[3])).toEqual(signerEntry(signerConfig));
      expect(set.args[4]).toBe("--strict-json");
      const allowSet = commands.find((command) => command.args[1] === "set" && command.args[2] === "tools.allow");
      if (allow) {
        expect(JSON.parse(allowSet!.args[3])).toEqual(["read", "mpas-coordination__*"]);
      } else {
        expect(allowSet).toBeUndefined();
      }
      expect(commands.some((command) => command.args.includes("gateway"))).toBe(false);
      expect(result.stdout).toContain("openclaw gateway restart");
      expect(result.stdout).toMatch(/workspace.*skills/);
    }
  });

  it("writes Claude Desktop's macOS config, and only prints the JSON elsewhere", async () => {
    const homedir = await tempDir();
    const mac = await maintainerInit("claude-desktop", homedir);
    expect(mac.result.exitCode, mac.result.stderr).toBe(0);
    const config = await readJson<Json>(join(homedir, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
    expect(config.mcpServers["mpas-coordination"]).toEqual(signerEntry(mac.signerConfig));
    expect(mac.deps.commands.find((command) => command.command === "ditto")?.args).toEqual([
      "-c", "-k", "--keepParent", join(mac.home, "skills", "mpas-maintainer"), join(mac.home, "skills", "mpas-maintainer.zip"),
    ]);
    expect(mac.result.stdout).toMatch(/Settings/);

    const linuxHome = await tempDir();
    const linux = await maintainerInit("claude-desktop", linuxHome, [], testDeps({ homedir: linuxHome, platform: "linux" }));
    expect(linux.result.exitCode).toBe(0);
    expect(linux.result.stdout).toContain("\"mpas-coordination\"");
    expect(await snapshot(join(linuxHome, "Library"))).toEqual({});
  });

  it("merges one Hermes mcp_servers entry, keeping comments and other settings", async () => {
    const homedir = await tempDir();
    await mkdir(join(homedir, ".hermes"), { recursive: true });
    await writeFile(join(homedir, ".hermes", "config.yaml"), "# my settings\nmodel: hermes-4\nmcp_servers:\n  docs:\n    command: docs-mcp\n");
    const { result, signerConfig } = await maintainerInit("hermes", homedir);
    expect(result.exitCode, result.stderr).toBe(0);
    const text = await readFile(join(homedir, ".hermes", "config.yaml"), "utf8");
    expect(text).toContain("# my settings");
    expect(text).toContain("model: hermes-4");
    const { parse } = await import("yaml");
    const parsed = parse(text);
    expect(parsed.mcp_servers.docs).toEqual({ command: "docs-mcp" });
    expect(parsed.mcp_servers["mpas-coordination"]).toEqual(signerEntry(signerConfig));
  });

  it("identifies MPAS entries by the config file they launch, not by their names", async () => {
    const homedir = await tempDir();
    await mkdir(join(homedir, ".cursor"), { recursive: true });
    const cursorConfig = join(homedir, ".cursor", "mcp.json");
    await writeFile(cursorConfig, JSON.stringify({
      mcpServers: { "github-mpas-mirror": { command: "node", args: ["bridge.js", "--config", "/x/.mpas/mcp-server-configs/github-mcp-bridge-config.json"] } },
    }));
    const blocked = await maintainerInit("cursor", homedir);
    expect(blocked.result.exitCode).not.toBe(0);
    expect(blocked.result.stderr).toContain("--harness-home");
    expect(await readJson(join(blocked.home, "account.json"))).toMatchObject({ roles: ["maintainer"] });
    expect(await readJson(blocked.signerConfig)).toMatchObject({ coordination: { url: "http://127.0.0.1:7545" } });

    await writeFile(cursorConfig, JSON.stringify({ mcpServers: { "other-mpas": { command: "other-server" } } }));
    expect((await maintainerInit("cursor", homedir)).result.exitCode).toBe(0);

    const proposer = await initAccount("proposer", ["--verifier-did", "did:web:verifier.example.test"]);
    const proposerResult = await run(["mcp", "add", "--home", proposer, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir }));
    expect(proposerResult.exitCode).not.toBe(0);
    expect(proposerResult.stderr).toContain("--harness-home");
    expect(await readJson(join(proposer, "mcp-server-configs", "mirror-mcp-bridge-config.json"))).toMatchObject({ mode: "proposer" });
  });

  it("copies skills into the harness only with install, replacing just that skill", async () => {
    const homedir = await tempDir();
    await mkdir(join(homedir, ".cursor", "skills", "other-skill"), { recursive: true });
    await writeFile(join(homedir, ".cursor", "skills", "other-skill", "SKILL.md"), "other\n");
    await mkdir(join(homedir, ".cursor", "skills", "mpas-maintainer"), { recursive: true });
    await writeFile(join(homedir, ".cursor", "skills", "mpas-maintainer", "OLD.md"), "old\n");
    await maintainerInit("cursor", homedir);
    expect(await readdir(join(homedir, ".cursor", "skills", "mpas-maintainer"))).toEqual(["SKILL.md"]);
    expect(await readFile(join(homedir, ".cursor", "skills", "other-skill", "SKILL.md"), "utf8")).toBe("other\n");

    const printHome = await tempDir();
    const printed = await maintainerInit("cursor", printHome, ["--skill", "print"]);
    expect(printed.result.exitCode).toBe(0);
    expect(await snapshot(join(printHome, ".cursor", "skills"))).toEqual({});
    expect(await readFile(join(printed.home, "skills", "mpas-maintainer", "SKILL.md"))).toEqual(await skillSource("maintainer"));
    expect(printed.result.stdout).toContain(join(printHome, ".cursor", "skills"));

    for (const harness of ["openclaw", "claude-desktop"]) {
      const rejected = await maintainerInit(harness, await tempDir(), ["--skill", "install"]);
      expect(rejected.result.exitCode).not.toBe(0);
      expect(await snapshot(rejected.home)).toEqual({});
    }
    expect((await maintainerInit("cursor", await tempDir(), ["--skill", "maybe"])).result.exitCode).not.toBe(0);
  });

  it("fails after saving when the harness is unknown, its CLI is missing, or the write fails", async () => {
    const unknown = await maintainerInit("emacs", await tempDir());
    expect(unknown.result.exitCode).not.toBe(0);
    expect(unknown.result.stderr).toContain("mpas-coordination");
    expect(unknown.result.stderr).toContain(nodePath);
    expect(unknown.result.stderr).toContain(unknown.signerConfig);
    expect(await readJson(join(unknown.home, "account.json"))).toMatchObject({ roles: ["maintainer"] });
    expect(await readJson(join(unknown.home, "keys", "signing-key.json"))).toHaveProperty("did");

    const homedir = await tempDir();
    const missingCli = await maintainerInit("codex", homedir, [], testDeps({
      homedir,
      runCommand: async () => {
        throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
      },
    }));
    expect(missingCli.result.exitCode).not.toBe(0);
    expect(missingCli.result.stderr).toContain("codex");
    expect(missingCli.result.stderr).toContain(missingCli.signerConfig);
    expect(await readJson(join(missingCli.home, "account.json"))).toMatchObject({ roles: ["maintainer"] });

    const brokenHome = await tempDir();
    await mkdir(join(brokenHome, ".cursor"), { recursive: true });
    await writeFile(join(brokenHome, ".cursor", "mcp.json"), "{ not json");
    const broken = await maintainerInit("cursor", brokenHome);
    expect(broken.result.exitCode).not.toBe(0);
    expect(await readFile(join(brokenHome, ".cursor", "mcp.json"), "utf8")).toBe("{ not json");
    expect(await readJson(broken.signerConfig)).toHaveProperty("agent");
  });

  it("never writes an instruction file", async () => {
    for (const harness of ["cursor", "codex", "claude-code", "hermes"]) {
      const homedir = await tempDir();
      await maintainerInit(harness, homedir);
      const files = Object.keys(await snapshot(homedir));
      expect(files.filter((path) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path)), harness).toEqual([]);
    }
  });
});
