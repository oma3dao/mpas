import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectTrace } from "../../src/cli/trace-inspect.js";
import type { TraceEvent } from "../../src/core/trace.js";

async function writeTrace(events: Array<TraceEvent | string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mpas-trace-inspect-"));
  const path = join(dir, "trace.jsonl");
  const lines = events.map((event) => (typeof event === "string" ? event : JSON.stringify(event)));
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

function baseEvent(overrides: Partial<TraceEvent> & Pick<TraceEvent, "type">): TraceEvent {
  return {
    timestamp: "2026-08-05T12:00:00.000Z",
    service: "adapter",
    ...overrides,
  };
}

describe("inspectTrace", () => {
  it("reports no events for empty or whitespace-only files", async () => {
    const path = await writeTrace(["", "   ", "\t"]);
    expect(inspectTrace(path)).toBe("No trace events found.\n");
  });

  it("skips malformed JSONL lines and keeps valid events", async () => {
    const path = await writeTrace([
      "not-json",
      baseEvent({ type: "incoming_action", actionId: "act-1", did: "did:jwk:proposer" }),
      "{broken",
    ]);

    const output = inspectTrace(path);
    expect(output).toContain("Total events: 1");
    expect(output).toContain("Actions: 1");
    expect(output).toContain("receives ActionPackage from did:jwk:proposer");
  });

  it("groups by actionId, truncates long ids, and renders ungrouped events", async () => {
    const longId = "abcdefghijklmnopqrstuvwxyz0123456789";
    const path = await writeTrace([
      baseEvent({
        type: "incoming_action",
        actionId: longId,
        timestamp: "2026-08-05T12:00:00.000Z",
        did: "did:jwk:a",
      }),
      baseEvent({
        type: "verification_step",
        actionId: longId,
        timestamp: "2026-08-05T12:00:00.010Z",
        step: "signature",
        passed: true,
      }),
      baseEvent({
        type: "coordination_poll",
        service: "coordination",
        timestamp: "2026-08-05T12:00:01.000Z",
        did: "did:jwk:poller",
      }),
    ]);

    const output = inspectTrace(path);
    expect(output).toContain(`─── Action: ${longId.slice(0, 12)}...${longId.slice(-8)} ───`);
    expect(output).toContain("+0ms");
    expect(output).toContain("+10ms");
    expect(output).toContain("[ADP]");
    expect(output).toContain("─── Ungrouped Events ───");
    expect(output).toContain("[coordination] coordination_poll");
    expect(output).toContain('did="did:jwk:poller"');
  });

  it("formats each event type and lists anomalies", async () => {
    const actionId = "act-anomalies";
    const path = await writeTrace([
      baseEvent({
        type: "incoming_action",
        actionId,
        timestamp: "2026-08-05T12:00:00.000Z",
      }),
      baseEvent({
        type: "verification_step",
        actionId,
        timestamp: "2026-08-05T12:00:00.001Z",
        step: "payload_binding",
        passed: false,
        code: "PAYLOAD_HASH_MISMATCH",
      }),
      baseEvent({
        type: "verification_step",
        actionId,
        timestamp: "2026-08-05T12:00:00.002Z",
        step: "expiry_check",
        passed: false,
        code: "EXPIRED_ACTION_ENVELOPE",
      }),
      baseEvent({
        type: "verification_step",
        actionId,
        timestamp: "2026-08-05T12:00:00.003Z",
        step: "signer",
        passed: false,
        code: "UNTRUSTED_SIGNER",
      }),
      baseEvent({
        type: "verification_step",
        actionId,
        timestamp: "2026-08-05T12:00:00.004Z",
        step: "signature",
        passed: false,
        code: "INVALID_SIGNATURE",
      }),
      baseEvent({
        type: "verification_step",
        actionId,
        timestamp: "2026-08-05T12:00:00.005Z",
        step: "approval",
        passed: false,
        code: "APPROVAL_HASH_MISMATCH",
      }),
      baseEvent({
        type: "dispatch",
        actionId,
        timestamp: "2026-08-05T12:00:00.006Z",
        result: "rejected",
        code: "REPLAY_DETECTED",
        reason: "duplicate",
      }),
      baseEvent({
        type: "dispatch",
        actionId,
        timestamp: "2026-08-05T12:00:00.007Z",
        result: "rejected",
        code: "ACTION_ID_HASH_MISMATCH",
      }),
      baseEvent({
        type: "mcp_call",
        actionId,
        timestamp: "2026-08-05T12:00:00.008Z",
        operation: "create_issue",
        targetType: "mcp.stdio",
      }),
      baseEvent({
        type: "mcp_response",
        actionId,
        timestamp: "2026-08-05T12:00:00.009Z",
        result: "ok",
      }),
      baseEvent({
        type: "receipt_generated",
        actionId,
        timestamp: "2026-08-05T12:00:00.010Z",
        result: "executed",
      }),
      baseEvent({
        type: "coordination_submit",
        service: "coordination",
        actionId,
        timestamp: "2026-08-05T12:00:00.011Z",
        did: "did:jwk:proposer",
      }),
      baseEvent({
        type: "coordination_poll",
        service: "coordination",
        actionId,
        timestamp: "2026-08-05T12:00:00.012Z",
        result: "ok",
        approvalRequestCount: 2,
        actionUpdateCount: 1,
      }),
      baseEvent({
        type: "approval_received",
        service: "coordination",
        actionId,
        timestamp: "2026-08-05T12:00:00.013Z",
      }),
      baseEvent({
        type: "approval_received",
        service: "coordination",
        actionId,
        timestamp: "2026-08-05T12:00:00.014Z",
        result: "accepted",
        state: "approved",
      }),
      baseEvent({
        type: "action_cancelled",
        service: "coordination",
        actionId,
        timestamp: "2026-08-05T12:00:00.015Z",
        did: "did:jwk:proposer",
      }),
      baseEvent({
        type: "state_transition",
        service: "coordination",
        actionId,
        timestamp: "2026-08-05T12:00:00.016Z",
        fromState: "pending",
        toState: "approved",
      }),
      baseEvent({
        type: "state_transition",
        service: "coordination",
        actionId,
        timestamp: "2026-08-05T12:00:00.017Z",
        toState: "completed",
      }),
      baseEvent({
        type: "custom_unknown" as TraceEvent["type"],
        actionId,
        timestamp: "2026-08-05T12:00:00.018Z",
      }),
    ]);

    const output = inspectTrace(path);
    expect(output).toContain("receives ActionPackage from unknown");
    expect(output).toContain("✗ payload_binding (PAYLOAD_HASH_MISMATCH)");
    expect(output).toContain("Hash mismatch detected");
    expect(output).toContain("Expired envelope");
    expect(output).toContain("Unauthorized signer");
    expect(output).toContain("Invalid signature");
    expect(output).toContain("Approval hash mismatch");
    expect(output).toContain("Replay attack detected");
    expect(output).toContain("ActionId hash mismatch (possible collision)");
    expect(output).toContain("→ MCP call: create_issue (mcp.stdio)");
    expect(output).toContain("← MCP response: ok");
    expect(output).toContain("receipt generated (executed)");
    expect(output).toContain("action submitted by did:jwk:proposer");
    expect(output).toContain("poll response → 2 requests, 1 updates");
    expect(output).toContain("approval submitted");
    expect(output).toContain("approval accepted → state: approved");
    expect(output).toContain("cancelled by did:jwk:proposer");
    expect(output).toContain("state: pending → approved");
    expect(output).toContain("state → completed");
    expect(output).toContain("custom_unknown");
    expect(output).toContain("Anomalies:");
    expect(output).toContain("[CRD]");
  });

  it("formats verification pass without codes and dispatch without reason", async () => {
    const path = await writeTrace([
      baseEvent({
        type: "verification_step",
        actionId: "act-pass",
        step: "schema",
        passed: true,
      }),
      baseEvent({
        type: "dispatch",
        actionId: "act-pass",
        timestamp: "2026-08-05T12:00:00.001Z",
        result: "executed",
      }),
      baseEvent({
        type: "mcp_call",
        actionId: "act-pass",
        timestamp: "2026-08-05T12:00:00.002Z",
      }),
    ]);

    const output = inspectTrace(path);
    expect(output).toContain("✓ schema");
    expect(output).toContain("dispatch → executed");
    expect(output).toContain("→ MCP call: unknown (unknown)");
    expect(output).not.toContain("Anomalies:");
  });

  it("flags an expiry_check failure as Expired envelope even without a code", async () => {
    const path = await writeTrace([
      baseEvent({
        type: "verification_step",
        actionId: "act-expired",
        step: "expiry_check",
        passed: false,
      }),
    ]);

    const output = inspectTrace(path);
    expect(output).toContain("Expired envelope");
    expect(output).toContain("Anomalies:");
  });
});
