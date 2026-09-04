import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBridgeFromConfig, runBridge } from "../../src/bridge/github-bridge.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const bridgeToolsDir = fileURLToPath(new URL("../../bridge-tools/", import.meta.url));

async function writeBridgeConfig(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mpas-bridge-cfg-"));
  const config = {
    mode: "proposer",
    plugin: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
    tools: join(bridgeToolsDir, "github-mirror-tools.json"),
    adapter: { url: "http://127.0.0.1:7544" },
    agent: { keyFile: join(fixturesDir, "test-keys", "proposer.json") },
    ...overrides,
  };
  const path = join(dir, "bridge.json");
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

describe("createBridgeFromConfig", () => {
  it("rejects maintainer mode", async () => {
    await expect(createBridgeFromConfig(await writeBridgeConfig({ mode: "maintainer" }))).rejects.toThrow(
      /Maintainer\/signer mode is not supported/,
    );
  });

  it("rejects a config missing plugin or adapter.url", async () => {
    await expect(createBridgeFromConfig(await writeBridgeConfig({ plugin: undefined }))).rejects.toThrow(
      /requires "plugin"/,
    );
    await expect(
      createBridgeFromConfig(await writeBridgeConfig({ adapter: undefined, adapterUrl: undefined })),
    ).rejects.toThrow(/requires "adapter.url"/);
  });
});

describe("runBridge", () => {
  it("requires --config", async () => {
    await expect(runBridge([])).rejects.toThrow(/Usage: mpas-bridge --config/);
  });
});
