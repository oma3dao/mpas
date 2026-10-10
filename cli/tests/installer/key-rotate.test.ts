import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initAccount, mode, readJson, run, snapshot, tempDir, testDeps, writeFixtureBridge, writeMixedKey } from "./helpers.js";

interface KeyFile {
  did: string;
  privateJwk: { d: string };
  publicJwk: { crv: string };
}

describe("Phase 2: mpas key rotate", () => {
  it("requires an account", async () => {
    const home = join(await tempDir(), "home");
    expect((await run(["key", "rotate", "--home", home], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual({});
  });

  it("retires the old key, writes a new one, and rewrites agent.did everywhere without touching a harness", async () => {
    const home = await initAccount("proposer");
    await run(["init", "maintainer", "--home", home, "--harness", "none", "--add-role"], testDeps());
    const bridge = await writeFixtureBridge(home);
    const oldBytes = await readFile(join(home, "keys", "signing-key.json"));
    const oldKey = JSON.parse(oldBytes.toString()) as KeyFile;

    const deps = testDeps();
    const result = await run(["key", "rotate", "--home", home], deps);
    expect(result.exitCode).toBe(0);

    const keyFiles = await readdir(join(home, "keys"));
    const retired = keyFiles.find((name) => name.startsWith("signing-key.retired-"));
    expect(retired).toBeDefined();
    expect(await readFile(join(home, "keys", retired!))).toEqual(oldBytes);
    expect(await mode(join(home, "keys", retired!))).toBe(0o600);
    expect(await mode(join(home, "keys", "signing-key.json"))).toBe(0o600);

    const newKey = await readJson<KeyFile>(join(home, "keys", "signing-key.json"));
    expect(newKey.did).not.toBe(oldKey.did);
    expect(newKey.publicJwk.crv).toBe("Ed25519");
    expect((await readJson(join(home, "account.json"))).did).toBe(newKey.did);
    expect((await readJson<{ agent: { did: string } }>(bridge)).agent.did).toBe(newKey.did);
    expect((await readJson<{ agent: { did: string } }>(join(home, "mcp-server-configs", "maintainer-signer-config.json"))).agent.did).toBe(newKey.did);
    expect(deps.commands).toEqual([]);

    expect(result.stdout).toContain(oldKey.did);
    expect(result.stdout).toContain(newKey.did);
    expect(result.stdout).toMatch(/Verifier/);
    expect(result.stdout).toMatch(/coordination operator/i);
    expect(result.stdout).toMatch(/Before rotating/);
    expect(result.stdout).toMatch(/close the harness sessions/i);
    expect(result.stdout).toMatch(/Start the harness sessions again/i);
    expect(`${result.stdout}${result.stderr}`).not.toContain(newKey.privateJwk.d);
    expect(`${result.stdout}${result.stderr}`).not.toContain(oldKey.privateJwk.d);
  });

  it("keeps the current suite by default and changes it with --suite", async () => {
    const home = await initAccount("verifier", ["--suite", "P-256"]);
    await run(["key", "rotate", "--home", home], testDeps());
    expect((await readJson<KeyFile>(join(home, "keys", "signing-key.json"))).publicJwk.crv).toBe("P-256");
    await run(["key", "rotate", "--home", home, "--suite", "Ed25519"], testDeps());
    expect((await readJson<KeyFile>(join(home, "keys", "signing-key.json"))).publicJwk.crv).toBe("Ed25519");
  });

  it("adopts a key made with mpas key generate, and rejects bad replacements without changes", async () => {
    const home = await initAccount("proposer");
    const keyDir = await tempDir();
    const generated = await run(["key", "generate", "next", "--key-dir", keyDir], testDeps());
    expect(generated.exitCode).toBe(0);
    const nextPath = join(keyDir, "next.json");
    const next = await readJson<KeyFile>(nextPath);

    const before = await snapshot(home);
    const current = await readFile(join(home, "keys", "signing-key.json"));
    await writeFile(join(keyDir, "same.json"), current);
    await writeFile(join(keyDir, "bad.json"), "{\"did\":\"did:jwk:nope\"}\n");
    const { foreignPrivateD } = await writeMixedKey(join(keyDir, "mixed.json"));
    for (const args of [["--use-key", join(keyDir, "same.json")], ["--use-key", join(keyDir, "bad.json")], ["--use-key", join(keyDir, "mixed.json")], ["--use-key", nextPath, "--suite", "P-256"]]) {
      const rejected = await run(["key", "rotate", "--home", home, ...args], testDeps());
      expect(rejected.exitCode).not.toBe(0);
      expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(foreignPrivateD);
      expect(await snapshot(home)).toEqual(before);
    }

    const result = await run(["key", "rotate", "--home", home, "--use-key", nextPath], testDeps());
    expect(result.exitCode).toBe(0);
    expect((await readJson<KeyFile>(join(home, "keys", "signing-key.json"))).did).toBe(next.did);
    expect(await readdir(keyDir)).not.toContain("next.json");
  });

  it("leaves relay state in place on a Verifier account and prints the regenerated adapter command", async () => {
    const home = await initAccount("verifier");
    await run(["config", "--home", home, "--action", "https://relay.example.test", "--mode", "relay"], testDeps());
    await mkdir(join(home, "journal"), { recursive: true });
    await writeFile(join(home, "journal", "verifier-relay-old.json"), "{}\n");
    const before = await run(["config", "--home", home], testDeps());
    const oldState = /--verifier-relay-state (\S+)/.exec(before.stdout)?.[1];

    const result = await run(["key", "rotate", "--home", home], testDeps());
    expect(result.exitCode).toBe(0);
    expect(await readdir(join(home, "journal"))).toEqual(["verifier-relay-old.json"]);
    expect(result.stdout).toContain("mpas config --verifier-did");
    expect(result.stdout).toMatch(/stop the Credential Adapter/i);
    const newState = /--verifier-relay-state (\S+)/.exec(result.stdout)?.[1];
    expect(newState).toBeDefined();
    expect(newState).not.toBe(oldState);
  });
});
