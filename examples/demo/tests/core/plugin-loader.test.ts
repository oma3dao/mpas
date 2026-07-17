import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlugin } from "../../src/core/plugin-loader.js";

const pluginsDir = fileURLToPath(new URL("../fixtures/plugins/", import.meta.url));

describe("loadPlugin", () => {
  it("loads the valid GitHub plugin fixture", async () => {
    const result = await loadPlugin(join(pluginsDir, "github-demo-plugin.json"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plugin.type).toBe("MpasApplicationPlugin");
      expect(Object.keys(result.plugin.operations)).toEqual([
        "delete_branch",
        "merge_pull_request",
      ]);
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
