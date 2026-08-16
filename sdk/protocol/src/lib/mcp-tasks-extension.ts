/**
 * MCP Tasks extension wire types and validators.
 *
 * Temporarily pinned to modelcontextprotocol/ext-tasks commit
 * 2c1425d9a288b9b1f489430fe1e00bb392b47e48, schema/draft/schema.ts
 * (Apache-2.0). Replace this isolated module when the official extension
 * package is published. See docs/features/mcp-tasks/plan.md Appendix A.
 */
import { z } from "zod";

export const MCP_TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const MPAS_MCP_PROFILE_EXTENSION_ID = "org.oma3/mpas";
export const MPAS_MCP_PROFILE_VERSION = "2";
export const MCP_TASKS_SCHEMA_COMMIT = "2c1425d9a288b9b1f489430fe1e00bb392b47e48";

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface Task {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkingTask extends Task {
  status: "working";
}

export interface InputRequiredTask extends Task {
  status: "input_required";
  inputRequests: Record<string, unknown>;
}

export interface CompletedTask extends Task {
  status: "completed";
  result: Record<string, unknown>;
}

export interface FailedTask extends Task {
  status: "failed";
  error: Record<string, unknown>;
}

export interface CancelledTask extends Task {
  status: "cancelled";
}

export type DetailedTask = WorkingTask | InputRequiredTask | CompletedTask | FailedTask | CancelledTask;

export type CreateTaskResult = Task & { resultType: "task" };
export type GetTaskResult = DetailedTask & { resultType: "complete" };
export type UpdateTaskResult = { resultType: "complete"; _meta?: Record<string, unknown> };
export type CancelTaskResult = { resultType: "complete"; _meta?: Record<string, unknown> };

export interface GetTaskParams {
  taskId: string;
}

export interface UpdateTaskParams {
  taskId: string;
  inputResponses: Record<string, unknown>;
}

export interface CancelTaskParams {
  taskId: string;
}

const ResultMetaSchema = z.record(z.string(), z.unknown()).optional();

export const TaskSchema = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(["working", "input_required", "completed", "failed", "cancelled"]),
    statusMessage: z.string().optional(),
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
    ttlMs: z.number().int().nonnegative().nullable(),
    pollIntervalMs: z.number().int().nonnegative().optional(),
    _meta: ResultMetaSchema,
  })
  .passthrough();

export const CreateTaskResultSchema = TaskSchema.extend({ resultType: z.literal("task") });

export const DetailedTaskSchema = z.discriminatedUnion("status", [
  TaskSchema.extend({ status: z.literal("working") }),
  TaskSchema.extend({ status: z.literal("input_required"), inputRequests: z.record(z.string(), z.unknown()) }),
  TaskSchema.extend({ status: z.literal("completed"), result: z.record(z.string(), z.unknown()) }),
  TaskSchema.extend({ status: z.literal("failed"), error: z.record(z.string(), z.unknown()) }),
  TaskSchema.extend({ status: z.literal("cancelled") }),
]);

export const GetTaskResultSchema = z.intersection(
  z.object({ resultType: z.literal("complete") }),
  DetailedTaskSchema,
);

export const EmptyCompleteResultSchema = z
  .object({ resultType: z.literal("complete"), _meta: ResultMetaSchema })
  .passthrough();

export const GetTaskParamsSchema = z.object({ taskId: z.string().min(1) }).passthrough();
export const UpdateTaskParamsSchema = z
  .object({ taskId: z.string().min(1), inputResponses: z.record(z.string(), z.unknown()) })
  .passthrough();
export const CancelTaskParamsSchema = z.object({ taskId: z.string().min(1) }).passthrough();
