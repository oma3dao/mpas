import { describe, expect, it } from "vitest";
import type { ActionResponse } from "../../src/index.js";
import {
  MPAS_WAIT_TOOL_NAME,
  appendMpasNotice,
  buildApplicationOutputSchema,
  buildBridgeError,
  buildWaitToolDefinition,
  toolResultForRecord,
  validateWaitInput,
} from "../../src/lib/bridge-results.js";
import type { WorkflowRecord } from "../../src/lib/workflow-store.js";

/**
 * Client-facing result objects and the reserved result tool
 * (client profile §3, §5, §6).
 */

const ACTION_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const HASH = "b64url-envelope-digest";

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    actionId: ACTION_ID,
    actionEnvelopeHash: HASH,
    toolName: "merge_pull_request",
    state: "awaitingApprovals",
    actionPackage: {},
    adapterAttempts: [],
    expiresAt: "2026-07-26T19:00:00.000Z",
    createdAt: "2026-07-26T18:00:00.000Z",
    updatedAt: "2026-07-26T18:00:00.000Z",
    ...overrides,
  };
}

function approvalsResponse(): ActionResponse {
  return {
    version: "1",
    type: "ActionResponse",
    result: "additionalApprovalsRequired",
    authorizationRequirements: { version: "1", type: "AuthorizationRequirements" } as ActionResponse["authorizationRequirements"],
    createdAt: "2026-07-26T18:00:00.000Z",
  };
}

describe("toolResultForRecord — deferred (§5.1)", () => {
  it("builds a deferred result carrying the exact lastActionResponse", () => {
    const result = toolResultForRecord(record({ lastActionResponse: approvalsResponse() }), {
      resultRetentionSeconds: 86_400,
      now: () => Date.parse("2026-07-26T18:00:30.000Z"),
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      version: "1",
      type: "MpasBridgeDeferredResult",
      actionRef: {
        type: "ActionRef",
        actionId: { value: ACTION_ID },
        actionEnvelopeHash: { alg: "sha-256", value: HASH },
      },
      lastActionResponse: approvalsResponse(),
      notificationRequired: true,
      expiresAt: "2026-07-26T19:00:00.000Z",
      resultRetentionSeconds: 86_400,
      createdAt: "2026-07-26T18:00:30.000Z",
    });
    // Human-readable content that does not contradict structuredContent.
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("omits lastActionResponse and forces notificationRequired false before any Verifier response", () => {
    const result = toolResultForRecord(record({ state: "created" }), { resultRetentionSeconds: 86_400 });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.type).toBe("MpasBridgeDeferredResult");
    expect("lastActionResponse" in structured).toBe(false);
    expect(structured.notificationRequired).toBe(false);
  });

  it("sets notificationRequired false for pending and when the deployment assigns notification elsewhere", () => {
    const pending = toolResultForRecord(
      record({ lastActionResponse: { version: "1", type: "ActionResponse", result: "pending" } }),
      { resultRetentionSeconds: 86_400 },
    );
    expect((pending.structuredContent as Record<string, unknown>).notificationRequired).toBe(false);

    const assigned = toolResultForRecord(record({ lastActionResponse: approvalsResponse() }), {
      resultRetentionSeconds: 86_400,
      notificationAssignedElsewhere: true,
    });
    expect((assigned.structuredContent as Record<string, unknown>).notificationRequired).toBe(false);
  });
});

describe("toolResultForRecord — terminal (§4.1, §5.2)", () => {
  it("returns the native upstream result verbatim, never wrapped", () => {
    const nativeResult = { content: [{ type: "text", text: "Pull request merged." }] };
    const result = toolResultForRecord(
      record({
        state: "resolved",
        resolvedAt: "2026-07-26T18:10:00.000Z",
        resolution: {
          kind: "resolved",
          actionResponse: { version: "1", type: "ActionResponse", result: "executed", executionResult: nativeResult },
        },
      }),
      { resultRetentionSeconds: 86_400 },
    );

    // Verbatim relay: the native MCP result IS the tool result.
    expect(result).toEqual(nativeResult);
  });

  it("returns MpasBridgeActionOutcome with the exact final ActionResponse when no native result exists", () => {
    const expired: ActionResponse = { version: "1", type: "ActionResponse", result: "expired" };
    const result = toolResultForRecord(
      record({
        state: "resolved",
        resolvedAt: "2026-07-26T19:00:00.000Z",
        resolution: { kind: "resolved", actionResponse: expired },
      }),
      { resultRetentionSeconds: 86_400 },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      version: "1",
      type: "MpasBridgeActionOutcome",
      actionRef: { actionId: { value: ACTION_ID } },
      actionResponse: expired,
      resolvedAt: "2026-07-26T19:00:00.000Z",
    });
  });

  it("returns MpasBridgeError for an unresolvable workflow — a bridge error, not an Action outcome", () => {
    const result = toolResultForRecord(
      record({
        state: "unresolvable",
        resolvedAt: "2026-07-26T19:00:00.000Z",
        resolution: {
          kind: "unresolvable",
          errorCode: "RESULT_UNAVAILABLE",
          errorMessage: "The Action was already dispatched and its result is not retrievable.",
        },
      }),
      { resultRetentionSeconds: 86_400 },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      version: "1",
      type: "MpasBridgeError",
      code: "RESULT_UNAVAILABLE",
      retryable: false,
    });
    expect((result.structuredContent as Record<string, unknown>).type).not.toBe("MpasBridgeActionOutcome");
  });
});

describe("buildBridgeError (§5.3)", () => {
  it("builds a versioned, typed error result with isError true", () => {
    const result = buildBridgeError("ACTION_NOT_FOUND", "No visible Action matches the supplied Action ID.", false);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      version: "1",
      type: "MpasBridgeError",
      code: "ACTION_NOT_FOUND",
      message: "No visible Action matches the supplied Action ID.",
      retryable: false,
    });
  });
});

describe("wait tool definition and input (§3.3–§3.5, §6.1)", () => {
  it("advertises the reserved name, §6.1 schema, and read-only annotations", () => {
    const tool = buildWaitToolDefinition();
    expect(tool.name).toBe(MPAS_WAIT_TOOL_NAME);
    expect(tool.name).toBe("mpas_wait_for_action_result");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["actionId", "timeoutSeconds"],
      properties: {
        actionId: { type: "string", minLength: 1 },
        timeoutSeconds: { type: "integer", minimum: 0, maximum: 300 },
      },
    });
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("accepts a lower advertised maximum", () => {
    const tool = buildWaitToolDefinition({ maxTimeoutSeconds: 30 });
    expect(tool.inputSchema.properties.timeoutSeconds.maximum).toBe(30);
  });

  it("validates input and reports INVALID_WAIT_TIMEOUT / ACTION_NOT_FOUND-shaped failures", () => {
    expect(validateWaitInput({ actionId: ACTION_ID, timeoutSeconds: 30 })).toEqual({
      kind: "ok",
      actionId: ACTION_ID,
      timeoutSeconds: 30,
    });

    expect(validateWaitInput({ actionId: ACTION_ID, timeoutSeconds: 301 })).toMatchObject({
      kind: "error",
      code: "INVALID_WAIT_TIMEOUT",
    });
    expect(validateWaitInput({ actionId: ACTION_ID, timeoutSeconds: 2.5 })).toMatchObject({
      kind: "error",
      code: "INVALID_WAIT_TIMEOUT",
    });
    expect(validateWaitInput({ actionId: "", timeoutSeconds: 0 })).toMatchObject({ kind: "error" });
    expect(validateWaitInput({ timeoutSeconds: 0 })).toMatchObject({ kind: "error" });
  });
});

describe("tool surface helpers (§3.1–§3.2)", () => {
  it("appends the standard MPAS notice to an upstream description", () => {
    const description = appendMpasNotice("Merge a pull request.");
    expect(description).toContain("Merge a pull request.");
    expect(description).toContain("mediated by MPAS");
    expect(description).toContain("mpas_wait_for_action_result");
  });

  it("unions an upstream outputSchema with the three profile objects", () => {
    const upstream = { type: "object", properties: { merged: { type: "boolean" } } };
    const union = buildApplicationOutputSchema(upstream);
    expect(union?.anyOf?.[0]).toEqual(upstream);
    const types = union?.anyOf?.slice(1).map((s: { properties?: { type?: { const?: string } } }) => s.properties?.type?.const);
    expect(types).toEqual(["MpasBridgeDeferredResult", "MpasBridgeActionOutcome", "MpasBridgeError"]);
  });

  it("omits the union when the upstream tool has no outputSchema (§3.2)", () => {
    expect(buildApplicationOutputSchema(undefined)).toBeUndefined();
  });
});
