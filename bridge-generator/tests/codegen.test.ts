import { describe, expect, it } from "vitest";
import ts from "typescript";
import { generateBridge, generateToolsJson } from "../src/bridge-codegen.js";
import { generatePlugin, inferImpact } from "../src/plugin-codegen.js";
import type { UpstreamInfo } from "../src/types.js";

const upstream: UpstreamInfo = {
  command: "node",
  args: ["mock-server.mjs"],
  serverName: "mock-mcp",
  serverVersion: "1.2.3",
  tools: [
    {
      name: "delete_branch",
      title: "Delete Branch",
      description: "Delete a branch.",
      inputSchema: { type: "object", required: ["branch"], properties: { branch: { type: "string" } } },
      outputSchema: { type: "object", properties: { deleted: { type: "boolean" } } },
      annotations: { destructiveHint: true },
      _meta: { "example.test/category": "branches" },
    },
    {
      name: "list_repositories",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

describe("generateBridge", () => {
  it("loads tool definitions from a sibling tools.json", () => {
    const source = generateBridge(upstream);
    expect(source).toContain('new URL("./tools.json", import.meta.url)');
    expect(source).toContain("const TOOLS = loadTools();");
    expect(source).not.toContain('"name": "delete_branch"');
    expect(source).not.toContain('"example.test/category": "branches"');
    // Unknown tools are rejected at both entry points.
    expect(source).toContain("UNKNOWN_TOOL");
  });

  it("emits the complete discovered tool list as deterministic JSON", () => {
    const json = generateToolsJson(upstream.tools);
    expect(JSON.parse(json)).toEqual(upstream.tools);
    expect(json).toContain('"outputSchema"');
    expect(json).toContain('"destructiveHint": true');
    expect(json).toContain('"example.test/category": "branches"');
    expect(json.endsWith("\n")).toBe(true);
    expect(generateToolsJson(upstream.tools)).toBe(json);
  });

  it("relays upstream MCP tool results without reshaping them", () => {
    const source = generateBridge(upstream);
    expect(source).toContain("return result as unknown as ToolCallResult;");
    expect(source).not.toContain("structuredContent: result,");
  });

  it("relays indeterminate diagnostics while preserving no-retry guidance", () => {
    const source = generateBridge(upstream);
    expect(source).toContain("response.context?.diagnostic");
    expect(source).toContain("...(diagnostic ? { diagnostic } : {})");
    expect(source).toContain("Do not automatically retry with the same actionId");
  });

  it("is deterministic: same input produces byte-identical output", () => {
    expect(generateBridge(upstream)).toBe(generateBridge(upstream));
  });

  it("emits syntactically valid TypeScript", () => {
    const source = generateBridge(upstream);
    const result = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    expect(result.diagnostics ?? []).toEqual([]);
  });

  it("cannot be broken out of by hostile tool names or descriptions", () => {
    const hostile: UpstreamInfo = {
      ...upstream,
      serverName: "evil */ import x from 'y' /*",
      tools: [
        {
          name: "tool_*/_breakout",
          description: "```${process.exit(1)}` */ // `",
          inputSchema: { type: "object" },
        },
      ],
    };
    const source = generateBridge(hostile);
    expect(JSON.parse(generateToolsJson(hostile.tools))).toEqual(hostile.tools);
    const result = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    expect(result.diagnostics ?? []).toEqual([]);
  });
});

describe("generatePlugin", () => {
  it("emits an operation for every tool with fail-closed payload schemas", () => {
    const plugin = JSON.parse(generatePlugin(upstream.tools)) as {
      type: string;
      operations: Record<string, { impact: string; executionPayloadSchema: Record<string, unknown> }>;
    };

    expect(plugin.type).toBe("MpasApplicationPlugin");
    expect(Object.keys(plugin.operations)).toEqual(["delete_branch", "list_repositories"]);
    expect(plugin.operations.delete_branch.impact).toBe("critical");
    expect(plugin.operations.delete_branch.executionPayloadSchema).toMatchObject({
      type: "object",
      required: ["name", "arguments"],
      additionalProperties: false,
    });
  });

  it("is deterministic", () => {
    expect(generatePlugin(upstream.tools)).toBe(generatePlugin(upstream.tools));
  });
});

describe("inferImpact", () => {
  it.each([
    ["delete_branch", "critical"],
    ["remove_user", "critical"],
    ["merge_pull_request", "high"],
    ["deploy_service", "high"],
    ["transfer_ownership", "high"],
    ["list_repositories", "medium"],
    ["create_issue", "medium"],
  ])("classifies %s as %s", (name, impact) => {
    expect(inferImpact(name)).toBe(impact);
  });
});
