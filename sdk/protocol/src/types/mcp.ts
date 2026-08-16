import type { JsonSchema } from "./mpas.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

export interface ToolCallResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}
