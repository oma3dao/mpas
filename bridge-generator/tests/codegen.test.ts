import { describe, expect, it } from "vitest";
import ts from "typescript";
import { generateBridge } from "../src/bridge-codegen.js";
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
      description: "Delete a branch.",
      inputSchema: { type: "object", required: ["branch"], properties: { branch: { type: "string" } } },
    },
    {
      name: "list_repositories",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

describe("generateBridge", () => {
  it("embeds every discovered tool statically", () => {
    const source = generateBridge(upstream);
    expect(source).toContain('"name": "delete_branch"');
    expect(source).toContain('"name": "list_repositories"');
    expect(source).toContain("const TOOLS =");
    // Unknown tools are rejected at both entry points.
    expect(source).toContain("UNKNOWN_TOOL");
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
