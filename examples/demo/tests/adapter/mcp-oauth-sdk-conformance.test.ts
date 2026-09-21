import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareMcpHttp } from "../../src/adapter/dispatch/mcp-http.js";
import {
  assertExactAuthorizationServerIssuer,
  OAuthIssuerMismatchError,
} from "../../src/adapter/oauth-discovery.js";
import { createOAuthFetchPolicy } from "../../src/adapter/oauth-fetch-policy.js";
import { loadFileOAuthClientProvider } from "../../src/adapter/oauth-operator.js";
import {
  pkceS256,
  startOAuthProtectedMcpFixture,
  type OAuthProtectedMcpFixture,
} from "../fixtures/oauth-protected-mcp.js";

let fixture: OAuthProtectedMcpFixture | undefined;
let credentialDir: string | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (credentialDir) await rm(credentialDir, { recursive: true, force: true });
  credentialDir = undefined;
  vi.restoreAllMocks();
});

class FixtureOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  savedVerifier?: string;
  savedTokens?: OAuthTokens;
  savedDiscovery?: OAuthDiscoveryState;

  constructor(readonly redirectUrl: URL) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "MPAS OAuth conformance fixture",
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return "fixture-state-with-at-least-256-bits-of-test-entropy-000000000000";
  }

  clientInformation(): OAuthClientInformationMixed {
    return { client_id: "fixture-public-client" };
  }

  tokens(): OAuthTokens | undefined {
    return this.savedTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.savedTokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.savedVerifier = codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    assertExactAuthorizationServerIssuer(state);
    this.savedDiscovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.savedDiscovery;
  }

  codeVerifier(): string {
    if (!this.savedVerifier) {
      throw new Error("missing fixture PKCE verifier");
    }
    return this.savedVerifier;
  }
}

describe("official MCP SDK OAuth conformance spike", () => {
  it("discovers metadata, starts PKCE, exchanges with an exact resource, and authenticates MCP", async () => {
    fixture = await startOAuthProtectedMcpFixture();
    const provider = new FixtureOAuthProvider(new URL("http://127.0.0.1:49152/oauth/callback"));
    const oauthFetch = createOAuthFetchPolicy({
      testOnlyAllowHttpLoopback: true,
      bearerTokenResourceUrl: fixture.resourceUrl,
    });

    await expect(auth(provider, { serverUrl: fixture.resourceUrl, fetchFn: oauthFetch }))
      .resolves.toBe("REDIRECT");
    expect(provider.authorizationUrl).toBeDefined();
    expect(provider.savedVerifier).toBeDefined();

    const authorizationUrl = provider.authorizationUrl!;
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${fixture.origin}/authorize`);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("fixture-public-client");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(provider.redirectUrl.toString());
    expect(authorizationUrl.searchParams.get("resource")).toBe(fixture.resourceUrl);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(pkceS256(provider.savedVerifier!));
    expect(authorizationUrl.searchParams.get("state")).toBe(provider.state());

    await expect(auth(provider, {
      serverUrl: fixture.resourceUrl,
      authorizationCode: "fixture-code",
      fetchFn: oauthFetch,
    })).resolves.toBe("AUTHORIZED");
    expect(provider.savedTokens).toMatchObject({
      access_token: "fixture-access-token",
      refresh_token: "fixture-refresh-token",
      token_type: "Bearer",
    });
    expect(fixture.tokenRequests).toHaveLength(1);
    expect(fixture.tokenRequests[0].get("resource")).toBe(fixture.resourceUrl);

    const authenticatedTransport = new StreamableHTTPClientTransport(new URL(fixture.resourceUrl), {
      authProvider: provider,
    });
    const authenticatedClient = new Client({ name: "oauth-spike", version: "1.0.0" });
    try {
      await authenticatedClient.connect(authenticatedTransport);
      const result = await authenticatedClient.callTool({ name: "fixture_tool", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "authorized" }]);
      expect(fixture.requests.some((request) =>
        request.path === "/mcp" && request.authorization === "Bearer fixture-access-token"
      )).toBe(true);
    } finally {
      await authenticatedClient.close().catch(() => {});
    }
  });

  it("refreshes after an upstream 401 and persists rotated access and refresh tokens", async () => {
    fixture = await startOAuthProtectedMcpFixture();
    const provider = new FixtureOAuthProvider(new URL("http://127.0.0.1:49152/oauth/callback"));
    provider.savedTokens = {
      access_token: "expired-access-token",
      refresh_token: "fixture-refresh-token",
      token_type: "Bearer",
      expires_in: 0,
    };

    const transport = new StreamableHTTPClientTransport(new URL(fixture.resourceUrl), {
      authProvider: provider,
    });
    const client = new Client({ name: "oauth-refresh-spike", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "fixture_tool", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "authorized" }]);
      expect(provider.savedTokens).toMatchObject({
        access_token: "fixture-refreshed-access-token",
        refresh_token: "fixture-rotated-refresh-token",
      });
      expect(fixture.tokenRequests).toHaveLength(1);
      expect(fixture.tokenRequests[0].get("grant_type")).toBe("refresh_token");
      expect(fixture.tokenRequests[0].get("refresh_token")).toBe("fixture-refresh-token");
      expect(fixture.tokenRequests[0].get("resource")).toBe(fixture.resourceUrl);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("atomically retains rotated tokens in the file-backed CA provider", async () => {
    fixture = await startOAuthProtectedMcpFixture();
    credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-refresh-"));
    const credentialHandle = "fixture-oauth";
    const credentialPath = join(credentialDir, `${credentialHandle}.json`);
    await writeFile(credentialPath, `${JSON.stringify({
      version: 1,
      session: "fixture-session",
      credentialHandle,
      applicationDid: "did:web:fixture.example",
      resourceUrl: fixture.resourceUrl,
      state: "fixture-state-with-at-least-256-bits-of-test-entropy-000000000000",
      redirectUrl: "http://127.0.0.1:49152/oauth/callback",
      clientInformation: { client_id: "fixture-public-client" },
      tokens: {
        access_token: "expired-access-token",
        refresh_token: "fixture-refresh-token",
        token_type: "Bearer",
        expires_in: 0,
      },
      tokensSavedAt: "2020-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });

    const provider = await loadFileOAuthClientProvider(
      "fixture-session",
      credentialHandle,
      "did:web:fixture.example",
      fixture.resourceUrl,
      credentialDir,
    );
    expect(provider).toBeDefined();

    const transport = new StreamableHTTPClientTransport(new URL(fixture.resourceUrl), {
      authProvider: provider,
    });
    const client = new Client({ name: "file-oauth-refresh-spike", version: "1.0.0" });
    try {
      await client.connect(transport);
      const stored = JSON.parse(await readFile(credentialPath, "utf8"));
      expect(stored.tokens).toMatchObject({
        access_token: "fixture-refreshed-access-token",
        refresh_token: "fixture-rotated-refresh-token",
      });
      expect(Date.parse(stored.tokensSavedAt)).toBeGreaterThan(Date.parse("2020-01-01T00:00:00.000Z"));
    } finally {
      await client.close().catch(() => {});
    }
  });

  it.each([
    { name: "advertising only plain", options: { codeChallengeMethodsSupported: ["plain"] } },
    { name: "omitting PKCE metadata", options: { omitCodeChallengeMethodsSupported: true } },
  ])("rejects authorization-server metadata $name", async ({ options }) => {
    fixture = await startOAuthProtectedMcpFixture(options);
    const provider = new FixtureOAuthProvider(new URL("http://127.0.0.1:49152/oauth/callback"));
    const oauthFetch = createOAuthFetchPolicy({
      testOnlyAllowHttpLoopback: true,
      bearerTokenResourceUrl: fixture.resourceUrl,
    });

    await expect(auth(provider, { serverUrl: fixture.resourceUrl, fetchFn: oauthFetch })).rejects.toThrow();
    expect(provider.authorizationUrl).toBeUndefined();
    expect(provider.savedVerifier).toBeUndefined();
  });

  it("rejects an issuer mismatch through the CA provider validation wrapper", async () => {
    fixture = await startOAuthProtectedMcpFixture({
      authorizationServerIssuer: "https://attacker.invalid/issuer",
    });
    const provider = new FixtureOAuthProvider(new URL("http://127.0.0.1:49152/oauth/callback"));
    const oauthFetch = createOAuthFetchPolicy({
      testOnlyAllowHttpLoopback: true,
      bearerTokenResourceUrl: fixture.resourceUrl,
    });

    await expect(auth(provider, { serverUrl: fixture.resourceUrl, fetchFn: oauthFetch }))
      .rejects.toBeInstanceOf(OAuthIssuerMismatchError);
    expect(provider.authorizationUrl).toBeUndefined();
    expect(provider.savedVerifier).toBeUndefined();
  });
});

describe("adapter tool-call boundary (not upstream SDK initialization)", () => {
  it.each([200, 401, 403, 307, 308] as const)("keeps file-backed authority unchanged after HTTP %s with and without refresh tokens", async (status) => {
    fixture = await startOAuthProtectedMcpFixture({
      toolStatus: status,
      toolChallenge: 'Bearer error="insufficient_scope", scope="SECRET_SCOPE admin", resource_metadata="http://127.0.0.1:1/SECRET_METADATA"',
      toolErrorBody: "SECRET_BODY fixture-access-token fixture-refresh-token",
    });
    credentialDir = await mkdtemp(join(tmpdir(), "mpas-transport-authority-"));
    for (const refresh of [false, true]) {
      const credentialPath = join(credentialDir, "fixture-oauth.json");
      const stored = {
        version: 1, session: "fixture-session", credentialHandle: "fixture-oauth",
        applicationDid: "did:web:fixture.example", resourceUrl: fixture.resourceUrl,
        state: "fixture-unchanged-state", redirectUrl: "http://127.0.0.1:49152/oauth/callback",
        clientInformation: { client_id: "fixture-public-client" },
        tokens: { access_token: "fixture-access-token", token_type: "Bearer", scope: "mcp:tools", expires_in: 3600,
          ...(refresh ? { refresh_token: "fixture-refresh-token" } : {}) },
        tokensSavedAt: new Date().toISOString(),
      };
      await writeFile(credentialPath, JSON.stringify(stored), { mode: 0o600 });
      const provider = await loadFileOAuthClientProvider("fixture-session", "fixture-oauth", "did:web:fixture.example", fixture.resourceUrl, credentialDir);
      expect(provider).toBeDefined();
      if (!provider) throw new Error("Fixture provider missing");
      const mutations = ["saveTokens", "saveClientInformation", "saveCodeVerifier", "saveDiscoveryState", "redirectToAuthorization"] as const;
      const spies = mutations.map(method => vi.spyOn(provider, method));
      const fetchCalls = vi.spyOn(globalThis, "fetch");
      const prepared = await prepareMcpHttp({ type: "mcp.http", url: fixture.resourceUrl, timeoutMs: 1000 }, undefined, "2024-11-05", provider);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error("Fixture preparation failed");
      const before = await readFile(credentialPath, "utf8");
      const count = fixture.toolEffects.length;
      try {
        const result = await prepared.session.transmit("fixture_tool", { exact: "signed argument" });
        if (status === 200) expect(result).toEqual({ ok: true, result: { content: [{ type: "text", text: "authorized" }] } });
        else expect(result).toMatchObject({ ok: false, error: {
          code: status === 401 ? "OAUTH_AUTHENTICATION_FAILED" : status === 403 ? "OAUTH_SCOPE_DEMAND" : "TRANSPORT_ERROR",
        } });
        expect(JSON.stringify(result)).not.toMatch(/SECRET_|fixture-access-token|fixture-refresh-token|hostile-replacement-session/);
        // The failed response's session header must not become session state.
        await prepared.session.transmit("fixture_tool", { exact: "second independent request" });
        expect(fixture.toolEffects.slice(count)).toEqual([
          { name: "fixture_tool", arguments: { exact: "signed argument" } },
          { name: "fixture_tool", arguments: { exact: "second independent request" } },
        ]);
        const attempts = fetchCalls.mock.calls.filter(([, init]) => typeof init?.body === "string" && JSON.parse(init.body).method === "tools/call");
        expect(attempts).toHaveLength(2);
        expect(attempts.every(([, init]) => init?.redirect === "manual")).toBe(true);
        expect(fixture.requests.filter(r => r.rpcMethod === "tools/call").slice(-2).every(r => r.sessionId === "fixture-initial-session")).toBe(true);
        expect(fixture.requests.filter(r => !["/mcp"].includes(r.path))).toEqual([]);
        expect(fixture.tokenRequests).toEqual([]);
        expect(fixture.registrationRequests).toEqual([]);
        expect(fixture.revocationRequests).toEqual([]);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(await readFile(credentialPath, "utf8")).toBe(before);
        expect(await readdir(credentialDir)).toEqual(["fixture-oauth.json"]);
        expect(provider.tokens()).toEqual(stored.tokens);
        console.log(JSON.stringify({ case: "adapter transport authority", status, refresh, fetchAttempts: attempts.length,
          realToolRequests: 2, realTargetEffects: fixture.toolEffects.length - count, authFollowups: 0,
          persistenceMutations: 0, unchangedSessionHeader: true, unchangedTokenScopeFile: true }));
      } finally {
        await prepared.session.close();
        vi.restoreAllMocks();
      }
    }
  });

  it("isolates concurrent requests in one session without a shared retry flag", async () => {
    fixture = await startOAuthProtectedMcpFixture({ toolStatusByName: { expired: 401, scope: 403, success: 200 }, toolDelayMs: 20 });
    const provider = new FixtureOAuthProvider(new URL("http://127.0.0.1:49152/oauth/callback"));
    provider.savedTokens = { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", token_type: "Bearer", scope: "mcp:tools" };
    const before = JSON.stringify(provider);
    const prepared = await prepareMcpHttp({ type: "mcp.http", url: fixture.resourceUrl, timeoutMs: 1000 }, undefined, "2024-11-05", provider);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("Fixture preparation failed");
    try {
      const results = await Promise.all(["expired", "scope", "success"].map(name => prepared.session.transmit(name, {})));
      expect(results[0]).toMatchObject({ ok: false, error: { code: "OAUTH_AUTHENTICATION_FAILED" } });
      expect(results[1]).toMatchObject({ ok: false, error: { code: "OAUTH_SCOPE_DEMAND" } });
      expect(results[2]).toMatchObject({ ok: true });
      expect(fixture.toolEffects.map(effect => effect.name).sort()).toEqual(["expired", "scope", "success"]);
      expect(fixture.requests.filter(r => r.rpcMethod === "tools/call")).toHaveLength(3);
      expect(fixture.tokenRequests).toEqual([]);
      expect(fixture.registrationRequests).toEqual([]);
      expect(JSON.stringify(provider)).toBe(before);
      console.log(JSON.stringify({ case: "concurrent session boundary", toolRequests: 3, targetEffects: 3, authMutations: 0 }));
    } finally { await prepared.session.close(); }
  });
});
