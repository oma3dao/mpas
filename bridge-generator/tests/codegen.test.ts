import { describe, expect, it } from "vitest";
import ts from "typescript";
import { generateBridge, generateToolsJson, generateWorkflowStore } from "../src/bridge-codegen.js";
import { generatePlugin, inferImpact } from "../src/plugin-codegen.js";
import type { UpstreamInfo } from "../src/types.js";

const upstream: UpstreamInfo = {
  command: "node",
  args: ["mock-server.mjs"],
  serverName: "mock-mcp",
  serverVersion: "1.2.3",
  protocolVersion: "2024-11-05",
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
  });

  it("wires the shared official Tasks runtime around the tool definitions", () => {
    const source = generateBridge(upstream);
    // The spec-compliance surface comes from the SDK, not inline logic.
    expect(source).toContain("ProposerBridge");
    expect(source).toContain("MpasProtocolServer");
    expect(source).toContain("mcp_protocol_mode_selected");
    expect(source).not.toContain("clientInfo.name");
    expect(source).not.toContain("clientInfo.version");
    expect(source).toContain('from "@modelcontextprotocol/server/stdio"');
    expect(source).toContain('from "@oma3/mpas"');
    // Durable store is emitted repository code, memory store is the fallback.
    expect(source).toContain('from "./sqlite-workflow-store.js"');
    expect(source).toContain("MemoryWorkflowStore");
    expect(source).toContain("signer: keyManagerPromise");
    expect(source).toContain("new ActionRelayClient({");
    expect(source).toContain("...(timeoutMs !== undefined ? { timeoutMs } : {})");
    expect(source).toContain("client.submitAction(buildDeliveryEnvelope({");
    expect(source).toContain("new Set([config.verifierDid, ...(config.additionalRecipients ?? [])])");
    expect(source).toContain("coordinationService,");
    expect(source).toContain('either "actionEndpoint.url" or "adapter.url"');
    expect(source).toContain('actionEndpoint.verifierDid');
    // The background workflow loop starts with the server.
    expect(source).toContain("await bridge.start();");
    expect(source).not.toContain("mpas_wait_for_action_result");
    expect(source).not.toContain("execution.taskSupport");
    expect(source).not.toContain("@modelcontextprotocol/sdk");
  });

  it("returns control without a synchronous approval wait", () => {
    const source = generateBridge(upstream);
    expect(source).not.toContain("waitForCoordinatedResult");
    expect(source).not.toContain("approvalTimeoutMs ?? 300_000");
    // Legacy blocking-wait config is accepted but ignored, with a warning.
    expect(source).toContain("deprecated_config_ignored");
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

  it("emits the SQLite workflow store as standalone repository code", () => {
    const store = generateWorkflowStore();
    expect(store).toContain('from "node:sqlite"');
    expect(store).toContain("implements WorkflowStore");
    expect(store).toContain("PRAGMA journal_mode = WAL");
    expect(store).toContain("cancelWorkflow(taskId: string)");
    expect(store).toContain("replaceAction(taskId: string, input: ReplaceWorkflowActionInput)");
    expect(store).toContain("action_idempotency_key");
    expect(store).toContain("idx_workflows_current_action_id");
    expect(store).toContain("Task ID and Action ID must be distinct.");
    expect(store).toContain("'resolved', 'unresolvable', 'cancelled'");
    expect(generateWorkflowStore()).toBe(store);

    const result = ts.transpileModule(store, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    expect(result.diagnostics ?? []).toEqual([]);
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
    const plugin = JSON.parse(generatePlugin(upstream.tools, upstream.protocolVersion)) as {
      type: string;
      pluginVersion: string;
      executionProfile: { protocolVersion: string };
      operations: Record<string, { impact: string; executionPayloadSchema: Record<string, unknown> }>;
    };

    expect(plugin.type).toBe("MpasApplicationPlugin");
    expect(plugin.pluginVersion).toBe("0.1.0");
    expect(plugin.executionProfile.protocolVersion).toBe("2024-11-05");
    expect(Object.keys(plugin.operations)).toEqual(["delete_branch", "list_repositories"]);
    expect(plugin.operations.delete_branch.impact).toBe("critical");
    expect(plugin.operations.delete_branch.executionPayloadSchema).toMatchObject({
      type: "object",
      required: ["name", "arguments"],
      additionalProperties: false,
    });
  });

  it("is deterministic", () => {
    expect(generatePlugin(upstream.tools, upstream.protocolVersion)).toBe(
      generatePlugin(upstream.tools, upstream.protocolVersion),
    );
  });

  it("rebases input-schema JSON Pointer references after nesting under arguments", () => {
    const plugin = JSON.parse(generatePlugin([
      {
        name: "add_reference_variable",
        inputSchema: {
          type: "object",
          $defs: {
            ReferenceVariable: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
          properties: {
            variables: {
              type: "array",
              items: { $ref: "#/$defs/ReferenceVariable" },
            },
            recursive: { $ref: "#" },
            external: { $ref: "https://example.com/schema.json" },
          },
        },
      },
    ], upstream.protocolVersion)) as {
      operations: Record<string, { executionPayloadSchema: {
        properties: { arguments: { properties: Record<string, { $ref: string }> } };
      } }>;
    };

    const properties = plugin.operations.add_reference_variable.executionPayloadSchema.properties.arguments.properties;
    expect(properties.variables).toMatchObject({
      items: { $ref: "#/properties/arguments/$defs/ReferenceVariable" },
    });
    expect(properties.recursive.$ref).toBe("#/properties/arguments");
    expect(properties.external.$ref).toBe("https://example.com/schema.json");
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
