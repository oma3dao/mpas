import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mode, readJson, run, scriptedPrompt, snapshot, tempDir, testDeps, writeMixedKey } from "./helpers.js";

const verifierDid = "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6IjR2OGt4WEppRnBDSHBWeFd4SFJRTExxMGJqSWxVRi1zRTFVSU5veTUwLTgifQ";

async function newHome() {
  return join(await tempDir(), "home");
}

describe("Phase 1: mpas init", () => {
  it("asks a Proposer on a terminal for both URLs and the Verifier DID, and nothing else", async () => {
    const home = await newHome();
    const prompt = scriptedPrompt(["", "", ""]);
    const result = await run(["init", "proposer", "--home", home], testDeps({ isTerminal: true, prompt: prompt.prompt }));

    expect(result.exitCode).toBe(0);
    expect(prompt.asked).toHaveLength(3);
    expect(prompt.asked[0]).toMatch(/^Coordination URL \(http:\/\/127\.0\.0\.1:7545\)/);
    expect(prompt.asked[1]).toMatch(/^Action URL \(http:\/\/127\.0\.0\.1:7544\)/);
    expect(prompt.asked[2]).toMatch(/^Verifier DID/);

    const account = await readJson(join(home, "account.json"));
    expect(account).toMatchObject({
      roles: ["proposer"],
      coordinationUrl: "http://127.0.0.1:7545",
      actionUrl: "http://127.0.0.1:7544",
    });
    expect(account.verifierDid).toBeUndefined();
    expect(Object.keys(await snapshot(join(home, "mcp-server-configs")))).toEqual([]);
    expect(result.stdout).toContain(String(account.did));
    expect(result.stdout).not.toContain("Prime Directive");
  });

  it("requires both URL flags for a Proposer without a terminal, and treats the Verifier DID as optional", async () => {
    for (const args of [["--coordination", "local"], ["--action", "local"]]) {
      const home = await newHome();
      const result = await run(["init", "proposer", "--home", home, ...args], testDeps());
      expect(result.exitCode).not.toBe(0);
      expect(await snapshot(home)).toEqual({});
    }

    const home = await newHome();
    const result = await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local"], testDeps());
    expect(result.exitCode).toBe(0);
    expect((await readJson(join(home, "account.json"))).verifierDid).toBeUndefined();
  });

  it("stores supplied Proposer flags without prompting", async () => {
    const home = await newHome();
    const result = await run(
      ["init", "proposer", "--home", home, "--coordination", "https://api.signerset.com", "--action", "https://api.signerset.com", "--verifier-did", verifierDid],
      testDeps({ isTerminal: true, prompt: scriptedPrompt([]).prompt }),
    );
    expect(result.exitCode).toBe(0);
    expect(await readJson(join(home, "account.json"))).toMatchObject({
      coordinationUrl: "https://api.signerset.com",
      actionUrl: "https://api.signerset.com",
      verifierDid,
    });
  });

  it("asks a Verifier only for the Action URL, never the mode, and writes no application config", async () => {
    const home = await newHome();
    const prompt = scriptedPrompt([""]);
    const result = await run(["init", "verifier", "--home", home], testDeps({ isTerminal: true, prompt: prompt.prompt }));

    expect(result.exitCode).toBe(0);
    expect(prompt.asked).toHaveLength(1);
    expect(prompt.asked[0]).toMatch(/^Action URL/);
    const account = await readJson(join(home, "account.json"));
    expect(account).toMatchObject({ roles: ["verifier"], actionUrl: "http://127.0.0.1:7544" });
    expect(account.verifierMode).toBeUndefined();
    expect(account.coordinationUrl).toBeUndefined();
    expect(Object.keys(await snapshot(join(home, "config"))).filter((path) => path.endsWith(".json"))).toEqual([]);
    expect(result.stdout).not.toContain("Prime Directive");
  });

  it("requires --action, but not --mode, for a Verifier without a terminal, and rejects DID-list flags", async () => {
    const missing = await newHome();
    expect((await run(["init", "verifier", "--mode", "direct", "--home", missing], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(missing)).toEqual({});
    const noMode = await newHome();
    expect((await run(["init", "verifier", "--home", noMode, "--action", "local"], testDeps())).exitCode).toBe(0);
    expect((await readJson(join(noMode, "account.json"))).verifierMode).toBeUndefined();
    const relay = await newHome();
    expect((await run(["init", "verifier", "--home", relay, "--action", "local", "--mode", "relay"], testDeps())).exitCode).toBe(0);
    expect((await readJson(join(relay, "account.json"))).verifierMode).toBe("relay");
    const badMode = await newHome();
    expect((await run(["init", "verifier", "--home", badMode, "--action", "local", "--mode", "proxy"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(badMode)).toEqual({});

    const ok = await newHome();
    expect((await run(["init", "verifier", "--mode", "direct", "--home", ok, "--action", "local"], testDeps())).exitCode).toBe(0);

    for (const flag of ["--proposer-did", "--maintainer-did"]) {
      const home = await newHome();
      const result = await run(["init", "verifier", "--mode", "direct", "--home", home, "--action", "local", flag, verifierDid], testDeps());
      expect(result.exitCode).not.toBe(0);
      expect(await snapshot(home)).toEqual({});
    }
  });

  it("asks a Maintainer for the Coordination URL and a harness, rejecting an empty harness", async () => {
    const home = await newHome();
    const prompt = scriptedPrompt(["", "", "none"]);
    const deps = testDeps({ isTerminal: true, prompt: prompt.prompt });
    const result = await run(["init", "maintainer", "--home", home], deps);

    expect(result.exitCode).toBe(0);
    expect(prompt.asked.map((question) => question.split(" ")[0])).toEqual(["Coordination", "Harness", "Harness"]);
    expect(await readJson(join(home, "account.json"))).toMatchObject({ coordinationUrl: "http://127.0.0.1:7545" });
    expect(Object.keys(await snapshot(home)).some((path) => path.includes("bridge-config"))).toBe(false);
  });

  it("requires --coordination and --harness for a Maintainer without a terminal", async () => {
    for (const args of [["--coordination", "local"], ["--harness", "none"]]) {
      const home = await newHome();
      expect((await run(["init", "maintainer", "--home", home, ...args], testDeps())).exitCode).not.toBe(0);
      expect(await snapshot(home)).toEqual({});
    }
  });

  it("writes the signer config and registers nothing with --harness none", async () => {
    const home = await newHome();
    const deps = testDeps();
    const result = await run(["init", "maintainer", "--home", home, "--coordination", "local", "--harness", "none"], deps);

    expect(result.exitCode).toBe(0);
    const account = await readJson(join(home, "account.json"));
    const signerConfigPath = join(home, "mcp-server-configs", "maintainer-signer-config.json");
    expect(await readJson(signerConfigPath)).toEqual({
      agent: { did: account.did, keyFile: join(home, "keys", "signing-key.json") },
      coordination: { url: "http://127.0.0.1:7545" },
    });
    expect(deps.commands).toEqual([]);
    expect(result.stdout).not.toContain("Prime Directive");
    expect(result.stdout).toContain(`mpas action pending --config ${signerConfigPath}`);
  });

  it("uses Ed25519 by default, accepts P-256, and rejects an unknown suite before writing", async () => {
    const ed = await newHome();
    await run(["init", "verifier", "--mode", "direct", "--home", ed, "--action", "local"], testDeps());
    expect((await readJson<{ publicJwk: { crv: string } }>(join(ed, "keys", "signing-key.json"))).publicJwk.crv).toBe("Ed25519");

    const p256 = await newHome();
    await run(["init", "verifier", "--mode", "direct", "--home", p256, "--action", "local", "--suite", "P-256"], testDeps());
    expect((await readJson<{ publicJwk: { crv: string } }>(join(p256, "keys", "signing-key.json"))).publicJwk.crv).toBe("P-256");

    const bad = await newHome();
    expect((await run(["init", "verifier", "--mode", "direct", "--home", bad, "--action", "local", "--suite", "RSA"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(bad)).toEqual({});
  });

  it("selects the home from --home, then $MPAS_HOME, then ~/.mpas, with private modes", async () => {
    const fromEnv = await newHome();
    const homedir = await tempDir();
    await run(["init", "verifier", "--mode", "direct", "--action", "local"], testDeps({ env: { MPAS_HOME: fromEnv }, homedir }));
    expect(await mode(join(fromEnv, "keys", "signing-key.json"))).toBe(0o600);
    expect(await mode(fromEnv)).toBe(0o700);
    expect(await mode(join(fromEnv, "keys"))).toBe(0o700);

    const flagHome = await newHome();
    await run(["init", "verifier", "--mode", "direct", "--home", flagHome, "--action", "local"], testDeps({ env: { MPAS_HOME: fromEnv }, homedir }));
    expect(await readJson(join(flagHome, "account.json"))).toMatchObject({ roles: ["verifier"] });

    await run(["init", "verifier", "--mode", "direct", "--action", "local"], testDeps({ homedir }));
    expect(await readJson(join(homedir, ".mpas", "account.json"))).toMatchObject({ roles: ["verifier"] });
  });

  it("rejects scheme-less URLs, expands local and localhost, and keeps a /mpas/v1 path", async () => {
    for (const url of ["api.signerset.com", "localhost:7544", "127.0.0.1:7544"]) {
      const home = await newHome();
      expect((await run(["init", "verifier", "--mode", "direct", "--home", home, "--action", url], testDeps())).exitCode).not.toBe(0);
      expect(await snapshot(home)).toEqual({});
    }
    for (const shorthand of ["local", "localhost"]) {
      const home = await newHome();
      await run(["init", "verifier", "--mode", "direct", "--home", home, "--action", shorthand], testDeps());
      expect((await readJson(join(home, "account.json"))).actionUrl).toBe("http://127.0.0.1:7544");
    }
    const home = await newHome();
    await run(["init", "verifier", "--mode", "direct", "--home", home, "--action", "https://relay.example.test/mpas/v1"], testDeps());
    expect((await readJson(join(home, "account.json"))).actionUrl).toBe("https://relay.example.test/mpas/v1");
  });

  it("rejects --app on init", async () => {
    const home = await newHome();
    expect((await run(["init", "verifier", "--mode", "direct", "--home", home, "--action", "local", "--app", "github"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual({});
  });

  it("leaves an existing role untouched on a second init", async () => {
    const home = await newHome();
    await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local"], testDeps());
    const before = await snapshot(home);

    const result = await run(
      ["init", "proposer", "--home", home, "--coordination", "https://a.example.test", "--action", "https://b.example.test", "--verifier-did", verifierDid, "--suite", "P-256"],
      testDeps({ isTerminal: true, prompt: scriptedPrompt([]).prompt }),
    );
    expect(result.exitCode).toBe(0);
    expect(await snapshot(home)).toEqual(before);
    expect(result.stdout).toMatch(/already/i);
    expect(result.stdout).toContain("mpas config");
    expect(result.stdout).toContain("mpas key rotate");
  });

  it("asks before adding a second role on a terminal and reuses the key", async () => {
    const home = await newHome();
    await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local"], testDeps());
    const before = await snapshot(home);

    const declined = await run(["init", "maintainer", "--home", home], testDeps({ isTerminal: true, prompt: scriptedPrompt([""]).prompt }));
    expect(declined.exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);

    const prompt = scriptedPrompt(["y", "none"]);
    const accepted = await run(["init", "maintainer", "--home", home], testDeps({ isTerminal: true, prompt: prompt.prompt }));
    expect(accepted.exitCode).toBe(0);
    expect(prompt.asked[0]).toMatch(/Add the maintainer role/);
    // The Coordination URL is already saved, so only the harness is asked.
    expect(prompt.asked.slice(1).map((question) => question.split(" ")[0])).toEqual(["Harness"]);
    expect(await readFile(join(home, "keys", "signing-key.json"))).toEqual(
      Buffer.from(before[join("keys", "signing-key.json")].split(":")[1], "base64"),
    );
    expect((await readJson(join(home, "account.json"))).roles).toEqual(["proposer", "maintainer"]);
  });

  it("requires --add-role without a terminal, rejects --suite for a new role, and warns on Proposer plus Verifier", async () => {
    const home = await newHome();
    await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local"], testDeps());
    const before = await snapshot(home);

    expect((await run(["init", "maintainer", "--home", home, "--harness", "none"], testDeps())).exitCode).not.toBe(0);
    expect((await run(["init", "maintainer", "--home", home, "--harness", "none", "--add-role", "--suite", "P-256"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);

    const verifier = await run(["init", "verifier", "--mode", "direct", "--home", home, "--add-role"], testDeps());
    expect(verifier.exitCode).toBe(0);
    expect(`${verifier.stdout}${verifier.stderr}`).toMatch(/credentials/i);
    const keyFiles = Object.keys(await snapshot(join(home, "keys")));
    expect(keyFiles).toEqual(["signing-key.json"]);
  });

  it("refuses a home with hand-made key files and no account.json", async () => {
    const home = await newHome();
    await mkdir(join(home, "keys"), { recursive: true });
    await writeFile(join(home, "keys", "proposer-key.json"), "{}\n");
    const before = await snapshot(home);

    const result = await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local"], testDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("proposer-key.json");
    expect(await snapshot(home)).toEqual(before);
  });

  it("adopts a manual key with --use-key, keeping the DID and the original files", async () => {
    const home = await newHome();
    await mkdir(join(home, "keys"), { recursive: true });
    const keyDir = await tempDir();
    await run(["key", "generate", "proposer-key", "--key-dir", join(home, "keys")], testDeps());
    await run(["key", "generate", "maintainer-key", "--key-dir", join(home, "keys")], testDeps());
    const manual = join(home, "keys", "proposer-key.json");
    const manualBytes = await readFile(manual);
    const manualKey = JSON.parse(manualBytes.toString()) as { did: string };

    const result = await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local", "--use-key", manual], testDeps());
    expect(result.exitCode, result.stderr).toBe(0);
    expect((await readJson(join(home, "account.json"))).did).toBe(manualKey.did);
    expect(await readFile(join(home, "keys", "signing-key.json"))).toEqual(manualBytes);
    expect(await mode(join(home, "keys", "signing-key.json"))).toBe(0o600);
    expect(await readFile(manual)).toEqual(manualBytes);
    expect(`${result.stdout}${result.stderr}`).toContain("maintainer-key.json");

    const bad = join(keyDir, "bad.json");
    await writeFile(bad, "{\"did\":\"did:jwk:nope\"}\n");
    for (const args of [["--use-key", bad], ["--use-key", manual, "--suite", "P-256"]]) {
      const other = await newHome();
      expect((await run(["init", "proposer", "--home", other, "--coordination", "local", "--action", "local", ...args], testDeps())).exitCode).not.toBe(0);
      expect(await snapshot(other)).toEqual({});
    }
    const before = await snapshot(home);
    expect((await run(["init", "proposer", "--home", home, "--use-key", manual], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);
  });

  it("rejects a key file whose private key does not derive its DID, without printing key material", async () => {
    const home = await newHome();
    const mixed = join(await tempDir(), "mixed.json");
    const { foreignPrivateD } = await writeMixedKey(mixed);
    const result = await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local", "--use-key", mixed], testDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not a usable MPAS key file/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(foreignPrivateD);
    expect(Object.entries(await snapshot(home)).filter(([, value]) => !value.endsWith(":dir"))).toEqual([]);
  });

  it("never prints a private key", async () => {
    const home = await newHome();
    const result = await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local"], testDeps());
    const key = await readJson<{ privateJwk: { d: string } }>(join(home, "keys", "signing-key.json"));
    expect(`${result.stdout}${result.stderr}`).not.toContain(key.privateJwk.d);
    expect(`${result.stdout}${result.stderr}`).not.toContain("privateJwk");
  });
});
