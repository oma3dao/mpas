import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, testDeps } from "./helpers.js";

const demoDir = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFile(join(demoDir, path), "utf8");

function firstCodeBlock(markdown: string): string {
  return /```[a-z]*\n([\s\S]*?)```/.exec(markdown)?.[1] ?? "";
}

describe("Phase 5: help text and operator docs", () => {
  it("lists every new and existing command in mpas --help", async () => {
    const result = await run(["--help"], testDeps());
    expect(result.exitCode).toBe(0);
    const commands = [
      "init", "config", "config validate", "key rotate", "mcp add", "signer add", "signer remove", "signer list",
      "adapter start", "adapter status", "daemon start", "daemon status", "coordination start", "signer-server start",
      "action pending", "action inspect", "action review", "key generate", "test submit", "test dry-run",
      "plugin install", "plugin list", "credential set", "credential list", "oauth login", "oauth status", "oauth logout",
      "trace inspect",
    ];
    for (const command of commands) {
      expect(result.stdout, command).toContain(`mpas ${command}`);
    }
    expect(result.stdout).not.toContain("process start");
    expect(result.stdout).not.toMatch(/mpas start\b/);
  });

  it("opens the package README with the operator section", async () => {
    const readme = await read("README.md");
    const operator = readme.indexOf("## Install and set up");
    expect(operator).toBeGreaterThan(-1);
    expect(operator).toBeLessThan(readme.indexOf("## Architecture"));
    const section = readme.slice(operator, readme.indexOf("## Architecture"));
    for (const text of [
      "npm install -g @oma3/mpas-cli@alpha", "mpas init", "mpas config", "mpas config validate", "mpas key rotate",
      "mpas mcp add", "mpas signer add", "mpas signer remove", "mpas signer list", "oma3dao/mpas#6",
    ]) {
      expect(section, text).toContain(text);
    }
  });

  it("leads each participant guide with the CLI", async () => {
    for (const guide of ["guides/proposer.md", "guides/maintainer.md", "guides/credential-adapter.md"]) {
      const text = await read(guide);
      expect(firstCodeBlock(text), guide).toContain("npm install -g @oma3/mpas-cli@alpha");
      expect(firstCodeBlock(text), guide).toContain("mpas init");
    }
  });

  it("runs the single-machine demo with one home per participant and lists current skill support", async () => {
    const text = await read("guides/setup-macos.md");
    for (const home of ["~/.mpas-proposer", "~/.mpas-maintainer", "~/.mpas-verifier"]) {
      expect(text).toContain(`--home ${home}`);
    }
    const table = text.slice(text.indexOf("### Where to put them"), text.indexOf("### Skill files"));
    expect(table).toMatch(/\| Claude Desktop .*Settings/);
    expect(table).toMatch(/\| Cursor .*~\/\.cursor\/skills\//);
  });

  it("documents the release steps a person runs", async () => {
    const text = await read("RELEASING.md");
    for (const step of [
      "@oma3/mpas-cli", "npm pack --dry-run", "npm install -g --prefix", "npm login --auth-type=web",
      "npm publish --access public --tag alpha", "npm dist-tag ls @oma3/mpas-cli", "npx -y @oma3/mpas-cli@alpha --help",
    ]) {
      expect(text, step).toContain(step);
    }
  });
});
