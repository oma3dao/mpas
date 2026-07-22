export interface JsonSchema {
  [key: string]: unknown;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

/**
 * The required MCP Tool fields plus the standardized optional fields known to
 * the generator. The index signature is intentional: discovery must preserve
 * extension and future protocol fields instead of silently stripping them.
 */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
  icons?: Array<Record<string, unknown>>;
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
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
