/**
 * MCP Execution Profile payload structure validation (mpas-profile-mcp.md §3.1, §5 step 1).
 *
 * An Execution Payload under `mcp.toolsCall` MUST be a JSON object with exactly
 * two members: `name` (string) and `arguments` (object). Any other shape MUST be
 * rejected as malformed. This check is profile-structural and requires no
 * knowledge of the target's tool list, so it applies to every payload —
 * including operations routed as pass-through.
 */

export interface McpPayloadStructureError {
  kind: "PayloadStructureError";
  code: "PAYLOAD_STRUCTURE_INVALID";
  message: string;
  path: string;
}

export type McpPayloadStructureResult =
  | {
      ok: true;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      ok: false;
      error: McpPayloadStructureError;
    };

export function validateMcpPayloadStructure(payload: unknown): McpPayloadStructureResult {
  if (!isRecord(payload)) {
    return structureError("Execution Payload must be a JSON object.", "$.executionPayload");
  }

  const keys = Object.keys(payload);
  const extraKeys = keys.filter((key) => key !== "name" && key !== "arguments");
  if (extraKeys.length > 0) {
    return structureError(
      `Execution Payload must contain exactly "name" and "arguments"; unexpected member(s): ${extraKeys.join(", ")}.`,
      "$.executionPayload",
    );
  }

  if (typeof payload.name !== "string" || payload.name.length === 0) {
    return structureError("Execution Payload name must be a non-empty string.", "$.executionPayload.name");
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "arguments")) {
    return structureError(
      'Execution Payload must include "arguments" (an empty object for tools that take no arguments).',
      "$.executionPayload.arguments",
    );
  }

  if (!isRecord(payload.arguments)) {
    return structureError("Execution Payload arguments must be a JSON object.", "$.executionPayload.arguments");
  }

  return {
    ok: true,
    name: payload.name,
    arguments: payload.arguments,
  };
}

function structureError(message: string, path: string): McpPayloadStructureResult {
  return {
    ok: false,
    error: {
      kind: "PayloadStructureError",
      code: "PAYLOAD_STRUCTURE_INVALID",
      message,
      path,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
