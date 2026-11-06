/**
 * Credential Adapter OAuth plan, Phases 4-6: scopes, refresh and failure
 * classification, and dispatch, accounts and results
 * (docs/features/credential-adapter-oauth/plan.md).
 */
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareMcpHttp } from "../../src/adapter/dispatch/mcp-http.js";
import {
  classifyOAuthPrepareError,
  OAUTH_REASON_BY_CODE,
  OAuthOperatorError,
  type OAuthReasonCode,
} from "../../src/adapter/oauth-operator.js";
import { runCli } from "../../src/cli/index.js";
import {
  authorizeFixture,
  MALFORMED_REFRESH_RESPONSES,
  startOAuthProtectedMcpFixture,
  type OAuthProtectedMcpFixture,
  type OAuthProtectedMcpFixtureOptions,
} from "../fixtures/oauth-protected-mcp.js";
import {
  applicationDid,
  credentialHandle,
  expireAccessToken,
  operator,
  pipeline,
  prepare,
  readStored,
  session,
  writeStored,
} from "./credential-adapter-oauth-harness.js";

const fixtures: OAuthProtectedMcpFixture[] = [];
async function start(options: OAuthProtectedMcpFixtureOptions = {}) {
  const fixture = await startOAuthProtectedMcpFixture(options);
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

const scopeParam = (url: URL) => url.searchParams.get("scope")?.split(" ") ?? null;
const refreshRequests = (fixture: OAuthProtectedMcpFixture) =>
  fixture.tokenRequests.filter((request) => request.get("grant_type") === "refresh_token");

async function connect(fixture: OAuthProtectedMcpFixture, credentialDir: string, scopes?: string[]) {
  const prepared = await prepare(fixture, credentialDir);
  if (!prepared.ok) throw new Error(`preparation failed: ${prepared.error.code}`);
  return prepareMcpHttp(
    { type: "mcp.http", url: fixture.resourceUrl, auth: { type: "oauth2", session, ...(scopes ? { scopes } : {}) } },
    undefined, "2025-06-18", prepared.provider, "mpas oauth login --application-did did:web:github-mirror.example",
  );
}

async function cliStatus(harness: Awaited<ReturnType<typeof operator>>) {
  const io = { stdout: { text: "", write(chunk: string) { this.text += chunk; return true; } }, stderr: { text: "", write(chunk: string) { this.text += chunk; return true; } } };
  const result = await runCli(["oauth", "status", "--application-did", applicationDid], io as never, {
    oauthOperator: harness.service,
    resolveOAuthDeployment: async () => ({
      ...harness.request,
      refreshScope: "offline_access",
      client: harness.request.client ?? { type: "auto" },
      refresh: { safetyWindowMs: 0, jitterMaxMs: 0 },
    }),
  });
  return { exitCode: result.exitCode, output: JSON.parse(io.stdout.text) as Record<string, unknown> };
}

describe("Phase 4: scopes", () => {
  it("P4-01 requests the challenge scope, else resource scopes_supported, else no scope, never authorization-server scopes", async () => {
    const challenge = await start({
      challengeScope: "mcp:tools mcp:read",
      scopesSupported: ["mcp:tools", "mcp:other"],
      authorizationServerScopesSupported: ["as:only"],
    });
    const first = await operator(challenge);
    await first.login();
    expect(scopeParam(first.authorizationUrls[0])).toEqual(["mcp:tools", "mcp:read"]);

    const resource = await start({ challengeScope: null, scopesSupported: ["mcp:tools", "mcp:other"], authorizationServerScopesSupported: ["as:only"] });
    const second = await operator(resource);
    await second.login();
    expect(scopeParam(second.authorizationUrls[0])).toEqual(["mcp:tools", "mcp:other"]);

    const neither = await start({ challengeScope: null, scopesSupported: null, authorizationServerScopesSupported: ["as:only"] });
    const third = await operator(neither);
    await third.login();
    expect(third.authorizationUrls[0].searchParams.has("scope")).toBe(false);
    expect((await readStored(third.credentialDir)).binding.requestedScopes).toEqual([]);
  });

  it("P4-02 records the requested set before consent and refuses a later challenge outside it", async () => {
    const fixture = await start({ challengeScope: "mcp:tools", authorizationServerScopesSupported: ["offline_access"] });
    let recordedBeforeConsent: unknown;
    const harness = await operator(fixture, {
      authorize: async (url) => {
        recordedBeforeConsent = (await readStored(harness.credentialDir)).binding?.requestedScopes;
        await authorizeFixture(url);
      },
    });
    await harness.login();
    expect(recordedBeforeConsent).toEqual(["mcp:tools", "offline_access"]);
    fixture.failures.scopeChallenge = "mcp:admin";
    const connected = await connect(fixture, harness.credentialDir);
    expect(connected).toMatchObject({ ok: false, error: { code: "OAUTH_SCOPE_CHANGE_REQUIRED" } });
    if (connected.ok) return;
    expect(classifyOAuthPrepareError(new OAuthOperatorError("OAUTH_INSUFFICIENT_SCOPE", "x"), "cmd").reason).toBe("oauth_insufficient_scope");
    expect(harness.authorizationUrls).toHaveLength(1);
    expect(fixture.tokenRequests).toHaveLength(1);
    expect((await readStored(harness.credentialDir)).binding.requestedScopes).toEqual(["mcp:tools", "offline_access"]);
  });

  it("P4-03 may request offline_access advertised only by the authorization server, uses a refresh token issued without it, and expires to login required without one", async () => {
    const fixture = await start({ scopesSupported: ["mcp:tools"], authorizationServerScopesSupported: ["offline_access"], grantedScope: "mcp:tools" });
    const harness = await operator(fixture);
    await harness.login();
    expect(scopeParam(harness.authorizationUrls[0])).toContain("offline_access");
    expect((await readStored(harness.credentialDir)).tokens.scope).toBe("mcp:tools");
    await expireAccessToken(harness.credentialDir);
    await expect(prepare(fixture, harness.credentialDir)).resolves.toMatchObject({ ok: true });
    expect(refreshRequests(fixture)).toHaveLength(1);

    const noRefresh = await start({ issueRefreshToken: false, accessTokenExpiresIn: 1 });
    const other = await operator(noRefresh);
    await expect(other.login()).resolves.toMatchObject({ status: "authorized", refreshable: false });
    await expireAccessToken(other.credentialDir);
    await expect(prepare(noRefresh, other.credentialDir)).resolves.toMatchObject({
      ok: false,
      error: { code: "OAUTH_LOGIN_REQUIRED", reason: "oauth_login_required" },
    });
    const stored = await readStored(other.credentialDir);
    expect(stored.reauthorizationRequired).toBe(false);
    expect(stored.reauthorizationReason).toBeUndefined();
    await expect(other.service.status(other.request)).resolves.toMatchObject({ state: "login_required", reason: "oauth_login_required" });
  });

  it("P4-04 a returned scope replaces the granted set and extra granted scopes never widen policy", async () => {
    const fixture = await start({ challengeScope: "mcp:tools", grantedScope: "mcp:tools linkedin:w_member_social", refreshOmitsScope: true });
    const harness = await operator(fixture);
    const result = await harness.login();
    expect(result).toMatchObject({
      requestedScopes: ["mcp:tools", "offline_access"],
      grantedScopes: ["mcp:tools", "linkedin:w_member_social"],
    });
    await expireAccessToken(harness.credentialDir);
    await prepare(fixture, harness.credentialDir);
    expect((await readStored(harness.credentialDir)).tokens.scope).toBe("mcp:tools linkedin:w_member_social");
    fixture.failures.scopeChallenge = "linkedin:w_member_social";
    const connected = await connect(fixture, harness.credentialDir);
    expect(connected).toMatchObject({ ok: false, error: { code: "OAUTH_SCOPE_CHANGE_REQUIRED" } });
    expect((await readStored(harness.credentialDir)).binding.requestedScopes).toEqual(["mcp:tools", "offline_access"]);

    const replacing = await start({ challengeScope: "mcp:tools", grantedScope: "mcp:tools" });
    const second = await operator(replacing);
    await second.login();
    const stored = await readStored(second.credentialDir);
    stored.tokens.scope = "mcp:tools stale:removed";
    await writeStored(second.credentialDir, stored);
    await expireAccessToken(second.credentialDir);
    await prepare(replacing, second.credentialDir);
    expect((await readStored(second.credentialDir)).tokens.scope).toBe("mcp:tools");
  });

  it("P4-05 operator reauthorization requests permitted prior grants and reports invalid_scope once", async () => {
    const fixture = await start({ challengeScope: "mcp:tools", grantedScope: "mcp:tools extra:granted" });
    const harness = await operator(fixture, {
      authorize: async (url) => {
        await authorizeFixture(url, harness.authorizationUrls.length > 1 ? { error: "invalid_scope" } : {});
      },
    });
    await harness.login();
    const before = await readFile(join(harness.credentialDir, `${credentialHandle}.json`));
    await expect(harness.login()).rejects.toMatchObject({ code: "OAUTH_INSUFFICIENT_SCOPE" });
    expect(scopeParam(harness.authorizationUrls[1])).toEqual(["mcp:tools", "extra:granted", "offline_access"]);
    expect(harness.authorizationUrls).toHaveLength(2);
    expect(await readFile(join(harness.credentialDir, `${credentialHandle}.json`))).toEqual(before);

    const configured = await operator(fixture, { credentialDir: harness.credentialDir, scopes: ["mcp:tools"], authorize: (url) => authorizeFixture(url) });
    await configured.login();
    expect(scopeParam(configured.authorizationUrls[0])).toEqual(["mcp:tools", "offline_access"]);
  });

  it("P4-06 explicit fixed scopes behave as shipped, including operator step-up by configuration", async () => {
    const fixture = await start({ scopesSupported: ["mcp:tools", "mcp:admin"] });
    const harness = await operator(fixture, { scopes: ["mcp:tools"] });
    await harness.login();
    expect(scopeParam(harness.authorizationUrls[0])).toEqual(["mcp:tools", "offline_access"]);
    await expect(harness.login({ scopes: ["not:advertised"] })).resolves.toMatchObject({ status: "oauth_scope_not_supported" });
    const widened = { scopes: ["mcp:tools", "mcp:admin"], refreshScope: "offline_access" };
    await expect(prepare(fixture, harness.credentialDir, { expected: widened })).resolves.toMatchObject({
      ok: false,
      error: { code: "OAUTH_REAUTHORIZATION_REQUIRED" },
    });
    expect(harness.authorizationUrls).toHaveLength(1);
    await harness.login({ scopes: widened.scopes });
    expect(scopeParam(harness.authorizationUrls[1])).toEqual(["mcp:tools", "mcp:admin", "offline_access"]);
    await expect(prepare(fixture, harness.credentialDir, { expected: widened })).resolves.toMatchObject({ ok: true });
  });

  it("P4-07 two sessions for different resources on one authorization server refresh independently", async () => {
    const fixture = await start();
    const a = await operator(fixture, { handle: "session-a" });
    const b = await operator(fixture, { credentialDir: a.credentialDir, handle: "session-b", resourceUrl: fixture.resourceUrlB });
    await a.login();
    await b.login();
    await expireAccessToken(a.credentialDir, "session-a");
    await expect(prepare(fixture, a.credentialDir, { handle: "session-a" })).resolves.toMatchObject({ ok: true });
    await expireAccessToken(a.credentialDir, "session-b");
    await expect(prepare(fixture, a.credentialDir, { handle: "session-b", resourceUrl: fixture.resourceUrlB })).resolves.toMatchObject({ ok: true });
    const [refreshA, refreshB] = refreshRequests(fixture);
    expect(refreshA.get("resource")).toBe(fixture.resourceUrl);
    expect(refreshA.get("refresh_token")).toBe("fixture-refresh-token");
    expect(refreshB.get("resource")).toBe(fixture.resourceUrlB);
    expect(refreshB.get("refresh_token")).toBe("fixture-b-refresh-token");
    expect((await readStored(a.credentialDir, "session-a")).tokens.refresh_token).toBe("fixture-rotated-refresh-token");
    expect((await readStored(a.credentialDir, "session-b")).tokens.refresh_token).toBe("fixture-b-rotated-refresh-token");
  });
});

describe("Phase 5: refresh and failure classification", () => {
  it("P5-01 a lost rotation response keeps the session, marks refresh_uncertain and refuses dispatch before the executing write", async () => {
    const fixture = await start();
    const harness = await operator(fixture);
    await harness.login();
    await expireAccessToken(harness.credentialDir);
    const before = await readStored(harness.credentialDir);
    fixture.failures.refresh = "drop_after_rotation";
    const adapter = await pipeline(fixture, harness.credentialDir);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await adapter.submit();
        expect(response.body).toMatchObject({
          result: "rejected",
          error: { code: "OAUTH_TOKEN_REFRESH_FAILED" },
          context: { oauth: { reason: "oauth_token_refresh_failed", operatorCommand: expect.stringContaining("mpas oauth login") } },
        });
        expect(response.body.executionReceipt).toBeUndefined();
      }
      expect(adapter.executingCount()).toBe(0);
      expect(refreshRequests(fixture)).toHaveLength(1);
      const stored = await readStored(harness.credentialDir);
      expect(stored.tokens).toEqual(before.tokens);
      expect(stored.refreshState).toMatchObject({ status: "uncertain" });
      expect(fixture.toolCalls).toHaveLength(0);
      await expect(harness.service.status(harness.request)).resolves.toMatchObject({
        state: "refresh_uncertain",
        reason: "oauth_token_refresh_failed",
        operatorCommand: expect.stringContaining("mpas oauth login"),
      });
      fixture.failures.refresh = undefined;
      await harness.login();
      expect((await adapter.submit()).body).toMatchObject({ result: "executed" });
      expect(refreshRequests(fixture)).toHaveLength(1);
    } finally {
      await adapter.app.close();
    }
  });

  it("P5-02 a refresh refused before processing retries within the bounded policy and honors Retry-After", async () => {
    const fixture = await start();
    const harness = await operator(fixture);
    await harness.login();
    const closedPort = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        server.close(() => resolve(port));
      });
    });
    const stored = await readStored(harness.credentialDir);
    const liveEndpoint = stored.discovery.authorizationServerMetadata.token_endpoint;
    stored.discovery.authorizationServerMetadata.token_endpoint = `http://127.0.0.1:${closedPort}/token`;
    await writeStored(harness.credentialDir, stored);
    await expireAccessToken(harness.credentialDir);
    await expect(prepare(fixture, harness.credentialDir)).resolves.toMatchObject({
      ok: false,
      error: { code: "OAUTH_TEMPORARILY_UNAVAILABLE", reason: "oauth_temporarily_unavailable" },
    });
    const afterRefused = await readStored(harness.credentialDir);
    expect(afterRefused.refreshState).toBeUndefined();
    afterRefused.discovery.authorizationServerMetadata.token_endpoint = liveEndpoint;
    await writeStored(harness.credentialDir, afterRefused);
    await expect(prepare(fixture, harness.credentialDir)).resolves.toMatchObject({ ok: true });
    expect(refreshRequests(fixture)[0].get("refresh_token")).toBe("fixture-refresh-token");

    fixture.failures.refresh = "429";
    fixture.failures.retryAfterSeconds = 30;
    await expireAccessToken(harness.credentialDir);
    await expect(prepare(fixture, harness.credentialDir)).resolves.toMatchObject({
      ok: false,
      error: { code: "OAUTH_RATE_LIMITED", reason: "oauth_rate_limited", retryAfterSeconds: 30 },
    });
    const count = refreshRequests(fixture).length;
    await expect(prepare(fixture, harness.credentialDir)).resolves.toMatchObject({ ok: false, error: { code: "OAUTH_RATE_LIMITED" } });
    expect(refreshRequests(fixture)).toHaveLength(count);
    await expect(harness.service.status(harness.request)).resolves.toMatchObject({ state: "rate_limited", reason: "oauth_rate_limited" });
    fixture.failures.refresh = undefined;
    const deferred = await readStored(harness.credentialDir);
    deferred.refreshState.retryAfter = new Date(Date.now() - 1000).toISOString();
    await writeStored(harness.credentialDir, deferred);
    await expect(prepare(fixture, harness.credentialDir)).resolves.toMatchObject({ ok: true });
    expect(refreshRequests(fixture)).toHaveLength(count + 1);
  });

  it.each(["5xx", "drop_after_rotation"] as const)("P5-03 a temporary refresh failure (%s) is never revocation or denial and never erases the session", async (mode) => {
    const fixture = await start();
    const harness = await operator(fixture);
    await harness.login();
    await expireAccessToken(harness.credentialDir);
    const before = await readStored(harness.credentialDir);
    fixture.failures.refresh = mode;
    const prepared = await prepare(fixture, harness.credentialDir);
    expect(prepared).toMatchObject({ ok: false, error: { code: "OAUTH_TOKEN_REFRESH_FAILED", reason: "oauth_token_refresh_failed" } });
    if (prepared.ok) return;
    expect(prepared.error.reason).not.toMatch(/reauthorization|denied/);
    expect(prepared.error.message).not.toMatch(/revoked|denied/i);
    const stored = await readStored(harness.credentialDir);
    expect(stored.tokens).toEqual(before.tokens);
    expect(stored.reauthorizationRequired).toBe(false);
  });

  it("P5-04 an unqualified invalid_grant marks reauthorization_required once with the login command and is not retried", async () => {
    const fixture = await start({ invalidRefreshGrant: true });
    const harness = await operator(fixture);
    await harness.login();
    await expireAccessToken(harness.credentialDir);
    const first = await prepare(fixture, harness.credentialDir);
    expect(first).toMatchObject({
      ok: false,
      error: { code: "OAUTH_INVALID_GRANT", reason: "oauth_reauthorization_required", operatorCommand: expect.stringContaining("mpas oauth login") },
    });
    await expect(prepare(fixture, harness.credentialDir)).resolves.toMatchObject({
      ok: false,
      error: { code: "OAUTH_REAUTHORIZATION_REQUIRED", reason: "oauth_reauthorization_required" },
    });
    expect(refreshRequests(fixture)).toHaveLength(1);
    expect(harness.authorizationUrls).toHaveLength(1);
  });

  it("P5-05 a 403 account_not_allowed without a Bearer challenge reports oauth_access_denied without login advice, at dispatch and in status", async () => {
    const fixture = await start();
    const harness = await operator(fixture);
    await harness.login();
    fixture.failures.resourceDenial = "account_not_allowed";
    const adapter = await pipeline(fixture, harness.credentialDir);
    try {
      const response = await adapter.submit();
      expect(response.body).toMatchObject({
        result: "rejected",
        error: { code: "OAUTH_ACCESS_DENIED" },
        context: { oauth: { reason: "oauth_access_denied" } },
      });
      expect(response.body.context.oauth.operatorCommand).toBeUndefined();
      expect(response.body.error.message).not.toContain("mpas oauth login");
      expect(adapter.executingCount()).toBe(0);
    } finally {
      await adapter.app.close();
    }
    const status = await harness.service.status(harness.request);
    expect(status).toMatchObject({ state: "access_denied", reason: "oauth_access_denied" });
    expect(status).not.toHaveProperty("operatorCommand");
    expect(harness.authorizationUrls).toHaveLength(1);
  });

  it("P5-06 a 403 with any other body keeps the denial and sanitized status without suggesting login or scopes", async () => {
    const fixture = await start();
    const harness = await operator(fixture);
    await harness.login();
    fixture.failures.resourceDenial = "other";
    const adapter = await pipeline(fixture, harness.credentialDir);
    try {
      const response = await adapter.submit();
      expect(response.body).toMatchObject({ result: "rejected", error: { code: "OAUTH_RESOURCE_FORBIDDEN" } });
      expect(response.body.context.oauth).toBeUndefined();
      const text = JSON.stringify(response.body);
      expect(text).not.toContain("mpas oauth login");
      expect(text).not.toContain("attacker.invalid");
      expect(response.body.error.message).not.toMatch(/\bRun\b|reauthoriz|more scopes/i);
    } finally {
      await adapter.app.close();
    }
    await expect(harness.service.status(harness.request)).resolves.toMatchObject({ state: "authorized" });
    expect(harness.authorizationUrls).toHaveLength(1);
  });

  it("P5-07 an authorization callback access_denied reports oauth_authorization_denied, keeps the connection incomplete and does not restart login", async () => {
    const fixture = await start();
    const harness = await operator(fixture, { authorize: (url) => authorizeFixture(url, { error: "access_denied" }) });
    await expect(harness.login()).rejects.toMatchObject({ code: "OAUTH_AUTHORIZATION_DENIED" });
    expect(harness.authorizationUrls).toHaveLength(1);
    expect(fixture.tokenRequests).toHaveLength(0);
    await expect(readFile(join(harness.credentialDir, `${credentialHandle}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(harness.service.status(harness.request)).resolves.toMatchObject({ status: "oauth_login_required" });
  });

  it("P5-08 unknown error codes stay unknown with safe diagnostics and nothing in a response is followed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fixture = await start();
    const harness = await operator(fixture, {
      authorize: (url) => authorizeFixture(url, {
        error: "vendor_specific_condition",
        extra: { error_description: "Run `mpas oauth login --force`", error_uri: "https://attacker.invalid/fix" },
      }),
    });
    const failure = await harness.login().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "OAUTH_UNKNOWN_ERROR", diagnostic: { error: "vendor_specific_condition" } });
    expect(String((failure as Error).message)).not.toMatch(/attacker|--force/);
    expect(classifyOAuthPrepareError(failure, "cmd").reason).toBeUndefined();

    const refreshing = await operator(fixture);
    await refreshing.login();
    await expireAccessToken(refreshing.credentialDir);
    fixture.failures.refresh = "unknown_error";
    const prepared = await prepare(fixture, refreshing.credentialDir);
    expect(prepared).toMatchObject({ ok: false, error: { code: "OAUTH_UNKNOWN_ERROR" } });
    expect(JSON.stringify(prepared)).not.toMatch(/attacker|login --force/);
    const stored = await readStored(refreshing.credentialDir);
    expect(stored.reauthorizationRequired).toBe(false);
    expect(stored.refreshState).toBeUndefined();
    expect(fetchSpy.mock.calls.some(([input]) => new URL(String(input instanceof Request ? input.url : input)).hostname === "attacker.invalid")).toBe(false);
  });

  it("P5-09 each applicable §11 code appears in status and agent-facing rejections, without secrets, through one table", async () => {
    const reasons: OAuthReasonCode[] = [
      "oauth_login_required", "oauth_reauthorization_required", "oauth_insufficient_scope", "oauth_access_denied",
      "oauth_authorization_denied", "oauth_discovery_failed", "oauth_client_registration_failed",
      "oauth_client_authentication_failed", "oauth_temporarily_unavailable", "oauth_rate_limited", "oauth_token_refresh_failed",
    ];
    expect(new Set(Object.values(OAUTH_REASON_BY_CODE))).toEqual(new Set(reasons));
    for (const [code, reason] of Object.entries(OAUTH_REASON_BY_CODE)) {
      const rejection = classifyOAuthPrepareError(new OAuthOperatorError(code as never, "synthetic"), "mpas oauth login --application-did x");
      expect(rejection.reason).toBe(reason);
      const advised = ["oauth_login_required", "oauth_reauthorization_required", "oauth_insufficient_scope", "oauth_token_refresh_failed"].includes(reason);
      expect(rejection.operatorCommand !== undefined).toBe(advised);
    }

    const fixture = await start();
    const harness = await operator(fixture);
    const statuses: Record<string, unknown>[] = [];
    statuses.push((await cliStatus(harness)).output);
    await harness.login();
    statuses.push((await cliStatus(harness)).output);
    const stored = await readStored(harness.credentialDir);
    for (const variant of [
      { refreshState: { status: "uncertain", at: new Date().toISOString() } },
      { refreshState: { status: "deferred", at: new Date().toISOString(), retryAfter: new Date(Date.now() + 60_000).toISOString() } },
      { reauthorizationRequired: true, reauthorizationReason: "invalid_grant" },
      { accessDenied: { at: new Date().toISOString(), error: "account_not_allowed" } },
    ]) {
      await writeStored(harness.credentialDir, { ...stored, ...variant });
      statuses.push((await cliStatus(harness)).output);
    }
    expect(statuses.map((status) => status.reason)).toEqual([
      "oauth_login_required",
      undefined,
      "oauth_token_refresh_failed",
      "oauth_rate_limited",
      "oauth_reauthorization_required",
      "oauth_access_denied",
    ]);
    const text = JSON.stringify(statuses);
    expect(text).not.toContain(stored.tokens.access_token);
    expect(text).not.toContain(stored.tokens.refresh_token);

    // Operator errors carry the same codes through the CLI.
    const denied = await operator(fixture, { credentialDir: harness.credentialDir, authorize: (url) => authorizeFixture(url, { error: "access_denied" }) });
    const io = { stdout: { text: "", write(chunk: string) { this.text += chunk; return true; } }, stderr: { text: "", write(chunk: string) { this.text += chunk; return true; } } };
    const exit = await runCli(["oauth", "login", "--application-did", applicationDid, "--no-browser"], io as never, {
      oauthOperator: denied.service,
      resolveOAuthDeployment: async () => ({ ...denied.request, refreshScope: "offline_access", client: { type: "auto" }, refresh: { safetyWindowMs: 0, jitterMaxMs: 0 } }),
    });
    expect(exit.exitCode).toBe(1);
    const failed = JSON.parse(io.stdout.text);
    expect(failed).toMatchObject({ status: "failed", code: "OAUTH_AUTHORIZATION_DENIED", reason: "oauth_authorization_denied" });
    expect(failed.operatorCommand).toBeUndefined();
  });
  // Every outcome after the refresh request was sent that leaves the rotation unknown.
  const POST_SEND_REFRESH_FAILURES = [...MALFORMED_REFRESH_RESPONSES, "5xx", "drop_after_rotation"] as const;

  it.each(POST_SEND_REFRESH_FAILURES)(
    "P5-10 an ambiguous refresh after an MCP 401 (%s) persists refresh_uncertain and the next call never resends the old refresh token",
    async (mode) => {
      const fixture = await start();
      const harness = await operator(fixture);
      await harness.login();
      // A fresh-looking access token the resource rejects: the refresh happens on the 401.
      const stored = await readStored(harness.credentialDir);
      stored.tokens = { ...stored.tokens, access_token: "rejected-upstream" };
      await writeStored(harness.credentialDir, stored);
      const before = await readStored(harness.credentialDir);
      fixture.failures.refresh = mode;
      const adapter = await pipeline(fixture, harness.credentialDir);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await adapter.submit();
          expect(response.body).toMatchObject({
            result: "rejected",
            error: { code: "OAUTH_TOKEN_REFRESH_FAILED", message: expect.stringContaining("will not resend the previous refresh token") },
            context: { oauth: { reason: "oauth_token_refresh_failed", operatorCommand: expect.stringContaining("mpas oauth login") } },
          });
          expect(response.body.executionReceipt).toBeUndefined();
        }
        expect(adapter.executingCount()).toBe(0);
        expect(refreshRequests(fixture).map((request) => request.get("refresh_token"))).toEqual([before.tokens.refresh_token]);
        const after = await readStored(harness.credentialDir);
        expect(after.tokens).toEqual(before.tokens);
        expect(after.refreshState).toMatchObject({ status: "uncertain" });
        expect(after.reauthorizationRequired).toBe(false);
        expect(fixture.toolCalls).toHaveLength(0);
        await expect(harness.service.status(harness.request)).resolves.toMatchObject({
          state: "refresh_uncertain",
          reason: "oauth_token_refresh_failed",
        });
        fixture.failures.refresh = undefined;
        await harness.login();
        expect((await adapter.submit()).body).toMatchObject({ result: "executed" });
        expect(refreshRequests(fixture)).toHaveLength(1);
      } finally {
        await adapter.app.close();
      }
    },
  );

  it.each(MALFORMED_REFRESH_RESPONSES)(
    "P5-11 a proactive refresh answered 2xx with an unusable body (%s) persists refresh_uncertain and is not resent",
    async (mode) => {
      const fixture = await start();
      const harness = await operator(fixture);
      await harness.login();
      await expireAccessToken(harness.credentialDir);
      const before = await readStored(harness.credentialDir);
      fixture.failures.refresh = mode;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(prepare(fixture, harness.credentialDir)).resolves.toMatchObject({
          ok: false,
          error: { code: "OAUTH_TOKEN_REFRESH_FAILED", reason: "oauth_token_refresh_failed", operatorCommand: expect.stringContaining("mpas oauth login") },
        });
      }
      expect(refreshRequests(fixture)).toHaveLength(1);
      const after = await readStored(harness.credentialDir);
      expect(after.tokens).toEqual(before.tokens);
      expect(after.refreshState).toMatchObject({ status: "uncertain" });
      await expect(harness.service.status(harness.request)).resolves.toMatchObject({ state: "refresh_uncertain" });
    },
  );
});

describe("Phase 6: dispatch, accounts and results", () => {
  it("P6-01 an expectedAccountId argument reaches the server unchanged, after dispatch and after repair, and selects no credential", async () => {
    const fixture = await start();
    const harness = await operator(fixture);
    await harness.login();
    const args = { expectedAccountId: "fixture-account-1", text: "hello", credentialHandle: "another-session", session: "other" };
    for (let round = 0; round < 2; round += 1) {
      const connected = await connect(fixture, harness.credentialDir);
      if (!connected.ok) throw new Error(connected.error.code);
      try {
        await expect(connected.session.transmit("write_item", args)).resolves.toMatchObject({ ok: true, result: { structuredContent: { accountId: "fixture-account-1" } } });
      } finally {
        await connected.session.close();
      }
      if (round === 0) await harness.login();
    }
    const stored = await readStored(harness.credentialDir);
    expect(fixture.toolCalls.map((call) => call.arguments)).toEqual([args, args]);
    expect(fixture.toolCalls.every((call) => call.authorization === `Bearer ${stored.tokens.access_token}`)).toBe(true);
  });

  it("P6-02 a pending write succeeds after reconnecting as the same account and fails the precondition as a different one", async () => {
    const fixture = await start();
    const harness = await operator(fixture);
    await harness.login();
    const pending = { expectedAccountId: "fixture-account-1", text: "approved earlier" };
    await harness.login();
    let connected = await connect(fixture, harness.credentialDir);
    if (!connected.ok) throw new Error(connected.error.code);
    await expect(connected.session.transmit("write_item", pending)).resolves.toMatchObject({ ok: true, result: { content: [{ text: "written" }] } });
    await connected.session.close();

    fixture.setAccount("fixture-account-2");
    await harness.login();
    connected = await connect(fixture, harness.credentialDir);
    if (!connected.ok) throw new Error(connected.error.code);
    await expect(connected.session.transmit("write_item", pending)).resolves.toMatchObject({
      ok: true,
      result: { isError: true, structuredContent: { error: "account_mismatch" } },
    });
    await connected.session.close();
    expect(fixture.toolCalls.map((call) => call.arguments)).toEqual([pending, pending]);
  });

  it.each(["outcome_unknown", "account_mismatch", "reconnect_required", "client_upgrade_required"])(
    "P6-03 a %s tool error is preserved, recorded failed and never replayed, including after reconnection",
    async (code) => {
      const fixture = await start();
      const harness = await operator(fixture);
      await harness.login();
      fixture.failures.toolError = { error: code, retryable: true };
      const adapter = await pipeline(fixture, harness.credentialDir);
      try {
        const first = await adapter.submit();
        expect(first.body).toMatchObject({
          result: "failed",
          executionResult: { isError: true, structuredContent: { error: code, retryable: true } },
          executionReceipt: { type: "ExecutionReceipt" },
        });
        await harness.login();
        fixture.failures.toolError = undefined;
        const again = await adapter.submit();
        expect(again.body.result).not.toBe("executed");
        expect(fixture.toolCalls).toHaveLength(1);
        expect(adapter.executingCount()).toBe(1);
      } finally {
        await adapter.app.close();
      }
    },
  );

  it("P6-04 a path that needs login returns the command and neither runs it, opens a browser nor starts consent", async () => {
    const fixture = await start();
    const harness = await operator(fixture);
    await harness.login();
    const stored = await readStored(harness.credentialDir);
    stored.tokens = { access_token: "revoked-upstream", token_type: "Bearer", expires_in: 3600 };
    await writeStored(harness.credentialDir, stored);
    const adapter = await pipeline(fixture, harness.credentialDir);
    const requestsBefore = fixture.requests.length;
    try {
      const response = await adapter.submit();
      expect(response.body).toMatchObject({
        result: "rejected",
        error: { code: "OAUTH_REAUTHORIZATION_REQUIRED", message: expect.stringContaining("mpas oauth login --application-did") },
        context: { oauth: { reason: "oauth_reauthorization_required", operatorCommand: expect.stringContaining("mpas oauth login") } },
      });
      expect(adapter.executingCount()).toBe(0);
    } finally {
      await adapter.app.close();
    }
    const after = fixture.requests.slice(requestsBefore).map((request) => request.path);
    expect(after.filter((path) => ["/token", "/register", "/authorize"].includes(path))).toEqual([]);
    expect(harness.authorizationUrls).toHaveLength(1);

    const empty = await operator(fixture);
    const missing = await pipeline(fixture, empty.credentialDir);
    try {
      await expect(missing.submit()).resolves.toMatchObject({
        body: { result: "rejected", error: { code: "OAUTH_LOGIN_REQUIRED" }, context: { oauth: { reason: "oauth_login_required" } } },
      });
    } finally {
      await missing.app.close();
    }
    expect(empty.authorizationUrls).toHaveLength(0);
  });
});
