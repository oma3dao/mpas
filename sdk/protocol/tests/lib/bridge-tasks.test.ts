import { describe, expect, it } from "vitest";
import type { ActionPackage, Did } from "../../src/index.js";
import {
  buildCancelTaskResult,
  buildCreateTaskResult,
  buildGetTaskResult,
  buildUpdateTaskResult,
} from "../../src/lib/bridge-tasks.js";
import { CreateTaskResultSchema, GetTaskResultSchema } from "../../src/lib/mcp-tasks-extension.js";
import type { WorkflowRecord } from "../../src/lib/workflow-store.js";

const ACTION_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const PROPOSER_DID = "did:jwk:proposer" as Did;
const CREATED_AT = "2026-08-14T10:00:00.000Z";
const EXPIRES_AT = "2026-08-14T10:30:00.000Z";
const RESOLVED_AT = "2026-08-14T10:10:00.000Z";
const CONFIG = { resultRetentionSeconds: 86_400, taskPollIntervalMs: 2_500 };

describe("official MCP Task result builders", () => {
  it("builds a flat working Task with metadata from the stored Action Package", () => {
    const record = workflow();
    const storedDigest = record.actionEnvelopeHash;

    const result = buildCreateTaskResult(record, CONFIG);

    expect(CreateTaskResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      resultType: "task",
      taskId: ACTION_ID,
      status: "working",
      ttlMs: 1_800_000,
      pollIntervalMs: 2_500,
      _meta: {
        "org.oma3/mpas": {
          version: "1",
          actionId: ACTION_ID,
          actionEnvelopeHash: { alg: "sha-256", value: "signed-envelope-digest" },
          authorizationState: "submitted",
          disclosure: "transparent",
        },
      },
    });
    expect(record.actionEnvelopeHash).toBe(storedDigest);
    expect(typeof record.actionEnvelopeHash).toBe("string");
  });

  it("includes transparent approval requirements without approval counts", () => {
    const requirements = {
      anyOf: [{ type: "threshold" as const, threshold: 2, eligibleSigners: [PROPOSER_DID] }],
    };
    const record = workflow({
      state: "awaitingApprovals",
      authorizationRequirements: {
        version: "1",
        type: "AuthorizationRequirements",
        approvalRequirements: requirements,
      },
    });

    const result = buildGetTaskResult(record, CONFIG);

    expect(result).toMatchObject({
      status: "working",
      _meta: {
        "org.oma3/mpas": {
          authorizationState: "authorization_required",
          requirements,
        },
      },
    });
    expect(result._meta?.["org.oma3/mpas"]).not.toHaveProperty("approvalCount");
  });

  it("passes through the native CallToolResult and extends terminal TTL to retention", () => {
    const nativeResult = { content: [{ type: "text", text: "merged" }], isError: false };
    const record = workflow({
      state: "resolved",
      updatedAt: RESOLVED_AT,
      resolvedAt: RESOLVED_AT,
      resolution: {
        kind: "resolved",
        actionResponse: {
          version: "1",
          type: "ActionResponse",
          result: "executed",
          executionResult: nativeResult,
        },
      },
    });

    const result = buildGetTaskResult(record, CONFIG);

    expect(GetTaskResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      resultType: "complete",
      status: "completed",
      ttlMs: 87_000_000,
      result: nativeResult,
    });
    expect(result).not.toHaveProperty("_meta");
  });

  it("maps a terminal MPAS rejection to a completed tool-level error", () => {
    const result = buildGetTaskResult(
      workflow({
        state: "resolved",
        resolvedAt: RESOLVED_AT,
        resolution: {
          kind: "resolved",
          actionResponse: {
            version: "1",
            type: "ActionResponse",
            result: "rejected",
            error: { code: "POLICY_DENIED", message: "Denied by policy." },
          },
        },
      }),
      CONFIG,
    );

    expect(result).toMatchObject({
      status: "completed",
      result: {
        isError: true,
        structuredContent: { type: "ActionResponse", result: "rejected" },
      },
    });
  });

  it("maps an unresolvable workflow to a completed MPAS task error", () => {
    const result = buildGetTaskResult(
      workflow({
        state: "unresolvable",
        resolvedAt: RESOLVED_AT,
        resolution: {
          kind: "unresolvable",
          errorCode: "RESULT_UNAVAILABLE",
          errorMessage: "The authoritative result is unavailable.",
        },
      }),
      CONFIG,
    );

    expect(result).toMatchObject({
      status: "completed",
      result: {
        isError: true,
        structuredContent: { type: "MpasTaskError", code: "RESULT_UNAVAILABLE" },
      },
    });
  });

  it("builds a cancelled Task without result, error, or MPAS metadata", () => {
    const result = buildGetTaskResult(
      workflow({
        state: "cancelled",
        resolvedAt: RESOLVED_AT,
        resolution: { kind: "cancelled", cancelledAt: RESOLVED_AT },
      }),
      CONFIG,
    );

    expect(result).toMatchObject({ resultType: "complete", status: "cancelled" });
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("error");
    expect(result).not.toHaveProperty("_meta");
  });

  it("builds empty update and cancellation acknowledgements", () => {
    expect(buildUpdateTaskResult()).toEqual({ resultType: "complete" });
    expect(buildCancelTaskResult()).toEqual({ resultType: "complete" });
  });
});

function workflow(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    actionId: ACTION_ID,
    actionEnvelopeHash: "signed-envelope-digest",
    toolName: "merge_pull_request",
    state: "created",
    actionPackage: actionPackage(),
    adapterAttempts: [],
    expiresAt: EXPIRES_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function actionPackage(): ActionPackage {
  return {
    version: "1",
    type: "ActionPackage",
    executionPayload: { name: "merge_pull_request", arguments: {} } as unknown as ActionPackage["executionPayload"],
    actionEnvelope: {
      version: "1",
      type: "ActionEnvelope",
      proposer: { did: PROPOSER_DID },
      target: { applicationDid: "did:web:example.com" as Did },
      executionProfile: { id: "did:web:example.com:profiles:mcp" as Did, format: "mcp.toolsCall" },
      executionPayloadHash: { alg: "sha-256", value: "payload-digest" },
      actionId: { value: ACTION_ID },
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    },
    approvalBundle: {
      version: "1",
      type: "ApprovalBundle",
      actionEnvelopeHash: { alg: "sha-256", value: "signed-envelope-digest" },
      approvals: [],
    },
  };
}
