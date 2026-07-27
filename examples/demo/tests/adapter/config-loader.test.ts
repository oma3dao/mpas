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

  const plugin = await readJson<unknown>(join(fixturesDir, "plugins", "github-mirror-plugin.json"));
  await writeJson(join(pluginDir, "github-mirror-plugin.json"), plugin);

  return { root, configDir, pluginDir };
}

describe("loadDeploymentConfigs", () => {
  it("loads fixture configs and indexes by target application DID", async () => {
    const result = await loadDeploymentConfigs(join(fixturesDir, "configs"), { confirmPluginUse: approvePluginUse });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs).toHaveLength(2);
      expect(result.configsByApplicationDid.has("did:web:github-mirror.example")).toBe(true);
      expect(result.configs.map((entry) => entry.config.name).sort()).toEqual([
        "github-live-demo",
        "github-mirror",
      ]);
      // Mirror and live demo are distinct applications, so both route cleanly.
      expect(result.configsByApplicationDid.has("did:web:github-live-demo.example")).toBe(true);
      expect(result.configs.every((entry) => entry.plugin.type === "MpasApplicationPlugin")).toBe(true);
    }
  });

  it("rejects configs with missing plugin files", async () => {
    const { configDir } = await tempFixtureConfigDir();
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-mirror-adapter-config.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: "../plugins/missing.json",
    };
    await writeJson(join(configDir, "github-mirror-adapter-config.json"), config);

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
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-mirror-adapter-config.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      artifactDid: "did:artifact:bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    await writeJson(join(configDir, "github-mirror-adapter-config.json"), config);

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
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: "../plugins/github-mirror-plugin.json",
    };
    const policy = config.policy as { policies: Record<string, unknown[]> };
    policy.policies.create_issue_mirror = [
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

describe("duplicate applicationDid", () => {
  it("refuses to load two configs claiming the same application", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-dup-did-"));
    const mirror = JSON.parse(
      await readFile(join(fixturesDir, "configs", "github-mirror-adapter-config.json"), "utf8"),
    ) as Record<string, any>;
    mirror.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");

    // Same application, two files — the adapter routes only by applicationDid,
    // so this must fail loudly rather than silently keep one.
    await writeFile(join(dir, "a-mirror.json"), JSON.stringify(mirror));
    await writeFile(join(dir, "b-mirror-copy.json"), JSON.stringify({ ...mirror, name: "github-mirror-copy" }));

    const result = await loadDeploymentConfigs(dir, { confirmPluginUse: approvePluginUse });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DUPLICATE_APPLICATION_DID");
      expect(result.error.message).toContain("did:web:github-mirror.example");
    }
  });
});
