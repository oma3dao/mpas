import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { prepareMcpHttp, type McpHttpTarget } from "../../src/adapter/dispatch/mcp-http.js";

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startEchoServer(): Promise<{ url: string }> {
  server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const json = JSON.parse(body);
      response.setHeader("content-type", "application/json");
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
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }

  return { url: `http://127.0.0.1:${address.port}` };
}

async function startSlowServer(delayMs: number): Promise<{ url: string }> {
  server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const json = JSON.parse(body);
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: {
              name: json.params.name,
              arguments: json.params.arguments,
            },
          }),
        );
      }, delayMs);
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
    const { url } = await startEchoServer();
    const target: McpHttpTarget = {
      type: "mcp.http",
      url,
      headers: {
        authorization: "Bearer {{credential:github-test-token}}",
      },
    };

    const prepared = await prepareMcpHttp(target, "ghp_test");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const result = await prepared.session.transmit("create_issue", {
      owner: "oma3dao",
      repo: "app-registry",
      title: "hello",
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        name: "create_issue",
        arguments: {
          owner: "oma3dao",
          repo: "app-registry",
          title: "hello",
        },
        authorization: "Bearer ghp_test",
      },
    });
  });

  it("returns DISPATCH_TIMEOUT when the HTTP MCP endpoint does not respond in time", async () => {
    const { url } = await startSlowServer(100);
    const prepared = await prepareMcpHttp({ type: "mcp.http", url, timeoutMs: 10 }, "ghp_test");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const result = await prepared.session.transmit("create_issue", {
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
  });
});
