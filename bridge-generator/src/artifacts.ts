/**
 * Discovery snapshot artifacts (spec.md §3.2–3.5).
 *
 * Determinism rules (spec.md §4): metadata is the only artifact that may carry
 * a timestamp; the snapshot, classification, and harness config are byte-stable
 * for an unchanged upstream.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { inferImpact } from "./plugin-codegen.js";
import type { McpToolDefinition, UpstreamInfo } from "./types.js";

export interface HashObject {
  alg: "sha-256";
  value: string;
}

export interface ToolsListSnapshot {
  version: "1";
  type: "McpToolsListSnapshot";
  toolSurface: HashObject;
  tools: McpToolDefinition[];
}

export interface DiscoveryMetadata {
  version: "1";
  type: "McpDiscoveryMetadata";
  serverInfo: { name: string; version?: string };
  protocolVersion: string;
  upstreamCommand: string[];
  generatorVersion: string;
  capturedAt: string;
}

export interface ClassificationEntry {
  impact: "medium" | "high" | "critical";
  rationale: string;
}

export interface ClassificationDraft {
  version: "1";
  type: "ImpactClassificationDraft";
  draft: boolean;
  operations: Record<string, ClassificationEntry>;
}

export interface HarnessConfig {
  version: "1";
  type: "HarnessConfig";
  upstream: { command: string; args: string[]; env?: Record<string, string> };
  intentionalDeviations: {
    renamedTools: Record<string, string>;
    wrappedSchemas: string[];
    modifiedDescriptions: string[];
  };
}

/** Tools sorted by name in UTF-16 code-unit order (spec.md §3.2). */
export function sortTools(tools: McpToolDefinition[]): McpToolDefinition[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * toolSurface hash: base64url(sha-256(JCS(sorted tools array))), no padding.
 * Shared construction with the plugin toolSurface field (drift-prevention
 * proposal) — one definition for snapshot, plugin, harness, and registry.
 */
export function computeToolSurfaceHash(tools: McpToolDefinition[]): HashObject {
  const canonical = canonicalize(sortTools(tools));
  return {
    alg: "sha-256",
    value: createHash("sha256").update(canonical, "utf8").digest("base64url"),
  };
}

export function buildToolsListSnapshot(tools: McpToolDefinition[]): ToolsListSnapshot {
  const sorted = sortTools(tools);
  return {
    version: "1",
    type: "McpToolsListSnapshot",
    toolSurface: computeToolSurfaceHash(sorted),
    tools: sorted,
  };
}

export function buildDiscoveryMetadata(
  upstream: UpstreamInfo,
  options: { protocolVersion: string; generatorVersion: string; capturedAt?: string },
): DiscoveryMetadata {
  return {
    version: "1",
    type: "McpDiscoveryMetadata",
    serverInfo: {
      name: upstream.serverName,
      ...(upstream.serverVersion ? { version: upstream.serverVersion } : {}),
    },
    protocolVersion: options.protocolVersion,
    upstreamCommand: [upstream.command, ...upstream.args],
    generatorVersion: options.generatorVersion,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
  };
}

export function buildClassificationDraft(tools: McpToolDefinition[]): ClassificationDraft {
  const operations: Record<string, ClassificationEntry> = {};
  for (const tool of sortTools(tools)) {
    operations[tool.name] = { impact: inferImpact(tool.name), rationale: "name-heuristic" };
  }

  return {
    version: "1",
    type: "ImpactClassificationDraft",
    draft: true,
    operations,
  };
}

/**
 * Merge semantics (spec.md §5): new tools are added with heuristic impact and
 * "name-heuristic" rationale; existing entries (manually reviewed) are
 * preserved verbatim; entries for tools no longer present are dropped. The
 * draft flag stays false only if it was false AND no unreviewed entries were
 * added.
 */
export function mergeClassificationDraft(
  existing: ClassificationDraft,
  tools: McpToolDefinition[],
): ClassificationDraft {
  const operations: Record<string, ClassificationEntry> = {};
  let addedUnreviewed = false;
  for (const tool of sortTools(tools)) {
    const kept = existing.operations[tool.name];
    if (kept) {
      operations[tool.name] = kept;
    } else {
      operations[tool.name] = { impact: inferImpact(tool.name), rationale: "name-heuristic" };
      addedUnreviewed = true;
    }
  }

  return {
    version: "1",
    type: "ImpactClassificationDraft",
    draft: existing.draft || addedUnreviewed,
    operations,
  };
}

export function buildHarnessConfig(upstream: UpstreamInfo): HarnessConfig {
  return {
    version: "1",
    type: "HarnessConfig",
    upstream: { command: upstream.command, args: upstream.args },
    intentionalDeviations: {
      renamedTools: {},
      wrappedSchemas: [],
      modifiedDescriptions: [],
    },
  };
}

/**
 * Merge semantics (spec.md §5): generated fields refreshed, manual edits
 * (intentionalDeviations, env) preserved.
 */
export function mergeHarnessConfig(existing: HarnessConfig, upstream: UpstreamInfo): HarnessConfig {
  return {
    version: "1",
    type: "HarnessConfig",
    upstream: {
      command: upstream.command,
      args: upstream.args,
      ...(existing.upstream?.env ? { env: existing.upstream.env } : {}),
    },
    intentionalDeviations: existing.intentionalDeviations ?? {
      renamedTools: {},
      wrappedSchemas: [],
      modifiedDescriptions: [],
    },
  };
}
