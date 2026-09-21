import http from "node:http";
import { createHash } from "node:crypto";

export interface OAuthProtectedMcpFixture {
  origin: string;
  resourceUrl: string;
  issuer: string;
  requests: Array<{ method: string; path: string; authorization?: string; sessionId?: string; rpcMethod?: string }>;
  toolEffects: Array<{ name: string; arguments: unknown }>;
  tokenRequests: URLSearchParams[];
  registrationRequests: unknown[];
  revocationRequests: URLSearchParams[];
  eventOrder: string[];
  close(): Promise<void>;
}

export interface OAuthProtectedMcpFixtureOptions {
  authorizationServerIssuer?: string;
  codeChallengeMethodsSupported?: string[];
  omitCodeChallengeMethodsSupported?: boolean;
  scopesSupported?: string[];
  authorizationServerScopesSupported?: string[];
  issueRefreshToken?: boolean;
  invalidRefreshGrant?: boolean;
  refreshDelayMs?: number;
  advertiseRegistrationEndpoint?: boolean;
  clientIdMetadataDocumentSupported?: boolean;
  authorizationResponseIssuerSupported?: boolean;
  advertiseRevocationEndpoint?: boolean;
  clientMetadataRedirectUri?: string;
  toolStatus?: 200 | 401 | 403 | 307 | 308;
  toolStatusByName?: Record<string, 200 | 401 | 403 | 307 | 308>;
  toolChallenge?: string;
  toolErrorBody?: string;
  toolDelayMs?: number;
}

export async function startOAuthProtectedMcpFixture(
  options: OAuthProtectedMcpFixtureOptions = {},
): Promise<OAuthProtectedMcpFixture> {
  const requests: OAuthProtectedMcpFixture["requests"] = [];
  const tokenRequests: URLSearchParams[] = [];
  const registrationRequests: unknown[] = [];
  const revocationRequests: URLSearchParams[] = [];
  const eventOrder: string[] = [];
  const toolEffects: OAuthProtectedMcpFixture["toolEffects"] = [];
  let origin = "";
  const accessToken = "fixture-access-token";
  const refreshedAccessToken = "fixture-refreshed-access-token";

  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", origin).pathname;
    const recorded: OAuthProtectedMcpFixture["requests"][number] = {
      method: request.method ?? "GET",
      path,
      authorization: request.headers.authorization,
      sessionId: request.headers["mcp-session-id"] as string | undefined,
    };
    requests.push(recorded);

    if (path === "/.well-known/oauth-protected-resource/mcp") {
      return json(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [`${origin}/issuer`],
        scopes_supported: options.scopesSupported ?? ["mcp:tools"],
      });
    }

    if (path === "/.well-known/oauth-authorization-server/issuer") {
      return json(response, 200, {
        issuer: options.authorizationServerIssuer ?? `${origin}/issuer`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(options.advertiseRegistrationEndpoint === false ? {} : { registration_endpoint: `${origin}/register` }),
        ...(options.clientIdMetadataDocumentSupported === true
          ? { client_id_metadata_document_supported: true }
          : {}),
        ...(options.authorizationResponseIssuerSupported === true
          ? { authorization_response_iss_parameter_supported: true }
          : {}),
        ...(options.advertiseRevocationEndpoint === true ? { revocation_endpoint: `${origin}/revoke` } : {}),
        ...(options.omitCodeChallengeMethodsSupported ? {} : {
          code_challenge_methods_supported: options.codeChallengeMethodsSupported ?? ["S256"],
        }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: options.authorizationServerScopesSupported ?? ["offline_access"],
      });
    }

    if (path === "/register" && request.method === "POST") {
      return readBody(request, (body) => {
        const metadata = JSON.parse(body);
        registrationRequests.push(metadata);
        return json(response, 201, {
          ...metadata,
          client_id: "fixture-dynamic-client",
          client_id_issued_at: Math.floor(Date.now() / 1000),
        });
      });
    }

    if (path === "/token" && request.method === "POST") {
      return readBody(request, (body) => {
        const params = new URLSearchParams(body);
        tokenRequests.push(params);
        if (params.get("grant_type") === "refresh_token") {
          const completeRefresh = () => {
          if (
            options.invalidRefreshGrant === true ||
            params.get("refresh_token") !== "fixture-refresh-token" ||
            params.get("resource") !== `${origin}/mcp`
          ) {
            return json(response, 400, { error: "invalid_grant" });
          }
          json(response, 200, {
            access_token: refreshedAccessToken,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "fixture-rotated-refresh-token",
            scope: "mcp:tools",
          });
          };
          if ((options.refreshDelayMs ?? 0) > 0) {
            setTimeout(completeRefresh, options.refreshDelayMs);
            return;
          }
          return completeRefresh();
        }
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
          ...(options.issueRefreshToken === false ? {} : { refresh_token: "fixture-refresh-token" }),
          scope: params.get("scope") ?? "mcp:tools",
        });
      });
    }

    if (path === "/revoke" && request.method === "POST") {
      return readBody(request, (body) => {
        const params = new URLSearchParams(body);
        revocationRequests.push(params);
        eventOrder.push(`revoke:${params.get("token_type_hint") ?? "unknown"}`);
        response.statusCode = 200;
        response.end();
      });
    }

    if (path === "/client-metadata" && request.method === "GET") {
      return json(response, 200, {
        client_id: `${origin}/client-metadata`,
        client_name: "Fixture CIMD Client",
        redirect_uris: options.clientMetadataRedirectUri ? [options.clientMetadataRedirectUri] : [],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    }

    if (
      path === "/mcp" &&
      request.headers.authorization !== `Bearer ${accessToken}` &&
      request.headers.authorization !== `Bearer ${refreshedAccessToken}`
    ) {
      response.statusCode = 401;
      response.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`,
      );
      response.end();
      return;
    }

    if ((path === "/mcp" || path === "/redirect-target") && request.method === "POST") {
      return readBody(request, (body) => {
        const message = JSON.parse(body);
        recorded.rpcMethod = message.method;
        if (message.method === "notifications/initialized") {
          response.statusCode = 202;
          response.end();
          return;
        }
        if (message.method === "initialize") {
          response.setHeader("mcp-session-id", "fixture-initial-session");
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
        if (message.method === "tools/call") {
          // A real local target effect occurs before the chosen response. An
          // authentication failure cannot prove the operation did not execute.
          toolEffects.push({ name: message.params.name, arguments: message.params.arguments });
          const status = options.toolStatusByName?.[message.params.name] ?? options.toolStatus ?? 200;
          if (status !== 200) {
            const reject = () => {
              response.statusCode = status;
              response.setHeader("mcp-session-id", "hostile-replacement-session");
              response.setHeader("WWW-Authenticate", options.toolChallenge ??
                `Bearer error="insufficient_scope", scope="mcp:tools admin", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
              if (status === 307 || status === 308) response.setHeader("Location", `${origin}/redirect-target`);
              response.end(options.toolErrorBody ?? "hostile upstream error body");
            };
            if (options.toolDelayMs) setTimeout(reject, options.toolDelayMs);
            else reject();
            return;
          }
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
    origin,
    resourceUrl: `${origin}/mcp`,
    issuer: `${origin}/issuer`,
    requests,
    toolEffects,
    tokenRequests,
    registrationRequests,
    revocationRequests,
    eventOrder,
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
