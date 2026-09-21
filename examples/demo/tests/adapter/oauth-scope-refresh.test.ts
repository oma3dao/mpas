import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  classifyOAuthPrepareError,
  fileOAuthOperatorService,
  isAccessTokenExpired,
  isAccessTokenRefreshDue,
  oauthLoginCommand,
  OAuthReauthorizationRequiredError,
  prepareOAuthForDispatch,
  resolveRequestedOAuthScopes,
  type OAuthOperatorRequest,
  validateManagedOAuthSession,
  validateOAuthCallbackParameters,
} from "../../src/adapter/oauth-operator.js";
import {
  startOAuthProtectedMcpFixture,
  type OAuthProtectedMcpFixture,
} from "../fixtures/oauth-protected-mcp.js";

const applicationDid = "did:web:fixture.example";
const session = "fixture-session";
const credentialHandle = "fixture-oauth";
const localPrincipal = `local-os-user:${typeof process.getuid === "function" ? process.getuid() : "test"}`;

let fixture: OAuthProtectedMcpFixture | undefined;

function storedSession(
  resourceUrl: string,
  tokens: Record<string, unknown>,
  tokensSavedAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 2,
    session,
    credentialHandle,
    applicationDid,
    resourceUrl,
    owner: localPrincipal,
    sharing: { applicationDids: [applicationDid], operatorPrincipals: [localPrincipal] },
    binding: {
      applicationDid,
      resourceUrl,
      issuer: resourceUrl.replace(/\/mcp$/, "/issuer"),
      clientMode: "dynamic",
      clientId: "fixture-public-client",
      clientConfiguration: JSON.stringify({ type: "dynamic" }),
      scopeConfiguration: JSON.stringify({ scopes: ["mcp:tools"], refreshScope: "offline_access" }),
      requestedScopes: ["mcp:tools", "offline_access"],
      redirectUrl: "http://127.0.0.1:49152/oauth/callback",
    },
    clientInformation: { client_id: "fixture-public-client" },
    discovery: {
      authorizationServerUrl: resourceUrl.replace(/\/mcp$/, "/issuer"),
      resourceMetadata: { resource: resourceUrl },
      authorizationServerMetadata: {
        issuer: resourceUrl.replace(/\/mcp$/, "/issuer"),
        token_endpoint: resourceUrl.replace(/\/mcp$/, "/token"),
        code_challenge_methods_supported: ["S256"],
      },
    },
    tokens,
    tokensSavedAt,
    refreshJitterMs: 0,
    ...overrides,
  };
}

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("OAuth scope resolution and silent-failure reporting", () => {
  it("resolves advertised refresh scope without inventing permission scopes", () => {
    expect(resolveRequestedOAuthScopes({
      supportedScopes: ["offline_access", "read", "write", "claudeai"],
    })).toEqual({
      ok: true,
      scopes: ["offline_access"],
      warnings: [],
    });
  });

  it("rejects a configured scope that the server does not advertise", () => {
    const result = resolveRequestedOAuthScopes({
      configuredScopes: ["netlify:mcp"],
      supportedScopes: ["offline_access", "read", "write", "claudeai"],
    });
    expect(result).toMatchObject({
      ok: false,
      requestedScope: "netlify:mcp",
    });
    if (result.ok) return;
    expect(result.message).toContain("netlify:mcp");
    expect(result.message).toContain("offline_access, read, write, claudeai");
  });

  it("falls back to offline_access when the plugin refresh scope is not advertised", () => {
    const result = resolveRequestedOAuthScopes({
      refreshScope: "offline.access",
      supportedScopes: ["read", "offline_access"],
    });
    expect(result).toMatchObject({
      ok: true,
      scopes: ["offline_access"],
    });
    if (!result.ok) return;
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "OAUTH_REFRESH_SCOPE_NOT_ADVERTISED",
    })]);
  });

  it("errors when neither the plugin refresh scope nor offline_access is advertised", () => {
    const result = resolveRequestedOAuthScopes({
      refreshScope: "offline.access",
      configuredScopes: ["mcp:tools"],
      supportedScopes: ["mcp:tools"],
    });
    expect(result).toMatchObject({
      ok: false,
      requestedScope: "offline.access",
    });
    if (result.ok) return;
    expect(result.message).toContain("offline.access");
    expect(result.message).toContain("offline_access is not available");
  });

  it("selects offline_access when it is advertised only by the authorization server", () => {
    expect(resolveRequestedOAuthScopes({
      configuredScopes: ["mcp:tools"],
      supportedScopes: ["mcp:tools", "offline_access"],
    })).toEqual({
      ok: true,
      scopes: ["mcp:tools", "offline_access"],
      warnings: [],
    });
  });

  it("warns at login when no refresh_token is issued", async () => {
    fixture = await startOAuthProtectedMcpFixture({ issueRefreshToken: false });
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-no-refresh-"));
    const service = fileOAuthOperatorService({
      credentialDir,
      testOnlyAllowHttpLoopback: true,
      onAuthorizationUrl: async (url) => {
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", "fixture-code");
        redirect.searchParams.set("state", url.searchParams.get("state")!);
        await fetch(redirect);
      },
    });

    const result = await service.login({
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      openBrowser: false,
    });
    expect(result).toMatchObject({
      status: "authorized",
      refreshable: false,
    });
    if (result.status !== "authorized") return;
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OAUTH_REFRESH_TOKEN_NOT_ISSUED" }),
    ]));
  });

  it("fails login when a configured scope is not advertised", async () => {
    fixture = await startOAuthProtectedMcpFixture();
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-bad-scope-"));
    const service = fileOAuthOperatorService({
      credentialDir,
      testOnlyAllowHttpLoopback: true,
      onAuthorizationUrl: async () => {
        throw new Error("authorization must not start for an unsupported scope");
      },
    });

    const result = await service.login({
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["netlify:mcp"],
      openBrowser: false,
    });
    expect(result).toMatchObject({
      status: "oauth_scope_not_supported",
      requestedScope: "netlify:mcp",
    });
    if (result.status !== "oauth_scope_not_supported") return;
    expect(result.supportedScopes).toEqual(expect.arrayContaining(["mcp:tools", "offline_access"]));
  });

  it("treats a known-expired access token without a refresh grant as reauthorization required", () => {
    expect(isAccessTokenExpired(
      { access_token: "dead", token_type: "Bearer", expires_in: 1 },
      "2020-01-01T00:00:00.000Z",
    )).toBe(true);
    expect(isAccessTokenExpired(
      { access_token: "live", token_type: "Bearer", expires_in: 3600 },
      new Date().toISOString(),
    )).toBe(false);
  });

  it("refuses dispatch of an expired non-refreshable grant", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-expired-"));
    await writeFile(join(credentialDir, `${credentialHandle}.json`), `${JSON.stringify(storedSession(
      "https://mcp.example/mcp",
      {
        access_token: "expired-access-token",
        token_type: "Bearer",
        expires_in: 1,
      },
      "2020-01-01T00:00:00.000Z",
    ))}\n`, { mode: 0o600 });

    await expect(prepareOAuthForDispatch(
      session,
      credentialHandle,
      applicationDid,
      "https://mcp.example/mcp",
      credentialDir,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "OAUTH_REAUTHORIZATION_REQUIRED" },
    });
  });

  it("refreshes an expired refreshable grant before dispatch and persists rotation", async () => {
    fixture = await startOAuthProtectedMcpFixture();
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-dispatch-refresh-"));
    const credentialPath = join(credentialDir, `${credentialHandle}.json`);
    await writeFile(credentialPath, `${JSON.stringify(storedSession(
      fixture.resourceUrl,
      {
        access_token: "expired-access-token",
        refresh_token: "fixture-refresh-token",
        token_type: "Bearer",
        expires_in: 0,
      },
      "2020-01-01T00:00:00.000Z",
    ))}\n`, { mode: 0o600 });

    const prepared = await prepareOAuthForDispatch(
      session,
      credentialHandle,
      applicationDid,
      fixture.resourceUrl,
      credentialDir,
    );
    expect(prepared.ok).toBe(true);
    const stored = JSON.parse(await readFile(credentialPath, "utf8"));
    expect(stored.tokens).toMatchObject({
      access_token: "fixture-refreshed-access-token",
      refresh_token: "fixture-rotated-refresh-token",
    });
    expect(stored.codeVerifier).toBeUndefined();
  });

  it("reports expired non-refreshable status as reauthorization required", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-status-expired-"));
    await writeFile(join(credentialDir, `${credentialHandle}.json`), `${JSON.stringify(storedSession(
      "https://mcp.example/mcp",
      {
        access_token: "expired-access-token",
        token_type: "Bearer",
        expires_in: 1,
      },
      "2020-01-01T00:00:00.000Z",
    ))}\n`, { mode: 0o600 });

    const status = await fileOAuthOperatorService({ credentialDir }).status({
      applicationDid,
      resourceUrl: "https://mcp.example/mcp",
      session,
      credentialHandle,
    });
    expect(status).toMatchObject({
      status: "authorized",
      refreshable: false,
      reauthorizationRequired: true,
    });
  });

  it("classifies a post-refresh 401 as authentication failure, not a target outage", () => {
    expect(classifyOAuthPrepareError(
      new StreamableHTTPError(401, "Server returned 401 after successful authentication"),
      "mpas oauth login --application-did did:web:fixture.example",
    )).toMatchObject({
      code: "OAUTH_AUTHENTICATION_FAILED",
    });
  });

  it("starts refresh before expiry using a bounded safety window and jitter", () => {
    const savedAt = "2030-01-01T00:00:00.000Z";
    const now = Date.parse("2030-01-01T00:01:15.000Z");
    const tokens = { access_token: "synthetic", token_type: "Bearer", expires_in: 120 };
    expect(isAccessTokenRefreshDue(tokens, savedAt, now, 30_000, 15_000)).toBe(true);
    expect(isAccessTokenRefreshDue(tokens, savedAt, now - 1, 30_000, 14_999)).toBe(false);
  });

  it("serializes concurrent refresh callers into one token transaction", async () => {
    fixture = await startOAuthProtectedMcpFixture({ refreshDelayMs: 25 });
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-singleflight-"));
    await writeFile(join(credentialDir, `${credentialHandle}.json`), `${JSON.stringify(storedSession(
      fixture.resourceUrl,
      { access_token: "expired", refresh_token: "fixture-refresh-token", token_type: "Bearer", expires_in: 0 },
      "2020-01-01T00:00:00.000Z",
    ))}\n`, { mode: 0o600 });
    const expected = {
      scopes: ["mcp:tools"],
      refreshScope: "offline_access",
      client: { type: "dynamic" as const },
      refresh: { safetyWindowMs: 0, jitterMaxMs: 0 },
    };

    const results = await Promise.all(Array.from({ length: 8 }, () => prepareOAuthForDispatch(
      session,
      credentialHandle,
      applicationDid,
      fixture!.resourceUrl,
      credentialDir,
      expected,
    )));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fixture.tokenRequests.filter((request) => request.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("persists invalid_grant as reauthorization-required and suppresses restart retries", async () => {
    fixture = await startOAuthProtectedMcpFixture({ invalidRefreshGrant: true });
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-invalid-grant-"));
    const path = join(credentialDir, `${credentialHandle}.json`);
    await writeFile(path, `${JSON.stringify(storedSession(
      fixture.resourceUrl,
      { access_token: "expired", refresh_token: "fixture-refresh-token", token_type: "Bearer", expires_in: 0 },
      "2020-01-01T00:00:00.000Z",
    ))}\n`, { mode: 0o600 });
    const expected = { scopes: ["mcp:tools"], refreshScope: "offline_access", client: { type: "dynamic" as const } };

    await expect(prepareOAuthForDispatch(
      session, credentialHandle, applicationDid, fixture.resourceUrl, credentialDir, expected,
    )).resolves.toMatchObject({ ok: false, error: { code: "OAUTH_INVALID_GRANT" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      reauthorizationRequired: true,
      reauthorizationReason: "invalid_grant",
    });
    await expect(prepareOAuthForDispatch(
      session, credentialHandle, applicationDid, fixture.resourceUrl, credentialDir, expected,
    )).resolves.toMatchObject({ ok: false, error: { code: "OAUTH_REAUTHORIZATION_REQUIRED" } });
    expect(fixture.tokenRequests.filter((request) => request.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("invalidates a stored grant when any configured authorization tuple member changes", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-binding-"));
    const resource = "https://mcp.example/mcp";
    const path = join(credentialDir, `${credentialHandle}.json`);
    await writeFile(path, `${JSON.stringify(storedSession(
      resource,
      { access_token: "synthetic", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600 },
      new Date().toISOString(),
    ))}\n`, { mode: 0o600 });

    await expect(prepareOAuthForDispatch(
      session,
      credentialHandle,
      applicationDid,
      resource,
      credentialDir,
      { scopes: ["mcp:tools", "new-scope"], refreshScope: "offline_access", client: { type: "dynamic" } },
    )).resolves.toMatchObject({ ok: false, error: { code: "OAUTH_REAUTHORIZATION_REQUIRED" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      reauthorizationRequired: true,
      reauthorizationReason: "binding_mismatch",
    });
  });

  it("applies redirect, state, expiry, and issuer checks to success and OAuth error callbacks", () => {
    const expected = {
      state: "state-with-256-bits-of-synthetic-entropy-0000000000000000000000",
      redirectUrl: "http://127.0.0.1:49152/oauth/callback",
      issuer: "https://issuer.example",
      issuerRequired: true,
      expiresAt: "2030-01-01T00:10:00.000Z",
    };
    expect(() => validateOAuthCallbackParameters(new URL(
      `${expected.redirectUrl}?error=access_denied&state=${expected.state}&iss=${encodeURIComponent(expected.issuer)}`,
    ), expected, Date.parse("2030-01-01T00:00:00.000Z"))).not.toThrow();
    expect(() => validateOAuthCallbackParameters(new URL(
      `${expected.redirectUrl}?code=synthetic&state=wrong&iss=${encodeURIComponent(expected.issuer)}`,
    ), expected, Date.parse("2030-01-01T00:00:00.000Z"))).toThrow("state mismatch");
    expect(() => validateOAuthCallbackParameters(new URL(
      `http://127.0.0.1:49153/oauth/callback?code=synthetic&state=${expected.state}&iss=${encodeURIComponent(expected.issuer)}`,
    ), expected, Date.parse("2030-01-01T00:00:00.000Z"))).toThrow("redirect URI mismatch");
    expect(() => validateOAuthCallbackParameters(new URL(
      `${expected.redirectUrl}?code=synthetic&state=${expected.state}`,
    ), expected, Date.parse("2030-01-01T00:00:00.000Z"))).toThrow("issuer mismatch");
    expect(() => validateOAuthCallbackParameters(new URL(
      `${expected.redirectUrl}?code=synthetic&state=${expected.state}&iss=https%3A%2F%2Fother.example`,
    ), expected, Date.parse("2030-01-01T00:00:00.000Z"))).toThrow("issuer mismatch");
  });

  it("rejects an integrated callback without iss when the server advertises RFC 9207", async () => {
    fixture = await startOAuthProtectedMcpFixture({ authorizationResponseIssuerSupported: true });
    const service = fileOAuthOperatorService({
      credentialDir: await mkdtemp(join(tmpdir(), "mpas-oauth-callback-issuer-")),
      testOnlyAllowHttpLoopback: true,
      onAuthorizationUrl: authorizeFixture,
    });
    await expect(service.login({
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      openBrowser: false,
    })).rejects.toThrow("issuer mismatch");
    expect(fixture.tokenRequests).toHaveLength(0);
  });

  it("supports static, CIMD, dynamic, and exact automatic client selection", async () => {
    fixture = await startOAuthProtectedMcpFixture({ clientIdMetadataDocumentSupported: true });
    const staticDir = await mkdtemp(join(tmpdir(), "mpas-oauth-static-"));
    const staticService = fileOAuthOperatorService({
      credentialDir: staticDir,
      testOnlyAllowHttpLoopback: true,
      onAuthorizationUrl: authorizeFixture,
    });
    await expect(staticService.login({
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      client: { type: "auto", clientId: "fixture-static-client", clientIdMetadataDocument: "https://client.example/metadata" },
      openBrowser: false,
    })).resolves.toMatchObject({ status: "authorized", clientMode: "static" });
    expect(fixture.registrationRequests).toHaveLength(0);

    await fixture.close();
    fixture = await startOAuthProtectedMcpFixture();
    const dynamicService = fileOAuthOperatorService({
      credentialDir: await mkdtemp(join(tmpdir(), "mpas-oauth-dynamic-")),
      testOnlyAllowHttpLoopback: true,
      onAuthorizationUrl: authorizeFixture,
    });
    await expect(dynamicService.login({
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      client: { type: "dynamic" },
      openBrowser: false,
    })).resolves.toMatchObject({ status: "authorized", clientMode: "dynamic" });
    expect(fixture.registrationRequests).toEqual([expect.objectContaining({ application_type: "native" })]);

    await fixture.close();
    fixture = await startOAuthProtectedMcpFixture({ clientIdMetadataDocumentSupported: true });
    const cimdDir = await mkdtemp(join(tmpdir(), "mpas-oauth-cimd-"));
    const cimdPath = join(cimdDir, `${credentialHandle}.json`);
    const cimdUrl = "https://client.example/oauth/metadata";
    const cimdService = fileOAuthOperatorService({
      credentialDir: cimdDir,
      testOnlyAllowHttpLoopback: true,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === cimdUrl) {
          const stored = JSON.parse(await readFile(cimdPath, "utf8"));
          return new Response(JSON.stringify({
            client_id: cimdUrl,
            client_name: "Synthetic CIMD Client",
            redirect_uris: [stored.authorization.redirectUrl],
            grant_types: ["authorization_code", "refresh_token"],
          }), { headers: { "content-type": "application/json" } });
        }
        return fetch(input, init);
      },
      onAuthorizationUrl: authorizeFixture,
    });
    await expect(cimdService.login({
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      client: { type: "cimd", clientIdMetadataDocument: cimdUrl },
      openBrowser: false,
    })).resolves.toMatchObject({ status: "authorized", clientMode: "cimd" });
    expect(fixture.registrationRequests).toHaveLength(0);

    await fixture.close();
    fixture = await startOAuthProtectedMcpFixture({ advertiseRegistrationEndpoint: false });
    const unavailable = fileOAuthOperatorService({
      credentialDir: await mkdtemp(join(tmpdir(), "mpas-oauth-no-client-mode-")),
      testOnlyAllowHttpLoopback: true,
      onAuthorizationUrl: authorizeFixture,
    });
    await expect(unavailable.login({
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      client: { type: "dynamic" },
      openBrowser: false,
    })).rejects.toThrow("not advertised");
  });

  it("enforces owner ACL, audits without secrets, and revokes before local deletion", async () => {
    fixture = await startOAuthProtectedMcpFixture({ advertiseRevocationEndpoint: true });
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-owner-"));
    const auditPath = join(credentialDir, "audit.jsonl");
    const ownerService = fileOAuthOperatorService({
      credentialDir,
      auditPath,
      operatorPrincipal: "operator:owner",
      testOnlyAllowHttpLoopback: true,
      onAuthorizationUrl: authorizeFixture,
    });
    const request = {
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      owner: "operator:owner",
      sharing: { applicationDids: [applicationDid], operatorPrincipals: ["operator:owner"] },
    };
    await expect(ownerService.login({ ...request, openBrowser: false }))
      .resolves.toMatchObject({ status: "authorized" });
    const otherService = fileOAuthOperatorService({ credentialDir, operatorPrincipal: "operator:other" });
    await expect(otherService.status(request)).rejects.toThrow("access denied");
    await expect(ownerService.logout(request)).resolves.toMatchObject({
      status: "logged_out",
      remoteRevocation: "succeeded",
      localCredentialsDeleted: true,
    });
    expect(fixture.eventOrder).toEqual(["revoke:refresh_token", "revoke:access_token"]);
    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"operatorPrincipal":"operator:owner"');
    expect(audit).toContain('"action":"revocation"');
    expect(audit).not.toContain("fixture-access-token");
    expect(audit).not.toContain("fixture-refresh-token");
  });

  it.each([
    "session",
    "application DID",
    "canonical resource",
    "issuer",
    "client mode",
    "client identity and configuration",
    "configured scopes",
    "refresh scope",
    "owner",
    "sharing policy",
  ])("rejects logout before every side effect when the %s binding changes", async (field) => {
    fixture = await startOAuthProtectedMcpFixture({ advertiseRevocationEndpoint: true });
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-logout-binding-"));
    const credentialPath = join(credentialDir, `${credentialHandle}.json`);
    const auditPath = join(credentialDir, "audit.jsonl");
    const otherApplicationDid = "did:web:other.fixture.example";
    const sharing = {
      applicationDids: [applicationDid, otherApplicationDid],
      operatorPrincipals: ["operator:owner"],
    };
    const persisted = storedSession(
      fixture.resourceUrl,
      {
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      },
      new Date().toISOString(),
      {
        owner: "operator:owner",
        sharing,
        binding: {
          applicationDid,
          resourceUrl: fixture.resourceUrl,
          issuer: fixture.issuer,
          clientMode: "static",
          clientId: "fixture-static-client",
          clientConfiguration: JSON.stringify({ type: "static", clientId: "fixture-static-client" }),
          scopeConfiguration: JSON.stringify({ scopes: ["mcp:tools"], refreshScope: "offline_access" }),
          requestedScopes: ["mcp:tools", "offline_access"],
          redirectUrl: "http://127.0.0.1:49152/oauth/callback",
        },
        clientInformation: { client_id: "fixture-static-client" },
        discovery: {
          authorizationServerUrl: fixture.issuer,
          resourceMetadata: { resource: fixture.resourceUrl },
          authorizationServerMetadata: {
            issuer: fixture.issuer,
            token_endpoint: `${fixture.origin}/token`,
            revocation_endpoint: `${fixture.origin}/revoke`,
            code_challenge_methods_supported: ["S256"],
          },
        },
      },
    );
    await writeFile(credentialPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    const before = await readFile(credentialPath);
    const baseline: OAuthOperatorRequest = {
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      refreshScope: "offline_access",
      issuer: fixture.issuer,
      client: { type: "static", clientId: "fixture-static-client" },
      owner: "operator:owner",
      sharing,
    };
    let request: OAuthOperatorRequest;
    switch (field) {
      case "session":
        request = { ...baseline, session: "other-session" };
        break;
      case "application DID":
        request = { ...baseline, applicationDid: otherApplicationDid };
        break;
      case "canonical resource":
        request = { ...baseline, resourceUrl: `${fixture.origin}/other-resource` };
        break;
      case "issuer":
        request = { ...baseline, issuer: `${fixture.origin}/other-issuer` };
        break;
      case "client mode":
        request = { ...baseline, client: { type: "dynamic" } };
        break;
      case "client identity and configuration":
        request = { ...baseline, client: { type: "static", clientId: "other-static-client" } };
        break;
      case "configured scopes":
        request = { ...baseline, scopes: ["mcp:tools", "mcp:admin"] };
        break;
      case "refresh scope":
        request = { ...baseline, refreshScope: "refresh_token" };
        break;
      case "owner":
        request = { ...baseline, owner: "operator:other" };
        break;
      case "sharing policy":
        request = {
          ...baseline,
          sharing: {
            applicationDids: [...sharing.applicationDids],
            operatorPrincipals: [...sharing.operatorPrincipals, "operator:other"],
          },
        };
        break;
      default:
        throw new Error(`Unknown logout binding field: ${field}`);
    }
    const service = fileOAuthOperatorService({
      credentialDir,
      auditPath,
      operatorPrincipal: "operator:owner",
      testOnlyAllowHttpLoopback: true,
    });

    let rejected: unknown;
    try {
      await service.logout(request);
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(OAuthReauthorizationRequiredError);
    expect(rejected).toMatchObject({
      code: "OAUTH_REAUTHORIZATION_REQUIRED",
      operatorCommand: oauthLoginCommand(request),
    });
    expect(await readFile(credentialPath)).toEqual(before);
    expect(fixture.revocationRequests).toHaveLength(0);
    expect(fixture.eventOrder).toHaveLength(0);
    await expect(readFile(auditPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a credential-handle mismatch without affecting the original credential", async () => {
    fixture = await startOAuthProtectedMcpFixture({ advertiseRevocationEndpoint: true });
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-logout-handle-"));
    const originalPath = join(credentialDir, `${credentialHandle}.json`);
    const otherCredentialHandle = "other-fixture-oauth";
    const otherPath = join(credentialDir, `${otherCredentialHandle}.json`);
    const auditPath = join(credentialDir, "audit.jsonl");
    const persisted = storedSession(
      fixture.resourceUrl,
      {
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      },
      new Date().toISOString(),
      {
        owner: "operator:owner",
        sharing: { applicationDids: [applicationDid], operatorPrincipals: ["operator:owner"] },
        discovery: {
          authorizationServerUrl: fixture.issuer,
          resourceMetadata: { resource: fixture.resourceUrl },
          authorizationServerMetadata: {
            issuer: fixture.issuer,
            token_endpoint: `${fixture.origin}/token`,
            revocation_endpoint: `${fixture.origin}/revoke`,
            code_challenge_methods_supported: ["S256"],
          },
        },
      },
    );
    const serialized = `${JSON.stringify(persisted)}\n`;
    await writeFile(originalPath, serialized, { mode: 0o600 });
    await writeFile(otherPath, serialized, { mode: 0o600 });
    const originalBefore = await readFile(originalPath);
    const otherBefore = await readFile(otherPath);
    const service = fileOAuthOperatorService({
      credentialDir,
      auditPath,
      operatorPrincipal: "operator:owner",
      testOnlyAllowHttpLoopback: true,
    });

    let rejected: unknown;
    try {
      await service.logout({
        applicationDid,
        resourceUrl: fixture.resourceUrl,
        session,
        credentialHandle: otherCredentialHandle,
        scopes: ["mcp:tools"],
        refreshScope: "offline_access",
        client: { type: "dynamic" },
        owner: "operator:owner",
        sharing: { applicationDids: [applicationDid], operatorPrincipals: ["operator:owner"] },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(OAuthReauthorizationRequiredError);
    expect(rejected).toMatchObject({ code: "OAUTH_REAUTHORIZATION_REQUIRED" });
    expect(await readFile(originalPath)).toEqual(originalBefore);
    expect(await readFile(otherPath)).toEqual(otherBefore);
    expect(fixture.revocationRequests).toHaveLength(0);
    expect(fixture.eventOrder).toHaveLength(0);
    await expect(readFile(auditPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies managed session health without exposing token material", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-validation-"));
    const path = join(credentialDir, `${credentialHandle}.json`);
    await writeFile(path, `${JSON.stringify(storedSession(
      "https://mcp.example/mcp",
      { access_token: "synthetic-secret", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 0 },
      "2020-01-01T00:00:00.000Z",
    ))}\n`, { mode: 0o600 });
    const result = await validateManagedOAuthSession({
      applicationDid,
      resourceUrl: "https://mcp.example/mcp",
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      refreshScope: "offline_access",
      client: { type: "dynamic" },
      refresh: { safetyWindowMs: 0, jitterMaxMs: 0 },
    }, credentialDir);
    expect(result).toEqual({ ok: true, state: "refresh_due" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
});

async function authorizeFixture(url: URL): Promise<void> {
  const redirect = new URL(url.searchParams.get("redirect_uri")!);
  redirect.searchParams.set("code", "fixture-code");
  redirect.searchParams.set("state", url.searchParams.get("state")!);
  await fetch(redirect);
}
