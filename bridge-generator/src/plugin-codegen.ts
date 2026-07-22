import type { GeneratedPlugin, McpToolDefinition } from "./types.js";

export function generatePlugin(tools: McpToolDefinition[]): string {
  const plugin: GeneratedPlugin = {
    version: "1",
    type: "MpasApplicationPlugin",
    pluginDid: "did:web:PLACEHOLDER",
    pluginVersion: "1.0.0",
    publisherDid: "did:web:PLACEHOLDER",
    applicationDid: "did:web:PLACEHOLDER",
    executionProfile: {
      id: "did:web:profiles.oma3.org:mcp",
      format: "mcp.toolsCall",
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
              arguments: tool.inputSchema,
            },
            additionalProperties: false,
          },
        },
      ]),
    ),
  };

  return `${JSON.stringify(plugin, null, 2)}\n`;
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
