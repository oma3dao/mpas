import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlugin, validatePayloadAgainstPlugin } from "../../src/core/plugin-loader.js";
import type { ActionPackage } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function githubPlugin() {
  const result = await loadPlugin(join(fixturesDir, "plugins", "github-repo.json"));
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.plugin;
}

describe("validatePayloadAgainstPlugin", () => {
  it.each([
    ["valid-no-approval-required.json", "create_issue"],
    ["valid-two-approvals.json", "merge_pull_request"],
    ["valid-delete-branch.json", "delete_branch"],
  ])("matches and validates %s", async (fixtureFile, operationName) => {
    const plugin = await githubPlugin();
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", fixtureFile));
    const result = validatePayloadAgainstPlugin(actionPackage.executionPayload, plugin);

    expect(result).toMatchObject({
      ok: true,
      match: {
        operation: {
          name: operationName,
        },
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
        name: "merge_pull_request",
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
