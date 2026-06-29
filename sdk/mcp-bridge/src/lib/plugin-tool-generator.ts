import type { JsonSchema, McpToolDefinition, MpasApplicationPlugin, PluginOperation } from "../index.js";

export class PluginToolGenerator {
  constructor(private readonly plugin: MpasApplicationPlugin) {
    if (!Array.isArray(plugin.operations) || plugin.operations.length === 0) {
      throw new Error("MPAS application plugin must define at least one operation.");
    }
  }

  generateTools(): McpToolDefinition[] {
    return this.plugin.operations.map((operation) => ({
      name: operation.name,
      description: operation.description,
      inputSchema: this.getInputSchema(operation.name),
    }));
  }

  getInputSchema(operationName: string): JsonSchema {
    const operation = this.requiredOperation(operationName);
    const properties = schemaRecord(operation.executionPayloadSchema.properties);
    const argumentsSchema = schemaRecord(properties.arguments);

    return argumentsSchema;
  }

  getOperation(operationName: string): PluginOperation | undefined {
    return this.plugin.operations.find((operation) => operation.name === operationName);
  }

  private requiredOperation(operationName: string): PluginOperation {
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
