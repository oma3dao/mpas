import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema } from "./mpas.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

export type ToolCallResult = CallToolResult;
