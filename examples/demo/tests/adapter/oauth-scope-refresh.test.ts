import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  classifyOAuthPrepareError,
  fileOAuthOperatorService,
  isAccessTokenExpired,
  prepareOAuthForDispatch,
  resolveRequestedOAuthScopes,
} from "../../src/adapter/oauth-operator.js";
import {
  startOAuthProtectedMcpFixture,
  type OAuthProtectedMcpFixture,
} from "../fixtures/oauth-protected-mcp.js";

const applicationDid = "did:web:fixture.example";
const session = "fixture-session";
const credentialHandle = "fixture-oauth";

let fixture: OAuthProtectedMcpFixture | undefined;

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
    await writeFile(join(credentialDir, `${credentialHandle}.json`), `${JSON.stringify({
      version: 1,
      session,
      credentialHandle,
      applicationDid,
      resourceUrl: "https://mcp.example/mcp",
      state: "fixture-state-with-at-least-256-bits-of-test-entropy-000000000000",
      redirectUrl: "http://127.0.0.1:49152/oauth/callback",
      tokens: {
        access_token: "expired-access-token",
        token_type: "Bearer",
        expires_in: 1,
      },
      tokensSavedAt: "2020-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });

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
    await writeFile(credentialPath, `${JSON.stringify({
      version: 1,
      session,
      credentialHandle,
      applicationDid,
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
    await writeFile(join(credentialDir, `${credentialHandle}.json`), `${JSON.stringify({
      version: 1,
      session,
      credentialHandle,
      applicationDid,
      resourceUrl: "https://mcp.example/mcp",
      state: "fixture-state-with-at-least-256-bits-of-test-entropy-000000000000",
      redirectUrl: "http://127.0.0.1:49152/oauth/callback",
      tokens: {
        access_token: "expired-access-token",
        token_type: "Bearer",
        expires_in: 1,
      },
      tokensSavedAt: "2020-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });

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
});
