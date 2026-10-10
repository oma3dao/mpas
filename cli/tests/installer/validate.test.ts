import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRegistry,
  fixtureApplicationDid,
  initAccount,
  newDid,
  readJson,
  run,
  snapshot,
  testDeps,
  writeCredential,
  writeFixtureBridge,
  writeFixtureConfig,
  writeMixedKey,
} from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const offline = () =>
  testDeps({
    npmVersionExists: async () => {
      throw new Error("validate must not call the network");
    },
  });

describe("Phase 2: mpas config validate", () => {
  it("passes on a new account of each role", async () => {
    for (const role of ["proposer", "maintainer", "verifier"] as const) {
      const home = await initAccount(role);
      const result = await run(["config", "validate", "--home", home], offline());
      expect(result.exitCode, `${role}: ${result.stdout}${result.stderr}`).toBe(0);
    }
  });

  it("names the file for each failure", async () => {
    const keyMode = await initAccount("proposer");
    await chmod(join(keyMode, "keys", "signing-key.json"), 0o644);
    const modeResult = await run(["config", "validate", "--home", keyMode], offline());
    expect(modeResult.exitCode).not.toBe(0);
    expect(modeResult.stdout).toContain(join(keyMode, "keys", "signing-key.json"));

    const mixedHome = await initAccount("proposer");
    const { foreignPrivateD } = await writeMixedKey(join(mixedHome, "keys", "signing-key.json"));
    const account = await readJson<Record<string, any>>(join(mixedHome, "account.json"));
    account.did = (await readJson<{ did: string }>(join(mixedHome, "keys", "signing-key.json"))).did;
    await writeFile(join(mixedHome, "account.json"), JSON.stringify(account));
    const mixedResult = await run(["config", "validate", "--home", mixedHome], offline());
    expect(mixedResult.exitCode).not.toBe(0);
    expect(mixedResult.stdout).toContain(join(mixedHome, "keys", "signing-key.json"));
    expect(`${mixedResult.stdout}${mixedResult.stderr}`).not.toContain(foreignPrivateD);

    const otherVerifier = await initAccount("proposer", ["--verifier-did", "did:web:verifier.example.test"]);
    const otherBridge = await writeFixtureBridge(otherVerifier);
    const otherConfig = await readJson<Record<string, any>>(otherBridge);
    otherConfig.actionEndpoint.verifierDid = "did:web:someone-else.example.test";
    await writeFile(otherBridge, JSON.stringify(otherConfig));
    const otherResult = await run(["config", "validate", "--home", otherVerifier], offline());
    expect(otherResult.exitCode).not.toBe(0);
    expect(otherResult.stdout).toMatch(new RegExp(`${otherBridge}.*actionEndpoint\\.verifierDid`));

    const proposer = await initAccount("proposer");
    const bridge = await writeFixtureBridge(proposer);
    const config = await readJson<Record<string, any>>(bridge);
    config.agent.did = await newDid();
    await writeFile(bridge, JSON.stringify(config));
    const didResult = await run(["config", "validate", "--home", proposer], offline());
    expect(didResult.exitCode).not.toBe(0);
    expect(didResult.stdout).toMatch(new RegExp(`${bridge}.*agent\\.did`));

    const adapter = await initAccount("proposer");
    const adapterBridge = await writeFixtureBridge(adapter);
    const withAdapter = await readJson<Record<string, any>>(adapterBridge);
    withAdapter.adapter = { url: "http://127.0.0.1:7544" };
    await writeFile(adapterBridge, JSON.stringify(withAdapter));
    const adapterResult = await run(["config", "validate", "--home", adapter], offline());
    expect(adapterResult.exitCode).not.toBe(0);
    expect(adapterResult.stdout).toMatch(new RegExp(`${adapterBridge}.*adapter`));

    const plugin = await initAccount("proposer");
    await writeFixtureBridge(plugin);
    const pluginPath = join(plugin, "plugins", "mirror-plugin.json");
    const pluginJson = await readJson<Record<string, any>>(pluginPath);
    pluginJson.description = "tampered";
    await writeFile(pluginPath, JSON.stringify(pluginJson));
    const pluginResult = await run(["config", "validate", "--home", plugin], offline());
    expect(pluginResult.exitCode).not.toBe(0);
    expect(pluginResult.stdout).toMatch(new RegExp(`${pluginPath}.*artifactDid`));
  });

  it("names each placeholder in a Verifier draft, and prints the move command once the draft passes", async () => {
    const home = await initAccount("verifier");
    await writeCredential(home);
    const draft = await writeFixtureConfig(home, "draft");

    const pending = await run(["config", "validate", "mirror", "--home", home], offline());
    expect(pending.exitCode).not.toBe(0);
    expect(pending.stdout).toContain("policy.signerGroups.proposers[0]: REPLACE_WITH_PROPOSER_DID");
    expect(pending.stdout).toContain("policy.signerGroups.approvers[0]: REPLACE_WITH_APPROVER_DID");
    expect(pending.stdout).toContain("signerKeys[1].did: REPLACE_WITH_APPROVER_DID");

    const proposer = await newDid();
    const maintainer = await newDid();
    await writeFixtureConfig(home, "draft", (config) => {
      config.policy.signerGroups = { all: [proposer, maintainer], proposers: [proposer], approvers: [maintainer] };
      config.signerKeys = [{ did: proposer, label: "Proposer" }, { did: maintainer, label: "Maintainer" }];
    });
    const before = await snapshot(home);
    const ready = await run(["config", "validate", "mirror", "--home", home], offline());
    expect(ready.exitCode, ready.stdout + ready.stderr).toBe(0);
    expect(ready.stdout).toContain(`mv ${draft} ${join(home, "config", "mirror-adapter-config.json")}`);
    expect(await snapshot(home)).toEqual(before);
  });

  it("checks live deployment configs, including credentials and duplicate applications", async () => {
    const home = await initAccount("verifier");
    const proposer = await newDid();
    const maintainer = await newDid();
    const fill = (config: Record<string, any>) => {
      config.policy.signerGroups = { all: [proposer, maintainer], proposers: [proposer], approvers: [maintainer] };
      config.signerKeys = [{ did: proposer }, { did: maintainer }];
    };
    await writeFixtureConfig(home, "live", fill);

    const noCredential = await run(["config", "validate", "--home", home], offline());
    expect(noCredential.exitCode).not.toBe(0);
    expect(noCredential.stdout).toContain("github-mirror-token");

    await writeCredential(home);
    expect((await run(["config", "validate", "--home", home], offline())).exitCode).toBe(0);

    await writeFixtureConfig(home, "draft", fill, "mirror-copy");
    const duplicate = await run(["config", "validate", "--home", home], offline());
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stdout).toContain(fixtureApplicationDid);
  });

  it("keeps the legacy form for configs outside an MPAS home", async () => {
    const home = await initAccount("verifier");
    const result = await run(
      ["config", "validate", "github-mirror", "--config-dir", join(home, "missing")],
      offline(),
    );
    // The legacy path reports the unreadable directory rather than account checks.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unable to read config directory");
  });
  it("keeps the original meaning of config validate <name> and never passes by checking nothing", async () => {
    const home = await initAccount("verifier");
    await writeCredential(home);
    const proposer = await newDid();
    const maintainer = await newDid();
    await writeFixtureConfig(home, "live", (config) => {
      config.name = "custom-name";
      config.policy.signerGroups = { all: [proposer, maintainer], proposers: [proposer], approvers: [maintainer] };
      config.signerKeys = [{ did: proposer }, { did: maintainer }];
    });

    for (const name of ["mirror", "custom-name", "mirror-adapter-config.json"]) {
      const result = await run(["config", "validate", name, "--home", home], offline());
      expect(result.exitCode, `${name}: ${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(join(home, "config", "mirror-adapter-config.json"));
    }
    const nothing = await run(["config", "validate", "nope", "--home", home], offline());
    expect(nothing.exitCode).not.toBe(0);
    expect(`${nothing.stdout}${nothing.stderr}`).toContain("nope");

    // With $MPAS_CONFIG_DIR set, the original command runs, even though the home has account.json.
    vi.stubEnv("MPAS_CONFIG_DIR", join(home, "config"));
    vi.stubEnv("MPAS_CREDENTIAL_DIR", join(home, "credentials"));
    const legacy = await run(["config", "validate", "custom-name", "--home", home], testDeps({ env: { MPAS_CONFIG_DIR: join(home, "config") } }));
    expect(legacy.exitCode, legacy.stderr).toBe(0);
    expect(legacy.stdout).toContain("Config: custom-name");
  });

  it("checks an installed plugin against the record made at install, not a newer bundled registry", async () => {
    const home = await initAccount("proposer", ["--verifier-did", "did:web:verifier.example.test"]);
    const homedir = join(home, "..", "user");
    expect((await run(["mcp", "add", "--home", home, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir }))).exitCode).toBe(0);
    expect((await run(["config", "validate", "--home", home], offline())).exitCode).toBe(0);

    // A later CLI bundles a registry that names a different plugin for the same application.
    const upgraded = await buildRegistry([{ name: "mirror-fixtureorg", registryArtifactDid: "did:artifact:bafkreinewerpluginnewerpluginnewerpluginnewerpluginnewerplugi" }]);
    const result = await run(["config", "validate", "--home", home], testDeps({ registryDir: upgraded.registryDir }));
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toMatch(/newer registry entry/i);
    expect(result.stdout).toMatch(/mpas mcp add(?: --home \S+)? --app mirror --replace-config/);
  });
});
