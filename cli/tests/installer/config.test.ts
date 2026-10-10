import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initAccount, newDid, readJson, run, scriptedPrompt, snapshot, tempDir, testDeps, writeFixtureBridge } from "./helpers.js";

describe("Phase 2: mpas config", () => {
  it("requires an account and names mpas init", async () => {
    const home = join(await tempDir(), "home");
    const result = await run(["config", "--home", home, "--coordination", "local"], testDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("mpas init");
    expect(await snapshot(home)).toEqual({});
  });

  it("works on a home outside ~/.mpas and rejects --role", async () => {
    const home = await initAccount("proposer");
    const result = await run(["config", "--home", home, "--coordination", "https://coord.example.test"], testDeps());
    expect(result.exitCode).toBe(0);
    expect((await readJson(join(home, "account.json"))).coordinationUrl).toBe("https://coord.example.test");

    const before = await snapshot(home);
    expect((await run(["config", "--home", home, "--role", "proposer"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);
  });

  it("rejects flags that no role on the account uses, and flags config never takes", async () => {
    const maintainer = await initAccount("maintainer");
    const before = await snapshot(maintainer);
    const did = await newDid();
    const rejected = [
      ["--verifier-did", did],
      ["--suite", "P-256"],
      ["--proposer-did", did],
      ["--maintainer-did", did],
      ["--app", "mirror"],
      ["--harness", "cursor"],
      ["--token", "secret"],
      ["--action", "local"],
    ];
    for (const flags of rejected) {
      expect((await run(["config", "--home", maintainer, ...flags], testDeps())).exitCode).not.toBe(0);
    }
    expect(await snapshot(maintainer)).toEqual(before);
  });

  it("rejects an invalid DID or URL without changing anything", async () => {
    const home = await initAccount("proposer");
    const before = await snapshot(home);
    expect((await run(["config", "--home", home, "--verifier-did", "not-a-did"], testDeps())).exitCode).not.toBe(0);
    expect((await run(["config", "--home", home, "--action", "relay.example.test"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);
  });

  it("asks only the account's rows on a terminal, keeps saved values on return, and never touches the key", async () => {
    const home = await initAccount("proposer");
    const before = await snapshot(home);
    const prompt = scriptedPrompt(["", "", ""]);
    const result = await run(["config", "--home", home], testDeps({ isTerminal: true, prompt: prompt.prompt }));
    expect(result.exitCode).toBe(0);
    expect(prompt.asked.map((question) => question.split(" (")[0].replace(/:.*$/, ""))).toEqual(["Coordination URL", "Action URL", "Verifier DID"]);
    expect(await snapshot(home)).toEqual(before);

    const verifier = await initAccount("verifier");
    const verifierPrompt = scriptedPrompt([""]);
    await run(["config", "--home", verifier], testDeps({ isTerminal: true, prompt: verifierPrompt.prompt }));
    expect(verifierPrompt.asked).toHaveLength(1);
    expect(verifierPrompt.asked[0]).toMatch(/^Action URL/);
  });

  it("prints the settings and changes nothing without a terminal or flags", async () => {
    const home = await initAccount("proposer");
    const before = await snapshot(home);
    const account = await readJson(join(home, "account.json"));
    const result = await run(["config", "--home", home], testDeps());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(String(account.did));
    expect(result.stdout).toContain("http://127.0.0.1:7545");
    expect(await snapshot(home)).toEqual(before);
  });

  it("changes only the flags given, without asking about other rows", async () => {
    const home = await initAccount("proposer");
    const result = await run(["config", "--home", home, "--action", "https://relay.example.test"], testDeps({ isTerminal: true, prompt: scriptedPrompt([]).prompt }));
    expect(result.exitCode).toBe(0);
    expect(await readJson(join(home, "account.json"))).toMatchObject({
      coordinationUrl: "http://127.0.0.1:7545",
      actionUrl: "https://relay.example.test",
    });
  });

  it("rewrites existing bridge configs for a Proposer, and treats the same Verifier DID as a no-op", async () => {
    const home = await initAccount("proposer");
    const bridge = await writeFixtureBridge(home);
    const did = await newDid();

    expect((await run(["config", "--home", home, "--verifier-did", did], testDeps())).exitCode).toBe(0);
    expect(await readJson(join(home, "account.json"))).toMatchObject({ verifierDid: did });
    expect((await readJson<{ actionEndpoint: { verifierDid: string } }>(bridge)).actionEndpoint.verifierDid).toBe(did);

    const before = await snapshot(home);
    expect((await run(["config", "--home", home, "--verifier-did", did], testDeps())).exitCode).toBe(0);
    expect(await snapshot(home)).toEqual(before);

    await run(["config", "--home", home, "--coordination", "https://coord.example.test", "--action", "https://relay.example.test"], testDeps());
    expect(await readJson(bridge)).toMatchObject({
      coordination: { url: "https://coord.example.test" },
      actionEndpoint: { url: "https://relay.example.test", verifierDid: did },
    });
  });

  it("rewrites the signer config URL for a Maintainer without touching a harness", async () => {
    const home = await initAccount("maintainer");
    const deps = testDeps();
    expect((await run(["config", "--home", home, "--coordination", "https://coord.example.test"], deps)).exitCode).toBe(0);
    expect((await readJson<{ coordination: { url: string } }>(join(home, "mcp-server-configs", "maintainer-signer-config.json"))).coordination.url)
      .toBe("https://coord.example.test");
    expect(deps.commands).toEqual([]);
  });

  it("never moves relay state, and prints the regenerated adapter command when the Action URL or mode changes", async () => {
    const home = await initAccount("verifier");
    await mkdir(join(home, "journal"), { recursive: true });
    await writeFile(join(home, "journal", "verifier-relay-existing.json"), "{}\n");

    const changed = await run(["config", "--home", home, "--action", "https://relay.example.test", "--mode", "relay"], testDeps());
    expect(changed.exitCode, changed.stderr).toBe(0);
    expect(await readJson(join(home, "account.json"))).toMatchObject({ actionUrl: "https://relay.example.test", verifierMode: "relay" });
    expect(await readdir(join(home, "journal"))).toEqual(["verifier-relay-existing.json"]);
    expect(changed.stdout).toMatch(/Restart the Credential Adapter/);
    const relayState = /--verifier-relay-state (\S+)/.exec(changed.stdout)?.[1];
    expect(relayState).toMatch(new RegExp(`^${join(home, "journal", "verifier-relay-")}[A-Za-z0-9_-]{16}\\.json$`));

    await run(["config", "--home", home, "--action", "https://other-relay.example.test"], testDeps());
    const other = await run(["config", "--home", home], testDeps());
    const otherState = /--verifier-relay-state (\S+)/.exec(other.stdout)?.[1];
    expect(otherState).toBeDefined();
    expect(otherState).not.toBe(relayState);

    await run(["config", "--home", home, "--mode", "direct"], testDeps());
    const direct = await run(["config", "--home", home], testDeps());
    expect(direct.stdout).toContain("mpas adapter start");
    expect(direct.stdout).not.toContain("--verifier-relay-url");
    expect((await run(["config", "--home", home, "--mode", "proxy"], testDeps())).exitCode).not.toBe(0);
  });

  it("names the processes to restart after a URL change", async () => {
    const proposer = await initAccount("proposer");
    const result = await run(["config", "--home", proposer, "--coordination", "https://coord.example.test"], testDeps());
    expect(result.stdout).toMatch(/Restart the harness sessions/);
    expect(result.stdout).toMatch(/let pending work finish first/);

    const verifier = await initAccount("verifier");
    const modeOnly = await run(["config", "--home", verifier, "--mode", "relay"], testDeps());
    expect(modeOnly.stdout).toMatch(/Restart the Credential Adapter/);
    expect(modeOnly.stdout).not.toMatch(/pending work/);
  });

  it("stops before changing anything when a file it would rewrite is malformed", async () => {
    const home = await initAccount("proposer");
    const bridge = await writeFixtureBridge(home);
    await writeFile(bridge, "{ not json");
    const before = await snapshot(home);
    const result = await run(["config", "--home", home, "--coordination", "https://coord.example.test"], testDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(bridge);
    expect(await snapshot(home)).toEqual(before);
  });
});
