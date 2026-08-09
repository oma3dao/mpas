import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactAuthorizationServerIssuer,
  OAuthIssuerMismatchError,
} from "../../src/adapter/oauth-discovery.js";
import { createOAuthFetchPolicy } from "../../src/adapter/oauth-fetch-policy.js";
import {
  pkceS256,
  startOAuthProtectedMcpFixture,
  type OAuthProtectedMcpFixture,
} from "../fixtures/oauth-protected-mcp.js";

let fixture: OAuthProtectedMcpFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
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
