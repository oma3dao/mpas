import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const approvePluginUse = async () => true;

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function tempFixtureConfigDir() {
  const root = await mkdtemp(join(tmpdir(), "mpas-config-loader-"));
  const configDir = join(root, "configs");
  const pluginDir = join(root, "plugins");
  await mkdir(configDir, { recursive: true });
  await mkdir(pluginDir, { recursive: true });

  const plugin = await readJson<unknown>(join(fixturesDir, "plugins", "github-demo-plugin.json"));
  await writeJson(join(pluginDir, "github-demo-plugin.json"), plugin);

  return { root, configDir, pluginDir };
}

describe("loadDeploymentConfigs", () => {
  it("loads fixture configs and indexes by target application DID", async () => {
    const result = await loadDeploymentConfigs(join(fixturesDir, "configs"), { confirmPluginUse: approvePluginUse });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs).toHaveLength(2);
      expect(result.configsByApplicationDid.has("did:web:github.example")).toBe(true);
      expect(result.configs.map((entry) => entry.config.name).sort()).toEqual([
        "github-auto-approve",
        "github-strict",
      ]);
      expect(result.configs.every((entry) => entry.plugin.type === "MpasApplicationPlugin")).toBe(true);
    }
  });

  it("rejects configs with missing plugin files", async () => {
    const { configDir } = await tempFixtureConfigDir();
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-strict.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: "../plugins/missing.json",
    };
    await writeJson(join(configDir, "github-strict.json"), config);

    const result = await loadDeploymentConfigs(configDir, { confirmPluginUse: approvePluginUse });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_LOAD_FAILED",
      },
    });
  });

  it("rejects configs with plugin artifact DID mismatches", async () => {
    const { configDir } = await tempFixtureConfigDir();
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-strict.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      artifactDid: "did:artifact:bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    await writeJson(join(configDir, "github-strict.json"), config);

    const result = await loadDeploymentConfigs(configDir, { confirmPluginUse: approvePluginUse });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_HASH_MISMATCH",
      },
    });
  });

  it("rejects a reject policy entry that also contains requirements", async () => {
    const { configDir } = await tempFixtureConfigDir();
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-auto-approve.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: "../plugins/github-demo-plugin.json",
    };
    const policy = config.policy as { policies: Record<string, unknown[]> };
    policy.policies.create_issue_demo = [
      {
        reject: true,
        requirements: { type: "proposerOnly" },
      },
    ];
    await writeJson(join(configDir, "github-invalid-deny.json"), config);

    const result = await loadDeploymentConfigs(configDir, { confirmPluginUse: approvePluginUse });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "CONFIG_SCHEMA_INVALID",
      },
    });
  });
});
