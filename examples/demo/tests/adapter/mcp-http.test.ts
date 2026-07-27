import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { prepareMcpHttp, type McpHttpTarget } from "../../src/adapter/dispatch/mcp-http.js";

let server: http.Server | undefined;
let initializedProtocolVersion: string | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  initializedProtocolVersion = undefined;
});

async function startMcpServer(toolDelayMs = 0): Promise<{ url: string }> {
  server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method === "GET") {
        response.statusCode = 405;
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        response.statusCode = 204;
        response.end();
        return;
      }
      const json = JSON.parse(body);
      if (json.method === "notifications/initialized") {
        response.statusCode = 202;
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      if (json.method === "initialize") {
        initializedProtocolVersion = json.params.protocolVersion;
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: {
              protocolVersion: json.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "http-test-mcp-server", version: "1.0.0" },
            },
          }),
        );
        return;
      }
      setTimeout(() => {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: {
              name: json.params.name,
              arguments: json.params.arguments,
              authorization: request.headers.authorization,
            },
          }),
        );
      }, toolDelayMs);
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }

  return { url: `http://127.0.0.1:${address.port}` };
}

describe("prepareMcpHttp", () => {
  it("calls an HTTP MCP endpoint and injects credentials", async () => {
    const { url } = await startMcpServer();
    const target: McpHttpTarget = {
      type: "mcp.http",
      url,
      headers: {
        authorization: "Bearer {{credential:github-mirror-token}}",
      },
    };

    const prepared = await prepareMcpHttp(target, "ghp_test", "2024-11-05");
    expect(prepared.ok).toBe(true);
    expect(initializedProtocolVersion).toBe("2024-11-05");
    if (!prepared.ok) {
      return;
    }
    try {
      const result = await prepared.session.transmit("create_issue_mirror", {
        owner: "oma3dao",
        repo: "app-registry",
        title: "hello",
      });

      expect(result).toMatchObject({
        ok: true,
        result: {
          name: "create_issue_mirror",
          arguments: {
            owner: "oma3dao",
            repo: "app-registry",
            title: "hello",
          },
          authorization: "Bearer ghp_test",
        },
      });
    } finally {
      await prepared.session.close();
    }
  });

  it("returns DISPATCH_TIMEOUT when the HTTP MCP endpoint does not respond in time", async () => {
    const { url } = await startMcpServer(100);
    const prepared = await prepareMcpHttp(
      { type: "mcp.http", url, timeoutMs: 50 },
      "ghp_test",
      "2024-11-05",
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    try {
      const result = await prepared.session.transmit("create_issue_mirror", {
        owner: "oma3dao",
        repo: "app-registry",
        title: "hello",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "DISPATCH_TIMEOUT",
        },
      });
    } finally {
      await prepared.session.close();
    }
  });
});
