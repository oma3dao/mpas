import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlugin } from "../../src/core/plugin-loader.js";

const pluginsDir = fileURLToPath(new URL("../fixtures/plugins/", import.meta.url));

describe("loadPlugin", () => {
  it("loads the valid GitHub plugin fixture", async () => {
    const result = await loadPlugin(join(pluginsDir, "github-mirror-plugin.json"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plugin.type).toBe("MpasApplicationPlugin");
      expect(Object.keys(result.plugin.operations)).toEqual([
        "delete_branch_mirror",
        "merge_pull_request_mirror",
      ]);
      expect(result.plugin.credentialRequirements?.[0]).toMatchObject({
        expectedAuthority: ["issue.write", "pullRequest.merge", "pullRequest.read", "branch.delete"],
      });
    }
  });

  it("rejects plugin JSON that fails the Application Plugin Profile schema", async () => {
    const result = await loadPlugin(join(pluginsDir, "malformed-missing-operations.json"));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_SCHEMA_INVALID",
      },
    });
  });

  it("rejects an MCP plugin without an execution protocol version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-plugin-loader-"));
    const path = join(dir, "missing-protocol-version.json");
    const plugin = JSON.parse(
      await readFile(join(pluginsDir, "github-mirror-plugin.json"), "utf8"),
    ) as { executionProfile: { protocolVersion?: string } };
    delete plugin.executionProfile.protocolVersion;
    await writeFile(path, JSON.stringify(plugin));

    const result = await loadPlugin(path);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_SCHEMA_INVALID",
      },
    });
  });

  it.each([
    ["legacy authority", { type: "oauthToken", requiredCapabilities: ["repo.write"] }],
    ["mixed authority", { type: "oauthToken", expectedAuthority: ["repo.write"], requiredCapabilities: ["repo.write"] }],
    ["unknown key", { type: "oauthToken", expectedAuthority: ["repo.write"], authorityHint: "write" }],
    ["provider scopes", { type: "oauthToken", scopes: ["repo"] }],
  ])("rejects %s in plugin credential requirements", async (_label, requirement) => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-plugin-loader-"));
    const path = join(dir, "invalid-credential-requirement.json");
    const plugin = JSON.parse(
      await readFile(join(pluginsDir, "github-mirror-plugin.json"), "utf8"),
    ) as { credentialRequirements: unknown[] };
    plugin.credentialRequirements = [requirement];
    await writeFile(path, JSON.stringify(plugin));

    const result = await loadPlugin(path);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_SCHEMA_INVALID" },
    });
  });

  it("rejects invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-plugin-loader-"));
    const path = join(dir, "invalid.json");
    await writeFile(path, "{");

    const result = await loadPlugin(path);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_INVALID_JSON",
      },
    });
  });

  it("returns a read error for a missing file", async () => {
    const result = await loadPlugin(join(pluginsDir, "does-not-exist.json"));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_READ_FAILED",
      },
    });
  });
});
