import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ExecutionPayload } from "../types/mpas.js";

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
  };
  credentialRequirements?: Array<{
    type: string;
    requiredCapabilities?: string[];
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
  code: "PLUGIN_READ_FAILED" | "PLUGIN_INVALID_JSON" | "PLUGIN_SCHEMA_INVALID";
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
  code: "PAYLOAD_NOT_OBJECT" | "UNKNOWN_OPERATION" | "PAYLOAD_SCHEMA_INVALID";
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
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
        format: { type: "string", minLength: 1 },
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
          requiredCapabilities: { type: "array", items: { type: "string" } },
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

export async function loadPlugin(path: string): Promise<LoadPluginResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return loadError("PLUGIN_READ_FAILED", `Unable to read plugin: ${path}`, path, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return loadError("PLUGIN_INVALID_JSON", `Plugin is not valid JSON: ${path}`, path, error);
  }

  if (!validateApplicationPlugin(parsed)) {
    return loadError(
      "PLUGIN_SCHEMA_INVALID",
      "Plugin does not conform to the MPAS Application Plugin Profile v0.2.",
      path,
      validateApplicationPlugin.errors,
    );
  }

  return {
    ok: true,
    plugin: parsed as unknown as MpasApplicationPlugin,
  };
}

export function validatePayloadAgainstPlugin(
  payload: ExecutionPayload,
  plugin: MpasApplicationPlugin,
): PayloadValidationResult {
  if (!isRecord(payload) || typeof payload.name !== "string") {
    return payloadValidationError(
      "PAYLOAD_NOT_OBJECT",
      "Execution Payload must be an object with a string name field.",
      "$.executionPayload.name",
    );
  }

  const operationName = payload.name as string;
  const operation = plugin.operations[operationName];
  if (!operation) {
    return payloadValidationError("UNKNOWN_OPERATION", `Unknown operation: ${operationName}`, "$.executionPayload.name");
  }

  const validate = compiledOperationSchema(operation);
  if (!validate(payload)) {
    return payloadValidationError(
      "PAYLOAD_SCHEMA_INVALID",
      `Execution Payload failed schema validation for operation: ${operationName}`,
      "$.executionPayload",
      validate.errors,
    );
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

const compiledSchemaCache = new WeakMap<MpasOperationDescriptor, CompiledValidator>();

function compiledOperationSchema(operation: MpasOperationDescriptor): CompiledValidator {
  const cached = compiledSchemaCache.get(operation);
  if (cached) {
    return cached;
  }

  const validate = ajv.compile(applyFailClosedDefaults(operation.executionPayloadSchema) as Record<string, unknown>);
  compiledSchemaCache.set(operation, validate);
  return validate;
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

function payloadValidationError(
  code: PayloadValidationError["code"],
  message: string,
  path: string,
  details?: unknown,
): PayloadValidationResult {
  return {
    ok: false,
    error: {
      kind: "PayloadValidationError",
      code,
      message,
      path,
      details,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
