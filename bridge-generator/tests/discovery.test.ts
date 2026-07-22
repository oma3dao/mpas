import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverUpstream, HandshakeError, ToolsListError, UpstreamSpawnError } from "../src/discovery.js";

const mockServer = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));

describe("discoverUpstream", () => {
  it("performs the MCP handshake and captures the full tool list", async () => {
    const upstream = await discoverUpstream("node", [mockServer]);

    expect(upstream.serverName).toBe("mock-mcp");
    expect(upstream.serverVersion).toBe("1.2.3");
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

  it("rejects when the upstream command cannot be spawned", async () => {
    await expect(discoverUpstream("definitely-not-a-real-command-xyz", [])).rejects.toBeInstanceOf(UpstreamSpawnError);
  });
});
