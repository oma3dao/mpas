import type { ActionResponse } from "../types/mpas.js";
import type { BridgeUpstreamTool } from "./bridge-runtime.js";
import type { WorkflowRecord } from "./workflow-store.js";

/** Temporary MCP compatibility surface for clients without MCP Tasks. */

export const MPAS_WAIT_TOOL_NAME = "mpas_wait_for_action_result";
export const MPAS_COMPATIBILITY_INTERFACE_VERSION = "1";

export class ReservedCompatibilityToolCollisionError extends Error {
  constructor() {
    super(`Upstream tool surface contains reserved compatibility tool name: ${MPAS_WAIT_TOOL_NAME}`);
    this.name = "ReservedCompatibilityToolCollisionError";
  }
}

export interface CompatibilityToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface CompatibilityActionRef {
  version: "1";
  type: "ActionRef";
  actionId: { value: string };
  actionEnvelopeHash: { alg: "sha-256"; value: string };
}

export interface CompatibilityResultOptions {
  resultRetentionSeconds: number;
  notificationAssignedElsewhere?: boolean;
  now?: () => number;
}

export function compatibilityResultForRecord(
  record: WorkflowRecord,
  options: CompatibilityResultOptions,
): CompatibilityToolResult {
  if (record.state === "cancelled") {
    return buildCompatibilityError("ACTION_CANCELLED", "The MPAS Action was cancelled.", false);
  }

  if (record.state === "unresolvable") {
    const resolution = record.resolution;
    if (resolution?.kind !== "unresolvable") {
      return buildCompatibilityError(
        "BRIDGE_UNAVAILABLE",
        "The bridge holds an inconsistent record for this Action.",
        true,
      );
    }
    return buildCompatibilityError(resolution.errorCode, resolution.errorMessage, false);
  }

  if (record.state === "resolved") {
    const resolution = record.resolution;
    if (resolution?.kind !== "resolved") {
      return buildCompatibilityError(
        "BRIDGE_UNAVAILABLE",
        "The bridge holds an inconsistent record for this Action.",
        true,
      );
    }
    const actionResponse = resolution.actionResponse as ActionResponse;
    if (actionResponse.executionResult !== undefined) {
      return actionResponse.executionResult as CompatibilityToolResult;
    }
    return {
      content: [
        {
          type: "text",
          text: `MPAS Action ${record.actionId} ended with result "${actionResponse.result}" and produced no native application result.`,
        },
      ],
      structuredContent: {
        version: MPAS_COMPATIBILITY_INTERFACE_VERSION,
        type: "MpasBridgeActionOutcome",
        taskId: record.taskId,
        actionRef: compatibilityActionRef(record),
        actionResponse: actionResponse as unknown as Record<string, unknown>,
        resolvedAt: record.resolvedAt,
      },
      isError: true,
    };
  }

  return buildDeferredCompatibilityResult(record, options);
}

export function buildCompatibilityError(
  code: string,
  message: string,
  retryable: boolean,
): CompatibilityToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: {
      version: MPAS_COMPATIBILITY_INTERFACE_VERSION,
      type: "MpasBridgeError",
      code,
      message,
      retryable,
    },
    isError: true,
  };
}

function buildDeferredCompatibilityResult(
  record: WorkflowRecord,
  options: CompatibilityResultOptions,
): CompatibilityToolResult {
  const now = options.now ?? (() => Date.now());
  const storedResponse = record.lastActionResponse as ActionResponse | undefined;
  const lastActionResponse =
    (record.state === "submittingToCoordination" || record.state === "awaitingApprovals") &&
    storedResponse?.result === "additionalApprovalsRequired"
      ? storedResponse
      : record.state === "awaitingVerifierResult" && storedResponse?.result === "pending"
        ? storedResponse
        : undefined;
  const notificationRequired =
    lastActionResponse?.result === "additionalApprovalsRequired" &&
    options.notificationAssignedElsewhere !== true;

  const structuredContent: Record<string, unknown> = {
    version: MPAS_COMPATIBILITY_INTERFACE_VERSION,
    type: "MpasBridgeDeferredResult",
    taskId: record.taskId,
    actionRef: compatibilityActionRef(record),
    ...(lastActionResponse !== undefined ? { lastActionResponse } : {}),
    notificationRequired,
    expiresAt: record.expiresAt,
    resultRetentionSeconds: options.resultRetentionSeconds,
    createdAt: new Date(now()).toISOString(),
  };

  const text =
    lastActionResponse?.result === "additionalApprovalsRequired"
      ? `Additional MPAS approvals are required. Action ${record.actionId} remains active.`
      : `MPAS Task ${record.taskId} remains active on Action ${record.actionId}. Use ${MPAS_WAIT_TOOL_NAME} to retrieve the result.`;

  return { content: [{ type: "text", text }], structuredContent };
}

function compatibilityActionRef(record: WorkflowRecord): CompatibilityActionRef {
  return {
    version: "1",
    type: "ActionRef",
    actionId: { value: record.actionId },
    actionEnvelopeHash: { alg: "sha-256", value: record.actionEnvelopeHash },
  };
}

export interface CompatibilityWaitToolDefinition {
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

export function buildCompatibilityWaitToolDefinition(
  options: { maxTimeoutSeconds?: number } = {},
): CompatibilityWaitToolDefinition {
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

export type CompatibilityWaitInputValidation =
  | { kind: "ok"; actionId: string; timeoutSeconds: number }
  | { kind: "error"; code: "INVALID_WAIT_TOOL_INPUT" | "INVALID_WAIT_TIMEOUT"; message: string };

export function validateCompatibilityWaitInput(
  args: unknown,
  options: { maxTimeoutSeconds?: number } = {},
): CompatibilityWaitInputValidation {
  const maximum = options.maxTimeoutSeconds ?? 300;
  const input = (args ?? {}) as Record<string, unknown>;

  if (typeof input.actionId !== "string" || input.actionId.length < 1) {
    return {
      kind: "error",
      code: "INVALID_WAIT_TOOL_INPUT",
      message: "actionId must be a non-empty string.",
    };
  }
  const timeoutSeconds = input.timeoutSeconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 0 ||
    timeoutSeconds > maximum
  ) {
    return {
      kind: "error",
      code: "INVALID_WAIT_TIMEOUT",
      message: `timeoutSeconds must be an integer between 0 and ${maximum}.`,
    };
  }
  return { kind: "ok", actionId: input.actionId, timeoutSeconds };
}

const MPAS_COMPATIBILITY_NOTICE =
  "This tool is mediated by MPAS and may return a deferred Action reference. " +
  `Use ${MPAS_WAIT_TOOL_NAME} to retrieve an asynchronous result.`;

export function appendCompatibilityNotice(upstreamDescription: string | undefined): string {
  return upstreamDescription
    ? `${upstreamDescription}\n\n${MPAS_COMPATIBILITY_NOTICE}`
    : MPAS_COMPATIBILITY_NOTICE;
}

interface JsonSchemaObject {
  [key: string]: unknown;
  anyOf?: JsonSchemaObject[];
}

function compatibilityObjectSchema(type: string): JsonSchemaObject {
  return {
    type: "object",
    required: ["version", "type"],
    properties: {
      version: { const: MPAS_COMPATIBILITY_INTERFACE_VERSION },
      type: { const: type },
    },
    additionalProperties: true,
  };
}

export function buildCompatibilityOutputSchema(
  upstreamSchema: JsonSchemaObject | undefined,
): JsonSchemaObject | undefined {
  if (upstreamSchema === undefined) return undefined;
  return {
    anyOf: [
      upstreamSchema,
      compatibilityObjectSchema("MpasBridgeDeferredResult"),
      compatibilityObjectSchema("MpasBridgeActionOutcome"),
      compatibilityObjectSchema("MpasBridgeError"),
    ],
  };
}

export function buildCompatibilityToolDefinitions(
  upstreamTools: BridgeUpstreamTool[],
  options: { maxTimeoutSeconds?: number } = {},
): BridgeUpstreamTool[] {
  if (upstreamTools.some((tool) => tool.name === MPAS_WAIT_TOOL_NAME)) {
    throw new ReservedCompatibilityToolCollisionError();
  }
  const applicationTools = upstreamTools.map((tool) => {
      const outputSchema = buildCompatibilityOutputSchema(tool.outputSchema);
      return {
        ...structuredClone(tool),
        description: appendCompatibilityNotice(tool.description),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
      };
    });
  return [
    ...applicationTools,
    buildCompatibilityWaitToolDefinition(options) as unknown as BridgeUpstreamTool,
  ];
}
