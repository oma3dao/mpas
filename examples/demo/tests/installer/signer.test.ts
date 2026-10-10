import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initAccount, newDid, readJson, run, scriptedPrompt, snapshot, testDeps, writeFixtureConfig } from "./helpers.js";

type Config = Record<string, any>;

function withoutSigners(config: Config): Config {
  const copy = structuredClone(config);
  delete copy.signerKeys;
  delete copy.policy.signerGroups;
  return copy;
}

describe("Phase 2: mpas signer", () => {
  it("requires the Verifier role, and --app without a terminal", async () => {
    const proposer = await initAccount("proposer");
    const before = await snapshot(proposer);
    expect((await run(["signer", "add", "--home", proposer, "--app", "mirror", "--proposer", await newDid()], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(proposer)).toEqual(before);

    const verifier = await initAccount("verifier");
    await writeFixtureConfig(verifier, "draft");
    expect((await run(["signer", "list", "--home", verifier], testDeps())).exitCode).not.toBe(0);
    const prompt = scriptedPrompt(["mirror"]);
    expect((await run(["signer", "list", "--home", verifier], testDeps({ isTerminal: true, prompt: prompt.prompt }))).exitCode).toBe(0);
    expect(prompt.asked[0]).toMatch(/^Application/);
  });

  it("adds a Proposer and three labeled Maintainers one at a time, replacing placeholders", async () => {
    const home = await initAccount("verifier");
    const draft = await writeFixtureConfig(home, "draft");
    const original = await readJson<Config>(draft);
    const proposer = await newDid();
    const maintainers = [await newDid(), await newDid("P-256"), await newDid()];

    expect((await run(["signer", "add", "--home", home, "--app", "mirror", "--proposer", proposer], testDeps())).exitCode).toBe(0);
    const labels = ["Alice", "Bob", "Carol"];
    for (const [index, did] of maintainers.entries()) {
      const result = await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", did, "--label", labels[index]], testDeps());
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(draft);
      expect(result.stdout).toMatch(/mpas config validate(?: --home \S+)? mirror/);
    }

    const config = await readJson<Config>(draft);
    expect(config.policy.signerGroups).toEqual({
      all: [proposer, ...maintainers],
      proposers: [proposer],
      approvers: maintainers,
    });
    expect(config.signerKeys).toEqual([
      { did: proposer, label: "Proposer" },
      { did: maintainers[0], label: "Alice" },
      { did: maintainers[1], label: "Bob" },
      { did: maintainers[2], label: "Carol" },
    ]);
    expect(withoutSigners(config)).toEqual(withoutSigners(original));
  });

  it("keeps a placeholder that another group still lists", async () => {
    const home = await initAccount("verifier");
    const draft = await writeFixtureConfig(home, "draft", (config) => {
      config.policy.signerGroups.all.push("REPLACE_WITH_HUMAN_APPROVER_DID");
      config.policy.signerGroups.approvers.push("REPLACE_WITH_HUMAN_APPROVER_DID");
      config.policy.signerGroups.humanApprovers = ["REPLACE_WITH_HUMAN_APPROVER_DID"];
      config.signerKeys.push({ did: "REPLACE_WITH_HUMAN_APPROVER_DID", label: "Human" });
    });
    const did = await newDid();
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", did], testDeps());

    const config = await readJson<Config>(draft);
    expect(config.policy.signerGroups.approvers).toEqual([did]);
    expect(config.policy.signerGroups.humanApprovers).toEqual(["REPLACE_WITH_HUMAN_APPROVER_DID"]);
    expect(config.policy.signerGroups.all).toEqual(["REPLACE_WITH_PROPOSER_DID", "REPLACE_WITH_HUMAN_APPROVER_DID", did]);
    expect(config.signerKeys.map((key: { did: string }) => key.did)).toEqual(["REPLACE_WITH_PROPOSER_DID", "REPLACE_WITH_HUMAN_APPROVER_DID", did]);
  });

  it("prefers a maintainers group, honors --group, and refuses a missing group", async () => {
    const home = await initAccount("verifier");
    const draft = await writeFixtureConfig(home, "draft", (config) => {
      config.policy.signerGroups.maintainers = [];
      config.policy.signerGroups.humanApprovers = [];
    });
    const did = await newDid();
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", did], testDeps());
    expect((await readJson<Config>(draft)).policy.signerGroups.maintainers).toEqual([did]);

    const human = await newDid();
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", human, "--group", "humanApprovers"], testDeps());
    expect((await readJson<Config>(draft)).policy.signerGroups.humanApprovers).toEqual([human]);

    const before = await snapshot(home);
    const missing = await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", await newDid(), "--group", "auditors"], testDeps());
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("oma3dao/mpas#6");
    expect((await run(["signer", "add", "--home", home, "--app", "mirror", "--proposer", await newDid(), "--group", "approvers"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);
  });

  it("treats a repeated DID as a no-op and rejects an invalid did:jwk", async () => {
    const home = await initAccount("verifier");
    await writeFixtureConfig(home, "draft");
    const did = await newDid();
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", did], testDeps());
    const before = await snapshot(home);

    expect((await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", did], testDeps())).exitCode).toBe(0);
    for (const bad of ["did:web:example.test", "did:jwk:not-base64", "REPLACE_WITH_PROPOSER_DID"]) {
      expect((await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", bad], testDeps())).exitCode).not.toBe(0);
    }
    expect((await run(["signer", "add", "--home", home, "--app", "mirror"], testDeps())).exitCode).not.toBe(0);
    expect(await snapshot(home)).toEqual(before);
  });

  it("removes a DID from every group and from signerKeys, warning about an empty group", async () => {
    const home = await initAccount("verifier");
    const draft = await writeFixtureConfig(home, "draft");
    const original = await readJson<Config>(draft);
    const proposer = await newDid();
    const maintainer = await newDid();
    await run(["signer", "add", "--home", home, "--app", "mirror", "--proposer", proposer], testDeps());
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", maintainer], testDeps());

    const result = await run(["signer", "remove", "--home", home, "--app", "mirror", maintainer], testDeps());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/approvers.*empty/);
    const config = await readJson<Config>(draft);
    expect(config.policy.signerGroups).toEqual({ all: [proposer], proposers: [proposer], approvers: [] });
    expect(config.signerKeys).toEqual([{ did: proposer, label: "Proposer" }]);
    expect(withoutSigners(config)).toEqual(withoutSigners(original));
  });

  it("lists groups, DIDs, labels, and placeholders without changing the file", async () => {
    const home = await initAccount("verifier");
    await writeFixtureConfig(home, "draft");
    const did = await newDid();
    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", did, "--label", "Alice"], testDeps());
    const before = await snapshot(home);

    const result = await run(["signer", "list", "--home", home, "--app", "mirror"], testDeps());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/approvers/);
    expect(result.stdout).toContain(`${did} Alice`);
    expect(result.stdout).toContain("REPLACE_WITH_PROPOSER_DID (placeholder)");
    expect(await snapshot(home)).toEqual(before);
  });

  it("edits the draft when there is one, and otherwise the live config with a restart reminder", async () => {
    const home = await initAccount("verifier");
    const live = await writeFixtureConfig(home, "live");
    const draft = await writeFixtureConfig(home, "draft");
    const liveBefore = await snapshot(join(home, "config"));
    const did = await newDid();

    await run(["signer", "add", "--home", home, "--app", "mirror", "--maintainer", did], testDeps());
    expect((await readJson<Config>(draft)).policy.signerGroups.approvers).toEqual([did]);
    expect((await snapshot(join(home, "config")))["mirror-adapter-config.json"]).toEqual(liveBefore["mirror-adapter-config.json"]);

    const liveOnly = await initAccount("verifier");
    const livePath = await writeFixtureConfig(liveOnly, "live");
    const result = await run(["signer", "add", "--home", liveOnly, "--app", "mirror", "--maintainer", did], testDeps());
    expect((await readJson<Config>(livePath)).policy.signerGroups.approvers).toEqual([did]);
    expect(result.stdout).toMatch(/restart/i);
    expect(live).not.toBe(livePath);
  });
});
