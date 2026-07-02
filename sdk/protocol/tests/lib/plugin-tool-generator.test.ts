import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PluginToolGenerator, type MpasApplicationPlugin } from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function argumentsSchema(plugin: MpasApplicationPlugin, operationName: string): Record<string, unknown> {
  const schema = plugin.operations[operationName]?.executionPayloadSchema;
  const properties = schema?.properties as Record<string, unknown> | undefined;
  return properties?.arguments as Record<string, unknown>;
}

describe("PluginToolGenerator", () => {
  it("generates MCP tool definitions from the GitHub plugin fixture", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const generator = new PluginToolGenerator(plugin);
    const tools = generator.generateTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "create_issue",
      "merge_pull_request",
      "delete_branch",
    ]);
    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({
      name: "create_issue",
      description: "Create a new issue in a repository.",
      inputSchema: argumentsSchema(plugin, "create_issue"),
    });
  });

  it("returns operation-specific argument schemas", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const generator = new PluginToolGenerator(plugin);
    const mergeSchema = generator.getInputSchema("merge_pull_request");

    expect(mergeSchema).toEqual(argumentsSchema(plugin, "merge_pull_request"));
    expect(mergeSchema.required).toEqual([
      "owner",
      "repo",
      "pullNumber",
      "baseRef",
      "expectedHeadSha",
      "mergeMethod",
    ]);
    expect(generator.getOperation("delete_branch")?.description).toBe("Delete a branch from a repository.");
  });

  it("rejects plugins without operations and unknown operation schema lookups", () => {
    const plugin = {
      version: "1",
      type: "MpasApplicationPlugin",
      pluginDid: "did:web:plugins.example.com:empty",
      pluginVersion: "1.0.0",
      publisherDid: "did:web:publisher.example",
      applicationDid: "did:web:app.example",
      executionProfile: {
        id: "did:web:profiles.oma3.org:mcp",
        format: "mcp.toolsCall",
      },
      operations: {},
    } as MpasApplicationPlugin;

    expect(() => new PluginToolGenerator(plugin)).toThrow("at least one operation");

    const validPlugin = { ...plugin, operations: { op: { executionPayloadSchema: { properties: { arguments: {} } } } } };
    const generator = new PluginToolGenerator(validPlugin as unknown as MpasApplicationPlugin);
    expect(() => generator.getInputSchema("missing")).toThrow("Unknown plugin operation");
  });
});
