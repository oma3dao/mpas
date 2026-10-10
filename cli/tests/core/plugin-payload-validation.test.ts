import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlugin, validatePayloadAgainstPlugin } from "../../src/core/plugin-loader.js";
import type { MpasApplicationPlugin } from "../../src/core/plugin-loader.js";
import { PLUGIN_RESOURCE_LIMITS } from "@oma3/mpas/plugin-loader";
import type { ActionPackage } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

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

function testPlugin(schema: Record<string, unknown>): MpasApplicationPlugin {
  return {
    version: "1",
    type: "MpasApplicationPlugin",
    pluginDid: "did:web:plugins.example:payload-boundary",
    pluginVersion: "1.0.0",
    publisherDid: "did:web:publisher.example",
    applicationDid: "did:web:app.example",
    executionProfile: { id: "did:web:profiles.example:mcp", protocolVersion: "2024-11-05" },
    operations: {
      probe: { executionPayloadSchema: schema },
    },
  } as MpasApplicationPlugin;
}

const OPEN_SCHEMA = { type: "object", required: ["name"], additionalProperties: true };

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

describe("validatePayloadAgainstPlugin", () => {
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

describe("validatePayloadAgainstPlugin resource bounds (N33)", () => {
  it("accepts a payload at exactly 1,048,576 serialized bytes and rejects 1,048,577", async () => {
    const plugin = testPlugin(OPEN_SCHEMA);
    const base = { name: "probe", arguments: { pad: "" } };
    const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
    const pad = (target: number) => "x".repeat(target - overhead);

    const atLimit = { name: "probe", arguments: { pad: pad(PLUGIN_RESOURCE_LIMITS.maxPayloadBytes) } };
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(PLUGIN_RESOURCE_LIMITS.maxPayloadBytes);
    expect(validatePayloadAgainstPlugin(atLimit, plugin)).toMatchObject({ ok: true });

    const aboveLimit = { name: "probe", arguments: { pad: pad(PLUGIN_RESOURCE_LIMITS.maxPayloadBytes + 1) } };
    expect(Buffer.byteLength(JSON.stringify(aboveLimit), "utf8")).toBe(PLUGIN_RESOURCE_LIMITS.maxPayloadBytes + 1);
    expect(validatePayloadAgainstPlugin(aboveLimit, plugin)).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_RESOURCE_EXCEEDED", details: { resource: "payload-bytes" } },
    });
  });

  it("accepts a payload at depth 64 and rejects depth 65", () => {
    const plugin = testPlugin(OPEN_SCHEMA);
    const nested = (wraps: number) => {
      let value: unknown = "x";
      for (let index = 0; index < wraps; index += 1) value = [value];
      return { name: "probe", arguments: { pad: value } } as unknown as Parameters<typeof validatePayloadAgainstPlugin>[0];
    };

    const at64 = nested(62);
    expect(jsonDepth(at64)).toBe(64);
    expect(validatePayloadAgainstPlugin(at64, plugin)).toMatchObject({ ok: true });

    const at65 = nested(63);
    expect(jsonDepth(at65)).toBe(65);
    expect(validatePayloadAgainstPlugin(at65, plugin)).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_RESOURCE_EXCEEDED", details: { resource: "payload-depth" } },
    });
  });

  it("accepts a payload at exactly 100,000 nodes and rejects 100,001", () => {
    const plugin = testPlugin(OPEN_SCHEMA);
    const base = { name: "probe", arguments: { pad: [] as number[] } };
    const overhead = countJsonNodes(base);

    const atLimit = { name: "probe", arguments: { pad: Array.from({ length: PLUGIN_RESOURCE_LIMITS.maxPayloadNodes - overhead }, () => 0) } };
    expect(countJsonNodes(atLimit)).toBe(PLUGIN_RESOURCE_LIMITS.maxPayloadNodes);
    expect(validatePayloadAgainstPlugin(atLimit, plugin)).toMatchObject({ ok: true });

    const aboveLimit = {
      name: "probe",
      arguments: { pad: Array.from({ length: PLUGIN_RESOURCE_LIMITS.maxPayloadNodes + 1 - overhead }, () => 0) },
    };
    expect(countJsonNodes(aboveLimit)).toBe(PLUGIN_RESOURCE_LIMITS.maxPayloadNodes + 1);
    expect(validatePayloadAgainstPlugin(aboveLimit, plugin)).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_RESOURCE_EXCEEDED", details: { resource: "payload-nodes" } },
    });
  });

  it("rejects a cyclic programmatic payload without recursing indefinitely", () => {
    const plugin = testPlugin(OPEN_SCHEMA);
    const args: Record<string, unknown> = {};
    args.self = args;
    const payload = { name: "probe", arguments: args } as unknown as Parameters<typeof validatePayloadAgainstPlugin>[0];
    const result = validatePayloadAgainstPlugin(payload, plugin);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_RESOURCE_EXCEEDED", details: { resource: "payload-cycle" } },
    });
  });

  it("rejects a programmatic plugin with a depth-33 schema before Ajv", () => {
    let schema: Record<string, unknown> = { type: "array", items: { type: "array", items: { type: "string" } } };
    for (let index = 0; index < 15; index += 1) schema = { type: "object", properties: { a: schema } };
    expect(jsonDepth(schema)).toBe(33);
    const result = validatePayloadAgainstPlugin({ name: "probe", arguments: {} }, testPlugin(schema));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_RESOURCE_EXCEEDED", details: { resource: "operation-schema-depth" } },
    });
  });

  it("rejects a programmatic plugin with a cyclic schema without recursing indefinitely", () => {
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    (schema.properties as Record<string, unknown>).self = schema;
    const result = validatePayloadAgainstPlugin({ name: "probe", arguments: {} }, testPlugin(schema));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_RESOURCE_EXCEEDED" },
    });
  });

  it("returns the schema-invalid family with a stable path when Ajv cannot compile the schema", () => {
    const schema = { type: "object", properties: { a: { minimum: "abc" } } };
    const result = validatePayloadAgainstPlugin({ name: "probe", arguments: {} }, testPlugin(schema));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PAYLOAD_SCHEMA_INVALID",
        path: "$.plugin.operations.probe.executionPayloadSchema",
      },
    });
  });

  it("still enforces a plugin pattern through Ajv (positive control)", () => {
    const schema = {
      type: "object",
      properties: {
        name: { const: "probe" },
        arguments: {
          type: "object",
          properties: { digest: { type: "string", pattern: "^[0-9a-f]{64}$" } },
          additionalProperties: false,
        },
      },
    };
    const plugin = testPlugin(schema);
    expect(
      validatePayloadAgainstPlugin({ name: "probe", arguments: { digest: "a".repeat(64) } }, plugin),
    ).toMatchObject({ ok: true, match: { operationName: "probe" } });
    expect(
      validatePayloadAgainstPlugin({ name: "probe", arguments: { digest: "z".repeat(64) } }, plugin),
    ).toMatchObject({ ok: false, error: { code: "PAYLOAD_SCHEMA_INVALID" } });
  });

  it("preserves local JSON Pointer references inside operation schemas", () => {
    const schema = {
      type: "object",
      $defs: { hex: { type: "string", pattern: "^[0-9a-f]{2}$" } },
      properties: {
        name: { const: "probe" },
        arguments: {
          type: "object",
          properties: { byte: { $ref: "#/$defs/hex" } },
          additionalProperties: false,
        },
      },
    };
    const plugin = testPlugin(schema);
    expect(validatePayloadAgainstPlugin({ name: "probe", arguments: { byte: "0a" } }, plugin)).toMatchObject({ ok: true });
    expect(validatePayloadAgainstPlugin({ name: "probe", arguments: { byte: "zz" } }, plugin)).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_SCHEMA_INVALID" },
    });
  });
});
