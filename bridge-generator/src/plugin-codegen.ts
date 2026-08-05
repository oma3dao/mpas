import type { GeneratedPlugin, McpToolDefinition } from "./types.js";

export function generatePlugin(tools: McpToolDefinition[], protocolVersion: string): string {
  const plugin: GeneratedPlugin = {
    version: "1",
    type: "MpasApplicationPlugin",
    pluginDid: "did:web:PLACEHOLDER",
    pluginVersion: "0.1.0",
    publisherDid: "did:web:PLACEHOLDER",
    applicationDid: "did:web:PLACEHOLDER",
    executionProfile: {
      id: "did:web:profiles.oma3.org:mcp",
      format: "mcp.toolsCall",
      protocolVersion,
    },
    credentialRequirements: [],
    operations: Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        {
          description: tool.description ?? "",
          impact: tool.annotations?.destructiveHint === true ? "critical" : inferImpact(tool.name),
          executionPayloadSchema: {
            type: "object",
            required: ["name", "arguments"],
            properties: {
              name: { const: tool.name },
              arguments: rebaseLocalJsonReferences(tool.inputSchema, "#/properties/arguments"),
            },
            additionalProperties: false,
          },
        },
      ]),
    ),
  };

  return `${JSON.stringify(plugin, null, 2)}\n`;
}

/**
 * An MCP tool's inputSchema is a schema document of its own. The Application
 * Plugin wraps that document under executionPayloadSchema.properties.arguments,
 * so JSON Pointer references rooted at the original document must move with it.
 */
export function rebaseLocalJsonReferences(value: unknown, basePointer: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rebaseLocalJsonReferences(entry, basePointer));
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "$ref" && typeof entry === "string") {
        if (entry === "#") return [key, basePointer];
        if (entry.startsWith("#/")) return [key, `${basePointer}${entry.slice(1)}`];
      }
      return [key, rebaseLocalJsonReferences(entry, basePointer)];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inferImpact(name: string): "medium" | "high" | "critical" {
  const normalized = name.toLowerCase();
  if (/(delete|remove|destroy|drop|purge)/.test(normalized)) {
    return "critical";
  }
  if (/(merge|deploy|release|transfer|revoke)/.test(normalized)) {
    return "high";
  }
  return "medium";
}
