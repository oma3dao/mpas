import type { ActionResponse } from "../types/mpas.js";
import {
  MPAS_MCP_PROFILE_EXTENSION_ID,
  type CancelTaskResult,
  type CompleteToolCallResult,
  type CreateTaskResult,
  type GetTaskResult,
  type Task,
  type UpdateTaskResult,
} from "./mcp-tasks-extension.js";
import { buildMpasTaskMeta } from "./mpas-task-meta.js";
import { TERMINAL_WORKFLOW_STATES, type WorkflowRecord } from "./workflow-store.js";

export interface TaskResultConfig {
  resultRetentionSeconds: number;
  taskPollIntervalMs?: number;
}

export function buildCreateTaskResult(record: WorkflowRecord, config: TaskResultConfig): CreateTaskResult {
  return { resultType: "task", ...taskSummary(record, config) };
}

/** Return a normal tools/call result when the initial Action settles quickly. */
export function buildCompleteToolCallResult(record: WorkflowRecord): CompleteToolCallResult {
  if (record.state !== "resolved") {
    throw new Error(`Workflow ${record.taskId} has no synchronous tool result.`);
  }
  return { ...resolvedResult(record), resultType: "complete" } as CompleteToolCallResult;
}

export function buildGetTaskResult(record: WorkflowRecord, config: TaskResultConfig): GetTaskResult {
  const task = taskSummary(record, config);
  if (record.state === "cancelled") {
    return { resultType: "complete", ...task, status: "cancelled" };
  }
  if (record.state === "resolved") {
    return { resultType: "complete", ...task, status: "completed", result: resolvedResult(record) };
  }
  if (record.state === "unresolvable") {
    return { resultType: "complete", ...task, status: "completed", result: unresolvableResult(record) };
  }
  return { resultType: "complete", ...task, status: "working" };
}

export function buildUpdateTaskResult(): UpdateTaskResult {
  return { resultType: "complete" };
}

export function buildCancelTaskResult(): CancelTaskResult {
  return { resultType: "complete" };
}

function taskSummary(record: WorkflowRecord, config: TaskResultConfig): Task {
  const status = TERMINAL_WORKFLOW_STATES.has(record.state)
    ? record.state === "cancelled"
      ? "cancelled"
      : "completed"
    : "working";
  return {
    taskId: record.taskId,
    status,
    ...(statusMessage(record) !== undefined ? { statusMessage: statusMessage(record) } : {}),
    createdAt: record.createdAt,
    lastUpdatedAt: record.updatedAt,
    ttlMs: ttlMs(record, config.resultRetentionSeconds),
    pollIntervalMs: config.taskPollIntervalMs ?? 5_000,
    ...(status === "working" ? { _meta: { [MPAS_MCP_PROFILE_EXTENSION_ID]: buildMpasTaskMeta(record) } } : {}),
  };
}

function statusMessage(record: WorkflowRecord): string | undefined {
  switch (record.state) {
    case "created":
      return "Submitting the MPAS Action.";
    case "awaitingApprovals":
    case "submittingToCoordination":
      return "Awaiting MPAS authorization.";
    case "readyForSubmission":
    case "submittingToVerifier":
      return "MPAS approvals collected; submitting for execution.";
    case "awaitingVerifierResult":
      return "Awaiting the MPAS Verifier result.";
    case "cancelled":
      return "The MPAS task was cancelled.";
    case "unresolvable":
      return record.resolution?.kind === "unresolvable" ? record.resolution.errorMessage : "The MPAS task could not be resolved.";
    case "resolved": {
      const response = resolvedActionResponse(record);
      return response.result === "executed" ? undefined : `MPAS ended the Action with result ${response.result}.`;
    }
  }
}

function resolvedResult(record: WorkflowRecord): Record<string, unknown> {
  const response = resolvedActionResponse(record);
  if (response.executionResult !== undefined) {
    if (typeof response.executionResult !== "object" || response.executionResult === null || Array.isArray(response.executionResult)) {
      return toolError("MPAS returned an invalid native application result.", response);
    }
    return structuredClone(response.executionResult) as Record<string, unknown>;
  }
  return toolError(`MPAS Action ended with result ${response.result} and produced no native application result.`, response);
}

function unresolvableResult(record: WorkflowRecord): Record<string, unknown> {
  const resolution = record.resolution;
  if (resolution?.kind !== "unresolvable") {
    return toolError("The bridge holds an inconsistent terminal workflow record.");
  }
  return {
    content: [{ type: "text", text: resolution.errorMessage }],
    structuredContent: {
      version: "1",
      type: "MpasTaskError",
      code: resolution.errorCode,
      message: resolution.errorMessage,
    },
    isError: true,
  };
}

function toolError(message: string, actionResponse?: ActionResponse): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    ...(actionResponse !== undefined ? { structuredContent: structuredClone(actionResponse) } : {}),
    isError: true,
  };
}

function resolvedActionResponse(record: WorkflowRecord): ActionResponse {
  const resolution = record.resolution;
  if (resolution?.kind !== "resolved") {
    throw new Error(`Workflow ${record.taskId} has an inconsistent resolved state.`);
  }
  return resolution.actionResponse as ActionResponse;
}

function ttlMs(record: WorkflowRecord, retentionSeconds: number): number {
  const createdAt = Date.parse(record.createdAt);
  const expiresAt = Date.parse(record.expiresAt);
  const resolvedAt = record.resolvedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(record.resolvedAt);
  const retentionBoundary = resolvedAt + retentionSeconds * 1_000;
  return Math.max(0, Math.trunc(Math.max(expiresAt, retentionBoundary) - createdAt));
}
