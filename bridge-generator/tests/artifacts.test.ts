import { describe, expect, it } from "vitest";
import {
  buildClassificationDraft,
  buildDiscoveryMetadata,
  buildHarnessConfig,
  buildToolsListSnapshot,
  computeToolSurfaceHash,
  mergeClassificationDraft,
  mergeHarnessConfig,
  sortTools,
} from "../src/artifacts.js";
import type { McpToolDefinition, UpstreamInfo } from "../src/types.js";

const tools: McpToolDefinition[] = [
  { name: "merge_pull_request", description: "Merge a PR.", inputSchema: { type: "object" } },
  { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object" } },
  { name: "delete_branch", description: "Delete a branch.", inputSchema: { type: "object" } },
];

const upstream: UpstreamInfo = {
  command: "node",
  args: ["server.mjs"],
  serverName: "mock-mcp",
  serverVersion: "1.2.3",
  protocolVersion: "2024-11-05",
  tools,
};

describe("toolSurface hash (spec §3.2)", () => {
  it("is order-independent: any input ordering yields the same hash", () => {
    const shuffled = [tools[2], tools[0], tools[1]];
    expect(computeToolSurfaceHash(shuffled)).toEqual(computeToolSurfaceHash(tools));
  });

  it("changes when a schema changes (full-definition hashing, not names-only)", () => {
    const drifted = tools.map((tool) =>
      tool.name === "create_issue"
        ? { ...tool, inputSchema: { type: "object", properties: { extra: { type: "string" } } } }
        : tool,
    );
    expect(computeToolSurfaceHash(drifted).value).not.toBe(computeToolSurfaceHash(tools).value);
  });

  it("is base64url without padding", () => {
    const { alg, value } = computeToolSurfaceHash(tools);
    expect(alg).toBe("sha-256");
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(value).not.toContain("=");
  });
});

describe("buildToolsListSnapshot", () => {
  it("sorts tools by name and embeds the surface hash", () => {
    const snapshot = buildToolsListSnapshot(tools);
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(["create_issue", "delete_branch", "merge_pull_request"]);
    expect(snapshot.toolSurface).toEqual(computeToolSurfaceHash(tools));
  });

  it("is deterministic and timestamp-free (spec §4)", () => {
    const a = JSON.stringify(buildToolsListSnapshot(tools));
    const b = JSON.stringify(buildToolsListSnapshot([...tools].reverse()));
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("buildDiscoveryMetadata", () => {
  it("carries capture context including the timestamp", () => {
    const metadata = buildDiscoveryMetadata(upstream, {
      protocolVersion: upstream.protocolVersion ?? "unknown",
      generatorVersion: "0.2.0",
      capturedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(metadata).toEqual({
      version: "1",
      type: "McpDiscoveryMetadata",
      serverInfo: { name: "mock-mcp", version: "1.2.3" },
      protocolVersion: "2024-11-05",
      upstreamCommand: ["node", "server.mjs"],
      generatorVersion: "0.2.0",
      capturedAt: "2026-07-18T00:00:00.000Z",
    });
  });
});

describe("classification draft and merge (spec §3.4, §5)", () => {
  it("classifies every tool with the name heuristic, marked draft", () => {
    const draft = buildClassificationDraft(tools);
    expect(draft.draft).toBe(true);
    expect(draft.operations).toEqual({
      create_issue: { impact: "medium", rationale: "name-heuristic" },
      delete_branch: { impact: "critical", rationale: "name-heuristic" },
      merge_pull_request: { impact: "high", rationale: "name-heuristic" },
    });
  });

  it("merge preserves reviewed entries, adds new tools, drops removed tools", () => {
    const reviewed = {
      ...buildClassificationDraft(tools),
      draft: false,
      operations: {
        create_issue: { impact: "high" as const, rationale: "reviewed: creates externally visible content" },
        delete_branch: { impact: "critical" as const, rationale: "reviewed" },
        merge_pull_request: { impact: "high" as const, rationale: "reviewed" },
      },
    };
    const newSurface: McpToolDefinition[] = [
      tools[0], // merge_pull_request
      tools[1], // create_issue
      { name: "purge_cache", inputSchema: { type: "object" } }, // new; delete_branch removed
    ];

    const merged = mergeClassificationDraft(reviewed, newSurface);

    expect(merged.operations.create_issue).toEqual({
      impact: "high",
      rationale: "reviewed: creates externally visible content",
    });
    expect(merged.operations.purge_cache).toEqual({ impact: "critical", rationale: "name-heuristic" });
    expect(merged.operations.delete_branch).toBeUndefined();
    // Adding an unreviewed tool re-flags the draft.
    expect(merged.draft).toBe(true);
  });

  it("merge keeps draft false when the surface is unchanged", () => {
    const reviewed = { ...buildClassificationDraft(tools), draft: false };
    expect(mergeClassificationDraft(reviewed, tools).draft).toBe(false);
  });
});

describe("harness config and merge (spec §3.5, §5)", () => {
  it("emits empty deviations and no high-impact list (derived from classification at run time)", () => {
    const config = buildHarnessConfig(upstream);
    expect(config.intentionalDeviations).toEqual({ renamedTools: {}, wrappedSchemas: [], modifiedDescriptions: [] });
    expect(config).not.toHaveProperty("highImpact");
  });

  it("merge refreshes upstream command but preserves manual edits", () => {
    const edited = {
      ...buildHarnessConfig(upstream),
      upstream: { command: "old-node", args: ["old.mjs"], env: { TOKEN: "{{credential:x}}" } },
      intentionalDeviations: {
        renamedTools: { old_name: "new_name" },
        wrappedSchemas: ["create_issue"],
        modifiedDescriptions: [],
      },
    };

    const merged = mergeHarnessConfig(edited, upstream);

    expect(merged.upstream).toEqual({ command: "node", args: ["server.mjs"], env: { TOKEN: "{{credential:x}}" } });
    expect(merged.intentionalDeviations.renamedTools).toEqual({ old_name: "new_name" });
  });
});

describe("sortTools", () => {
  it("does not mutate its input", () => {
    const input = [...tools];
    sortTools(input);
    expect(input.map((tool) => tool.name)).toEqual(["merge_pull_request", "create_issue", "delete_branch"]);
  });
});
