import http from "node:http";
import { createHash } from "node:crypto";

export interface OAuthProtectedMcpFixture {
  resourceUrl: string;
  issuer: string;
  requests: Array<{ method: string; path: string; authorization?: string }>;
  tokenRequests: URLSearchParams[];
  close(): Promise<void>;
}

export async function startOAuthProtectedMcpFixture(): Promise<OAuthProtectedMcpFixture> {
  const requests: OAuthProtectedMcpFixture["requests"] = [];
  const tokenRequests: URLSearchParams[] = [];
  let origin = "";
  const accessToken = "fixture-access-token";

  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", origin).pathname;
    requests.push({
      method: request.method ?? "GET",
      path,
      authorization: request.headers.authorization,
    });

    if (path === "/.well-known/oauth-protected-resource/mcp") {
      return json(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [`${origin}/issuer`],
        scopes_supported: ["mcp:tools"],
      });
    }

    if (path === "/.well-known/oauth-authorization-server/issuer") {
      return json(response, 200, {
        issuer: `${origin}/issuer`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }

    if (path === "/token" && request.method === "POST") {
      return readBody(request, (body) => {
        const params = new URLSearchParams(body);
        tokenRequests.push(params);
        if (
          params.get("grant_type") !== "authorization_code" ||
          params.get("code") !== "fixture-code" ||
          params.get("resource") !== `${origin}/mcp` ||
          !params.get("code_verifier")
        ) {
          return json(response, 400, { error: "invalid_grant" });
        }
        return json(response, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "fixture-refresh-token",
          scope: "mcp:tools",
        });
      });
    }

    if (path === "/mcp" && request.headers.authorization !== `Bearer ${accessToken}`) {
      response.statusCode = 401;
      response.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`,
      );
      response.end();
      return;
    }

    if (path === "/mcp" && request.method === "POST") {
      return readBody(request, (body) => {
        const message = JSON.parse(body);
        if (message.method === "notifications/initialized") {
          response.statusCode = 202;
          response.end();
          return;
        }
        if (message.method === "initialize") {
          return json(response, 200, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-fixture", version: "1.0.0" },
            },
          });
        }
        return json(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "authorized" }] },
        });
      });
    }

    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth fixture did not bind to a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;

  return {
    resourceUrl: `${origin}/mcp`,
    issuer: `${origin}/issuer`,
    requests,
    tokenRequests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function readBody(request: http.IncomingMessage, callback: (body: string) => void): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => callback(body));
}
