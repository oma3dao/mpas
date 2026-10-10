import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newDid, printedCommand, readJson, run, shellWords, tempDir, testDeps, writeCredential } from "./helpers.js";

function linesWith(output: string, text: string): string[] {
  return output.split("\n").filter((line) => line.includes(text));
}

describe("printed commands", () => {
  it("carry --home for a custom home, never for the default home, and never in commands for other participants", async () => {
    const homedir = await tempDir();
    const deps = () => testDeps({ homedir });
    const custom = join(await tempDir(), "custom");

    const defaultInit = await run(["init", "verifier", "--action", "https://relay.example.test", "--mode", "relay"], deps());
    expect(defaultInit.exitCode, defaultInit.stderr).toBe(0);
    const defaultAdd = await run(["mcp", "add", "--app", "mirror"], deps());
    expect(defaultAdd.stdout).not.toContain("--home");

    const proposer = await run(["init", "proposer", "--home", custom, "--coordination", "local", "--action", "local"], deps());
    for (const line of [...linesWith(proposer.stdout, "mpas config --"), ...linesWith(proposer.stdout, "mpas mcp add")]) {
      expect(line).toContain(`--home ${custom}`);
    }
    const again = await run(["init", "proposer", "--home", custom], deps());
    expect(linesWith(again.stdout, "mpas config")[0]).toContain(`--home ${custom}`);

    const verifierHome = join(await tempDir(), "verifier");
    await run(["init", "verifier", "--home", verifierHome, "--action", "local"], deps());
    const added = await run(["mcp", "add", "--home", verifierHome, "--app", "mirror"], deps());
    expect(added.exitCode, added.stderr).toBe(0);
    for (const text of ["mpas signer add", "mpas config validate", "--mode direct|relay"]) {
      const lines = linesWith(added.stdout, text);
      expect(lines.length, text).toBeGreaterThan(0);
      for (const line of lines) expect(line, text).toContain(`--home ${verifierHome}`);
    }

    const rotated = await run(["key", "rotate", "--home", verifierHome], deps());
    expect(rotated.exitCode, rotated.stderr).toBe(0);
    // A Proposer runs this in its own home, so it must not name the Verifier's.
    expect(linesWith(rotated.stdout, "mpas config --verifier-did")[0]).not.toContain("--home");
    expect(linesWith(rotated.stdout, "mpas key rotate")[0]).toContain(`--home ${verifierHome}`);
  });

  it("names the home whenever $MPAS_HOME is set, so a printed command never falls through to another account", async () => {
    const homedir = await tempDir();
    const other = join(await tempDir(), "other");
    const defaultHome = join(homedir, ".mpas");

    // $MPAS_HOME points elsewhere, and the user explicitly selects ~/.mpas.
    const explicit = await run(["init", "proposer", "--home", defaultHome, "--coordination", "local", "--action", "local"], testDeps({ homedir, env: { MPAS_HOME: other } }));
    expect(explicit.exitCode, explicit.stderr).toBe(0);
    for (const line of linesWith(explicit.stdout, "mpas mcp add")) expect(line).toContain(`--home ${defaultHome}`);

    // $MPAS_HOME selected the home; a new shell without it would otherwise target ~/.mpas.
    const fromEnv = await run(["init", "verifier", "--action", "local"], testDeps({ homedir, env: { MPAS_HOME: other } }));
    expect(fromEnv.exitCode, fromEnv.stderr).toBe(0);
    for (const line of linesWith(fromEnv.stdout, "mpas mcp add")) expect(line).toContain(`--home ${other}`);
  });

  it("quotes paths and URLs so a shell splits each printed command into the intended arguments", async () => {
    const parent = await tempDir();
    const home = join(parent, "MPAS Demo $x 'q'");
    await mkdir(parent, { recursive: true });
    const url = "https://relay.example.test/mpas?x=1&y=2";
    const init = await run(["init", "verifier", "--home", home, "--action", url, "--mode", "relay"], testDeps());
    expect(init.exitCode, init.stderr).toBe(0);

    const added = await run(["mcp", "add", "--home", home, "--app", "mirror"], testDeps());
    expect(added.exitCode, added.stderr).toBe(0);
    const words = shellWords(printedCommand(added.stdout, "mpas adapter start"));
    expect(words.slice(0, 13)).toEqual([
      "mpas", "adapter", "start",
      "--config-dir", join(home, "config"),
      "--credential-dir", join(home, "credentials"),
      "--adapter-key", join(home, "keys", "signing-key.json"),
      "--journal-path", join(home, "journal", "dispatch-ledger.jsonl"),
      "--verifier-relay-url", url,
    ]);
    expect(words[13]).toBe("--verifier-relay-state");
    expect(words[14].startsWith(join(home, "journal", "verifier-relay-"))).toBe(true);

    const validateLine = linesWith(added.stdout, "mpas config validate")[0];
    expect(shellWords(validateLine.slice(validateLine.indexOf("mpas config validate")))).toEqual(["mpas", "config", "validate", "--home", home, "mirror"]);

    await run(["signer", "add", "--home", home, "--app", "mirror", "--proposer", await newDid()], testDeps());
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", await newDid()], testDeps());
    await writeCredential(home);
    const ready = await run(["config", "validate", "--home", home, "mirror"], testDeps());
    expect(ready.exitCode, ready.stdout).toBe(0);
    const draft = join(home, "config", "drafts", "mirror-adapter-config.json");
    expect(shellWords(printedCommand(ready.stdout, "mv "))).toEqual(["mv", draft, join(home, "config", "mirror-adapter-config.json")]);
    await rename(draft, join(home, "config", "mirror-adapter-config.json"));
    expect((await readJson(join(home, "account.json"))).actionUrl).toBe(url);
  });
});
