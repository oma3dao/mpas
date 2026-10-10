import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initAccount, readJson, run, snapshot, tempDir, testDeps, writeFixtureBridge } from "./helpers.js";

type Step = "stage" | "backup" | "marker" | "commit";

/** Throws the nth time the update reaches the given step. */
function failAt(step: Step, nth: number) {
  let count = 0;
  return (reached: Step, path: string) => {
    if (reached === step && count++ === nth) throw new Error(`injected failure at ${reached} ${path}`);
  };
}

function leftovers(snap: Record<string, string>): string[] {
  return Object.keys(snap).filter((path) => /\.mpas-(new|old)$/.test(path) || path.endsWith("update-in-progress.json"));
}

describe("multi-file updates", () => {
  it("leaves the home unchanged when config fails at any step", async () => {
    for (const [step, nth] of [["stage", 0], ["stage", 2], ["backup", 0], ["backup", 2], ["commit", 0], ["commit", 1], ["commit", 2]] as const) {
      const home = await initAccount("proposer");
      await run(["init", "maintainer", "--home", home, "--harness", "none", "--add-role"], testDeps());
      await writeFixtureBridge(home);
      const before = await snapshot(home);

      const result = await run(["config", "--home", home, "--coordination", "https://coord.example.test"], testDeps({ failpoint: failAt(step, nth) }));
      expect(result.exitCode, `${step} ${nth}`).not.toBe(0);
      expect(result.stderr).toContain("injected failure");
      const after = await snapshot(home);
      expect(leftovers(after), `${step} ${nth}`).toEqual([]);
      expect(after, `${step} ${nth}`).toEqual(before);
    }
  });

  it("leaves the home unchanged when the marker cannot be written or cannot record the finished commit", async () => {
    for (const nth of [0, 1]) {
      const home = await initAccount("proposer");
      await writeFixtureBridge(home);
      const before = await snapshot(home);
      const result = await run(["config", "--home", home, "--coordination", "https://coord.example.test"], testDeps({ failpoint: failAt("marker", nth) }));
      expect(result.exitCode, `marker ${nth}`).not.toBe(0);
      const after = await snapshot(home);
      expect(leftovers(after), `marker ${nth}`).toEqual([]);
      expect(after, `marker ${nth}`).toEqual(before);
    }
  });

  it("stops with recovery instructions when the marker cannot be read", async () => {
    const home = await initAccount("proposer");
    const account = join(home, "account.json");
    await writeFile(`${account}.mpas-old`, await readFile(account));
    await writeFile(join(home, "update-in-progress.json"), "{ \"version\": ");
    const result = await run(["config", "--home", home], testDeps());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(join(home, "update-in-progress.json"));
    expect(result.stderr).toContain(`${account}.mpas-old`);
  });

  it("leaves the home unchanged when key rotation or mcp add fails mid-commit", async () => {
    const rotated = await initAccount("proposer");
    await writeFixtureBridge(rotated);
    const beforeRotate = await snapshot(rotated);
    expect((await run(["key", "rotate", "--home", rotated], testDeps({ failpoint: failAt("commit", 2) }))).exitCode).not.toBe(0);
    expect(await snapshot(rotated)).toEqual(beforeRotate);

    const added = await initAccount("proposer", ["--verifier-did", "did:web:verifier.example.test"]);
    const homedir = await tempDir();
    const beforeAdd = await snapshot(added);
    expect((await run(["mcp", "add", "--home", added, "--app", "mirror", "--harness", "cursor"], testDeps({ homedir, failpoint: failAt("commit", 1) }))).exitCode).not.toBe(0);
    expect(await snapshot(added)).toEqual(beforeAdd);
    expect(await snapshot(join(homedir, ".cursor"))).toEqual({});
  });

  it("creates no key or account when init fails mid-commit, so init can be run again", async () => {
    const home = join(await tempDir(), "home");
    const failed = await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local"], testDeps({ failpoint: failAt("commit", 1) }));
    expect(failed.exitCode).not.toBe(0);
    const files = Object.entries(await snapshot(home)).filter(([, value]) => !value.endsWith(":dir"));
    expect(files).toEqual([]);
    expect((await run(["init", "proposer", "--home", home, "--coordination", "local", "--action", "local"], testDeps())).exitCode).toBe(0);
  });

  it("rolls back an interrupted update on the next command", async () => {
    const home = await initAccount("proposer");
    const account = join(home, "account.json");
    const original = await readFile(account);
    // The state an interrupted `mpas config` leaves: a copy of the old file, the new file in place, and the marker.
    await writeFile(`${account}.mpas-old`, original);
    await writeFile(account, JSON.stringify({ ...JSON.parse(original.toString()), coordinationUrl: "https://half-written.example.test" }));
    await writeFile(join(home, "bridge.json.mpas-new"), "{}");
    await writeFile(join(home, "update-in-progress.json"), JSON.stringify({
      version: "1",
      type: "MpasPendingUpdate",
      committed: false,
      files: [{ path: account, existed: true }, { path: join(home, "bridge.json"), existed: false }],
    }));

    const result = await run(["config", "--home", home], testDeps());
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/interrupted update was rolled back/i);
    expect(await readFile(account)).toEqual(original);
    expect(leftovers(await snapshot(home))).toEqual([]);
  });

  it("finishes an interrupted update whose renames all completed", async () => {
    const home = await initAccount("proposer");
    const account = join(home, "account.json");
    const updated = { ...(await readJson(account)), coordinationUrl: "https://coord.example.test" };
    await writeFile(`${account}.mpas-old`, await readFile(account));
    await writeFile(account, JSON.stringify(updated));
    await writeFile(join(home, "update-in-progress.json"), JSON.stringify({
      version: "1",
      type: "MpasPendingUpdate",
      committed: true,
      files: [{ path: account, existed: true }],
    }));

    const result = await run(["config", "--home", home], testDeps());
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/interrupted update was completed/i);
    expect((await readJson(account)).coordinationUrl).toBe("https://coord.example.test");
    expect(leftovers(await snapshot(home))).toEqual([]);
  });
});
