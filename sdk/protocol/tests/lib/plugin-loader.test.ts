import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlugin, validatePayloadAgainstPlugin, type MpasApplicationPlugin } from "../../src/lib/plugin-loader.js";
import type { ActionPackage } from "../../src/types/mpas.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function githubPlugin() {
  const result = await loadPlugin(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.plugin;
}

describe("loadPlugin", () => {
  it("loads the valid GitHub plugin fixture", async () => {
    const result = await loadPlugin(join(fixturesDir, "plugins", "github-mirror-plugin.json"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plugin.type).toBe("MpasApplicationPlugin");
      expect(Object.keys(result.plugin.operations)).toEqual([
        "delete_branch_mirror",
        "merge_pull_request_mirror",
      ]);
    }
  });

  it("rejects plugin JSON that fails the Application Plugin Profile schema", async () => {
    const result = await loadPlugin(join(fixturesDir, "plugins", "malformed-missing-operations.json"));

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
      await readFile(join(fixturesDir, "plugins", "github-mirror-plugin.json"), "utf8"),
    ) as {
      executionProfile: { protocolVersion?: string };
    };
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
    const result = await loadPlugin(join(fixturesDir, "plugins", "does-not-exist.json"));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_READ_FAILED",
      },
    });
  });
});

describe("validatePayloadAgainstPlugin", () => {
  it.each([
    ["valid-two-approvals.json", "merge_pull_request_mirror"],
    ["valid-delete-branch.json", "delete_branch_mirror"],
  ])("matches and validates %s", async (fixtureFile, operationName) => {
    const plugin = await githubPlugin();
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "verification", fixtureFile));
    const result = validatePayloadAgainstPlugin(actionPackage.executionPayload, plugin);

    expect(result).toMatchObject({
      ok: true,
      match: {
        operationName,
      },
    });
  });

  it("rejects an unknown operation", async () => {
    const result = validatePayloadAgainstPlugin({ name: "nonexistent_tool", arguments: {} }, await githubPlugin());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNKNOWN_OPERATION",
      },
    });
  });

  it("treats create_issue_mirror as an unknown operation on the GitHub mirror plugin", async () => {
    const plugin = await githubPlugin();
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "verification", "valid-no-approval-required.json"),
    );
    const result = validatePayloadAgainstPlugin(actionPackage.executionPayload, plugin);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNKNOWN_OPERATION",
      },
    });
  });

  it("rejects a non-object payload", async () => {
    const result = validatePayloadAgainstPlugin(null as never, await githubPlugin());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PAYLOAD_NOT_OBJECT",
      },
    });
  });

  it("rejects malformed arguments for a known operation", async () => {
    const result = validatePayloadAgainstPlugin(
      {
        name: "merge_pull_request_mirror",
        arguments: {
          owner: "oma3dao",
          repo: "app-registry",
          baseRef: "main",
          expectedHeadSha: "abc123",
          mergeMethod: "squash",
        },
      },
      await githubPlugin(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PAYLOAD_SCHEMA_INVALID",
      },
    });
  });

  it("rejects unknown argument members when the schema is silent on additionalProperties", async () => {
    const plugin = {
      version: "1",
      type: "MpasApplicationPlugin",
      pluginDid: "did:web:plugins.example:x",
      pluginVersion: "0.1.0",
      publisherDid: "did:web:publisher.example",
      applicationDid: "did:web:app.example",
      executionProfile: {
        id: "did:web:profiles.oma3.org:mcp",
        format: "mcp.toolsCall",
        protocolVersion: "2024-11-05",
      },
      operations: {
        x: {
          description: "silent schema",
          executionPayloadSchema: {
            type: "object",
            required: ["name", "arguments"],
            properties: {
              name: { const: "x" },
              arguments: { type: "object", properties: { known: { type: "string" } } },
            },
          },
        },
      },
    } as unknown as MpasApplicationPlugin;

    const valid = validatePayloadAgainstPlugin({ name: "x", arguments: { known: "a" } }, plugin);
    expect(valid.ok).toBe(true);

    const smuggled = validatePayloadAgainstPlugin({ name: "x", arguments: { known: "a", unknown: "b" } }, plugin);
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) {
      expect(smuggled.error.code).toBe("PAYLOAD_SCHEMA_INVALID");
    }
  });
});
