/**
 * Re-exports trace utilities from @oma3/mpas.
 * This file exists so that existing imports from "../core/trace.js" continue to work.
 */
export { TraceWriter, TraceLogger } from "@oma3/mpas/trace";

export type {
  AdapterTraceType,
  CoordinationTraceType,
  TraceService,
  TraceType,
  TraceEvent,
  VerificationTraceCallback,
} from "@oma3/mpas/trace";
