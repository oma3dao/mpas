import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ExecutionPayload } from "../types/mpas.js";
import { strictJsonParse } from "../utils/strict-json.js";

export interface MpasApplicationPlugin {
  version: "1";
  type: "MpasApplicationPlugin";
  pluginDid: string;
  pluginVersion: string;
  publisherDid: string;
  applicationDid: string;
  executionProfile: {
    id: string;
    format?: string;
    protocolVersion: string;
  };
  credentialRequirements?: Array<{
    type: string;
    expectedAuthority?: string[];
    refreshScope?: string;
    description?: string;
  }>;
  operations: Record<string, MpasOperationDescriptor>;
}

export interface MpasOperationDescriptor {
  description?: string;
  impact?: string;
  executionPayloadSchema: Record<string, unknown>;
}

export interface LoadError {
  kind: "LoadError";
  code: "PLUGIN_READ_FAILED" | "PLUGIN_INVALID_JSON" | "PLUGIN_SCHEMA_INVALID" | "PLUGIN_RESOURCE_EXCEEDED";
  message: string;
  path: string;
  details?: unknown;
}

export type LoadPluginResult =
  | {
      ok: true;
      plugin: MpasApplicationPlugin;
    }
  | {
      ok: false;
      error: LoadError;
    };

export interface OperationMatch {
  operationName: string;
  operation: MpasOperationDescriptor;
}

export interface PayloadValidationError {
  kind: "PayloadValidationError";
  code: "PAYLOAD_NOT_OBJECT" | "UNKNOWN_OPERATION" | "PAYLOAD_SCHEMA_INVALID" | "PAYLOAD_RESOURCE_EXCEEDED";
  message: string;
  path: string;
  details?: unknown;
}

export type PayloadValidationResult =
  | {
      ok: true;
      match: OperationMatch;
    }
  | {
      ok: false;
      error: PayloadValidationError;
    };

const applicationPluginSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: [
    "version",
    "type",
    "pluginDid",
    "pluginVersion",
    "publisherDid",
    "applicationDid",
    "executionProfile",
    "operations",
  ],
  properties: {
    version: { const: "1" },
    type: { const: "MpasApplicationPlugin" },
    pluginDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
    pluginVersion: { type: "string", minLength: 1 },
    publisherDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
    applicationDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
    executionProfile: {
      type: "object",
      required: ["id", "protocolVersion"],
      properties: {
        id: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
        format: { type: "string", minLength: 1 },
        protocolVersion: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    credentialRequirements: {
      type: "array",
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string" },
          expectedAuthority: { type: "array", items: { type: "string" } },
          refreshScope: { type: "string", minLength: 1 },
          description: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    operations: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        required: ["executionPayloadSchema"],
        properties: {
          description: { type: "string" },
          impact: { type: "string" },
          executionPayloadSchema: { type: "object" },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const ajv = new Ajv2020({ strict: false });
const validateApplicationPlugin = ajv.compile(applicationPluginSchema);

/**
 * Resource bounds for the plugin boundary: every plugin document, operation
 * schema, and execution payload is measured against these fixed upper bounds
 * before Ajv compilation or evaluation.
 */
export const PLUGIN_RESOURCE_LIMITS = {
  /** Raw plugin document, UTF-8 bytes. */
  maxPluginDocumentBytes: 262_144,
  /** Complete parsed plugin: containment depth (root value = 0) and total JSON values. */
  maxPluginDocumentDepth: 64,
  maxPluginDocumentNodes: 20_000,
  /** One operation schema: containment depth (schema root = 0). */
  maxOperationSchemaDepth: 32,
  /** All operation schemas together: total JSON values. */
  maxOperationSchemaNodes: 4_096,
  /** One execution payload: UTF-8 bytes (serialized), depth, and total JSON values. */
  maxPayloadBytes: 1_048_576,
  maxPayloadDepth: 64,
  maxPayloadNodes: 100_000,
} as const;

export async function loadPlugin(path: string): Promise<LoadPluginResult> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    return loadError("PLUGIN_READ_FAILED", `Unable to read plugin: ${path}`, path, error);
  }

  if (raw.length > PLUGIN_RESOURCE_LIMITS.maxPluginDocumentBytes) {
    return resourceLoadError(
      "plugin-document-bytes",
      `Plugin document is ${raw.length} bytes; the limit is ${PLUGIN_RESOURCE_LIMITS.maxPluginDocumentBytes}.`,
      path,
      "$",
      raw.length,
      PLUGIN_RESOURCE_LIMITS.maxPluginDocumentBytes,
    );
  }

  let parsed: unknown;
  try {
    parsed = strictJsonParse(raw.toString("utf8"));
  } catch (error) {
    return loadError("PLUGIN_INVALID_JSON", `Plugin is not valid JSON: ${path}`, path, error);
  }

  const documentStructure = measureJsonStructure(
    parsed,
    PLUGIN_RESOURCE_LIMITS.maxPluginDocumentDepth,
    PLUGIN_RESOURCE_LIMITS.maxPluginDocumentNodes,
  );
  if (!documentStructure.ok) {
    const resource = documentStructure.reason === "depth" ? "plugin-document-depth" : documentStructure.reason === "nodes" ? "plugin-document-nodes" : "plugin-document-cycle";
    return resourceLoadError(
      resource,
      `Plugin document ${structureReasonText(documentStructure.reason)}.`,
      path,
      "$",
      documentStructure.reason === "depth" ? PLUGIN_RESOURCE_LIMITS.maxPluginDocumentDepth + 1 : PLUGIN_RESOURCE_LIMITS.maxPluginDocumentNodes + 1,
      documentStructure.reason === "depth" ? PLUGIN_RESOURCE_LIMITS.maxPluginDocumentDepth : PLUGIN_RESOURCE_LIMITS.maxPluginDocumentNodes,
    );
  }

  if (!validateApplicationPlugin(parsed)) {
    return loadError(
      "PLUGIN_SCHEMA_INVALID",
      "Plugin does not conform to the MPAS Application Plugin Profile v0.2.",
      path,
      validateApplicationPlugin.errors,
    );
  }

  const plugin = parsed as unknown as MpasApplicationPlugin;
  const schemasCheck = checkOperationSchemaResources(plugin.operations);
  if (!schemasCheck.ok) {
    return resourceLoadError(schemasCheck.resource, schemasCheck.message, path, schemasCheck.path, schemasCheck.actual, schemasCheck.limit);
  }

  return {
    ok: true,
    plugin,
  };
}

export function validatePayloadAgainstPlugin(
  payload: ExecutionPayload,
  plugin: MpasApplicationPlugin,
): PayloadValidationResult {
  if (!isRecord(payload) || typeof payload.name !== "string") {
    return {
      ok: false,
      error: payloadValidationError(
        "PAYLOAD_NOT_OBJECT",
        "Execution Payload must be an object with a string name field.",
        "$.executionPayload.name",
      ),
    };
  }

  const payloadStructure = measureJsonStructure(
    payload,
    PLUGIN_RESOURCE_LIMITS.maxPayloadDepth,
    PLUGIN_RESOURCE_LIMITS.maxPayloadNodes,
  );
  if (!payloadStructure.ok) {
    return {
      ok: false,
      error: payloadResourceError(
        payloadStructure.reason === "depth"
          ? "payload-depth"
          : payloadStructure.reason === "nodes"
            ? "payload-nodes"
            : "payload-cycle",
        `Execution Payload ${structureReasonText(payloadStructure.reason)}.`,
        "$.executionPayload",
        payloadStructure.reason === "depth"
          ? PLUGIN_RESOURCE_LIMITS.maxPayloadDepth + 1
          : payloadStructure.reason === "nodes"
            ? PLUGIN_RESOURCE_LIMITS.maxPayloadNodes + 1
            : 0,
        payloadStructure.reason === "depth" ? PLUGIN_RESOURCE_LIMITS.maxPayloadDepth : PLUGIN_RESOURCE_LIMITS.maxPayloadNodes,
      ),
    };
  }
  const payloadBytes = measurePayloadBytes(payload);
  if (!payloadBytes.ok) {
    return { ok: false, error: payloadResourceError("payload-unmeasurable", payloadBytes.message, "$.executionPayload", 0, 0) };
  }
  if (payloadBytes.bytes > PLUGIN_RESOURCE_LIMITS.maxPayloadBytes) {
    return {
      ok: false,
      error: payloadResourceError(
        "payload-bytes",
        `Execution Payload serializes to ${payloadBytes.bytes} bytes; the limit is ${PLUGIN_RESOURCE_LIMITS.maxPayloadBytes}.`,
        "$.executionPayload",
        payloadBytes.bytes,
        PLUGIN_RESOURCE_LIMITS.maxPayloadBytes,
      ),
    };
  }

  const operationName = payload.name as string;
  const operation = plugin.operations[operationName];
  if (!operation) {
    return {
      ok: false,
      error: payloadValidationError("UNKNOWN_OPERATION", `Unknown operation: ${operationName}`, "$.executionPayload.name"),
    };
  }

  const compiled = compiledOperationSchema(operation, operationName);
  if (!compiled.ok) {
    return { ok: false, error: compiled.error };
  }
  if (!compiled.validate(payload)) {
    return {
      ok: false,
      error: payloadValidationError(
        "PAYLOAD_SCHEMA_INVALID",
        `Execution Payload failed schema validation for operation: ${operationName}`,
        "$.executionPayload",
        compiled.validate.errors,
      ),
    };
  }

  return {
    ok: true,
    match: {
      operationName,
      operation,
    },
  };
}

type CompiledValidator = ReturnType<typeof ajv.compile>;

type CompiledSchemaResult =
  | { ok: true; validate: CompiledValidator }
  | { ok: false; error: PayloadValidationError };

const compiledSchemaCache = new WeakMap<MpasOperationDescriptor, CompiledSchemaResult>();

function compiledOperationSchema(operation: MpasOperationDescriptor, operationName: string): CompiledSchemaResult {
  const cached = compiledSchemaCache.get(operation);
  if (cached) {
    return cached;
  }

  const result = compileOperationSchema(operation, operationName);
  compiledSchemaCache.set(operation, result);
  return result;
}

function compileOperationSchema(operation: MpasOperationDescriptor, operationName: string): CompiledSchemaResult {
  const schema = operation.executionPayloadSchema;
  const schemaPath = `$.plugin.operations.${operationName}.executionPayloadSchema`;
  const structure = measureJsonStructure(
    schema,
    PLUGIN_RESOURCE_LIMITS.maxOperationSchemaDepth,
    PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes,
  );
  if (!structure.ok) {
    return {
      ok: false,
      error: payloadResourceError(
        structure.reason === "depth" ? "operation-schema-depth" : structure.reason === "nodes" ? "operation-schema-nodes" : "operation-schema-cycle",
        `Operation schema for ${operationName} ${structureReasonText(structure.reason)}.`,
        schemaPath,
        0,
        structure.reason === "depth" ? PLUGIN_RESOURCE_LIMITS.maxOperationSchemaDepth : PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes,
      ),
    };
  }
  let validate: CompiledValidator;
  try {
    validate = ajv.compile(applyFailClosedDefaults(schema) as Record<string, unknown>);
  } catch (error) {
    return {
      ok: false,
      error: payloadValidationError(
        "PAYLOAD_SCHEMA_INVALID",
        `Operation schema for ${operationName} failed to compile.`,
        schemaPath,
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  return { ok: true, validate };
}

/** Keywords whose value is a map of property-name → subschema. */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

/** Keywords whose value is a subschema (or an array of subschemas). */
const SCHEMA_VALUE_KEYWORDS = new Set([
  "items",
  "additionalItems",
  "prefixItems",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "contains",
  "if",
  "then",
  "else",
  "not",
  "allOf",
  "anyOf",
  "oneOf",
]);

/**
 * MCP Execution Profile §5 step 3 (fail-closed): if a plugin schema does not
 * explicitly permit additional properties at a given object level, unknown
 * members at that level MUST cause rejection — even when the schema is silent.
 * This deep-copies the schema, setting `additionalProperties: false` on every
 * object subschema that declares `properties` (or `type: "object"`) without an
 * explicit `additionalProperties` keyword. Schemas that explicitly set
 * `additionalProperties` (true, false, or a subschema) are left untouched.
 * The walk is schema-position aware, so keyword maps (e.g. a property named
 * "properties") are never mistaken for subschemas.
 */
export function applyFailClosedDefaults(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => applyFailClosedDefaults(entry));
  }
  if (!isRecord(schema)) {
    return schema;
  }

  const transformed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, subschema] of Object.entries(value)) {
        mapped[name] = applyFailClosedDefaults(subschema);
      }
      transformed[key] = mapped;
    } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
      transformed[key] = applyFailClosedDefaults(value);
    } else {
      transformed[key] = value;
    }
  }

  const declaresObject = transformed.type === "object" || isRecord(transformed.properties);
  if (declaresObject && !Object.prototype.hasOwnProperty.call(transformed, "additionalProperties")) {
    transformed.additionalProperties = false;
  }

  return transformed;
}

type StructureFailure = "depth" | "nodes" | "cyclic";

type JsonStructureResult = { ok: true; depth: number; nodes: number } | { ok: false; reason: StructureFailure };

/**
 * Iterative JSON-value walk: counts every value (objects, arrays, primitives;
 * keys are not values) and tracks containment depth (root value = 0). True
 * cycles are detected with an active-path set — shared (DAG) references are
 * measured, not mistaken for cycles. Exits as soon as a bound is exceeded.
 */
function measureJsonStructure(root: unknown, maxDepth: number, maxNodes: number): JsonStructureResult {
  let nodes = 0;
  let depth = 0;
  const active = new Set<unknown>();
  type Frame = { kind: "enter"; value: unknown; depth: number } | { kind: "exit"; value: unknown };
  const stack: Frame[] = [{ kind: "enter", value: root, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      continue;
    }
    nodes += 1;
    if (nodes > maxNodes) return { ok: false, reason: "nodes" };
    if (frame.depth > depth) depth = frame.depth;
    if (depth > maxDepth) return { ok: false, reason: "depth" };
    const { value } = frame;
    if (Array.isArray(value)) {
      if (active.has(value)) return { ok: false, reason: "cyclic" };
      active.add(value);
      stack.push({ kind: "exit", value });
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "enter", value: value[index], depth: frame.depth + 1 });
      }
    } else if (isRecord(value)) {
      if (active.has(value)) return { ok: false, reason: "cyclic" };
      active.add(value);
      stack.push({ kind: "exit", value });
      for (const key of Object.keys(value)) {
        stack.push({ kind: "enter", value: value[key], depth: frame.depth + 1 });
      }
    }
  }
  return { ok: true, depth, nodes };
}

function measurePayloadBytes(payload: unknown): { ok: true; bytes: number } | { ok: false; message: string } {
  try {
    return { ok: true, bytes: Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8") };
  } catch (error) {
    return {
      ok: false,
      message: `Execution Payload cannot be measured as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function structureReasonText(reason: StructureFailure): string {
  if (reason === "depth") return "exceeds the depth limit";
  if (reason === "nodes") return "exceeds the node limit";
  return "contains a cyclic reference";
}

type SchemaResourceCheck =
  | { ok: true }
  | { ok: false; resource: string; message: string; path: string; actual: number; limit: number };

/** Plugin-level aggregate bound over all operation schemas (load time). */
function checkOperationSchemaResources(operations: Record<string, MpasOperationDescriptor>): SchemaResourceCheck {
  let totalNodes = 0;
  for (const [name, operation] of Object.entries(operations)) {
    const schemaPath = `$.operations.${name}.executionPayloadSchema`;
    const structure = measureJsonStructure(
      operation.executionPayloadSchema,
      PLUGIN_RESOURCE_LIMITS.maxOperationSchemaDepth,
      PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes,
    );
    if (!structure.ok) {
      return {
        ok: false,
        resource: structure.reason === "depth" ? "operation-schema-depth" : structure.reason === "nodes" ? "operation-schema-nodes" : "operation-schema-cycle",
        message: `Operation schema for ${name} ${structureReasonText(structure.reason)}.`,
        path: schemaPath,
        actual: structure.reason === "depth" ? PLUGIN_RESOURCE_LIMITS.maxOperationSchemaDepth + 1 : PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes + 1,
        limit: structure.reason === "depth" ? PLUGIN_RESOURCE_LIMITS.maxOperationSchemaDepth : PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes,
      };
    }
    totalNodes += structure.nodes;
    if (totalNodes > PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes) {
      return {
        ok: false,
        resource: "operation-schema-nodes",
        message: `Operation schemas together hold more than ${PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes} JSON values.`,
        path: schemaPath,
        actual: totalNodes,
        limit: PLUGIN_RESOURCE_LIMITS.maxOperationSchemaNodes,
      };
    }
  }
  return { ok: true };
}

function loadError(code: LoadError["code"], message: string, path: string, details?: unknown): LoadPluginResult {
  return {
    ok: false,
    error: {
      kind: "LoadError",
      code,
      message,
      path,
      details,
    },
  };
}

function resourceLoadError(
  resource: string,
  message: string,
  path: string,
  jsonPath: string,
  actual: number,
  limit: number,
): LoadPluginResult {
  return loadError("PLUGIN_RESOURCE_EXCEEDED", message, path, { resource, path: jsonPath, actual, limit });
}

function payloadValidationError(
  code: PayloadValidationError["code"],
  message: string,
  path: string,
  details?: unknown,
): PayloadValidationError {
  return {
    kind: "PayloadValidationError",
    code,
    message,
    path,
    details,
  };
}

function payloadResourceError(
  resource: string,
  message: string,
  path: string,
  actual: number,
  limit: number,
): PayloadValidationError {
  return payloadValidationError("PAYLOAD_RESOURCE_EXCEEDED", message, path, { resource, actual, limit });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
