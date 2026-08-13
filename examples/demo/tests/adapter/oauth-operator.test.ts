import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fileOAuthOperatorService,
  loadFileOAuthClientProvider,
  resolveOAuthApplication,
  unavailableOAuthOperatorService,
} from "../../src/adapter/oauth-operator.js";
import { startOAuthProtectedMcpFixture } from "../fixtures/oauth-protected-mcp.js";

const applicationDid = "did:web:netlify.example";
const resourceUrl = "https://mcp.netlify.com/mcp";
const session = "netlify-production";
const credentialHandle = "netlify-oauth-token";

async function writeDeployment(configDir: string, value: unknown, name = "app.json"): Promise<void> {
  await writeFile(join(configDir, name), `${JSON.stringify(value)}\n`);
}

function oauthDeployment(overrides: Record<string, unknown> = {}) {
  return {
    type: "MpasAdapterDeploymentConfig",
    target: { applicationDid },
    credentialBindings: [{ credentialHandle, provider: "file" }],
    executionTarget: { type: "mcp.http", url: resourceUrl, auth: { type: "oauth2", session } },
    ...overrides,
  };
}

async function writeSessionFile(
  credentialDir: string,
  handle: string,
  sessionValue: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(credentialDir, `${handle}.json`), `${JSON.stringify(sessionValue)}\n`);
}

describe("OAuth operator service", () => {
  it("returns unavailable for every operator method", async () => {
    const service = unavailableOAuthOperatorService();
    const request = { applicationDid, resourceUrl, session, credentialHandle };
    for (const method of ["login", "status", "logout"] as const) {
      await expect(service[method]({ ...request, openBrowser: false })).resolves.toMatchObject({
        status: "oauth_operator_service_unavailable",
        operatorCommand: `mpas oauth login --application-did '${applicationDid}'`,
      });
    }
  });

  it("rejects unreadable configs, invalid JSON, and unknown application DIDs", async () => {
    await expect(resolveOAuthApplication(join(tmpdir(), "mpas-oauth-missing-dir"), applicationDid))
      .rejects.toThrow(/Unable to read OAuth deployment config directory/);

    const brokenDir = await mkdtemp(join(tmpdir(), "mpas-oauth-broken-"));
    await writeFile(join(brokenDir, "broken.json"), "{not-json");
    await expect(resolveOAuthApplication(brokenDir, applicationDid))
      .rejects.toThrow(/not valid JSON/);

    const unknownDir = await mkdtemp(join(tmpdir(), "mpas-oauth-unknown-"));
    await writeDeployment(unknownDir, oauthDeployment());
    await expect(resolveOAuthApplication(unknownDir, "did:web:unknown.example"))
      .rejects.toThrow(/Unknown OAuth application DID/);
  });

  it("rejects invalid OAuth session names and missing file credential bindings", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mpas-oauth-session-"));
    await writeDeployment(configDir, oauthDeployment({
      executionTarget: { type: "mcp.http", url: resourceUrl, auth: { type: "oauth2", session: "has spaces" } },
    }));
    await expect(resolveOAuthApplication(configDir, applicationDid))
      .rejects.toThrow(/valid executionTarget.auth.session/);

    const missingBindingDir = await mkdtemp(join(tmpdir(), "mpas-oauth-binding-"));
    await writeDeployment(missingBindingDir, oauthDeployment({
      credentialBindings: [{ credentialHandle, provider: "macos-keychain" }],
    }));
    await expect(resolveOAuthApplication(missingBindingDir, applicationDid))
      .rejects.toThrow(/one file credential binding/);
  });

  it("ignores non-deployment JSON files while resolving a valid OAuth application", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mpas-oauth-skip-"));
    await writeDeployment(configDir, { type: "NotADeployment" }, "notes.json");
    await writeDeployment(configDir, oauthDeployment({
      executionTarget: {
        type: "mcp.http",
        url: resourceUrl,
        auth: { type: "oauth2", session, scopes: ["mcp:tools", "mcp:resources"] },
      },
      plugin: { path: "unused.json" },
    }), "app.json");
    await expect(resolveOAuthApplication(configDir, applicationDid)).resolves.toEqual({
      applicationDid,
      resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools", "mcp:resources"],
    });
  });

  it("loads a stored provider only when session identity fields match", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-load-"));
    await writeSessionFile(credentialDir, credentialHandle, {
      version: 1,
      session,
      credentialHandle,
      applicationDid,
      resourceUrl,
      state: "state",
      redirectUrl: "http://127.0.0.1:1/oauth/callback",
      tokens: { access_token: "tok", token_type: "Bearer" },
    });

    await expect(loadFileOAuthClientProvider(session, credentialHandle, applicationDid, resourceUrl, credentialDir))
      .resolves.toBeDefined();
    await expect(loadFileOAuthClientProvider("other-session", credentialHandle, applicationDid, resourceUrl, credentialDir))
      .resolves.toBeUndefined();
    await expect(loadFileOAuthClientProvider(session, "other-token", applicationDid, resourceUrl, credentialDir))
      .resolves.toBeUndefined();
    await expect(loadFileOAuthClientProvider(session, credentialHandle, "did:web:other.example", resourceUrl, credentialDir))
      .resolves.toBeUndefined();
    await expect(loadFileOAuthClientProvider(session, credentialHandle, applicationDid, "https://other.example/mcp", credentialDir))
      .resolves.toBeUndefined();
  });

  it("omits a stored session that has no tokens", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-notokens-"));
    await writeSessionFile(credentialDir, credentialHandle, {
      version: 1,
      session,
      credentialHandle,
      applicationDid,
      resourceUrl,
      state: "state",
      redirectUrl: "http://127.0.0.1:1/oauth/callback",
    });
    await expect(loadFileOAuthClientProvider(session, credentialHandle, applicationDid, resourceUrl, credentialDir))
      .resolves.toBeUndefined();
  });

  it("rejects invalid credential handles before reading a session file", async () => {
    await expect(loadFileOAuthClientProvider(session, "bad handle", applicationDid, resourceUrl))
      .rejects.toThrow(/letters, digits, dots, underscores, or hyphens/);
  });

  it("reports static vs dynamic client mode, expiry, scopes, and refreshability from stored tokens", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-status-"));
    const service = fileOAuthOperatorService({ credentialDir });
    const request = { applicationDid, resourceUrl, session, credentialHandle };

    await expect(service.status(request)).resolves.toMatchObject({ status: "oauth_login_required" });

    await writeSessionFile(credentialDir, credentialHandle, {
      version: 1,
      session,
      credentialHandle,
      applicationDid,
      resourceUrl,
      state: "state",
      redirectUrl: "http://127.0.0.1:1/oauth/callback",
      tokens: {
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh",
        scope: "mcp:tools extra",
      },
      tokensSavedAt: "2026-08-13T00:00:00.000Z",
      discovery: { authorizationServerUrl: "https://auth.example/issuer" },
    });
    await expect(service.status(request)).resolves.toEqual({
      status: "authorized",
      applicationDid,
      issuer: "https://auth.example/issuer",
      resource: resourceUrl,
      clientMode: "static",
      scopes: ["mcp:tools", "extra"],
      expiresAt: "2026-08-13T01:00:00.000Z",
      refreshable: true,
      reauthorizationRequired: false,
    });

    await writeSessionFile(credentialDir, credentialHandle, {
      version: 1,
      session,
      credentialHandle,
      applicationDid,
      resourceUrl,
      state: "state",
      redirectUrl: "http://127.0.0.1:1/oauth/callback",
      tokens: { access_token: "tok", token_type: "Bearer" },
      clientInformation: { client_id: "dynamic-client", scope: "from-client" },
    });
    await expect(service.status(request)).resolves.toMatchObject({
      status: "authorized",
      clientMode: "dynamic",
      scopes: ["from-client"],
      refreshable: false,
      issuer: "unknown",
    });
  });

  it("throws when a loaded provider has no PKCE verifier", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-pkce-"));
    await writeSessionFile(credentialDir, credentialHandle, {
      version: 1,
      session,
      credentialHandle,
      applicationDid,
      resourceUrl,
      state: "state",
      redirectUrl: "http://127.0.0.1:1/oauth/callback",
      tokens: { access_token: "tok", token_type: "Bearer" },
    });
    const provider = await loadFileOAuthClientProvider(
      session,
      credentialHandle,
      applicationDid,
      resourceUrl,
      credentialDir,
    );
    expect(provider).toBeDefined();
    expect(() => provider!.codeVerifier()).toThrow(/PKCE verifier is unavailable/);
  });

  it("returns a stored PKCE verifier and throws on corrupt session files", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-verifier-"));
    await writeSessionFile(credentialDir, credentialHandle, {
      version: 1,
      session,
      credentialHandle,
      applicationDid,
      resourceUrl,
      state: "state",
      redirectUrl: "http://127.0.0.1:1/oauth/callback",
      tokens: { access_token: "tok", token_type: "Bearer" },
      codeVerifier: "stored-verifier",
    });
    const provider = await loadFileOAuthClientProvider(
      session,
      credentialHandle,
      applicationDid,
      resourceUrl,
      credentialDir,
    );
    expect(provider!.codeVerifier()).toBe("stored-verifier");

    await writeFile(join(credentialDir, `${credentialHandle}.json`), "{not-json");
    await expect(
      fileOAuthOperatorService({ credentialDir }).status({ applicationDid, resourceUrl, session, credentialHandle }),
    ).rejects.toThrow();
  });

  it("opens the authorization URL through an injected browser callback", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-browser-"));
    const opened: string[] = [];
    const service = fileOAuthOperatorService({
      credentialDir,
      testOnlyAllowHttpLoopback: true,
      openBrowser: async (url) => {
        opened.push(url.toString());
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", "fixture-code");
        redirect.searchParams.set("state", url.searchParams.get("state")!);
        await fetch(redirect);
      },
    });
    try {
      await expect(service.login({
        applicationDid,
        resourceUrl: fixture.resourceUrl,
        session,
        credentialHandle,
        scopes: ["mcp:tools"],
        openBrowser: true,
      })).resolves.toMatchObject({ status: "authorized" });
      expect(opened).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("rejects OAuth callbacks that 404, report errors, omit fields, mismatch state, or time out", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-callback-"));
    const request = {
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      openBrowser: false,
    };

    const startLogin = (callbackTimeoutMs = 5_000) => {
      let authorizationUrl: URL | undefined;
      const loginPromise = fileOAuthOperatorService({
        credentialDir,
        testOnlyAllowHttpLoopback: true,
        callbackTimeoutMs,
        onAuthorizationUrl: (url) => {
          authorizationUrl = url;
        },
      }).login(request);
      return { loginPromise, authorizationUrl: () => authorizationUrl };
    };

    const afterWaitForCode = async (authorizationUrl: () => URL | undefined) => {
      await vi.waitFor(() => {
        expect(authorizationUrl()).toBeDefined();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new URL(authorizationUrl()!.searchParams.get("redirect_uri")!);
    };

    try {
      const notFound = startLogin();
      const notFoundRedirect = await afterWaitForCode(notFound.authorizationUrl);
      const missing = await fetch(new URL("/not-callback", notFoundRedirect.origin));
      expect(missing.status).toBe(404);
      notFoundRedirect.searchParams.set("code", "fixture-code");
      notFoundRedirect.searchParams.set("state", notFound.authorizationUrl()!.searchParams.get("state")!);
      await fetch(notFoundRedirect);
      await expect(notFound.loginPromise).resolves.toMatchObject({ status: "authorized" });

      const failed = startLogin();
      const failedRedirect = await afterWaitForCode(failed.authorizationUrl);
      const failedAssertion = expect(failed.loginPromise).rejects.toThrow(/OAuth authorization failed/);
      failedRedirect.searchParams.set("error", "access_denied");
      await fetch(failedRedirect);
      await failedAssertion;

      const incomplete = startLogin();
      const incompleteRedirect = await afterWaitForCode(incomplete.authorizationUrl);
      const incompleteAssertion = expect(incomplete.loginPromise).rejects.toThrow(/missing code or state/);
      await fetch(incompleteRedirect);
      await incompleteAssertion;

      const mismatch = startLogin();
      const mismatchRedirect = await afterWaitForCode(mismatch.authorizationUrl);
      const mismatchAssertion = expect(mismatch.loginPromise).rejects.toThrow(/state mismatch/);
      mismatchRedirect.searchParams.set("code", "fixture-code");
      mismatchRedirect.searchParams.set("state", "other-state");
      await fetch(mismatchRedirect);
      await mismatchAssertion;

      const timedOut = startLogin(200);
      const timeoutAssertion = expect(timedOut.loginPromise).rejects.toThrow(/timed out/);
      await afterWaitForCode(timedOut.authorizationUrl);
      await timeoutAssertion;
    } finally {
      await fixture.close();
    }
  });
});
