import { rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import { readJson, run, tempDir, testDeps } from "./helpers.js";

type Json = Record<string, any>;

function listeningServers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;
}

describe("Phase 4: end-to-end setup across three accounts", () => {
  it("sets up a Proposer, Maintainer, and Verifier without hand-editing any config", async () => {
    const serversBefore = listeningServers();
    const root = await tempDir("mpas-e2e-");
    const homes = { proposer: join(root, "proposer"), maintainer: join(root, "maintainer"), verifier: join(root, "verifier") };
    // Each participant has their own user account, so each gets its own harness location.
    const deps = {
      proposer: testDeps({ homedir: join(root, "proposer-user") }),
      maintainer: testDeps({ homedir: join(root, "maintainer-user") }),
      verifier: testDeps({ homedir: join(root, "verifier-user") }),
    };
    const ok = async (args: string[], who: keyof typeof deps) => {
      const result = await run(args, deps[who]);
      expect(result.exitCode, `mpas ${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
      return result;
    };

    // 1. Each participant creates an account. No init needs another participant's DID.
    await ok(["init", "maintainer", "--home", homes.maintainer, "--coordination", "local", "--harness", "cursor"], "maintainer");
    await ok(["init", "verifier", "--mode", "direct", "--home", homes.verifier, "--action", "local"], "verifier");
    await ok(["init", "proposer", "--home", homes.proposer, "--coordination", "local", "--action", "local"], "proposer");
    const did = {
      proposer: (await readJson(join(homes.proposer, "account.json"))).did as string,
      maintainer: (await readJson(join(homes.maintainer, "account.json"))).did as string,
      verifier: (await readJson(join(homes.verifier, "account.json"))).did as string,
    };

    // 2. DIDs are exchanged out of band. The Proposer stores the Verifier's and adds the bridge.
    await ok(["config", "--home", homes.proposer, "--verifier-did", did.verifier], "proposer");
    await ok(["mcp", "add", "--home", homes.proposer, "--app", "mirror", "--harness", "cursor"], "proposer");

    // 3. The Verifier adds the application, its signers, and the upstream credential, then makes the draft live.
    await ok(["mcp", "add", "--home", homes.verifier, "--app", "mirror"], "verifier");
    await ok(["signer", "add", "--home", homes.verifier, "--app", "mirror", "--proposer", did.proposer], "verifier");
    await ok(["signer", "add", "--home", homes.verifier, "--app", "mirror", "--maintainer", did.maintainer, "--label", "Maintainer A"], "verifier");
    await ok(["credential", "set", "github-mirror-token", "--credential-dir", join(homes.verifier, "credentials"), "--value", "test-token"], "verifier");
    const ready = await ok(["config", "validate", "mirror", "--home", homes.verifier], "verifier");
    expect(ready.stdout).toContain("Make it live with:");
    await rename(join(homes.verifier, "config", "drafts", "mirror-adapter-config.json"), join(homes.verifier, "config", "mirror-adapter-config.json"));

    // 4. Every home validates, and the Credential Adapter's own loader accepts the Verifier's config.
    for (const who of ["proposer", "maintainer", "verifier"] as const) {
      await ok(["config", "validate", "--home", homes[who]], who);
    }
    const loaded = await loadDeploymentConfigs(join(homes.verifier, "config"), { confirmPluginUse: async () => true });
    expect(loaded.ok, loaded.ok ? "" : loaded.error.message).toBe(true);
    if (loaded.ok) {
      expect(loaded.configs[0].config.policy.signerGroups).toEqual({
        all: [did.proposer, did.maintainer],
        proposers: [did.proposer],
        approvers: [did.maintainer],
      });
    }

    // Both agents are registered, each in its own user's Cursor.
    const proposerCursor = await readJson<Json>(join(root, "proposer-user", ".cursor", "mcp.json"));
    const maintainerCursor = await readJson<Json>(join(root, "maintainer-user", ".cursor", "mcp.json"));
    expect(Object.keys(proposerCursor.mcpServers)).toEqual(["mirror-mpas"]);
    expect(Object.keys(maintainerCursor.mcpServers)).toEqual(["mpas-coordination"]);

    // 5. The Proposer rotates its key; the Verifier swaps the DID with mpas signer.
    const rotated = await ok(["key", "rotate", "--home", homes.proposer], "proposer");
    const newDid = (await readJson(join(homes.proposer, "account.json"))).did as string;
    expect(rotated.stdout).toContain(newDid);
    await ok(["signer", "remove", "--home", homes.verifier, "--app", "mirror", did.proposer], "verifier");
    await ok(["signer", "add", "--home", homes.verifier, "--app", "mirror", "--proposer", newDid], "verifier");
    await ok(["config", "validate", "--home", homes.proposer], "proposer");
    await ok(["config", "validate", "--home", homes.verifier], "verifier");
    const live = await readJson<Json>(join(homes.verifier, "config", "mirror-adapter-config.json"));
    expect(JSON.stringify(live)).not.toContain(did.proposer);
    expect(live.policy.signerGroups.proposers).toEqual([newDid]);

    // No command started a process or opened a port.
    expect([...deps.proposer.commands, ...deps.maintainer.commands, ...deps.verifier.commands]).toEqual([]);
    expect(listeningServers()).toBe(serversBefore);
  });
});
