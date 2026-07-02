import type { JsonSchema, MpasApplicationPlugin, PluginOperationDescriptor } from "../types/mpas.js";
import type { McpToolDefinition } from "../types/mcp.js";

/**
 * Generates MCP tool definitions from an MPAS Application Plugin.
 *
 * The plugin's `operations` field is an object keyed by operation name,
 * per the MPAS Application Plugin Profile specification.
 */
export class PluginToolGenerator {
  private readonly operationNames: string[];

  constructor(private readonly plugin: MpasApplicationPlugin) {
    this.operationNames = Object.keys(plugin.operations);
    if (this.operationNames.length === 0) {
      throw new Error("MPAS application plugin must define at least one operation.");
    }
  }

  generateTools(): McpToolDefinition[] {
    return this.operationNames.map((name) => ({
      name,
      description: this.plugin.operations[name].description,
      inputSchema: this.getInputSchema(name),
    }));
  }

  getInputSchema(operationName: string): JsonSchema {
    const operation = this.requiredOperation(operationName);
    const properties = schemaRecord(operation.executionPayloadSchema.properties);
    const argumentsSchema = schemaRecord(properties.arguments);

    return argumentsSchema;
  }

  getOperation(operationName: string): PluginOperationDescriptor | undefined {
    return this.plugin.operations[operationName];
  }

  private requiredOperation(operationName: string): PluginOperationDescriptor {
    const operation = this.getOperation(operationName);
    if (!operation) {
      throw new Error(`Unknown plugin operation: ${operationName}`);
    }

    return operation;
  }
}

function schemaRecord(value: unknown): JsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin operation executionPayloadSchema must include an arguments object schema.");
  }

  return value as JsonSchema;
}
