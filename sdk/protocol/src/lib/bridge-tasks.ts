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
import { buildMpasTaskMeta, type MpasTaskMetaOptions } from "./mpas-task-meta.js";
import { TERMINAL_WORKFLOW_STATES, type WorkflowRecord } from "./workflow-store.js";

export interface TaskResultConfig {
  resultRetentionSeconds: number;
  /** Polling hint while approvals are awaited, and for finished Tasks. */
  taskPollIntervalMs?: number;
  /** Polling hint while the bridge itself has work to do for the Task. */
  processingPollIntervalMs?: number;
  /** Last completed Coordination poll; see {@link MpasTaskMetaOptions}. */
  coordinationCheckedAt?: string | null;
  /** The Task's last remote call failed or was interrupted and awaits a retry. */
  retrying?: boolean;
  /** Earliest time, in epoch milliseconds, the Task's next remote call may run. */
  retryNotBefore?: number;
  /** Current time in epoch milliseconds, for {@link retryNotBefore}. */
  now?: number;
}

/** Polling hint while approvals are awaited (feature reduce-polling §14.3). */
export const DEFAULT_TASK_POLL_INTERVAL_MS = 60_000;
/** Polling hint while the bridge itself has work to do (feature reduce-polling §14.3). */
export const DEFAULT_PROCESSING_POLL_INTERVAL_MS = 2_000;

export function buildCreateTaskResult(record: WorkflowRecord, config: TaskResultConfig): CreateTaskResult {
  return { resultType: "task", ...taskSummary(record, config) };
}

/**
 * Whether a workflow already has its final tool result, so `tools/call` can
 * return it directly instead of a Task: a resolved Action, or one that ended
 * without a native result (a permanent failure, an invalid response, expiry).
 */
export function hasCompleteToolCallResult(record: WorkflowRecord): boolean {
  return record.state === "resolved" || record.state === "unresolvable";
}

/**
 * Return a normal tools/call result when the initial Action reaches a
 * terminal outcome quickly: the native result, or an error `CallToolResult`
 * for an Action that ended without one (the same result a completed Task
 * carries).
 */
export function buildCompleteToolCallResult(record: WorkflowRecord): CompleteToolCallResult {
  if (record.state === "resolved") {
    return { ...resolvedResult(record), resultType: "complete" } as CompleteToolCallResult;
  }
  if (record.state === "unresolvable") {
    return { ...unresolvableResult(record), resultType: "complete" } as CompleteToolCallResult;
  }
  throw new Error(`Workflow ${record.taskId} has no synchronous tool result.`);
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
    ...(statusMessage(record, config.retrying === true) !== undefined
      ? { statusMessage: statusMessage(record, config.retrying === true) }
      : {}),
    createdAt: record.createdAt,
    lastUpdatedAt: record.updatedAt,
    ttlMs: ttlMs(record, config.resultRetentionSeconds),
    pollIntervalMs: pollIntervalFor(record, config),
    ...(status === "working"
      ? {
          _meta: {
            [MPAS_MCP_PROFILE_EXTENSION_ID]: buildMpasTaskMeta(
              record,
              config.coordinationCheckedAt !== undefined ? { coordinationCheckedAt: config.coordinationCheckedAt } : {},
            ),
          },
        }
      : {}),
  };
}

/**
 * The polling hint for a Task in its current state: slow while people decide,
 * quick while the bridge itself has work to do, and never sooner than the
 * Task's next permitted retry. Each check of a working Task can start its
 * next step, so the hint is in effect the retry schedule for hosts that
 * follow it.
 */
function pollIntervalFor(record: WorkflowRecord, config: TaskResultConfig): number {
  const approvals = config.taskPollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS;
  if (record.state === "awaitingApprovals" || TERMINAL_WORKFLOW_STATES.has(record.state)) return approvals;
  const processing = config.processingPollIntervalMs ?? DEFAULT_PROCESSING_POLL_INTERVAL_MS;
  const untilRetry = config.retryNotBefore !== undefined && config.now !== undefined
    ? Math.ceil(config.retryNotBefore - config.now)
    : 0;
  return Math.max(processing, untilRetry);
}

/** Status text never implies authorization or execution merely because a request was sent. */
function statusMessage(record: WorkflowRecord, retrying: boolean): string | undefined {
  switch (record.state) {
    case "created":
      return retrying
        ? "The Verifier could not be reached. The bridge resends the same request when this Task is next checked."
        : "Awaiting the Verifier response.";
    case "submittingToCoordination":
      return retrying
        ? "The approval request is not yet registered with the Coordination Service, so Maintainers cannot see it. The bridge retries when this Task is next checked."
        : "Registering the approval request with the Coordination Service.";
    case "awaitingApprovals":
      return "Awaiting MPAS authorization.";
    case "readyForSubmission":
    case "submittingToVerifier":
      return retrying
        ? "MPAS approvals collected, but the Verifier could not be reached. The bridge resends the same request when this Task is next checked."
        : "MPAS approvals collected; submitting for execution.";
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
