import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import {
  buildSource,
  fixtureApplicationDid,
  fixtureArtifactDid,
  fixturePluginFile,
  fixturePluginPath,
  fixtureSourceUrl,
  fixtureTemplatePath,
  initAccount,
  newDid,
  readJson,
  run,
  scriptedPrompt,
  snapshot,
  tempDir,
  testDeps,
  writeCredential,
  writeFixtureBridge,
  writeFixtureConfig,
} from "./helpers.js";

type Json = Record<string, any>;

async function proposerHome(extra: string[] = []) {
  return initAccount("proposer", ["--verifier-did", "did:web:verifier.example.test", ...extra]);
}

async function cursorServers(homedir: string): Promise<Json> {
  return (await readJson<Json>(join(homedir, ".cursor", "mcp.json"))).mcpServers;
}

function recordingFetch(fetchBytes: (url: string) => Promise<Uint8Array>) {
  const urls: string[] = [];
  return {
    urls,
    fetchBytes: async (url: string) => {
      urls.push(url);
      return fetchBytes(url);
    },
  };
}

describe("Phase 6: source URL", () => {
  it("reads a GitHub folder URL as raw files at that ref, and names the application after the folder", async () => {
    const home = await initAccount("verifier");
    const source = await buildSource([{ name: "mirror" }]);
    const raw = "https://raw.githubusercontent.com/acme/bridges/v1.2.0/applications/mirror/";
    const fetch = recordingFetch(async (url) => source.fetchBytes(url.replace(raw, "https://fixtures.example.test/mirror/")));
    const result = await run(["mcp", "add", "--home", home, "https://github.com/acme/bridges/tree/v1.2.0/applications/mirror"], testDeps({ fetchBytes: fetch.fetchBytes }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fetch.urls.sort()).toEqual([`${raw}adapter-config.example.json`, `${raw}plugin.json`]);
    expect(await readJson(join(home, "config", "drafts", "mirror-adapter-config.json"))).toMatchObject({ target: { applicationDid: fixtureApplicationDid } });
    expect(result.stdout).toContain("https://github.com/acme/bridges/blob/v1.2.0/applications/mirror/README.md");
  });

  it("treats any other https URL as the folder itself", async () => {
    const home = await initAccount("verifier");
    const fetch = recordingFetch(testDeps().fetchBytes);
    const result = await run(["mcp", "add", "--home", home, `${fixtureSourceUrl}/`], testDeps({ fetchBytes: fetch.fetchBytes }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fetch.urls.sort()).toEqual([`${fixtureSourceUrl}/adapter-config.example.json`, `${fixtureSourceUrl}/plugin.json`]);
    expect(result.stdout).toContain(`${fixtureSourceUrl}/README.md`);
  });

  it("accepts http only for a loopback host", async () => {
    const home = await initAccount("verifier");
    const before = await snapshot(home);
    for (const url of ["http://bridges.example.test/mirror", "ftp://fixtures.example.test/mirror", "fixtures.example.test/mirror"]) {
      const result = await run(["mcp", "add", "--home", home, url], testDeps());
      expect(result.exitCode, url).not.toBe(0);
    }
    expect(await snapshot(home)).toEqual(before);
    const local = await run(["mcp", "add", "--home", home, "http://127.0.0.1:8080/mirror"],
      testDeps({ fetchBytes: async (url) => testDeps().fetchBytes(url.replace("http://127.0.0.1:8080/", "https://fixtures.example.test/")) }));
    expect(local.exitCode, local.stderr).toBe(0);
  });

  it("prints the source URL and the plugin's artifactDid", async () => {
    const home = await initAccount("verifier");
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl], testDeps());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Source: ${fixtureSourceUrl}`);
    expect(result.stdout).toContain(`Plugin artifactDid: ${fixtureArtifactDid}`);
    expect(result.stdout.indexOf("Source:")).toBeLessThan(result.stdout.indexOf("Saved"));
  });

  it("rejects a folder without a file the role needs, writing nothing", async () => {
    const homedir = await tempDir();
    const verifier = await initAccount("verifier");
    const proposer = await proposerHome();
    const verifierBefore = await snapshot(verifier);
    const proposerBefore = await snapshot(proposer);

    const noTemplate = await buildSource([{ name: "mirror", withoutTemplate: true }]);
    const missingTemplate = await run(["mcp", "add", "--home", verifier, noTemplate.url("mirror")], testDeps(noTemplate));
    expect(missingTemplate.exitCode).not.toBe(0);
    expect(missingTemplate.stderr).toContain("adapter-config.example.json");

    const noBridge = await buildSource([{ name: "mirror", withoutBridge: true }]);
    const missingBridge = await run(["mcp", "add", "--home", proposer, noBridge.url("mirror"), "--harness", "cursor"], testDeps({ homedir, ...noBridge }));
    expect(missingBridge.exitCode).not.toBe(0);
    expect(missingBridge.stderr).toContain("bridge/package.json");

    const nothing = await run(["mcp", "add", "--home", verifier, "https://fixtures.example.test/empty"], testDeps());
    expect(nothing.exitCode).not.toBe(0);
    expect(nothing.stderr).toContain("plugin.json");

    expect(await snapshot(verifier)).toEqual(verifierBefore);
    expect(await snapshot(proposer)).toEqual(proposerBefore);
    expect(await snapshot(join(homedir, ".cursor"))).toEqual({});
  });

  it("rejects a template that does not match the downloaded plugin, and checks local files the same way", async () => {
    const home = await initAccount("verifier");
    const before = await snapshot(home);
    const wrongPin = await buildSource([{ name: "mirror", template: (t) => { t.plugin.artifactDid = "did:artifact:bafkreiotherotherotherotherotherotherotherotherotherotherothe"; } }]);
    const pin = await run(["mcp", "add", "--home", home, wrongPin.url("mirror")], testDeps(wrongPin));
    expect(pin.exitCode).not.toBe(0);
    expect(pin.stderr).toMatch(/artifactDid/);

    const wrongApp = await buildSource([{ name: "mirror", template: (t) => { t.target.applicationDid = "did:web:other.example"; } }]);
    const app = await run(["mcp", "add", "--home", home, wrongApp.url("mirror")], testDeps(wrongApp));
    expect(app.exitCode).not.toBe(0);
    expect(app.stderr).toMatch(/applicationDid/);

    const plugin = JSON.parse(await readFile(fixturePluginPath, "utf8")) as Json;
    plugin.description = "tampered";
    const localPlugin = join(await tempDir(), "plugin.json");
    await writeFile(localPlugin, JSON.stringify(plugin));
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--plugin", localPlugin], testDeps())).exitCode).not.toBe(0);

    const template = await readJson<Json>(fixtureTemplatePath);
    template.target.applicationDid = "did:web:other.example";
    const localTemplate = join(await tempDir(), "template.json");
    await writeFile(localTemplate, JSON.stringify(template));
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--config-template", localTemplate], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);
  });

  it("requires an exact bridge version", async () => {
    const home = await proposerHome();
    const homedir = await tempDir();
    const before = await snapshot(home);
    for (const version of ["^1.2.3", "alpha", ""]) {
      const source = await buildSource([{ name: "mirror", bridgePackage: (pkg) => { pkg.version = version; } }]);
      const result = await run(["mcp", "add", "--home", home, source.url("mirror"), "--harness", "cursor"], testDeps({ homedir, ...source }));
      expect(result.exitCode, version).not.toBe(0);
    }
    expect(await snapshot(home)).toEqual(before);
  });

  it("rejects --app and points at the URL form", async () => {
    const home = await initAccount("verifier");
    const result = await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("mpas mcp add <url>");
  });

  it("asks for the role on an account with more than one role, and requires --role without a terminal", async () => {
    const home = await proposerHome();
    await run(["init", "verifier", "--mode", "direct", "--home", home, "--add-role"], testDeps());
    const before = await snapshot(home);
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);

    const prompt = scriptedPrompt(["verifier"]);
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl], testDeps({ isTerminal: true, prompt: prompt.prompt }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(prompt.asked[0]).toMatch(/^Role/);
  });
});

describe("Phase 6: application name", () => {
  it("uses --name instead of the folder name, and rejects an invalid name", async () => {
    const home = await initAccount("verifier");
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--name", "mirror-two"], testDeps());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readJson(join(home, "config", "drafts", "mirror-two-adapter-config.json"))).toMatchObject({ target: { applicationDid: fixtureApplicationDid } });
    expect(await readJson(join(home, "installed", "mirror-two.json"))).toMatchObject({ name: "mirror-two", source: fixtureSourceUrl });

    const before = await snapshot(home);
    for (const name of ["Mirror", "mirror_two", "../mirror", "-mirror"]) {
      expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--name", name], testDeps())).exitCode, name).not.toBe(0);
    }
    expect(await snapshot(home)).toEqual(before);
  });

  it("refuses a name already used by an install record, a draft, or a live config, and names --name", async () => {
    const other = await buildSource([{ name: "mirror" }, { name: "elsewhere" }]);
    const setups: Array<[string, (home: string) => Promise<unknown>]> = [
      ["install record", (home) => run(["mcp", "add", "--home", home, other.url("mirror")], testDeps(other))],
      ["draft", (home) => writeFixtureConfig(home, "draft")],
      ["live config", (home) => writeFixtureConfig(home, "live")],
    ];
    for (const [label, setup] of setups) {
      const home = await initAccount("verifier");
      await setup(home);
      const before = await snapshot(home);
      const result = await run(["mcp", "add", "--home", home, other.url("elsewhere"), "--name", "mirror"], testDeps(other));
      expect(result.exitCode, label).not.toBe(0);
      expect(result.stderr, label).toContain("--name");
      expect(await snapshot(home), label).toEqual(before);
    }
  });

  it("refuses a name used by a Proposer bridge config or by a <name>-mpas server in the harness", async () => {
    const homedir = await tempDir();
    const withBridge = await proposerHome();
    await writeFixtureBridge(withBridge);
    const before = await snapshot(withBridge);
    const bridge = await run(["mcp", "add", "--home", withBridge, fixtureSourceUrl, "--harness", "cursor"], testDeps({ homedir }));
    expect(bridge.exitCode).not.toBe(0);
    expect(bridge.stderr).toContain("--name");
    expect(await snapshot(withBridge)).toEqual(before);

    const withServer = await proposerHome();
    await mkdir(join(homedir, ".cursor"), { recursive: true });
    const cursorConfig = JSON.stringify({ mcpServers: { "mirror-mpas": { command: "some-other-server" } } });
    await writeFile(join(homedir, ".cursor", "mcp.json"), cursorConfig);
    const serverBefore = await snapshot(withServer);
    const server = await run(["mcp", "add", "--home", withServer, fixtureSourceUrl, "--harness", "cursor"], testDeps({ homedir }));
    expect(server.exitCode).not.toBe(0);
    expect(server.stderr).toContain("mirror-mpas");
    expect(server.stderr).toContain("--name");
    expect(await snapshot(withServer)).toEqual(serverBefore);
    expect(await readFile(join(homedir, ".cursor", "mcp.json"), "utf8")).toBe(cursorConfig);

    const renamed = await run(["mcp", "add", "--home", withServer, fixtureSourceUrl, "--harness", "cursor", "--name", "mirror-two"], testDeps({ homedir }));
    expect(renamed.exitCode, renamed.stderr).toBe(0);
    expect(Object.keys(await cursorServers(homedir)).sort()).toEqual(["mirror-mpas", "mirror-two-mpas"]);
    expect((await cursorServers(homedir))["mirror-mpas"]).toEqual({ command: "some-other-server" });
  });

  it("reinstalls the same source only with --replace-config, and never under a name another source holds", async () => {
    const source = await buildSource([{ name: "mirror" }, { name: "elsewhere" }]);
    const home = await initAccount("verifier");
    expect((await run(["mcp", "add", "--home", home, source.url("mirror")], testDeps(source))).exitCode).toBe(0);

    const again = await run(["mcp", "add", "--home", home, source.url("mirror")], testDeps(source));
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr).toContain("--replace-config");
    expect((await run(["mcp", "add", "--home", home, source.url("mirror"), "--replace-config"], testDeps(source))).exitCode).toBe(0);

    const before = await snapshot(home);
    const different = await run(["mcp", "add", "--home", home, source.url("elsewhere"), "--name", "mirror", "--replace-config"], testDeps(source));
    expect(different.exitCode).not.toBe(0);
    expect(different.stderr).toContain("--name");
    expect(await snapshot(home)).toEqual(before);
  });

  it("lets --replace-config take over a bridge config set up by hand, which has no install record", async () => {
    const home = await proposerHome();
    await writeFixtureBridge(home);
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "cursor", "--replace-config"], testDeps({ homedir: await tempDir() }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readJson(join(home, "installed", "mirror.json"))).toMatchObject({ source: fixtureSourceUrl });
  });

  it("lets mpas signer and mpas config validate find the application by its installed name", async () => {
    const home = await initAccount("verifier");
    await writeCredential(home);
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--name", "mirror-two"], testDeps())).exitCode).toBe(0);
    expect((await run(["signer", "add", "--home", home, "--app", "mirror-two", "--proposer", await newDid()], testDeps())).exitCode).toBe(0);
    expect((await run(["signer", "add", "--home", home, "--app", "mirror-two", "--maintainer", await newDid()], testDeps())).exitCode).toBe(0);
    const validated = await run(["config", "validate", "--home", home, "mirror-two"], testDeps());
    expect(validated.exitCode, validated.stdout + validated.stderr).toBe(0);
  });
});

describe("Phase 6: install record", () => {
  it("records the source, each file's URL, the plugin, and the bridge package", async () => {
    const home = await proposerHome();
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "cursor"], testDeps({ homedir: await tempDir() }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readJson(join(home, "installed", "mirror.json"))).toEqual({
      version: "2",
      type: "MpasInstalledApplication",
      name: "mirror",
      role: "proposer",
      source: fixtureSourceUrl,
      files: {
        plugin: `${fixtureSourceUrl}/plugin.json`,
        bridgePackage: `${fixtureSourceUrl}/bridge/package.json`,
      },
      plugin: { artifactDid: fixtureArtifactDid, applicationDid: fixtureApplicationDid },
      bridge: { package: "@fixture/mpas-bridge-mirror", version: "1.2.3" },
      cliVersion: "0.1.0-alpha.1",
      installedAt: "2026-10-09T12:00:00.000Z",
    });
  });
});

describe("Phase 3 and 6: Proposer mcp add", () => {
  it("prompts for a missing URL and harness on a terminal, and requires them otherwise", async () => {
    const home = await proposerHome();
    const before = await snapshot(home);
    expect((await run(["mcp", "add", "--home", home, "--harness", "cursor"], testDeps())).exitCode).not.toBe(0);
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);

    const homedir = await tempDir();
    const prompt = scriptedPrompt(["", fixtureSourceUrl, "", "cursor"]);
    const result = await run(["mcp", "add", "--home", home], testDeps({ homedir, isTerminal: true, prompt: prompt.prompt }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(prompt.asked.map((question) => question.split(" ")[0])).toEqual(["Application", "Application", "Harness", "Harness"]);
  });

  it("requires a stored Verifier DID, with a loopback or a hosted Action URL", async () => {
    for (const action of ["local", "https://relay.example.test"]) {
      const home = await initAccount("proposer");
      if (action !== "local") await run(["config", "--home", home, "--action", action], testDeps());
      const before = await snapshot(home);
      const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "cursor"], testDeps({ homedir: await tempDir() }));
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/mpas config(?: --home \S+)? --verifier-did/);
      expect(await snapshot(home)).toEqual(before);
    }
  });

  it("writes the bridge config and registers only <name>-mpas, keeping other servers", async () => {
    const home = await proposerHome();
    const homedir = await tempDir();
    await mkdir(join(homedir, ".cursor"), { recursive: true });
    await writeFile(join(homedir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other-server" } }, theme: "dark" }));
    const account = await readJson(join(home, "account.json"));

    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "cursor"], testDeps({ homedir }));
    expect(result.exitCode, result.stderr).toBe(0);

    const bridgePath = join(home, "mcp-server-configs", "mirror-mcp-bridge-config.json");
    expect(await readJson(bridgePath)).toEqual({
      mode: "proposer",
      plugin: join(home, "plugins", fixturePluginFile),
      agent: { did: account.did, keyFile: join(home, "keys", "signing-key.json") },
      target: { applicationDid: fixtureApplicationDid },
      coordination: { url: "http://127.0.0.1:7545" },
      actionEndpoint: { url: "http://127.0.0.1:7544", verifierDid: "did:web:verifier.example.test" },
      workflow: { dbPath: join(home, "workflows", "mirror.db") },
    });
    expect(await readFile(join(home, "plugins", fixturePluginFile))).toEqual(await readFile(fixturePluginPath));

    const cursor = await readJson<Json>(join(homedir, ".cursor", "mcp.json"));
    expect(cursor.theme).toBe("dark");
    expect(Object.keys(cursor.mcpServers).sort()).toEqual(["mirror-mpas", "other"]);
    expect(cursor.mcpServers["mirror-mpas"]).toEqual({
      command: "/opt/node/bin/node",
      args: ["/opt/node/lib/node_modules/npm/bin/npx-cli.js", "-y", "@fixture/mpas-bridge-mirror@1.2.3", "--config", bridgePath],
      env: { PATH: "/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    expect(JSON.stringify(cursor.mcpServers["mirror-mpas"])).not.toContain("~");

    expect(result.stdout).toContain("## Prime Directive — MPAS Proposer");
    expect(result.stdout).toContain("AGENTS.md");
    expect(result.stdout).toContain(`${fixtureSourceUrl}/README.md`);
    expect(result.stdout).toMatch(/mpas config validate(?: --home \S+)? mirror/);
  });

  it("adds a second application from another URL", async () => {
    const home = await proposerHome();
    const homedir = await tempDir();
    const source = await buildSource([{ name: "mirror" }, { name: "second", applicationDid: "did:web:second.example" }]);
    const deps = () => testDeps({ homedir, ...source });
    expect((await run(["mcp", "add", "--home", home, source.url("mirror"), "--harness", "cursor"], deps())).exitCode).toBe(0);
    const second = await run(["mcp", "add", "--home", home, source.url("second"), "--harness", "cursor"], deps());
    expect(second.exitCode, second.stderr).toBe(0);
    expect(Object.keys(await cursorServers(homedir)).sort()).toEqual(["mirror-mpas", "second-mpas"]);
    expect((await readJson<Json>(join(home, "mcp-server-configs", "second-mcp-bridge-config.json"))).target.applicationDid).toBe("did:web:second.example");

    const key = await readFile(join(home, "keys", "signing-key.json"));
    expect((await run(["mcp", "add", "--home", home, source.url("mirror"), "--harness", "cursor", "--replace-config"], deps())).exitCode).toBe(0);
    expect(await readFile(join(home, "keys", "signing-key.json"))).toEqual(key);
  });

  it("keeps the plugin and bridge config but fails registration when the package is not on npm", async () => {
    const home = await proposerHome();
    const homedir = await tempDir();
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "cursor"], testDeps({ homedir, npmVersionExists: async () => false }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("@fixture/mpas-bridge-mirror@1.2.3");
    expect(await readJson(join(home, "mcp-server-configs", "mirror-mcp-bridge-config.json"))).toMatchObject({ mode: "proposer" });
    expect(await snapshot(join(homedir, ".cursor"))).toEqual({});
    for (const content of Object.values(await snapshot(home))) {
      expect(Buffer.from(content.split(":")[1] ?? "", "base64").toString()).not.toContain("dist/");
    }
  });

  it("rejects --config-template for a Proposer", async () => {
    const home = await proposerHome();
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "cursor", "--config-template", fixtureTemplatePath], testDeps({ homedir: await tempDir() }));
    expect(result.exitCode).not.toBe(0);
  });
});

describe("Phase 3 and 6: Maintainer mcp add", () => {
  it("rejects a URL", async () => {
    const home = await initAccount("maintainer");
    const before = await snapshot(home);
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "cursor"], testDeps({ homedir: await tempDir() }));
    expect(result.exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);
  });
});

describe("Phase 3 and 6: Verifier mcp add", () => {
  it("rejects --harness", async () => {
    const home = await initAccount("verifier");
    const before = await snapshot(home);
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "cursor"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);
  });

  it("writes the plugin, the install record, and a draft equal to the template except plugin.path, and nothing live", async () => {
    const home = await initAccount("verifier");
    const deps = testDeps();
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl], deps);
    expect(result.exitCode, result.stderr).toBe(0);

    const draft = await readJson<Json>(join(home, "config", "drafts", "mirror-adapter-config.json"));
    const template = await readJson<Json>(fixtureTemplatePath);
    expect(draft.plugin.path).toBe(join(home, "plugins", fixturePluginFile));
    expect(await readJson<Json>(join(home, "installed", "mirror.json"))).toMatchObject({
      role: "verifier",
      source: fixtureSourceUrl,
      files: { plugin: `${fixtureSourceUrl}/plugin.json`, template: `${fixtureSourceUrl}/adapter-config.example.json` },
      plugin: { artifactDid: fixtureArtifactDid, applicationDid: fixtureApplicationDid },
    });
    template.plugin.path = draft.plugin.path;
    expect(draft).toEqual(template);
    expect(Object.keys(await snapshot(join(home, "config"))).sort()).toEqual(["drafts", join("drafts", "mirror-adapter-config.json")]);
    expect(deps.commands).toEqual([]);

    expect(result.stdout).toContain(`${fixtureSourceUrl}/README.md`);
    expect(result.stdout).toMatch(/mpas signer add(?: --home \S+)? --app mirror --proposer <did>/);
    expect(result.stdout).toMatch(/mpas config validate(?: --home \S+)? mirror/);
    expect(result.stdout).toContain(`--config-dir ${join(home, "config")}`);
    expect(result.stdout).toContain(`--credential-dir ${join(home, "credentials")}`);
    expect(result.stdout).toContain(`--adapter-key ${join(home, "keys", "signing-key.json")}`);
    expect(result.stdout).toContain(`--journal-path ${join(home, "journal", "dispatch-ledger.jsonl")}`);
    expect(result.stdout).not.toContain("--verifier-relay-url");
  });

  it("prints both adapter commands when the Verifier has no mode", async () => {
    const home = join(await tempDir(), "home");
    await run(["init", "verifier", "--home", home, "--action", "https://relay.example.test"], testDeps());
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl], testDeps());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.match(/mpas adapter start/g)).toHaveLength(2);
    expect(result.stdout).toMatch(/If Proposers submit to this adapter directly/);
    expect(result.stdout).toMatch(/If this adapter polls a relay/);
    expect(result.stdout).toContain("--verifier-relay-url https://relay.example.test");
    expect(result.stdout).toMatch(/mpas config(?: --home \S+)? --mode direct\|relay/);
  });

  it("chooses relay flags from the Verifier's mode, not from the Action URL's host", async () => {
    const cases = [
      ["http://127.0.0.1:7544", "direct", false],
      ["https://adapter.example.test", "direct", false],
      ["http://localhost:9000", "relay", true],
      ["https://api.example.test", "relay", true],
    ] as const;
    for (const [action, mode, relay] of cases) {
      const home = await initAccount("verifier");
      await run(["config", "--home", home, "--action", action, "--mode", mode], testDeps());
      const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl], testDeps());
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.includes(`--verifier-relay-url ${action}`), `${mode} ${action}`).toBe(relay);
      expect(result.stdout.includes(`--verifier-relay-state ${join(home, "journal", "verifier-relay-")}`), `${mode} ${action}`).toBe(relay);
    }
  });

  it("replaces a draft only with --replace-config, keeping the earlier draft and the live config", async () => {
    const home = await initAccount("verifier");
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl], testDeps())).exitCode).toBe(0);
    await rename(join(home, "config", "drafts", "mirror-adapter-config.json"), join(home, "config", "mirror-adapter-config.json"));
    const live = join(home, "config", "mirror-adapter-config.json");
    const liveBytes = await readFile(live);
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl], testDeps())).exitCode).not.toBe(0);

    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--replace-config"], testDeps())).exitCode).toBe(0);
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", await newDid()], testDeps());
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--replace-config"], testDeps())).exitCode).toBe(0);
    const drafts = Object.keys(await snapshot(join(home, "config", "drafts"))).sort();
    expect(drafts).toEqual(["mirror-adapter-config.json", expect.stringMatching(/^mirror-adapter-config\..+\.json$/)].sort());
    expect(await readFile(live)).toEqual(liveBytes);
  });

  it("uses --plugin and --config-template in place of the downloads, after the same checks", async () => {
    const home = await initAccount("verifier");
    const template = await readJson<Json>(fixtureTemplatePath);
    template.policy.policies = {};
    const localTemplate = join(await tempDir(), "template.json");
    await writeFile(localTemplate, JSON.stringify(template));
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--plugin", fixturePluginPath, "--config-template", localTemplate], testDeps());
    expect(result.exitCode, result.stderr).toBe(0);
    expect((await readJson<Json>(join(home, "config", "drafts", "mirror-adapter-config.json"))).policy.policies).toEqual({});
    expect(await readJson(join(home, "installed", "mirror.json"))).toMatchObject({ files: { plugin: fixturePluginPath, template: localTemplate } });
  });

  it("leaves the live config's plugin untouched when a replacement draft brings a newer plugin", async () => {
    const home = await initAccount("verifier");
    await writeCredential(home);
    const proposer = await newDid();
    const maintainer = await newDid();
    expect((await run(["mcp", "add", "--home", home, fixtureSourceUrl], testDeps())).exitCode).toBe(0);
    await run(["signer", "add", "--home", home, "--app", "mirror", "--proposer", proposer], testDeps());
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", maintainer], testDeps());
    await rename(join(home, "config", "drafts", "mirror-adapter-config.json"), join(home, "config", "mirror-adapter-config.json"));
    const livePluginPath = (await readJson<Json>(join(home, "config", "mirror-adapter-config.json"))).plugin.path;
    const livePlugin = await readFile(livePluginPath);

    const newer = JSON.parse(livePlugin.toString()) as Json;
    newer.description = "A newer plugin release.";
    const source = await buildSource([{ name: "mirror", pluginBytes: new TextEncoder().encode(JSON.stringify(newer)) }]);
    expect((await run(["mcp", "add", "--home", home, source.url("mirror"), "--replace-config"], testDeps(source))).exitCode).toBe(0);

    const draftPluginPath = (await readJson<Json>(join(home, "config", "drafts", "mirror-adapter-config.json"))).plugin.path;
    expect(draftPluginPath).not.toBe(livePluginPath);
    expect(await readFile(livePluginPath)).toEqual(livePlugin);
    const loaded = await loadDeploymentConfigs(join(home, "config"), { confirmPluginUse: async () => true });
    expect(loaded.ok, loaded.ok ? "" : loaded.error.message).toBe(true);
  });
});

describe("Phase 6 review fixes", () => {
  it("never lets --replace-config take over an unrelated harness server when there is no application config", async () => {
    const home = await proposerHome();
    const homedir = await tempDir();
    await mkdir(join(homedir, ".cursor"), { recursive: true });
    const cursorConfig = JSON.stringify({ mcpServers: { "mirror-mpas": { command: "unrelated-server", args: ["--serve"] } } });
    await writeFile(join(homedir, ".cursor", "mcp.json"), cursorConfig);
    const before = await snapshot(home);
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "cursor", "--replace-config"], testDeps({ homedir }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--name");
    expect(await readFile(join(homedir, ".cursor", "mcp.json"), "utf8")).toBe(cursorConfig);
    expect(await snapshot(home)).toEqual(before);
  });

  it("takes over a hand-made setup only when its harness entry launches this home's bridge config", async () => {
    const homedir = await tempDir();
    const own = await proposerHome();
    const bridge = await writeFixtureBridge(own);
    await mkdir(join(homedir, ".cursor"), { recursive: true });
    await writeFile(join(homedir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "mirror-mpas": { command: "node", args: ["bridge.js", "--config", bridge] } } }));
    const takeover = await run(["mcp", "add", "--home", own, fixtureSourceUrl, "--harness", "cursor", "--replace-config"], testDeps({ homedir }));
    expect(takeover.exitCode, takeover.stderr).toBe(0);
    expect((await cursorServers(homedir))["mirror-mpas"].args).toContain("@fixture/mpas-bridge-mirror@1.2.3");

    const otherHomedir = await tempDir();
    const elsewhere = await proposerHome();
    await writeFixtureBridge(elsewhere);
    await mkdir(join(otherHomedir, ".cursor"), { recursive: true });
    const foreign = JSON.stringify({ mcpServers: { "mirror-mpas": { command: "node", args: ["bridge.js", "--config", "/somewhere/else/mirror-mcp-bridge-config.json"] } } });
    await writeFile(join(otherHomedir, ".cursor", "mcp.json"), foreign);
    const before = await snapshot(elsewhere);
    const refused = await run(["mcp", "add", "--home", elsewhere, fixtureSourceUrl, "--harness", "cursor", "--replace-config"], testDeps({ homedir: otherHomedir }));
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("mirror-mpas");
    expect(await readFile(join(otherHomedir, ".cursor", "mcp.json"), "utf8")).toBe(foreign);
    expect(await snapshot(elsewhere)).toEqual(before);
  });

  it("finds a Codex server however its TOML table name is quoted, and never removes it without --replace-config", async () => {
    for (const header of ["[mcp_servers.mirror-mpas]", '[mcp_servers."mirror-mpas"]', "[mcp_servers.'mirror-mpas']", "[mcp_servers . 'mirror-mpas']"]) {
      const home = await proposerHome();
      const homedir = await tempDir();
      const codexHome = join(homedir, ".codex-proposer");
      await mkdir(codexHome, { recursive: true });
      const toml = `${header}\ncommand = "unrelated-server"\nargs = ["--serve"]\n`;
      await writeFile(join(codexHome, "config.toml"), toml);
      const deps = testDeps({ homedir });
      const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "codex"], deps);
      expect(result.exitCode, header).not.toBe(0);
      expect(result.stderr, header).toContain("--name");
      expect(deps.commands.filter((command) => command.command === "codex"), header).toEqual([]);
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(toml);
    }
  });

  it("stops before running codex when config.toml cannot be parsed", async () => {
    const home = await proposerHome();
    const homedir = await tempDir();
    const codexHome = join(homedir, ".codex-proposer");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), "[mcp_servers.mirror-mpas\ncommand = \n");
    const deps = testDeps({ homedir });
    const before = await snapshot(home);
    const result = await run(["mcp", "add", "--home", home, fixtureSourceUrl, "--harness", "codex"], deps);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("config.toml");
    expect(deps.commands.filter((command) => command.command === "codex")).toEqual([]);
    expect(await snapshot(home)).toEqual(before);
  });

  it("prints next steps and migration steps in the URL form", async () => {
    for (const role of ["proposer", "verifier"] as const) {
      const home = join(await tempDir(), "home");
      const args = role === "proposer" ? ["--coordination", "local", "--action", "local"] : ["--action", "local"];
      const result = await run(["init", role, "--home", home, ...args], testDeps());
      expect(result.stdout, role).toMatch(/mpas mcp add(?: --home \S+)? <url>/);
      expect(result.stdout, role).not.toContain("--app");
    }

    const home = await proposerHome();
    const bridge = await writeFixtureBridge(home);
    const config = await readJson<Json>(bridge);
    config.agent.keyFile = join(home, "keys", "old-key.json");
    await writeFile(bridge, JSON.stringify(config));
    const refused = await run(["config", "--home", home, "--coordination", "http://127.0.0.1:9999"], testDeps());
    expect(refused.exitCode).not.toBe(0);
    const text = `${refused.stdout}${refused.stderr}`;
    expect(text).toMatch(/mpas mcp add(?: --home \S+)? <url> --name <name> --replace-config/);
    expect(text).not.toContain("--app");
  });
});
