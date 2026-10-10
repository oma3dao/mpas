import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlugin } from "../../src/core/plugin-loader.js";
import { PLUGIN_RESOURCE_LIMITS } from "@oma3/mpas/plugin-loader";

const pluginsDir = fileURLToPath(new URL("../fixtures/plugins/", import.meta.url));

/** Mirrors the loader's counting rule: every JSON value; keys are not values. */
function countJsonNodes(value: unknown): number {
  let nodes = 1;
  if (Array.isArray(value)) {
    for (const entry of value) nodes += countJsonNodes(entry);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) nodes += countJsonNodes((value as Record<string, unknown>)[key]);
  }
  return nodes;
}

/** Mirrors the loader's depth rule: containment depth, root value = 0. */
function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length === 0 ? 0 : 1 + Math.max(...value.map(jsonDepth));
  }
  if (value !== null && typeof value === "object") {
    const members = Object.values(value);
    return members.length === 0 ? 0 : 1 + Math.max(...members.map(jsonDepth));
  }
  return 0;
}

function basePlugin(): Record<string, unknown> {
  return {
    version: "1",
    type: "MpasApplicationPlugin",
    pluginDid: "did:web:plugins.example:boundary",
    pluginVersion: "1.0.0",
    publisherDid: "did:web:publisher.example",
    applicationDid: "did:web:app.example",
    executionProfile: { id: "did:web:profiles.example:mcp", protocolVersion: "2024-11-05" },
    operations: {
      probe: { executionPayloadSchema: { type: "object" } },
    },
  };
}

/** Nests a leaf schema under `wraps` object/property levels (each adds 2 depth). */
function nestedSchema(wraps: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let schema = leaf;
  for (let index = 0; index < wraps; index += 1) {
    schema = { type: "object", properties: { a: schema } };
  }
  return schema;
}

async function writePlugin(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mpas-plugin-boundary-"));
  const path = join(dir, "plugin.json");
  await writeFile(path, contents);
  return path;
}

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

describe("loadPlugin resource bounds (N33)", () => {
  it("accepts a document at exactly 262,144 bytes and rejects 262,145", async () => {
    const plugin = basePlugin();
    (plugin.operations as Record<string, { description?: string }>).probe.description = "";
    const emptyOverhead = Buffer.byteLength(JSON.stringify(plugin), "utf8");
    const pad = (target: number) => "x".repeat(target - emptyOverhead);

    (plugin.operations as Record<string, { description?: string }>).probe.description = pad(PLUGIN_RESOURCE_LIMITS.maxPluginDocumentBytes);
    const atLimit = JSON.stringify(plugin);
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(PLUGIN_RESOURCE_LIMITS.maxPluginDocumentBytes);
    const accepted = await loadPlugin(await writePlugin(atLimit));
    expect(accepted.ok).toBe(true);

    (plugin.operations as Record<string, { description?: string }>).probe.description = pad(PLUGIN_RESOURCE_LIMITS.maxPluginDocumentBytes + 1);
    const aboveLimit = JSON.stringify(plugin);
    expect(Buffer.byteLength(aboveLimit, "utf8")).toBe(PLUGIN_RESOURCE_LIMITS.maxPluginDocumentBytes + 1);
    const rejected = await loadPlugin(await writePlugin(aboveLimit));
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_RESOURCE_EXCEEDED", details: { resource: "plugin-document-bytes" } },
    });
  });

  it("rejects the proved one-megabyte-description plugin", async () => {
    const plugin = basePlugin();
    (plugin.operations as Record<string, { description?: string }>).probe.description = "x".repeat(1_048_576);
    const result = await loadPlugin(await writePlugin(JSON.stringify(plugin)));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_RESOURCE_EXCEEDED", details: { resource: "plugin-document-bytes" } },
    });
  });

  it("passes a document at depth 64 and rejects depth 65", async () => {
    const at64 = basePlugin();
    (at64.operations as Record<string, { executionPayloadSchema: unknown }>).probe.executionPayloadSchema = nestedSchema(29, {
      type: "array",
      items: { type: "array", items: { type: "string" } },
    });
    const schema = (at64.operations as Record<string, { executionPayloadSchema: unknown }>).probe.executionPayloadSchema;
    expect(jsonDepth(schema)).toBe(61);
    expect(jsonDepth(at64)).toBe(64);
    const below = await loadPlugin(await writePlugin(JSON.stringify(at64)));
    // Document depth 64 passes the document bound; the schema-depth bound (32) fires later.
    expect(below).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_RESOURCE_EXCEEDED", details: { resource: "operation-schema-depth" } },
    });

    const at65 = basePlugin();
    (at65.operations as Record<string, { executionPayloadSchema: unknown }>).probe.executionPayloadSchema = nestedSchema(30, {
      type: "array",
      items: { type: "string" },
    });
    expect(jsonDepth(at65)).toBe(65);
    const above = await loadPlugin(await writePlugin(JSON.stringify(at65)));
    expect(above).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_RESOURCE_EXCEEDED", details: { resource: "plugin-document-depth" } },
    });
  });

  it("accepts a document at exactly 20,000 nodes and rejects 20,001", async () => {
    const plugin = basePlugin();
    plugin.credentialRequirements = [{ type: "x", expectedAuthority: [] as string[] }];
    const base = countJsonNodes(plugin);
    const requirements = plugin.credentialRequirements as Array<{ expectedAuthority: string[] }>;
    const padTo = (target: number) => {
      requirements[0].expectedAuthority = Array.from({ length: target - base }, () => "a");
    };

    padTo(PLUGIN_RESOURCE_LIMITS.maxPluginDocumentNodes);
    expect(countJsonNodes(plugin)).toBe(PLUGIN_RESOURCE_LIMITS.maxPluginDocumentNodes);
    const accepted = await loadPlugin(await writePlugin(JSON.stringify(plugin)));
    expect(accepted.ok).toBe(true);

    padTo(PLUGIN_RESOURCE_LIMITS.maxPluginDocumentNodes + 1);
    expect(countJsonNodes(plugin)).toBe(PLUGIN_RESOURCE_LIMITS.maxPluginDocumentNodes + 1);
    const rejected = await loadPlugin(await writePlugin(JSON.stringify(plugin)));
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_RESOURCE_EXCEEDED", details: { resource: "plugin-document-nodes" } },
    });
  });

  it("accepts an operation schema at depth 32, rejects 33 and the proved depth-128 case", async () => {
    const at32 = basePlugin();
    (at32.operations as Record<string, { executionPayloadSchema: unknown }>).probe.executionPayloadSchema = nestedSchema(15, {
      type: "array",
      items: { type: "string" },
    });
    expect(jsonDepth((at32.operations as Record<string, { executionPayloadSchema: unknown }>).probe.executionPayloadSchema)).toBe(32);
    expect((await loadPlugin(await writePlugin(JSON.stringify(at32)))).ok).toBe(true);

    for (const [label, schema, resource] of [
      ["depth-33", nestedSchema(15, { type: "array", items: { type: "array", items: { type: "string" } } }), "operation-schema-depth"],
      ["depth-128 (proved)", nestedSchema(63, { type: "array", items: { type: "string" } }), "plugin-document-depth"],
    ] as const) {
      const plugin = basePlugin();
      (plugin.operations as Record<string, { executionPayloadSchema: unknown }>).probe.executionPayloadSchema = schema;
      expect(jsonDepth(schema)).toBe(label === "depth-33" ? 33 : 128);
      const result = await loadPlugin(await writePlugin(JSON.stringify(plugin)));
      // depth-33 sits under the document bound and trips the schema bound;
      // depth-128 puts the whole document at depth 131 and trips the document bound first.
      expect(result, label).toMatchObject({
        ok: false,
        error: { code: "PLUGIN_RESOURCE_EXCEEDED", details: { resource } },
      });
    }
  });

  it("accepts operation schemas at exactly 4,096 aggregate nodes and rejects 4,097", async () => {
    const build = (total: number) => {
      const plugin = basePlugin();
      const operations = plugin.operations as Record<string, { executionPayloadSchema: unknown }>;
      let count = countJsonNodes(operations.probe.executionPayloadSchema);
      let index = 0;
      while (count < total) {
        index += 1;
        operations[`op${index}`] = { executionPayloadSchema: { type: "object" } };
        count += 2;
      }
      return plugin;
    };

    const atLimit = build(PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes);
    expect(
      Object.values(atLimit.operations as Record<string, { executionPayloadSchema: unknown }>).reduce(
        (sum, op) => sum + countJsonNodes(op.executionPayloadSchema),
        0,
      ),
    ).toBe(PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes);
    expect((await loadPlugin(await writePlugin(JSON.stringify(atLimit)))).ok).toBe(true);

    const aboveLimit = build(PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes + 2);
    const rejected = await loadPlugin(await writePlugin(JSON.stringify(aboveLimit)));
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_RESOURCE_EXCEEDED", details: { resource: "operation-schema-nodes" } },
    });
  });
});
