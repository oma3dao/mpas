export interface JsonSchema {
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

export interface UpstreamInfo {
  command: string;
  args: string[];
  serverName: string;
  serverVersion?: string;
  protocolVersion?: string;
  tools: McpToolDefinition[];
}

export interface GeneratedPlugin {
  version: "1";
  type: "MpasApplicationPlugin";
  pluginDid: string;
  pluginVersion: string;
  publisherDid: string;
  applicationDid: string;
  executionProfile: {
    id: string;
    format: string;
  };
  credentialRequirements: unknown[];
  operations: Record<string, {
    description: string;
    impact: "medium" | "high" | "critical";
    executionPayloadSchema: JsonSchema;
  }>;
}
