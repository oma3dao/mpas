import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleAssets } from "../../scripts/bundle-assets.mjs";
import { startDaemon } from "../../src/adapter/daemon.js";
import { newDid, readJson, repoRoot, run, tempDir, testDeps, writeCredential } from "./helpers.js";

const demoRoot = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
let buildDir = "";

// Compile the package into a temporary folder inside the demo, so its imports resolve against node_modules.
beforeAll(async () => {
  buildDir = await mkdtemp(join(demoRoot, ".installer-launch-build-"));
  await execFileAsync(process.execPath, [join(demoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", buildDir], { cwd: demoRoot });
  await bundleAssets({ repoRoot, outDir: join(buildDir, "bundled") });
}, 60_000);

afterAll(async () => {
  if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

describe("launching the generated setup from a build", () => {
  it("starts the Maintainer's generated signer entry exactly as a harness would", async () => {
    const homedir = await tempDir();
    const home = join(await tempDir(), "home");
    const deps = testDeps({ homedir, execPath: process.execPath, mpasScriptPath: join(buildDir, "cli", "index.js") });
    const init = await run(["init", "maintainer", "--home", home, "--coordination", "local", "--harness", "cursor"], deps);
    expect(init.exitCode, init.stderr).toBe(0);

    const entry = (await readJson<Record<string, any>>(join(homedir, ".cursor", "mcp.json"))).mcpServers["mpas-coordination"];
    const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: entry.env, stderr: "pipe" });
    const client = new Client({ name: "installer-launch-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(tools).toEqual(["mpas_approve", "mpas_list_pending", "mpas_reject", "mpas_review_action"]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("starts the Credential Adapter from the paths in the printed command", async () => {
    const home = join(await tempDir(), "home");
    expect((await run(["init", "verifier", "--home", home, "--action", "local", "--mode", "direct"], testDeps())).exitCode).toBe(0);
    const added = await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps());
    expect(added.exitCode, added.stderr).toBe(0);
    await run(["signer", "add", "--home", home, "--app", "mirror", "--proposer", await newDid()], testDeps());
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", await newDid()], testDeps());
    await writeCredential(home);
    await rename(join(home, "config", "drafts", "mirror-adapter-config.json"), join(home, "config", "mirror-adapter-config.json"));

    const flag = (name: string) => new RegExp(`--${name} (\\S+)`).exec(added.stdout)?.[1];
    const daemon = await startDaemon({
      configDir: flag("config-dir"),
      credentialDir: flag("credential-dir"),
      adapterKeyPath: flag("adapter-key"),
      journalPath: flag("journal-path"),
      port: 0,
      trustContext: null,
      confirmPluginUse: async () => true,
    });
    try {
      expect(daemon.loadedConfigs).toHaveLength(1);
    } finally {
      await daemon.app.close();
    }
  }, 30_000);
});
