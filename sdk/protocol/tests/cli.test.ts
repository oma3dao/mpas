import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBridgeFromConfig } from "../src/cli.js";
import { ProposerBridge } from "../src/index.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("CLI configuration", () => {
  it("creates a proposer bridge that can list GitHub tools", async () => {
    const bridge = await createBridgeFromConfig(join(fixturesDir, "configs", "proposer.json"));

    expect(bridge).toBeInstanceOf(ProposerBridge);
    expect(bridge.getToolDefinitions().map((tool) => tool.name)).toEqual([
      "create_issue",
      "merge_pull_request",
      "delete_branch",
    ]);
    expect(bridge.buildMcpServer()).toBeDefined();
  });

  it("returns descriptive validation errors for invalid configs", async () => {
    await expect(createBridgeFromConfig(join(fixturesDir, "configs", "invalid-missing-adapter.json"))).rejects.toThrow(
      'adapter.url',
    );
    await expect(createBridgeFromConfig(join(fixturesDir, "configs", "invalid-did-mismatch.json"))).rejects.toThrow(
      "does not match derived DID",
    );
  });
});
