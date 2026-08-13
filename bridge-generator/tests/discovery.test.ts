import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverUpstream, HandshakeError, ToolsListError, UpstreamSpawnError } from "../src/discovery.js";

const mockServer = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));

describe("discoverUpstream", () => {
  it("performs the MCP handshake and captures the full tool list", async () => {
    const upstream = await discoverUpstream("node", [mockServer]);

    expect(upstream.serverName).toBe("mock-mcp");
    expect(upstream.serverVersion).toBe("1.2.3");
    expect(upstream.protocolVersion).toBe("2024-11-05");
    expect(upstream.tools.map((tool) => tool.name)).toEqual(["create_issue", "delete_branch", "merge_pull_request"]);
    // Required and optional Tool fields are captured verbatim.
    expect(upstream.tools[0]).toMatchObject({
      title: "Create Issue",
      outputSchema: { type: "object", required: ["number"] },
      annotations: { destructiveHint: false, openWorldHint: true },
      icons: [{ src: "https://example.test/create-issue.png", mimeType: "image/png" }],
      _meta: { "example.test/category": "issues" },
    });
    expect(upstream.tools[1].description).toBe("Delete a branch from a repository.");
    expect(upstream.tools[2].inputSchema).toMatchObject({
      type: "object",
      required: ["owner", "repo", "pull_number"],
    });
  });

  it("collects every tools/list page", async () => {
    const upstream = await discoverUpstream("node", [mockServer, "--paginated"]);

    expect(upstream.tools.map((tool) => tool.name)).toEqual([
      "create_issue",
      "delete_branch",
      "merge_pull_request",
    ]);
  });

  it("rejects an upstream reporting zero tools", async () => {
    await expect(discoverUpstream("node", [mockServer, "--zero-tools"])).rejects.toBeInstanceOf(ToolsListError);
  });

  it("rejects a malformed tool definition", async () => {
    await expect(discoverUpstream("node", [mockServer, "--malformed-tool"])).rejects.toBeInstanceOf(ToolsListError);
  });

  it("rejects a malformed initialize response", async () => {
    await expect(discoverUpstream("node", [mockServer, "--no-server-info"])).rejects.toBeInstanceOf(HandshakeError);
  });

  it("rejects when the upstream exits before responding", async () => {
    await expect(discoverUpstream("node", [mockServer, "--exit-early"])).rejects.toBeInstanceOf(HandshakeError);
  });

  it("rejects invalid JSON from the upstream", async () => {
    await expect(discoverUpstream("node", [mockServer, "--bad-json"])).rejects.toThrow(/Invalid JSON from upstream/);
  });

  it("rejects initialize JSON-RPC errors", async () => {
    await expect(discoverUpstream("node", [mockServer, "--rpc-error"])).rejects.toThrow(/initialize failed/);
  });

  it("rejects malformed tools/list payloads", async () => {
    await expect(discoverUpstream("node", [mockServer, "--bad-tools-list"])).rejects.toBeInstanceOf(ToolsListError);
  });

  it("rejects duplicate tool names", async () => {
    await expect(discoverUpstream("node", [mockServer, "--dup-tools"])).rejects.toThrow(/duplicate tool name/);
  });

  it("rejects a non-string nextCursor", async () => {
    await expect(discoverUpstream("node", [mockServer, "--bad-cursor"])).rejects.toThrow(/Malformed nextCursor/);
  });

  it("rejects a repeated tools/list cursor", async () => {
    await expect(discoverUpstream("node", [mockServer, "--repeat-cursor"])).rejects.toThrow(/Repeated tools\/list cursor/);
  });

  it("rejects when the upstream command cannot be spawned", async () => {
    await expect(discoverUpstream("definitely-not-a-real-command-xyz", [])).rejects.toBeInstanceOf(UpstreamSpawnError);
  });

  it("ignores notifications and orphan responses during discovery", async () => {
    const upstream = await discoverUpstream("node", [mockServer, "--noise"]);
    expect(upstream.tools.map((tool) => tool.name)).toEqual(["create_issue", "delete_branch", "merge_pull_request"]);
  });

  it("rejects tools/list JSON-RPC errors", async () => {
    await expect(discoverUpstream("node", [mockServer, "--tools-list-rpc-error"])).rejects.toThrow(/tools\/list failed/);
  });

  it("rejects tools/list JSON-RPC errors that omit a message", async () => {
    await expect(discoverUpstream("node", [mockServer, "--tools-list-rpc-error-no-message"])).rejects.toThrow(
      /JSON-RPC error/,
    );
  });

  it("forwards upstream stderr while still discovering tools", async () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      chunks.push(chunk.toString());
      return original(chunk, ...(args as Parameters<typeof original>));
    }) as typeof process.stderr.write;
    try {
      const upstream = await discoverUpstream("node", [mockServer, "--stderr-noise"]);
      expect(upstream.tools).toHaveLength(3);
      expect(chunks.join("")).toContain("upstream-noise");
    } finally {
      process.stderr.write = original;
    }
  });

  it(
    "rejects when the upstream stays silent through initialize",
    async () => {
      await expect(discoverUpstream("node", [mockServer, "--silent"])).rejects.toThrow(/timed out/);
    },
    15_000,
  );
});
