import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlugin, validatePayloadAgainstPlugin } from "../../src/lib/plugin-loader.js";
import type { ActionPackage } from "../../src/types/mpas.js";

const fixturesDir = fileURLToPath(new URL("../../../../examples/demo/tests/fixtures/", import.meta.url));

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

describe("validatePayloadAgainstPlugin (sdk)", () => {
  it.each([
    ["valid-two-approvals.json", "merge_pull_request_mirror"],
    ["valid-delete-branch.json", "delete_branch_mirror"],
  ])("matches and validates %s", async (fixtureFile, operationName) => {
    const plugin = await githubPlugin();
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", fixtureFile));
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

  it("treats create_issue_mirror as an unknown operation (pass-through)", async () => {
    const plugin = await githubPlugin();
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "valid-no-approval-required.json"));
    const result = validatePayloadAgainstPlugin(actionPackage.executionPayload, plugin);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNKNOWN_OPERATION",
      },
    });
  });

  it("rejects a non-object payload", async () => {
    const result = validatePayloadAgainstPlugin(null, await githubPlugin());

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
});
