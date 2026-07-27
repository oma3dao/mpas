import type { ActionResponse } from "../types/mpas.js";
import type { WorkflowRecord } from "./workflow-store.js";

/**
 * Client-facing result objects and the reserved result tool for MPAS MCP
 * proposer bridges (MPAS MCP Proposer Bridge Client Interface Profile v0.1).
 *
 * A tool result from the bridge carries one of four payloads (profile §5):
 * the native upstream result verbatim, `MpasBridgeDeferredResult`,
 * `MpasBridgeActionOutcome`, or `MpasBridgeError`.
 */

export const MPAS_WAIT_TOOL_NAME = "mpas_wait_for_action_result";

export const MPAS_INTERFACE_VERSION = "1";

/** Minimal MCP tool-result shape produced by this module. */
export interface BridgeToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface BridgeActionRef {
  version: "1";
  type: "ActionRef";
  actionId: { value: string };
  actionEnvelopeHash: { alg: "sha-256"; value: string };
}

export interface BridgeResultOptions {
  /** Minimum post-resolution retention disclosed to the client (profile §7.4). */
  resultRetentionSeconds: number;
  /** Deployment assigns maintainer notification to the bridge or another component. */
  notificationAssignedElsewhere?: boolean;
  now?: () => number;
}

/**
 * Map a workflow record to the client-visible tool result (profile §4–§5):
 *
 * - active → `MpasBridgeDeferredResult` (with `lastActionResponse` only when
 *   a Verifier response exists);
 * - resolved with a native `executionResult` → that native result, verbatim;
 * - resolved without one → `MpasBridgeActionOutcome` with the exact final
 *   `ActionResponse`;
 * - unresolvable → `MpasBridgeError`.
 */
export function toolResultForRecord(record: WorkflowRecord, options: BridgeResultOptions): BridgeToolResult {
  if (record.state === "unresolvable") {
    const resolution = record.resolution;
    if (resolution?.kind !== "unresolvable") {
      return buildBridgeError("BRIDGE_UNAVAILABLE", "The bridge holds an inconsistent record for this Action.", true);
    }
    return buildBridgeError(resolution.errorCode, resolution.errorMessage, false);
  }

  if (record.state === "resolved") {
    const resolution = record.resolution;
    if (resolution?.kind !== "resolved") {
      return buildBridgeError("BRIDGE_UNAVAILABLE", "The bridge holds an inconsistent record for this Action.", true);
    }
    const actionResponse = resolution.actionResponse as ActionResponse;
    if (actionResponse.executionResult !== undefined) {
      // Native upstream MCP result, verbatim — never wrapped (profile §4.1, §6.2).
      return actionResponse.executionResult as BridgeToolResult;
    }
    return {
      content: [
        {
          type: "text",
          text: `MPAS Action ${record.actionId} ended with result "${actionResponse.result}" and produced no native application result.`,
        },
      ],
      structuredContent: {
        version: MPAS_INTERFACE_VERSION,
        type: "MpasBridgeActionOutcome",
        actionRef: actionRef(record),
        actionResponse: actionResponse as unknown as Record<string, unknown>,
        resolvedAt: record.resolvedAt,
      },
      isError: true,
    };
  }

  return deferredResult(record, options);
}

/** Standalone `MpasBridgeError` tool result (profile §5.3). */
export function buildBridgeError(code: string, message: string, retryable: boolean): BridgeToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: {
      version: MPAS_INTERFACE_VERSION,
      type: "MpasBridgeError",
      code,
      message,
      retryable,
    },
    isError: true,
  };
}

function deferredResult(record: WorkflowRecord, options: BridgeResultOptions): BridgeToolResult {
  const now = options.now ?? (() => Date.now());
  const lastActionResponse = record.lastActionResponse as ActionResponse | undefined;

  // notificationRequired rules (profile §5.1): meaningful only alongside a
  // Verifier response; true only for additionalApprovalsRequired when the
  // deployment leaves notification to the client.
  const notificationRequired =
    lastActionResponse?.result === "additionalApprovalsRequired" && options.notificationAssignedElsewhere !== true;

  const structuredContent: Record<string, unknown> = {
    version: MPAS_INTERFACE_VERSION,
    type: "MpasBridgeDeferredResult",
    actionRef: actionRef(record),
    ...(lastActionResponse !== undefined ? { lastActionResponse } : {}),
    notificationRequired,
    expiresAt: record.expiresAt,
    resultRetentionSeconds: options.resultRetentionSeconds,
    createdAt: new Date(now()).toISOString(),
  };

  const text =
    lastActionResponse?.result === "additionalApprovalsRequired"
      ? `Additional MPAS approvals are required. Action ${record.actionId} remains active.`
      : `MPAS Action ${record.actionId} remains active. Use ${MPAS_WAIT_TOOL_NAME} to retrieve the result.`;

  return { content: [{ type: "text", text }], structuredContent };
}

function actionRef(record: WorkflowRecord): BridgeActionRef {
  return {
    version: "1",
    type: "ActionRef",
    actionId: { value: record.actionId },
    actionEnvelopeHash: { alg: "sha-256", value: record.actionEnvelopeHash },
  };
}

// ---------------------------------------------------------------------------
// Reserved result tool (profile §3.3–§3.5, §6.1)
// ---------------------------------------------------------------------------

export interface WaitToolDefinition {
  name: typeof MPAS_WAIT_TOOL_NAME;
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    required: ["actionId", "timeoutSeconds"];
    properties: {
      actionId: { type: "string"; minLength: 1; description: string };
      timeoutSeconds: { type: "integer"; minimum: 0; maximum: number; description: string };
    };
  };
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  };
}

export function buildWaitToolDefinition(options: { maxTimeoutSeconds?: number } = {}): WaitToolDefinition {
  const maximum = options.maxTimeoutSeconds ?? 300;
  return {
    name: MPAS_WAIT_TOOL_NAME,
    description:
      "Wait for or check the result of an MPAS Action previously returned by this bridge. " +
      "Observes the Action only; it never proposes, advances, or cancels one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["actionId", "timeoutSeconds"],
      properties: {
        actionId: {
          type: "string",
          minLength: 1,
          description: "The actionRef.actionId.value string returned by an MPAS bridge result.",
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 0,
          maximum,
          description: "Maximum number of seconds to wait in this call. 0 performs a nonblocking check.",
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export type WaitInputValidation =
  | { kind: "ok"; actionId: string; timeoutSeconds: number }
  | { kind: "error"; code: "INVALID_WAIT_TOOL_INPUT" | "INVALID_WAIT_TIMEOUT"; message: string };

export function validateWaitInput(args: unknown, options: { maxTimeoutSeconds?: number } = {}): WaitInputValidation {
  const maximum = options.maxTimeoutSeconds ?? 300;
  const input = (args ?? {}) as Record<string, unknown>;

  if (typeof input.actionId !== "string" || input.actionId.length < 1) {
    return { kind: "error", code: "INVALID_WAIT_TOOL_INPUT", message: "actionId must be a non-empty string." };
  }
  const timeoutSeconds = input.timeoutSeconds;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > maximum) {
    return {
      kind: "error",
      code: "INVALID_WAIT_TIMEOUT",
      message: `timeoutSeconds must be an integer between 0 and ${maximum}.`,
    };
  }
  return { kind: "ok", actionId: input.actionId, timeoutSeconds };
}

// ---------------------------------------------------------------------------
// Application tool surface helpers (profile §3.1–§3.2)
// ---------------------------------------------------------------------------

const MPAS_NOTICE =
  "This tool is mediated by MPAS and may return a deferred Action reference. " +
  `Use ${MPAS_WAIT_TOOL_NAME} to retrieve an asynchronous result.`;

/** Preserve the upstream description and append the standard MPAS notice. */
export function appendMpasNotice(upstreamDescription: string | undefined): string {
  return upstreamDescription ? `${upstreamDescription}\n\n${MPAS_NOTICE}` : MPAS_NOTICE;
}

interface JsonSchemaObject {
  [key: string]: unknown;
  anyOf?: JsonSchemaObject[];
  properties?: Record<string, JsonSchemaObject>;
}

function profileObjectSchema(type: string): JsonSchemaObject {
  return {
    type: "object",
    required: ["version", "type"],
    properties: {
      version: { const: MPAS_INTERFACE_VERSION },
      type: { const: type },
    },
    additionalProperties: true,
  };
}

/**
 * Deterministic `anyOf` union for an application tool's outputSchema
 * (profile §3.2): the upstream schema, preserved as the first branch, plus
 * the three profile-defined objects. Returns undefined when the upstream tool
 * has no outputSchema — the union MUST be omitted rather than advertising
 * only profile branches.
 */
export function buildApplicationOutputSchema(upstreamSchema: JsonSchemaObject | undefined): JsonSchemaObject | undefined {
  if (upstreamSchema === undefined) {
    return undefined;
  }
  return {
    anyOf: [
      upstreamSchema,
      profileObjectSchema("MpasBridgeDeferredResult"),
      profileObjectSchema("MpasBridgeActionOutcome"),
      profileObjectSchema("MpasBridgeError"),
    ],
  };
}
