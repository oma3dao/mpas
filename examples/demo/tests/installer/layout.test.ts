import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initAccount, readJson, run, snapshot, tempDir, testDeps, writeFixtureBridge } from "./helpers.js";

type Json = Record<string, any>;

describe("one command at a time", () => {
  it("refuses to run while another live process holds the lock, leaving a pending update alone", async () => {
    const home = await initAccount("proposer");
    await writeFile(join(home, "update.lock"), JSON.stringify({ pid: 4242, startedAt: "2026-10-09T12:00:00.000Z" }));
    await writeFile(join(home, "update-in-progress.json"), JSON.stringify({ version: "1", type: "MpasPendingUpdate", committed: false, files: [] }));
    const before = await snapshot(home);

    const result = await run(["config", "--home", home, "--coordination", "https://coord.example.test"], testDeps({ isProcessAlive: (pid) => pid === 4242 }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/another mpas command .*4242.* is updating/i);
    expect(await snapshot(home)).toEqual(before);
  });

  it("clears a lock left by a process that is no longer running, then recovers its update", async () => {
    const home = await initAccount("proposer");
    const account = join(home, "account.json");
    const original = await readFile(account);
    await writeFile(`${account}.mpas-old`, original);
    await writeFile(account, JSON.stringify({ ...JSON.parse(original.toString()), coordinationUrl: "https://half-written.example.test" }));
    await writeFile(join(home, "update-in-progress.json"), JSON.stringify({
      version: "1", type: "MpasPendingUpdate", committed: false, files: [{ path: account, existed: true }],
    }));
    await writeFile(join(home, "update.lock"), JSON.stringify({ pid: 4242, startedAt: "2026-10-09T12:00:00.000Z" }));

    const result = await run(["config", "--home", home], testDeps({ isProcessAlive: () => false }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/rolled back/);
    expect(await readFile(account)).toEqual(original);
    expect(Object.keys(await snapshot(home))).not.toContain("update.lock");
  });

  it("leaves no lock behind after a command succeeds or fails", async () => {
    const home = await initAccount("verifier");
    await run(["signer", "list", "--home", home, "--app", "missing"], testDeps());
    await run(["config", "--home", home, "--action", "https://relay.example.test"], testDeps());
    expect(Object.keys(await snapshot(home))).not.toContain("update.lock");
  });
});

describe("the managed layout", () => {
  async function adoptedProposer(): Promise<{ home: string; bridge: string }> {
    // A hand-made home: a key under its old name and a bridge config that points at it.
    const home = join(await tempDir(), "home");
    await mkdir(join(home, "keys"), { recursive: true });
    await run(["key", "generate", "proposer-key", "--key-dir", join(home, "keys")], testDeps());
    const adopted = await run(
      ["init", "proposer", "--home", home, "--coordination", "local", "--action", "local", "--use-key", join(home, "keys", "proposer-key.json")],
      testDeps(),
    );
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    await mkdir(join(home, "mcp-server-configs"), { recursive: true });
    const bridge = await writeFixtureBridge(home);
    const config = await readJson<Json>(bridge);
    config.agent.keyFile = join(home, "keys", "proposer-key.json");
    await writeFile(bridge, JSON.stringify(config, null, 2));
    return { home, bridge };
  }

  it("refuses key rotation and config changes while a config points at another key, with migration steps", async () => {
    const { home, bridge } = await adoptedProposer();
    const before = await snapshot(home);
    for (const args of [["key", "rotate"], ["config", "--coordination", "https://coord.example.test"]]) {
      const result = await run([...args, "--home", home], testDeps());
      expect(result.exitCode, args.join(" ")).not.toBe(0);
      expect(result.stderr).toContain(`${bridge}: agent.keyFile is ${join(home, "keys", "proposer-key.json")}`);
      expect(result.stderr).toMatch(/Back up/);
      expect(result.stderr).toContain(join(home, "keys", "signing-key.json"));
      expect(result.stderr).toContain("mpas config validate");
      expect(await snapshot(home)).toEqual(before);
    }

    const config = await readJson<Json>(bridge);
    config.agent.keyFile = join(home, "keys", "signing-key.json");
    await writeFile(bridge, JSON.stringify(config, null, 2));
    expect((await run(["key", "rotate", "--home", home], testDeps())).exitCode).toBe(0);
  });

  it("refuses to rewrite a config that names another participant's DID", async () => {
    const home = await initAccount("proposer");
    const bridge = await writeFixtureBridge(home);
    const config = await readJson<Json>(bridge);
    config.agent.did = "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6IjR2OGt4WEppRnBDSHBWeFd4SFJRTExxMGJqSWxVRi1zRTFVSU5veTUwLTgifQ";
    await writeFile(bridge, JSON.stringify(config, null, 2));
    const before = await snapshot(home);
    const result = await run(["key", "rotate", "--home", home], testDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`${bridge}: agent.did is ${config.agent.did}`);
    expect(await snapshot(home)).toEqual(before);
  });

  it("completes setup in place for a key already at keys/signing-key.json", async () => {
    const home = join(await tempDir(), "home");
    await mkdir(join(home, "keys"), { recursive: true });
    await run(["key", "generate", "signing-key", "--key-dir", join(home, "keys")], testDeps());
    const keyPath = join(home, "keys", "signing-key.json");
    const bytes = await readFile(keyPath);

    const plain = await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local"], testDeps());
    expect(plain.exitCode).not.toBe(0);
    expect(plain.stderr).toContain(`--use-key ${keyPath}`);

    const result = await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local", "--use-key", keyPath], testDeps());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(keyPath)).toEqual(bytes);
    expect((await readJson(join(home, "account.json"))).did).toBe(JSON.parse(bytes.toString()).did);
  });

  it("leaves an existing signer config untouched when a Maintainer account is created", async () => {
    const home = join(await tempDir(), "home");
    await mkdir(join(home, "keys"), { recursive: true });
    await mkdir(join(home, "mcp-server-configs"), { recursive: true });
    await run(["key", "generate", "maintainer-key", "--key-dir", join(home, "keys")], testDeps());
    const keyFile = join(home, "keys", "maintainer-key.json");
    const did = (await readJson(keyFile)).did;
    const signerConfig = join(home, "mcp-server-configs", "maintainer-signer-config.json");
    await writeFile(signerConfig, JSON.stringify({ agent: { did, keyFile }, coordination: { url: "http://127.0.0.1:7545" } }, null, 2));
    const bytes = await readFile(signerConfig);

    const result = await run(
      ["init", "maintainer", "--home", home, "--coordination", "local", "--harness", "none", "--use-key", keyFile],
      testDeps(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(signerConfig)).toEqual(bytes);
    expect(result.stdout).toMatch(/left unchanged/);
  });
});
