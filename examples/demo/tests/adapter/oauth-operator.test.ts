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

function storedSession(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    session,
    credentialHandle,
    applicationDid,
    resourceUrl,
    state: "state",
    redirectUrl: "http://127.0.0.1:1/oauth/callback",
    tokens: { access_token: "tok", token_type: "Bearer" },
    ...overrides,
  };
}

async function waitForAuthorizationUrl(getUrl: () => URL | undefined): Promise<URL> {
  await vi.waitFor(() => {
    expect(getUrl()).toBeDefined();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  return new URL(getUrl()!.searchParams.get("redirect_uri")!);
}

describe("OAuth operator service", () => {
  it("returns unavailable for every operator method", async () => {
    const service = unavailableOAuthOperatorService();
    const request = { applicationDid, resourceUrl, session, credentialHandle };
    for (const method of ["login", "status", "logout"] as const) {
      await expect(service[method]({ ...request, openBrowser: false })).resolves.toMatchObject({
        status: "oauth_operator_service_unavailable",
      });
    }
  });

  it("rejects an unreadable config directory", async () => {
    await expect(resolveOAuthApplication(join(tmpdir(), "mpas-oauth-missing-dir"), applicationDid)).rejects.toThrow(
      /Unable to read OAuth deployment config directory/,
    );
  });

  it("rejects invalid JSON and unknown application DIDs", async () => {
    const brokenDir = await mkdtemp(join(tmpdir(), "mpas-oauth-broken-"));
    await writeFile(join(brokenDir, "broken.json"), "{not-json");
    await expect(resolveOAuthApplication(brokenDir, applicationDid)).rejects.toThrow(/not valid JSON/);

    const unknownDir = await mkdtemp(join(tmpdir(), "mpas-oauth-unknown-"));
    await writeDeployment(unknownDir, oauthDeployment());
    await expect(resolveOAuthApplication(unknownDir, "did:web:unknown.example")).rejects.toThrow(
      /Unknown OAuth application DID/,
    );
  });

  it("rejects invalid OAuth session names and missing file credential bindings", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mpas-oauth-session-"));
    await writeDeployment(configDir, oauthDeployment({
      executionTarget: { type: "mcp.http", url: resourceUrl, auth: { type: "oauth2", session: "has spaces" } },
    }));
    await expect(resolveOAuthApplication(configDir, applicationDid)).rejects.toThrow(
      /valid executionTarget.auth.session/,
    );

    const missingBindingDir = await mkdtemp(join(tmpdir(), "mpas-oauth-binding-"));
    await writeDeployment(missingBindingDir, oauthDeployment({
      credentialBindings: [{ credentialHandle, provider: "macos-keychain" }],
    }));
    await expect(resolveOAuthApplication(missingBindingDir, applicationDid)).rejects.toThrow(
      /one file credential binding/,
    );
  });

  it("loads a stored provider only when session identity fields match", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-load-"));
    await writeSessionFile(credentialDir, credentialHandle, storedSession());

    await expect(loadFileOAuthClientProvider(session, credentialHandle, applicationDid, resourceUrl, credentialDir))
      .resolves.toBeDefined();
    await expect(
      loadFileOAuthClientProvider("other-session", credentialHandle, applicationDid, resourceUrl, credentialDir),
    ).resolves.toBeUndefined();
  });

  it("omits a stored session that has no tokens", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-notokens-"));
    const { tokens: _tokens, ...sessionWithoutTokens } = storedSession();
    await writeSessionFile(credentialDir, credentialHandle, sessionWithoutTokens);
    await expect(
      loadFileOAuthClientProvider(session, credentialHandle, applicationDid, resourceUrl, credentialDir),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid credential handles before reading a session file", async () => {
    await expect(loadFileOAuthClientProvider(session, "bad handle", applicationDid, resourceUrl)).rejects.toThrow(
      /letters, digits, dots, underscores, or hyphens/,
    );
  });

  it("reports login required until tokens are stored", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-status-"));
    const service = fileOAuthOperatorService({ credentialDir });
    const request = { applicationDid, resourceUrl, session, credentialHandle };

    await expect(service.status(request)).resolves.toMatchObject({ status: "oauth_login_required" });

    await writeSessionFile(credentialDir, credentialHandle, storedSession({
      tokens: { access_token: "tok", token_type: "Bearer", refresh_token: "refresh" },
      discovery: { authorizationServerUrl: "https://auth.example/issuer" },
    }));
    await expect(service.status(request)).resolves.toMatchObject({
      status: "authorized",
      refreshable: true,
      issuer: "https://auth.example/issuer",
    });
  });

  it("throws when a loaded provider has no PKCE verifier", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-pkce-"));
    await writeSessionFile(credentialDir, credentialHandle, storedSession());
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
});

describe("OAuth operator callbacks", () => {
  async function startLogin(fixture: Awaited<ReturnType<typeof startOAuthProtectedMcpFixture>>, callbackTimeoutMs = 5_000) {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-callback-"));
    let authorizationUrl: URL | undefined;
    const loginPromise = fileOAuthOperatorService({
      credentialDir,
      testOnlyAllowHttpLoopback: true,
      callbackTimeoutMs,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
      },
    }).login({
      applicationDid,
      resourceUrl: fixture.resourceUrl,
      session,
      credentialHandle,
      scopes: ["mcp:tools"],
      openBrowser: false,
    });
    return { loginPromise, authorizationUrl: () => authorizationUrl };
  }

  it("rejects an authorization error from the callback", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    try {
      const login = await startLogin(fixture);
      const redirect = await waitForAuthorizationUrl(login.authorizationUrl);
      const assertion = expect(login.loginPromise).rejects.toThrow(/OAuth authorization failed/);
      redirect.searchParams.set("error", "access_denied");
      await fetch(redirect);
      await assertion;
    } finally {
      await fixture.close();
    }
  });

  it("rejects a callback that omits code and state", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    try {
      const login = await startLogin(fixture);
      const redirect = await waitForAuthorizationUrl(login.authorizationUrl);
      const assertion = expect(login.loginPromise).rejects.toThrow(/missing code or state/);
      await fetch(redirect);
      await assertion;
    } finally {
      await fixture.close();
    }
  });

  it("rejects a callback whose state does not match", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    try {
      const login = await startLogin(fixture);
      const redirect = await waitForAuthorizationUrl(login.authorizationUrl);
      const assertion = expect(login.loginPromise).rejects.toThrow(/state mismatch/);
      redirect.searchParams.set("code", "fixture-code");
      redirect.searchParams.set("state", "other-state");
      await fetch(redirect);
      await assertion;
    } finally {
      await fixture.close();
    }
  });

  it("rejects a callback that never arrives", async () => {
    const fixture = await startOAuthProtectedMcpFixture();
    try {
      const login = await startLogin(fixture, 200);
      const assertion = expect(login.loginPromise).rejects.toThrow(/timed out/);
      await waitForAuthorizationUrl(login.authorizationUrl);
      await assertion;
    } finally {
      await fixture.close();
    }
  });
});
