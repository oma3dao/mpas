import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  prepareMcpStdio,
  type McpStdioTarget,
} from "../../src/adapter/dispatch/mcp-stdio.js";

const pluginProtocolVersion = "2024-11-05";
const fixtureServer = fileURLToPath(new URL("../fixtures/adapter/echo-mcp-server.mjs", import.meta.url));
const slowFixtureServer = fileURLToPath(new URL("../fixtures/adapter/slow-mcp-server.mjs", import.meta.url));
const protocolVersionFixtureServer = fileURLToPath(
  new URL("../fixtures/adapter/protocol-version-mcp-server.mjs", import.meta.url),
);

const target: McpStdioTarget = {
  type: "mcp.stdio",
  command: "node",
  args: [fixtureServer],
  env: {
    GITHUB_PERSONAL_ACCESS_TOKEN: "{{credential:github-mirror-token}}",
  },
};

describe("prepareMcpStdio", () => {
  it("initializes a stdio MCP server before transmitting with injected credentials", async () => {
    const prepared = await prepareMcpStdio(target, "ghp_test", pluginProtocolVersion);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    try {
      const result = await prepared.session.transmit("create_issue_mirror", {
        owner: "example-org",
        repo: "mpas-demo-repository",
        title: "hello",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const content = result.result as { content: Array<{ type: string; text: string }> };
      const payload = JSON.parse(content.content[0].text);

      expect(payload.mode).toBe("dry_run");
      expect(payload.credentialPresent).toBe(true);
      expect(payload.simulated_result).toMatchObject({ title: "hello" });
    } finally {
      await prepared.session.close();
    }
  });

  it("reuses the same process for subsequent transmissions on a session", async () => {
    const prepared = await prepareMcpStdio(target, "ghp_test", pluginProtocolVersion);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    try {
      const first = await prepared.session.transmit("create_issue_mirror", { owner: "a", repo: "b", title: "first" });
      const second = await prepared.session.transmit("create_issue_mirror", { owner: "a", repo: "b", title: "second" });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        const firstPayload = JSON.parse(
          (first.result as { content: Array<{ text: string }> }).content[0].text,
        );
        const secondPayload = JSON.parse(
          (second.result as { content: Array<{ text: string }> }).content[0].text,
        );
        expect(firstPayload.pid).toBe(secondPayload.pid);
      }
    } finally {
      await prepared.session.close();
    }
  });

  it("uses the stable MCP revision required by a GitHub-compatible stdio server", async () => {
    const prepared = await prepareMcpStdio(
      {
        type: "mcp.stdio",
        command: "node",
        args: [protocolVersionFixtureServer, "stdio"],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: "{{credential:github-mirror-token}}",
          EXPECTED_MCP_PROTOCOL_VERSION: pluginProtocolVersion,
          REQUIRE_STDIO_ARGUMENT: "1",
        },
      },
      "ghp_test",
      pluginProtocolVersion,
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }

    try {
      const result = await prepared.session.transmit("get_me", {});
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const content = result.result as { content: Array<{ text: string }> };
      expect(JSON.parse(content.content[0].text)).toEqual({
        initialized: true,
        protocolVersion: pluginProtocolVersion,
        credentialPresent: true,
      });
    } finally {
      await prepared.session.close();
    }
  });

  it("returns DISPATCH_TIMEOUT when the stdio MCP server does not respond in time", async () => {
    // timeoutMs covers both initialize and tools/call. Keep it high enough for
    // spawn/handshake on slow CI runners, but below the slow fixture's tool delay.
    const prepared = await prepareMcpStdio(
      { ...target, args: [slowFixtureServer], timeoutMs: 1_000 },
      "ghp_test",
      pluginProtocolVersion,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    try {
      const result = await prepared.session.transmit("create_issue_mirror", {
        owner: "example-org",
        repo: "mpas-demo-repository",
        title: "hello",
      });

      expect(result).toMatchObject({ ok: false, error: { code: "DISPATCH_TIMEOUT" } });
    } finally {
      await prepared.session.close();
    }
  });

  it("returns a stateless preparation error when the target cannot be launched", async () => {
    const prepared = await prepareMcpStdio(
      { type: "mcp.stdio", command: "this-command-does-not-exist-mpas", args: [] },
      "ghp_test",
      pluginProtocolVersion,
    );

    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.error.code).toBe("TARGET_UNAVAILABLE");
    }
  });
});
