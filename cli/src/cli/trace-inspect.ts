import { readFileSync } from "node:fs";
import type { TraceEvent } from "../core/trace.js";

interface GroupedAction {
  actionId: string;
  events: TraceEvent[];
  startTime: number;
}

/**
 * Reads a JSONL trace file and prints a human-readable protocol timeline
 * grouped by actionId, showing the sequence across both services with
 * relative timing. Highlights anomalies.
 */
export function inspectTrace(path: string): string {
  const content = readFileSync(path, "utf8");
  const events: TraceEvent[] = [];

  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // Skip malformed lines
    }
  }

  if (events.length === 0) {
    return "No trace events found.\n";
  }

  // Group events by actionId
  const groups = new Map<string, TraceEvent[]>();
  const ungrouped: TraceEvent[] = [];

  for (const event of events) {
    const id = event.actionId;
    if (id) {
      const group = groups.get(id) ?? [];
      group.push(event);
      groups.set(id, group);
    } else {
      ungrouped.push(event);
    }
  }

  const lines: string[] = [];
  lines.push(`Trace: ${path}`);
  lines.push(`Total events: ${events.length}`);
  lines.push(`Actions: ${groups.size}`);
  lines.push("");

  // Render each action group
  for (const [actionId, actionEvents] of groups) {
    lines.push(renderActionGroup(actionId, actionEvents));
  }

  // Render ungrouped events (polls without actionId, etc.)
  if (ungrouped.length > 0) {
    lines.push("─── Ungrouped Events ───");
    lines.push("");
    for (const event of ungrouped) {
      lines.push(`  ${formatTimestamp(event.timestamp)} [${event.service}] ${event.type}${formatFields(event)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderActionGroup(actionId: string, events: TraceEvent[]): string {
  const lines: string[] = [];
  const shortId = actionId.length > 24 ? `${actionId.slice(0, 12)}...${actionId.slice(-8)}` : actionId;
  lines.push(`─── Action: ${shortId} ───`);
  lines.push("");

  // Sort by timestamp
  events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const startTime = Date.parse(events[0].timestamp);
  const anomalies: string[] = [];

  for (const event of events) {
    const offset = Date.parse(event.timestamp) - startTime;
    const offsetStr = `+${offset}ms`.padEnd(8);
    const serviceTag = event.service === "adapter" ? "ADP" : "CRD";
    const marker = detectAnomaly(event);

    let detail = formatEventDetail(event);
    if (marker) {
      detail = `${detail} ⚠ ${marker}`;
      anomalies.push(marker);
    }

    lines.push(`  ${offsetStr} [${serviceTag}] ${detail}`);
  }

  if (anomalies.length > 0) {
    lines.push("");
    lines.push("  Anomalies:");
    for (const anomaly of anomalies) {
      lines.push(`    ⚠ ${anomaly}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function formatEventDetail(event: TraceEvent): string {
  switch (event.type) {
    case "incoming_action":
      return `receives ActionPackage from ${event.did ?? "unknown"}`;

    case "verification_step": {
      const step = (event.step as string) ?? "unknown";
      const passed = event.passed as boolean;
      const icon = passed ? "✓" : "✗";
      const code = event.code ? ` (${event.code})` : "";
      return `${icon} ${step}${code}`;
    }

    case "dispatch": {
      const result = event.result as string;
      const reason = event.reason ? ` [${event.reason}]` : "";
      const code = event.code ? ` (${event.code})` : "";
      return `dispatch → ${result}${code}${reason}`;
    }

    case "mcp_call":
      return `→ MCP call: ${event.operation ?? "unknown"} (${event.targetType ?? "unknown"})`;

    case "mcp_response": {
      const result = event.result as string;
      return `← MCP response: ${result}`;
    }

    case "receipt_generated":
      return `receipt generated (${event.result})`;

    case "coordination_workflow_create":
    case "coordination_submit":
      return `workflow created by ${event.did ?? "unknown"}`;

    case "coordination_poll": {
      const result = event.result as string | undefined;
      if (result) {
        return `poll response → ${event.approvalRequestCount ?? 0} requests, ${event.actionUpdateCount ?? 0} updates`;
      }
      return `poll from ${event.did ?? "unknown"}`;
    }

    case "approval_received": {
      const result = event.result as string | undefined;
      if (result) {
        return `approval accepted → state: ${event.state ?? "unknown"}`;
      }
      return `approval submitted`;
    }

    case "action_cancelled":
      return `cancelled by ${event.did ?? "unknown"}`;

    case "state_transition": {
      const from = event.fromState as string | undefined;
      const to = event.toState as string;
      if (from) {
        return `state: ${from} → ${to}`;
      }
      return `state → ${to}`;
    }

    default:
      return `${event.type}`;
  }
}

function detectAnomaly(event: TraceEvent): string | undefined {
  if (event.type === "verification_step" && event.passed === false) {
    const code = event.code as string | undefined;
    if (code === "PAYLOAD_HASH_MISMATCH") return "Hash mismatch detected";
    if (code === "EXPIRED_ACTION_ENVELOPE") return "Expired envelope";
    if (code === "UNTRUSTED_SIGNER") return "Unauthorized signer";
    if (code === "INVALID_SIGNATURE") return "Invalid signature";
    if (code === "APPROVAL_HASH_MISMATCH") return "Approval hash mismatch";
  }

  if (event.type === "dispatch" && event.result === "rejected") {
    const code = event.code as string | undefined;
    if (code === "REPLAY_DETECTED") return "Replay attack detected";
    if (code === "ACTION_ID_HASH_MISMATCH") return "ActionId hash mismatch (possible collision)";
  }

  if (event.type === "verification_step" && event.step === "expiry_check" && event.passed === false) {
    return "Expired envelope";
  }

  return undefined;
}

function formatTimestamp(timestamp: string): string {
  return timestamp.replace("T", " ").replace("Z", "");
}

function formatFields(event: TraceEvent): string {
  const skip = new Set(["timestamp", "service", "type", "actionId"]);
  const fields = Object.entries(event)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return fields ? ` ${fields}` : "";
}
