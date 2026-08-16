import { describe, expect, it } from "vitest";
import {
  CancelTaskParamsSchema,
  CreateTaskResultSchema,
  DetailedTaskSchema,
  EmptyCompleteResultSchema,
  GetTaskParamsSchema,
  GetTaskResultSchema,
  UpdateTaskParamsSchema,
} from "../../src/lib/mcp-tasks-extension.js";

const task = {
  taskId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  status: "working" as const,
  createdAt: "2026-08-14T10:00:00.000Z",
  lastUpdatedAt: "2026-08-14T10:00:00.000Z",
  ttlMs: 60_000,
  pollIntervalMs: 5_000,
};

describe("pinned official MCP Tasks extension schemas", () => {
  it("accepts the flat CreateTaskResult and rejects the older nested shape", () => {
    expect(CreateTaskResultSchema.safeParse({ resultType: "task", ...task }).success).toBe(true);
    expect(CreateTaskResultSchema.safeParse({ task }).success).toBe(false);
  });

  it("accepts status-specific DetailedTask variants", () => {
    expect(DetailedTaskSchema.safeParse(task).success).toBe(true);
    expect(DetailedTaskSchema.safeParse({ ...task, status: "completed", result: { content: [] } }).success).toBe(true);
    expect(DetailedTaskSchema.safeParse({ ...task, status: "failed", error: { code: -32603 } }).success).toBe(true);
    expect(DetailedTaskSchema.safeParse({ ...task, status: "cancelled" }).success).toBe(true);
  });

  it("requires terminal payloads on completed and failed tasks", () => {
    expect(DetailedTaskSchema.safeParse({ ...task, status: "completed" }).success).toBe(false);
    expect(DetailedTaskSchema.safeParse({ ...task, status: "failed" }).success).toBe(false);
  });

  it("validates tasks/get, tasks/update, and tasks/cancel params", () => {
    expect(GetTaskParamsSchema.safeParse({ taskId: task.taskId }).success).toBe(true);
    expect(UpdateTaskParamsSchema.safeParse({ taskId: task.taskId, inputResponses: {} }).success).toBe(true);
    expect(CancelTaskParamsSchema.safeParse({ taskId: task.taskId }).success).toBe(true);
  });

  it("uses resultType complete for task reads and acknowledgements", () => {
    expect(GetTaskResultSchema.safeParse({ resultType: "complete", ...task }).success).toBe(true);
    expect(EmptyCompleteResultSchema.safeParse({ resultType: "complete" }).success).toBe(true);
  });

  it("rejects the experimental ttl and pollInterval spellings", () => {
    const legacy = { ...task, ttl: task.ttlMs, pollInterval: task.pollIntervalMs } as Record<string, unknown>;
    delete legacy.ttlMs;
    delete legacy.pollIntervalMs;
    expect(CreateTaskResultSchema.safeParse({ resultType: "task", ...legacy }).success).toBe(false);
  });
});

