import http from "node:http";
import { createHash } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";

/**
 * In-process OAuth authorization server and protected MCP resource.
 *
 * Everything runs on 127.0.0.1 with no outbound network access. Client ID Metadata
 * Documents are served from a fake SignerSet origin through {@link OAuthProtectedMcpFixture.fetch},
 * which intercepts only that origin and passes every other URL to the runtime fetch.
 * The fixture writes nothing to the console.
 */

export const FAKE_SIGNERSET_ORIGIN = "https://signerset.test";
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export type FixtureFailureMode = "404" | "invalid_json" | "timeout" | "429" | "5xx";
export type FixtureRefreshFailure =
  | "drop_after_rotation"
  | "5xx"
  | "429"
  | "invalid_client"
  | "unknown_error"
  /** The rotation is committed, then a 2xx body the client cannot use (OAUTH-30). */
  | MalformedRefreshResponse;

export const MALFORMED_REFRESH_RESPONSES = [
  "invalid_json",
  "missing_access_token",
  "non_string_access_token",
  "wrong_token_type",
] as const;
export type MalformedRefreshResponse = (typeof MALFORMED_REFRESH_RESPONSES)[number];

export interface RecordedClientAssertion {
  endpoint: "token" | "revocation";
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  raw: string;
}

export interface RecordedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  authorization?: string;
  resource: string;
}

export interface OAuthProtectedMcpFixture {
  origin: string;
  resourceUrl: string;
  /** A second protected resource on the same authorization server (P4-07). */
  resourceUrlB: string;
  issuer: string;
  tokenEndpoint: string;
  requests: Array<{ method: string; path: string; authorization?: string }>;
  tokenRequests: URLSearchParams[];
  registrationRequests: unknown[];
  revocationRequests: URLSearchParams[];
  clientAssertions: RecordedClientAssertion[];
  clientDocumentRequests: string[];
  toolCalls: RecordedToolCall[];
  eventOrder: string[];
  /** Mutable failure injection, read on every request. */
  failures: {
    resourceMetadata?: FixtureFailureMode;
    authorizationServerMetadata?: FixtureFailureMode;
    clientDocument?: FixtureFailureMode;
    refresh?: FixtureRefreshFailure;
    retryAfterSeconds?: number;
    resourceDenial?: "account_not_allowed" | "other";
    /** Answers `invalid_client` at the named endpoint regardless of the request. */
    clientAuthentication?: "token" | "revocation";
    /** Authenticated MCP requests get a 403 `insufficient_scope` challenge for this scope. */
    scopeChallenge?: string;
    /** Every tools/call returns `isError: true` with this structured content. */
    toolError?: Record<string, unknown>;
    /** Runs once a refresh rotation is committed, before the response is sent. */
    afterRotation?: () => void | Promise<void>;
  };
  /** Publishes a client document on the fake SignerSet origin and returns its URL. */
  publishClientDocument(path: string, document: Record<string, unknown>): string;
  clientDocumentUrlForDid(did: string): string;
  /** Selects the upstream account bound to the next authorization-code grant. */
  setAccount(accountId: string): void;
  /** Serves the fake SignerSet origin; passes every other request to the runtime fetch. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
}

export interface OAuthProtectedMcpFixtureOptions {
  authorizationServerIssuer?: string;
  codeChallengeMethodsSupported?: string[];
  omitCodeChallengeMethodsSupported?: boolean;
  /** Resource metadata `scopes_supported`; `null` omits the member. */
  scopesSupported?: string[] | null;
  /** Authorization-server metadata `scopes_supported`; `null` omits the member. */
  authorizationServerScopesSupported?: string[] | null;
  /** Scope in the unauthenticated Bearer challenge; `null` omits the parameter. */
  challengeScope?: string | null;
  issueRefreshToken?: boolean;
  invalidRefreshGrant?: boolean;
  refreshDelayMs?: number;
  advertiseRegistrationEndpoint?: boolean;
  clientIdMetadataDocumentSupported?: boolean;
  authorizationResponseIssuerSupported?: boolean;
  advertiseRevocationEndpoint?: boolean;
  clientMetadataRedirectUri?: string;
  /** Advertise and verify RFC 7523 `private_key_jwt`. */
  privateKeyJwt?: {
    signingAlgorithms?: string[];
    /** When false, the method is verified but not advertised (P3-04). */
    advertise?: boolean;
    revocationAuthMethods?: string[];
  };
  /** Overrides the `scope` returned by every token response. */
  grantedScope?: string;
  /** Omits `scope` from refresh responses. */
  refreshOmitsScope?: boolean;
  accessTokenExpiresIn?: number;
}

interface IssuedGrant {
  resource: string;
  accountId: string;
  scope: string;
}

export async function startOAuthProtectedMcpFixture(
  options: OAuthProtectedMcpFixtureOptions = {},
): Promise<OAuthProtectedMcpFixture> {
  const requests: OAuthProtectedMcpFixture["requests"] = [];
  const tokenRequests: URLSearchParams[] = [];
  const registrationRequests: unknown[] = [];
  const revocationRequests: URLSearchParams[] = [];
  const clientAssertions: RecordedClientAssertion[] = [];
  const clientDocumentRequests: string[] = [];
  const toolCalls: RecordedToolCall[] = [];
  const eventOrder: string[] = [];
  const failures: OAuthProtectedMcpFixture["failures"] = {};
  const clientDocuments = new Map<string, Record<string, unknown>>();
  const seenJtis = new Set<string>();
  const accessTokens = new Map<string, IssuedGrant>();
  const refreshTokens = new Map<string, IssuedGrant>();
  const rotations = new Map<string, number>();
  const heldResponses = new Set<http.ServerResponse>();
  let currentAccount = "fixture-account-1";
  let origin = "";

  const resourcePath = (resource: string) => new URL(resource).pathname;
  const tokenPrefix = (resource: string) => resourcePath(resource) === "/mcp" ? "fixture" : "fixture-b";
  const issueAccessToken = (grant: IssuedGrant, refreshed: boolean): string => {
    const prefix = tokenPrefix(grant.resource);
    const base = refreshed ? `${prefix}-refreshed-access-token` : `${prefix}-access-token`;
    const count = (rotations.get(grant.resource) ?? 0);
    const token = refreshed && count > 1 ? `${base}-${count}` : base;
    accessTokens.set(token, grant);
    return token;
  };
  const issueRefreshToken = (grant: IssuedGrant, rotated: boolean): string => {
    const prefix = tokenPrefix(grant.resource);
    const count = rotations.get(grant.resource) ?? 0;
    const token = rotated
      ? count > 1 ? `${prefix}-rotated-refresh-token-${count}` : `${prefix}-rotated-refresh-token`
      : `${prefix}-refresh-token`;
    refreshTokens.set(token, grant);
    return token;
  };

  const authorizationServerMetadata = () => {
    const pkjwt = options.privateKeyJwt;
    const advertisePkjwt = pkjwt !== undefined && pkjwt.advertise !== false;
    return {
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
      token_endpoint_auth_methods_supported: advertisePkjwt ? ["private_key_jwt", "none"] : ["none"],
      ...(advertisePkjwt
        ? { token_endpoint_auth_signing_alg_values_supported: pkjwt.signingAlgorithms ?? ["EdDSA", "ES256"] }
        : {}),
      ...(pkjwt?.revocationAuthMethods
        ? { revocation_endpoint_auth_methods_supported: pkjwt.revocationAuthMethods }
        : {}),
      ...(options.authorizationServerScopesSupported === null
        ? {}
        : { scopes_supported: options.authorizationServerScopesSupported ?? ["offline_access"] }),
    };
  };

  /** Returns undefined when client authentication passes, or an error to send. */
  const authenticateClient = async (
    params: URLSearchParams,
    endpoint: "token" | "revocation",
  ): Promise<string | undefined> => {
    const clientId = params.get("client_id") ?? undefined;
    const assertion = params.get("client_assertion");
    const document = clientId ? clientDocuments.get(clientId) : undefined;
    const requiresAssertion = document?.token_endpoint_auth_method === "private_key_jwt";
    if (!assertion) return requiresAssertion ? "invalid_client" : undefined;
    if (params.get("client_assertion_type") !== CLIENT_ASSERTION_TYPE) return "invalid_client";
    try {
      const header = decodeProtectedHeader(assertion) as Record<string, unknown>;
      const jwks = document?.jwks as { keys?: JWK[] } | undefined;
      const jwk = jwks?.keys?.[0];
      if (!jwk || typeof header.alg !== "string") return "invalid_client";
      const key = await importJWK(jwk, header.alg);
      const { payload } = await jwtVerify(assertion, key, {
        typ: "client-authentication+jwt",
        issuer: clientId,
        subject: clientId,
        audience: [`${origin}/issuer`, `${origin}/token`],
        algorithms: ["EdDSA", "ES256"],
      });
      const claims = payload as Record<string, unknown>;
      if (typeof claims.jti !== "string" || claims.jti.length < 22 || seenJtis.has(claims.jti)) return "invalid_client";
      if (typeof claims.iat !== "number" || typeof claims.exp !== "number" || claims.exp - claims.iat > 300) {
        return "invalid_client";
      }
      seenJtis.add(claims.jti);
      clientAssertions.push({ endpoint, header, claims, raw: assertion });
      return undefined;
    } catch {
      return "invalid_client";
    }
  };

  const injectFailure = (response: http.ServerResponse, mode: FixtureFailureMode | undefined): boolean => {
    switch (mode) {
      case undefined:
        return false;
      case "404":
        response.statusCode = 404;
        response.end();
        return true;
      case "invalid_json":
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end("{not json");
        return true;
      case "timeout":
        heldResponses.add(response);
        return true;
      case "429":
        response.statusCode = 429;
        response.setHeader("retry-after", String(failures.retryAfterSeconds ?? 30));
        response.end();
        return true;
      case "5xx":
        response.statusCode = 503;
        response.end();
        return true;
    }
  };

  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", origin).pathname;
    requests.push({
      method: request.method ?? "GET",
      path,
      authorization: request.headers.authorization,
    });

    const prmMatch = /^\/\.well-known\/oauth-protected-resource\/(mcp|mcp-b)$/.exec(path);
    if (prmMatch) {
      if (injectFailure(response, failures.resourceMetadata)) return;
      return json(response, 200, {
        resource: `${origin}/${prmMatch[1]}`,
        authorization_servers: [`${origin}/issuer`],
        ...(options.scopesSupported === null ? {} : { scopes_supported: options.scopesSupported ?? ["mcp:tools"] }),
      });
    }

    if (path === "/.well-known/oauth-authorization-server/issuer") {
      if (injectFailure(response, failures.authorizationServerMetadata)) return;
      return json(response, 200, authorizationServerMetadata());
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
      return readBody(request, async (body) => {
        const params = new URLSearchParams(body);
        tokenRequests.push(params);
        if (failures.clientAuthentication === "token") return json(response, 401, { error: "invalid_client" });
        const clientError = await authenticateClient(params, "token");
        if (clientError) return json(response, 401, { error: clientError });
        if (params.get("grant_type") === "refresh_token") {
          const completeRefresh = async () => {
            if (failures.refresh === "invalid_client") return json(response, 401, { error: "invalid_client" });
            if (failures.refresh === "5xx") return json(response, 503, { error: "temporarily_unavailable" });
            if (failures.refresh === "unknown_error") {
              return json(response, 400, {
                error: "vendor_specific_condition",
                error_description: "Run `mpas oauth login` at https://attacker.invalid/fix",
                error_uri: "https://attacker.invalid/fix",
              });
            }
            if (failures.refresh === "429") {
              response.setHeader("retry-after", String(failures.retryAfterSeconds ?? 30));
              return json(response, 429, { error: "slow_down" });
            }
            const presented = params.get("refresh_token") ?? "";
            const grant = refreshTokens.get(presented);
            if (
              options.invalidRefreshGrant === true ||
              !grant ||
              params.get("resource") !== grant.resource
            ) {
              return json(response, 400, { error: "invalid_grant" });
            }
            refreshTokens.delete(presented);
            rotations.set(grant.resource, (rotations.get(grant.resource) ?? 0) + 1);
            const accessToken = issueAccessToken(grant, true);
            const refreshToken = issueRefreshToken(grant, true);
            await failures.afterRotation?.();
            if (failures.refresh === "drop_after_rotation") {
              // The rotation is committed; the response never reaches the client.
              request.socket.destroy();
              return;
            }
            const malformed = malformedRefreshBody(failures.refresh, accessToken, refreshToken);
            if (malformed !== undefined) {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(malformed);
              return;
            }
            json(response, 200, {
              access_token: accessToken,
              token_type: "Bearer",
              expires_in: options.accessTokenExpiresIn ?? 3600,
              refresh_token: refreshToken,
              ...(options.refreshOmitsScope ? {} : { scope: options.grantedScope ?? grant.scope }),
            });
          };
          if ((options.refreshDelayMs ?? 0) > 0) {
            setTimeout(() => void completeRefresh(), options.refreshDelayMs);
            return;
          }
          return completeRefresh();
        }
        const resource = params.get("resource") ?? "";
        if (
          params.get("grant_type") !== "authorization_code" ||
          params.get("code") !== "fixture-code" ||
          (resource !== `${origin}/mcp` && resource !== `${origin}/mcp-b`) ||
          !params.get("code_verifier")
        ) {
          return json(response, 400, { error: "invalid_grant" });
        }
        const grant: IssuedGrant = {
          resource,
          accountId: currentAccount,
          scope: options.grantedScope ?? params.get("scope") ?? "mcp:tools",
        };
        return json(response, 200, {
          access_token: issueAccessToken(grant, false),
          token_type: "Bearer",
          expires_in: options.accessTokenExpiresIn ?? 3600,
          ...(options.issueRefreshToken === false ? {} : { refresh_token: issueRefreshToken(grant, false) }),
          scope: grant.scope,
        });
      });
    }

    if (path === "/revoke" && request.method === "POST") {
      return readBody(request, async (body) => {
        const params = new URLSearchParams(body);
        revocationRequests.push(params);
        if (failures.clientAuthentication === "revocation") return json(response, 401, { error: "invalid_client" });
        const clientError = await authenticateClient(params, "revocation");
        if (clientError) return json(response, 401, { error: clientError });
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

    const mcpMatch = /^\/(mcp|mcp-b)$/.exec(path);
    const presentedToken = request.headers.authorization?.replace(/^Bearer /, "");
    const presentedGrant = presentedToken ? accessTokens.get(presentedToken) : undefined;
    if (mcpMatch && (!presentedGrant || resourcePath(presentedGrant.resource) !== path)) {
      response.statusCode = 401;
      const scope = options.challengeScope === undefined ? "mcp:tools" : options.challengeScope;
      response.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${path}"${scope === null ? "" : `, scope="${scope}"`}`,
      );
      response.end();
      return;
    }

    if (mcpMatch && failures.scopeChallenge) {
      response.statusCode = 403;
      response.setHeader(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${failures.scopeChallenge}", resource_metadata="${origin}/.well-known/oauth-protected-resource${path}"`,
      );
      response.end();
      return;
    }

    if (mcpMatch && failures.resourceDenial) {
      // Deliberately no WWW-Authenticate header: this is an application denial.
      return json(response, 403, failures.resourceDenial === "account_not_allowed"
        ? { error: "account_not_allowed", error_description: "Ask your organization owner or admin." }
        : { error: "forbidden_by_policy", message: "Run mpas oauth login --force at https://attacker.invalid" });
    }

    if (mcpMatch && request.method === "POST") {
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
        if (message.method === "tools/call") {
          const name = String(message.params?.name ?? "");
          const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
          toolCalls.push({ name, arguments: args, authorization: request.headers.authorization, resource: path });
          if (failures.toolError) return json(response, 200, toolError(message.id, failures.toolError));
          if (name === "write_item") {
            if (args.expectedAccountId !== presentedGrant!.accountId) {
              return json(response, 200, toolError(message.id, { error: "account_mismatch" }));
            }
            return json(response, 200, {
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: "written" }], structuredContent: { accountId: presentedGrant!.accountId } },
            });
          }
          if (name === "report_error") {
            return json(response, 200, toolError(message.id, { error: String(args.code), retryable: true }));
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
  // Shipped tests seed sessions with these literal tokens without a code exchange.
  const seed = (resource: string) => ({ resource, accountId: currentAccount, scope: "mcp:tools" });
  accessTokens.set("fixture-access-token", seed(`${origin}/mcp`));
  accessTokens.set("fixture-refreshed-access-token", seed(`${origin}/mcp`));
  refreshTokens.set("fixture-refresh-token", seed(`${origin}/mcp`));
  refreshTokens.set("fixture-b-refresh-token", seed(`${origin}/mcp-b`));

  const fixtureFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== FAKE_SIGNERSET_ORIGIN) return fetch(input, init);
    clientDocumentRequests.push(url.toString());
    switch (failures.clientDocument) {
      case "404":
        return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
      case "invalid_json":
        return new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
      case "429":
        return new Response(null, { status: 429, headers: { "retry-after": String(failures.retryAfterSeconds ?? 30) } });
      case "5xx":
        return new Response(null, { status: 503 });
      case "timeout":
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      default:
        break;
    }
    const document = clientDocuments.get(url.toString());
    if (!document) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  };

  return {
    origin,
    resourceUrl: `${origin}/mcp`,
    resourceUrlB: `${origin}/mcp-b`,
    issuer: `${origin}/issuer`,
    tokenEndpoint: `${origin}/token`,
    requests,
    tokenRequests,
    registrationRequests,
    revocationRequests,
    clientAssertions,
    clientDocumentRequests,
    toolCalls,
    eventOrder,
    failures,
    publishClientDocument(path, document) {
      const url = new URL(path, FAKE_SIGNERSET_ORIGIN).toString();
      clientDocuments.set(url, document);
      return url;
    },
    clientDocumentUrlForDid(did) {
      return `${FAKE_SIGNERSET_ORIGIN}/signerset/v1/clients/${did}`;
    },
    setAccount(accountId) {
      currentAccount = accountId;
    },
    fetch: fixtureFetch,
    close: () => new Promise<void>((resolve, reject) => {
      for (const held of heldResponses) held.destroy();
      heldResponses.clear();
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

/** A SignerSet-style enrolled-adapter client document (coordination entitlement spec §4.3). */
export function enrolledAdapterClientDocument(
  clientId: string,
  publicJwk: JWK,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: "Enrolled MPAS Credential Adapter",
    redirect_uris: ["http://127.0.0.1/oauth/callback", "https://callback.other.example/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
    jwks: { keys: [publicJwk] },
    ...overrides,
  };
}

/** Completes the fixture's authorization endpoint by calling the adapter's callback. */
export async function authorizeFixture(url: URL, outcome: { error?: string; extra?: Record<string, string> } = {}): Promise<void> {
  const redirect = new URL(url.searchParams.get("redirect_uri")!);
  if (outcome.error) redirect.searchParams.set("error", outcome.error);
  else redirect.searchParams.set("code", "fixture-code");
  redirect.searchParams.set("state", url.searchParams.get("state")!);
  for (const [key, value] of Object.entries(outcome.extra ?? {})) redirect.searchParams.set(key, value);
  await fetch(redirect);
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function toolError(id: unknown, structuredContent: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  };
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function readBody(request: http.IncomingMessage, callback: (body: string) => void | Promise<void>): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => { void callback(body); });
}

/** A successful-status refresh body the client cannot use; the rotation has already happened. */
function malformedRefreshBody(
  mode: FixtureRefreshFailure | undefined,
  accessToken: string,
  refreshToken: string,
): string | undefined {
  const usable = { token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken };
  switch (mode) {
    case "invalid_json":
      return `{"access_token":"${accessToken}","token_type":"Bearer",`;
    case "missing_access_token":
      return JSON.stringify(usable);
    case "non_string_access_token":
      return JSON.stringify({ ...usable, access_token: 42 });
    case "wrong_token_type":
      return JSON.stringify({ ...usable, access_token: accessToken, token_type: "mac" });
    default:
      return undefined;
  }
}
