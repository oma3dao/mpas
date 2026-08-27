import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Trace event types emitted by the adapter service.
 */
export type AdapterTraceType =
  | "incoming_action"
  | "verification_step"
  | "dispatch"
  | "mcp_call"
  | "mcp_response"
  | "receipt_generated";

/**
 * Trace event types emitted by the coordination service.
 */
export type CoordinationTraceType =
  | "coordination_workflow_create"
  /** @deprecated Use `coordination_workflow_create`. */
  | "coordination_submit"
  | "coordination_poll"
  | "approval_received"
  | "action_cancelled"
  | "state_transition";

export type TraceService = "adapter" | "coordination";
export type TraceType = AdapterTraceType | CoordinationTraceType;

export interface TraceEvent {
  timestamp: string;
  service: TraceService;
  type: TraceType;
  actionId?: string;
  did?: string;
  endpoint?: string;
  result?: string;
  [key: string]: unknown;
}

/**
 * Append-only JSONL trace file writer. Each call to `write()` appends one
 * self-contained JSON line. Unlike the dispatch ledger, the trace file is NOT
 * fsync'd on every write — it's observability, not a safety invariant.
 */
export class TraceWriter {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(event: TraceEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Protocol trace logger. Wraps a TraceWriter and provides typed emit methods
 * for each service. When no writer is provided (trace disabled), all methods
 * are no-ops with zero overhead.
 */
export class TraceLogger {
  private readonly writer: TraceWriter | undefined;
  private readonly service: TraceService;

  constructor(service: TraceService, writer?: TraceWriter) {
    this.service = service;
    this.writer = writer;
  }

  get enabled(): boolean {
    return this.writer !== undefined;
  }

  emit(type: TraceType, fields: Omit<TraceEvent, "timestamp" | "service" | "type">): void {
    if (!this.writer) return;
    this.writer.write({
      timestamp: new Date().toISOString(),
      service: this.service,
      type,
      ...fields,
    });
  }
}

/**
 * Callback interface passed into the verification pipeline to capture
 * individual verification step outcomes.
 */
export interface VerificationTraceCallback {
  (step: string, passed: boolean, details?: Record<string, unknown>): void;
}
