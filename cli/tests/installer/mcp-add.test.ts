import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import {
  buildRegistry,
  fixtureApplicationDid,
  fixtureArtifactDid,
  fixturePluginFile,
  fixturePluginPath,
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
  writeFixtureConfig,
} from "./helpers.js";

type Json = Record<string, any>;

async function proposerHome(extra: string[] = []) {
  return initAccount("proposer", ["--verifier-did", "did:web:verifier.example.test", ...extra]);
}

async function cursorServers(homedir: string): Promise<Json> {
  return (await readJson<Json>(join(homedir, ".cursor", "mcp.json"))).mcpServers;
}

describe("Phase 3: mpas mcp add, application resolution", () => {
  it("rejects an unknown application and an ambiguous application part before writing", async () => {
    const home = await proposerHome();
    const before = await snapshot(home);
    const homedir = await tempDir();
    const unknown = await run(["mcp", "add", "--home", home, "--app", "nope", "--harness", "cursor"], testDeps({ homedir }));
    expect(unknown.exitCode).not.toBe(0);

    const registry = await buildRegistry([{ name: "mirror-fixtureorg" }, { name: "mirror-otherorg" }]);
    const ambiguous = await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir, ...registry }));
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.stderr).toContain("mirror-fixtureorg");
    expect(ambiguous.stderr).toContain("mirror-otherorg");
    expect(await snapshot(home)).toEqual(before);
    expect(await snapshot(join(homedir, ".cursor"))).toEqual({});
  });

  it("rejects a manifest, plugin, or template that fails verification, writing nothing", async () => {
    const homedir = await tempDir();
    const proposer = await proposerHome();
    const before = await snapshot(proposer);

    const tamperedManifest = await buildRegistry([{ name: "mirror-fixtureorg" }]);
    const fetchTampered = async (url: string) => {
      const bytes = await tamperedManifest.fetchBytes(url);
      return url.endsWith("install.json") ? new TextEncoder().encode(`${new TextDecoder().decode(bytes)} `) : bytes;
    };
    const manifest = await run(["mcp", "add", "--home", proposer, "--app", "mirror", "--harness", "cursor"],
      testDeps({ homedir, registryDir: tamperedManifest.registryDir, fetchBytes: fetchTampered }));
    expect(manifest.exitCode).not.toBe(0);
    expect(manifest.stderr).toMatch(/manifest/i);

    const plugin = JSON.parse(await readFile(fixturePluginPath, "utf8")) as Json;
    plugin.description = "tampered";
    const badPlugin = await buildRegistry([{ name: "mirror-fixtureorg", pluginBytes: new TextEncoder().encode(JSON.stringify(plugin)), registryArtifactDid: fixtureArtifactDid }]);
    const pluginResult = await run(["mcp", "add", "--home", proposer, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir, ...badPlugin }));
    expect(pluginResult.exitCode).not.toBe(0);
    expect(pluginResult.stderr).toMatch(/artifactDid/);

    const localPlugin = join(await tempDir(), "plugin.json");
    await writeFile(localPlugin, JSON.stringify(plugin));
    expect((await run(["mcp", "add", "--home", proposer, "--app", "mirror", "--harness", "cursor", "--plugin", localPlugin], testDeps({ homedir }))).exitCode).not.toBe(0);

    const range = await buildRegistry([{ name: "mirror-fixtureorg", manifest: (value) => { value.bridge.version = "^1.2.3"; } }]);
    expect((await run(["mcp", "add", "--home", proposer, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir, ...range }))).exitCode).not.toBe(0);
    const tag = await buildRegistry([{ name: "mirror-fixtureorg", manifest: (value) => { value.bridge.version = "alpha"; } }]);
    expect((await run(["mcp", "add", "--home", proposer, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir, ...tag }))).exitCode).not.toBe(0);
    expect(await snapshot(proposer)).toEqual(before);
    expect(await snapshot(join(homedir, ".cursor"))).toEqual({});

    const verifier = await initAccount("verifier");
    const verifierBefore = await snapshot(verifier);
    const badTemplate = await buildRegistry([{ name: "mirror-fixtureorg" }]);
    const fetchBadTemplate = async (url: string) => {
      const bytes = await badTemplate.fetchBytes(url);
      return url.endsWith("adapter-config.example.json") ? new TextEncoder().encode(`${new TextDecoder().decode(bytes)} `) : bytes;
    };
    const template = await run(["mcp", "add", "--home", verifier, "--app", "mirror"], testDeps({ registryDir: badTemplate.registryDir, fetchBytes: fetchBadTemplate }));
    expect(template.exitCode).not.toBe(0);
    expect(template.stderr).toMatch(/template/i);
    expect(await snapshot(verifier)).toEqual(verifierBefore);
  });

  it("asks for the role on an account with more than one role, and requires --role without a terminal", async () => {
    const home = await proposerHome();
    await run(["init", "verifier", "--mode", "direct", "--home", home, "--add-role"], testDeps());
    const before = await snapshot(home);
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);

    const prompt = scriptedPrompt(["verifier"]);
    const result = await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps({ isTerminal: true, prompt: prompt.prompt }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(prompt.asked[0]).toMatch(/^Role/);
  });
});

describe("Phase 3: Proposer mcp add", () => {
  it("prompts for a missing application and harness on a terminal, and requires them otherwise", async () => {
    const home = await proposerHome();
    const before = await snapshot(home);
    expect((await run(["mcp", "add", "--home", home, "--harness", "cursor"], testDeps())).exitCode).not.toBe(0);
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);

    const homedir = await tempDir();
    const prompt = scriptedPrompt(["", "mirror", "", "cursor"]);
    const result = await run(["mcp", "add", "--home", home], testDeps({ homedir, isTerminal: true, prompt: prompt.prompt }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(prompt.asked.map((question) => question.split(" ")[0])).toEqual(["Application", "Application", "Harness", "Harness"]);
  });

  it("requires a stored Verifier DID, with a loopback or a hosted Action URL", async () => {
    for (const action of ["local", "https://relay.example.test"]) {
      const home = await initAccount("proposer");
      if (action !== "local") await run(["config", "--home", home, "--action", action], testDeps());
      const before = await snapshot(home);
      const result = await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir: await tempDir() }));
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/mpas config(?: --home \S+)? --verifier-did/);
      expect(await snapshot(home)).toEqual(before);
    }
  });

  it("writes the bridge config and registers only <app>-mpas, keeping other servers", async () => {
    const home = await proposerHome();
    const homedir = await tempDir();
    await mkdir(join(homedir, ".cursor"), { recursive: true });
    await writeFile(join(homedir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other-server" } }, theme: "dark" }));
    const account = await readJson(join(home, "account.json"));

    const result = await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir }));
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
    expect(result.stdout).toContain("https://fixtures.example.test/mirror/README.md");
    expect(result.stdout).toMatch(/mpas config validate(?: --home \S+)? mirror/);
  });

  it("adds a second application, and replaces one only with --replace-config", async () => {
    const home = await proposerHome();
    const homedir = await tempDir();
    const registry = await buildRegistry([{ name: "mirror-fixtureorg" }, { name: "second-fixtureorg", applicationDid: "did:web:second.example" }]);
    const deps = () => testDeps({ homedir, ...registry });
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor"], deps())).exitCode).toBe(0);
    expect((await run(["mcp", "add", "--home", home, "--app", "second", "--harness", "cursor"], deps())).exitCode).toBe(0);
    expect(Object.keys(await cursorServers(homedir)).sort()).toEqual(["mirror-mpas", "second-mpas"]);
    expect((await readJson<Json>(join(home, "mcp-server-configs", "second-mcp-bridge-config.json"))).target.applicationDid).toBe("did:web:second.example");

    const key = await readFile(join(home, "keys", "signing-key.json"));
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor"], deps())).exitCode).not.toBe(0);
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor", "--replace-config"], deps())).exitCode).toBe(0);
    expect(await readFile(join(home, "keys", "signing-key.json"))).toEqual(key);
  });

  it("keeps the plugin and bridge config but fails registration when the package is not on npm", async () => {
    const home = await proposerHome();
    const homedir = await tempDir();
    const result = await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir, npmVersionExists: async () => false }));
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
    const result = await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor", "--config-template", fixtureTemplatePath], testDeps({ homedir: await tempDir() }));
    expect(result.exitCode).not.toBe(0);
  });
});

describe("Phase 3: Verifier mcp add", () => {
  it("rejects --harness", async () => {
    const home = await initAccount("verifier");
    const before = await snapshot(home);
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);
  });

  it("writes the plugin and a draft equal to the template except plugin.path, and nothing live", async () => {
    const home = await initAccount("verifier");
    const deps = testDeps();
    const result = await run(["mcp", "add", "--home", home, "--app", "mirror"], deps);
    expect(result.exitCode, result.stderr).toBe(0);

    const draft = await readJson<Json>(join(home, "config", "drafts", "mirror-adapter-config.json"));
    const template = await readJson<Json>(fixtureTemplatePath);
    expect(draft.plugin.path).toBe(join(home, "plugins", fixturePluginFile));
    expect(await readJson<Json>(join(home, "installed", "mirror.json"))).toMatchObject({
      registryName: "mirror-fixtureorg",
      registryEntry: { plugin: { artifactDid: fixtureArtifactDid } },
      manifest: { applicationDid: fixtureApplicationDid },
    });
    template.plugin.path = draft.plugin.path;
    expect(draft).toEqual(template);
    expect(Object.keys(await snapshot(join(home, "config"))).sort()).toEqual(["drafts", join("drafts", "mirror-adapter-config.json")]);
    expect(deps.commands).toEqual([]);

    expect(result.stdout).toContain("https://fixtures.example.test/mirror/README.md");
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
    const result = await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps());
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
      const result = await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps());
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.includes(`--verifier-relay-url ${action}`), `${mode} ${action}`).toBe(relay);
      expect(result.stdout.includes(`--verifier-relay-state ${join(home, "journal", "verifier-relay-")}`), `${mode} ${action}`).toBe(relay);
    }
  });

  it("keeps the plugin but writes no draft when the manifest has no template", async () => {
    const home = await initAccount("verifier");
    const registry = await buildRegistry([{ name: "mirror-fixtureorg", withoutTemplate: true }]);
    const result = await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps(registry));
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("https://fixtures.example.test/mirror-fixtureorg/README.md");
    expect(await readFile(join(home, "plugins", fixturePluginFile))).toEqual(await readFile(fixturePluginPath));
    expect(Object.keys(await snapshot(join(home, "config", "drafts")))).toEqual([]);
  });

  it("replaces a draft only with --replace-config, keeping the earlier draft and the live config", async () => {
    const home = await initAccount("verifier");
    const live = await writeFixtureConfig(home, "live");
    const liveBytes = await readFile(live);
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps())).exitCode).not.toBe(0);

    expect((await run(["mcp", "add", "--home", home, "--app", "mirror", "--replace-config"], testDeps())).exitCode).toBe(0);
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", await newDid()], testDeps());
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror", "--replace-config"], testDeps())).exitCode).toBe(0);
    const drafts = Object.keys(await snapshot(join(home, "config", "drafts"))).sort();
    expect(drafts).toEqual(["mirror-adapter-config.json", expect.stringMatching(/^mirror-adapter-config\..+\.json$/)].sort());
    expect(await readFile(live)).toEqual(liveBytes);
  });

  it("checks --plugin against artifactDid and lets --config-template skip the digest", async () => {
    const home = await initAccount("verifier");
    const template = await readJson<Json>(fixtureTemplatePath);
    template.policy.policies = {};
    const localTemplate = join(await tempDir(), "template.json");
    await writeFile(localTemplate, JSON.stringify(template));
    const result = await run(["mcp", "add", "--home", home, "--app", "mirror", "--plugin", fixturePluginPath, "--config-template", localTemplate], testDeps());
    expect(result.exitCode, result.stderr).toBe(0);
    expect((await readJson<Json>(join(home, "config", "drafts", "mirror-adapter-config.json"))).policy.policies).toEqual({});

    template.target.applicationDid = "did:web:other.example";
    await writeFile(localTemplate, JSON.stringify(template));
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror", "--config-template", localTemplate, "--replace-config"], testDeps())).exitCode).not.toBe(0);
  });
  it("leaves the live config's plugin untouched when a replacement draft brings a newer plugin", async () => {
    const home = await initAccount("verifier");
    await writeCredential(home);
    const proposer = await newDid();
    const maintainer = await newDid();
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps())).exitCode).toBe(0);
    await run(["signer", "add", "--home", home, "--app", "mirror", "--proposer", proposer], testDeps());
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", maintainer], testDeps());
    await rename(join(home, "config", "drafts", "mirror-adapter-config.json"), join(home, "config", "mirror-adapter-config.json"));
    const livePluginPath = (await readJson<Json>(join(home, "config", "mirror-adapter-config.json"))).plugin.path;
    const livePlugin = await readFile(livePluginPath);

    const newer = JSON.parse(livePlugin.toString()) as Json;
    newer.description = "A newer plugin release.";
    const registry = await buildRegistry([{ name: "mirror-fixtureorg", pluginBytes: new TextEncoder().encode(JSON.stringify(newer)) }]);
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror", "--replace-config"], testDeps(registry))).exitCode).toBe(0);

    const draftPluginPath = (await readJson<Json>(join(home, "config", "drafts", "mirror-adapter-config.json"))).plugin.path;
    expect(draftPluginPath).not.toBe(livePluginPath);
    expect(await readFile(livePluginPath)).toEqual(livePlugin);
    const loaded = await loadDeploymentConfigs(join(home, "config"), { confirmPluginUse: async () => true });
    expect(loaded.ok, loaded.ok ? "" : loaded.error.message).toBe(true);
  });
});
