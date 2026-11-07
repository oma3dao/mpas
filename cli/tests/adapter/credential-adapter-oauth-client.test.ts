/**
 * Credential Adapter OAuth plan, Phases 1-3: fixtures, client documents and
 * selection, and `private_key_jwt` (docs/features/credential-adapter-oauth/plan.md).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyManager, signMpasRfc9421, verifyMpasRfc9421, type MpasRawSigner } from "@oma3/mpas";
import { createOAuthFetchPolicy } from "../../src/adapter/oauth-fetch-policy.js";
import {
  fileOAuthOperatorService,
  matchesRegisteredRedirectUri,
  OAuthOperatorError,
  validateClientMetadataDocument,
  validateClientMetadataDocumentValue,
} from "../../src/adapter/oauth-operator.js";
import { prepareMcpHttp } from "../../src/adapter/dispatch/mcp-http.js";
import { AdapterKeyNotFoundError, defaultAdapterKeyPath, loadAdapterKey } from "../../src/adapter/adapter-key.js";
import { generateKeyFile, runCli } from "../../src/cli/index.js";
import {
  CLIENT_ASSERTION_TYPE,
  enrolledAdapterClientDocument,
  FAKE_SIGNERSET_ORIGIN,
  startOAuthProtectedMcpFixture,
  type OAuthProtectedMcpFixture,
  type OAuthProtectedMcpFixtureOptions,
} from "../fixtures/oauth-protected-mcp.js";
import {
  adapterKey,
  applicationDid,
  credentialHandle,
  enroll,
  expireAccessToken,
  keyLoader,
  operator,
  pipeline,
  prepare,
  readStored,
  session,
  tempDir,
  writeStored,
  type TestKey,
} from "./credential-adapter-oauth-harness.js";

const fixtures: OAuthProtectedMcpFixture[] = [];
async function start(options: OAuthProtectedMcpFixtureOptions = {}) {
  const fixture = await startOAuthProtectedMcpFixture(options);
  fixtures.push(fixture);
  return fixture;
}
const ENROLLED: OAuthProtectedMcpFixtureOptions = {
  clientIdMetadataDocumentSupported: true,
  privateKeyJwt: {},
  advertiseRevocationEndpoint: true,
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function enrolledLogin(fixture: OAuthProtectedMcpFixture, key: TestKey, overrides: Record<string, unknown> = {}) {
  const url = enroll(fixture, key, overrides);
  const harness = await operator(fixture, { key, client: { type: "cimd", clientIdMetadataDocument: url } });
  return { url, harness };
}

describe("Phase 1: fixtures", () => {
  it("P1-01 every fixture mode starts and stops in-process with no network access and logs no secret by default", async () => {
    const writes: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => { writes.push(args.join(" ")); });
    }
    const modes: OAuthProtectedMcpFixtureOptions[] = [
      {},
      ENROLLED,
      { privateKeyJwt: { advertise: false, signingAlgorithms: ["ES256"], revocationAuthMethods: ["none"] } },
      { scopesSupported: null, authorizationServerScopesSupported: ["offline_access"], challengeScope: null },
      { issueRefreshToken: false },
      { grantedScope: "mcp:tools linkedin:w_member_social", refreshOmitsScope: true },
    ];
    for (const options of modes) {
      const fixture = await startOAuthProtectedMcpFixture(options);
      try {
        expect(new URL(fixture.origin).hostname).toBe("127.0.0.1");
        const key = await adapterKey();
        const documentUrl = enroll(fixture, key);
        expect(documentUrl.startsWith(FAKE_SIGNERSET_ORIGIN)).toBe(true);
        expect((await fixture.fetch(documentUrl)).status).toBe(200);
        expect((await fixture.fetch(`${fixture.origin}/.well-known/oauth-authorization-server/issuer`)).status).toBe(200);
        for (const mode of ["404", "invalid_json", "429", "5xx"] as const) {
          fixture.failures.resourceMetadata = mode;
          fixture.failures.clientDocument = mode;
          const response = await fixture.fetch(`${fixture.origin}/.well-known/oauth-protected-resource/mcp`);
          expect(response.status === 200 ? mode : String(response.status)).not.toBe("200");
          await fixture.fetch(documentUrl);
        }
        fixture.failures.resourceMetadata = "timeout";
        const held = fixture.fetch(`${fixture.origin}/.well-known/oauth-protected-resource/mcp`).catch(() => "closed");
        fixture.failures.resourceDenial = "account_not_allowed";
        fixture.failures.refresh = "drop_after_rotation";
        await fixture.close();
        await expect(held).resolves.toBe("closed");
      } finally {
        await fixture.close().catch(() => {});
      }
    }
    expect(writes).toEqual([]);
  });
});

describe("Phase 2: client documents and selection", () => {
  const clientId = `${FAKE_SIGNERSET_ORIGIN}/signerset/v1/clients/did:jwk:example`;
  const selected = "http://127.0.0.1:53111/oauth/callback";
  const document = (overrides: Record<string, unknown> = {}) => ({
    client_id: clientId,
    client_name: "Enrolled adapter",
    redirect_uris: [
      "https://callback.other.example/oauth/callback",
      "http://127.0.0.1/oauth/callback",
      "http://[::1]/oauth/callback",
    ],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...overrides,
  });
  const rejectsWith = (fn: () => unknown, code: string) => {
    let thrown: unknown;
    try { fn(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(OAuthOperatorError);
    expect(thrown).toMatchObject({ code });
  };

  it("P2-01 accepts three redirect URIs when the selected callback is one of them, and rejects an absent one", () => {
    expect(validateClientMetadataDocumentValue(document(), clientId, selected, true)).toMatchObject({ client_id: clientId });
    expect(validateClientMetadataDocumentValue(document(), clientId, "https://callback.other.example/oauth/callback", true))
      .toMatchObject({ client_id: clientId });
    rejectsWith(
      () => validateClientMetadataDocumentValue(document(), clientId, "http://127.0.0.1:53111/other/callback", true),
      "OAUTH_CLIENT_REGISTRATION_FAILED",
    );
  });

  it("P2-02 matches a registered loopback redirect on any port with host, path and query unchanged", () => {
    const registered = "http://127.0.0.1/callback";
    expect(matchesRegisteredRedirectUri(registered, "http://127.0.0.1:49152/callback")).toBe(true);
    expect(matchesRegisteredRedirectUri(registered, "http://127.0.0.1:1/callback")).toBe(true);
    expect(matchesRegisteredRedirectUri("http://127.0.0.1:8080/callback", "http://127.0.0.1:49152/callback")).toBe(true);
    expect(matchesRegisteredRedirectUri("http://127.0.0.1/callback?x=1", "http://127.0.0.1:49152/callback?x=1")).toBe(true);
    expect(matchesRegisteredRedirectUri(registered, "http://127.0.0.1:49152/callback/")).toBe(false);
    expect(matchesRegisteredRedirectUri(registered, "http://127.0.0.1:49152/other")).toBe(false);
    expect(matchesRegisteredRedirectUri("http://127.0.0.1/callback?x=1", "http://127.0.0.1:49152/callback?x=2")).toBe(false);
    expect(matchesRegisteredRedirectUri("http://localhost/callback", "http://127.0.0.1:49152/callback")).toBe(false);
    expect(matchesRegisteredRedirectUri(registered, "http://localhost:49152/callback")).toBe(false);
    expect(matchesRegisteredRedirectUri(registered, "https://127.0.0.1:49152/callback")).toBe(false);
  });

  it("P2-03 accepts an exact registered HTTPS callback on a domain other than the document's host", () => {
    const callback = "https://callback.other.example/oauth/callback";
    expect(new URL(callback).host).not.toBe(new URL(clientId).host);
    expect(validateClientMetadataDocumentValue(document({ redirect_uris: [callback] }), clientId, callback, true))
      .toMatchObject({ redirect_uris: [callback] });
    rejectsWith(
      () => validateClientMetadataDocumentValue(document({ redirect_uris: [callback] }), clientId, `${callback}/`, true),
      "OAUTH_CLIENT_REGISTRATION_FAILED",
    );
    rejectsWith(
      () => validateClientMetadataDocumentValue(
        document({ redirect_uris: [callback] }),
        clientId,
        "https://callback.other.example:8443/oauth/callback",
        true,
      ),
      "OAUTH_CLIENT_REGISTRATION_FAILED",
    );
  });

  it("P2-04 accepts standard public metadata and rejects private key material or references", async () => {
    const key = await adapterKey();
    expect(validateClientMetadataDocumentValue(document({
      token_endpoint_auth_method: "private_key_jwt",
      jwks: { keys: [key.publicJwk] },
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_signing_alg: "EdDSA",
    }), clientId, selected, true)).toMatchObject({ token_endpoint_auth_method: "private_key_jwt" });
    rejectsWith(
      () => validateClientMetadataDocumentValue(document({ jwks: { keys: [key.privateJwk] } }), clientId, selected, true),
      "OAUTH_CLIENT_REGISTRATION_FAILED",
    );
    for (const field of [
      { private_key_jwk: key.publicJwk },
      { privateKey: "file:///home/operator/.mpas/keys/adapter.json" },
      { client_secret: "inline" },
      { software_statement_key: "{{credential:adapter-key}}" },
    ]) {
      rejectsWith(() => validateClientMetadataDocumentValue(document(field), clientId, selected, true), "OAUTH_CLIENT_REGISTRATION_FAILED");
    }
  });

  it("P2-05 keeps every shipped rejection", async () => {
    const valid = document();
    const serve = (body: unknown, init: ResponseInit = {}) => createOAuthFetchPolicy({
      fetch: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
      }),
      timeoutMs: 100,
    });
    const rejects = async (promise: Promise<unknown>, code: string) => {
      await expect(promise).rejects.toBeInstanceOf(OAuthOperatorError);
      await expect(promise).rejects.toMatchObject({ code });
    };
    await rejects(validateClientMetadataDocument("http://signerset.test/clients/x", selected, true, serve(valid)), "OAUTH_CLIENT_REGISTRATION_FAILED");
    await rejects(validateClientMetadataDocument(`${FAKE_SIGNERSET_ORIGIN}/`, selected, true, serve(valid)), "OAUTH_CLIENT_REGISTRATION_FAILED");
    await rejects(validateClientMetadataDocument(clientId, selected, true, serve("", {
      status: 302,
      headers: { location: "https://attacker.invalid/document" },
    })), "OAUTH_CLIENT_REGISTRATION_FAILED");
    await rejects(validateClientMetadataDocument(clientId, selected, true, serve({ ...valid, client_id: `${clientId}-other` })), "OAUTH_CLIENT_REGISTRATION_FAILED");
    await rejects(validateClientMetadataDocument(clientId, selected, true, serve(
      JSON.stringify({ ...valid, padding: "x".repeat(70_000) }),
      { headers: { "content-type": "text/plain" } },
    )), "OAUTH_CLIENT_REGISTRATION_FAILED");
    const hanging = createOAuthFetchPolicy({
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }),
      timeoutMs: 50,
    });
    await rejects(validateClientMetadataDocument(clientId, selected, true, hanging), "OAUTH_TEMPORARILY_UNAVAILABLE");
    const { client_name: _name, ...withoutName } = valid;
    await rejects(validateClientMetadataDocument(clientId, selected, true, serve(withoutName)), "OAUTH_CLIENT_REGISTRATION_FAILED");
    const { redirect_uris: _redirects, ...withoutRedirects } = valid;
    await rejects(validateClientMetadataDocument(clientId, selected, true, serve(withoutRedirects)), "OAUTH_CLIENT_REGISTRATION_FAILED");
    await rejects(validateClientMetadataDocument(clientId, selected, true, serve({ ...valid, grant_types: ["authorization_code"] })), "OAUTH_CLIENT_REGISTRATION_FAILED");
    await expect(validateClientMetadataDocument(clientId, selected, false, serve({ ...valid, grant_types: ["authorization_code"] })))
      .resolves.toMatchObject({ client_id: clientId });
  });

  it("P2-06 accepts the document at the fake SignerSet URL for the adapter's DID as CIMD, with that URL as client_id", async () => {
    const fixture = await start(ENROLLED);
    const key = await adapterKey();
    const { url, harness } = await enrolledLogin(fixture, key);
    expect(url).toBe(`${FAKE_SIGNERSET_ORIGIN}/signerset/v1/clients/${key.did}`);
    await expect(harness.login()).resolves.toMatchObject({ status: "authorized", clientMode: "cimd", clientAuthentication: "private_key_jwt" });
    expect(harness.authorizationUrls[0].searchParams.get("client_id")).toBe(url);
    expect(fixture.tokenRequests[0].get("client_id")).toBe(url);
    expect(fixture.registrationRequests).toHaveLength(0);
    expect((await readStored(harness.credentialDir)).binding).toMatchObject({ clientMode: "cimd", clientId: url });
  });

  it("P2-07 fails with oauth_client_registration_failed when CIMD is configured but not advertised, without DCR or public fallback", async () => {
    const fixture = await start({ privateKeyJwt: {} });
    const key = await adapterKey();
    const { harness } = await enrolledLogin(fixture, key);
    await expect(harness.login()).rejects.toMatchObject({ code: "OAUTH_CLIENT_REGISTRATION_FAILED" });
    expect(fixture.registrationRequests).toHaveLength(0);
    expect(fixture.tokenRequests).toHaveLength(0);
    expect(harness.authorizationUrls).toHaveLength(0);
    await expect(readFile(join(harness.credentialDir, `${credentialHandle}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("P2-08 takes the client document, callback and signing key only from operator configuration", async () => {
    const fixture = await start(ENROLLED);
    const key = await adapterKey();
    const { url, harness } = await enrolledLogin(fixture, key);
    await harness.login();
    const before = await readStored(harness.credentialDir);
    const prepared = await prepare(fixture, harness.credentialDir, { key });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const mcp = await prepareMcpHttp(
      { type: "mcp.http", url: fixture.resourceUrl, auth: { type: "oauth2", session } },
      undefined, "2025-06-18", prepared.provider,
    );
    expect(mcp.ok).toBe(true);
    if (!mcp.ok) return;
    const hostile = {
      expectedAccountId: "fixture-account-1",
      client_id: "https://attacker.invalid/client",
      clientIdMetadataDocument: "https://attacker.invalid/client",
      redirect_uri: "https://attacker.invalid/callback",
      signingKey: "/etc/attacker-key.json",
      credentialHandle: "other-handle",
    };
    try {
      await mcp.session.transmit("write_item", hostile);
    } finally {
      await mcp.session.close();
    }
    fixture.failures.resourceDenial = "other";
    const denied = await prepareMcpHttp(
      { type: "mcp.http", url: fixture.resourceUrl, auth: { type: "oauth2", session } },
      undefined, "2025-06-18", (await prepare(fixture, harness.credentialDir, { key }) as unknown as { provider: never }).provider,
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "OAUTH_RESOURCE_FORBIDDEN" } });
    expect(JSON.stringify(denied)).not.toContain("attacker.invalid");
    const after = await readStored(harness.credentialDir);
    expect(after.binding).toEqual(before.binding);
    expect(after.clientInformation).toMatchObject({ client_id: url });
    expect(fixture.clientDocumentRequests.every((request) => request === url)).toBe(true);
    expect(fixture.toolCalls[0].arguments).toEqual(hostile);
    expect(fixture.toolCalls[0].authorization).toBe(`Bearer ${before.tokens.access_token}`);
  });

  it.each([
    { target: "clientDocument", mode: "timeout", code: "OAUTH_TEMPORARILY_UNAVAILABLE" },
    { target: "clientDocument", mode: "429", code: "OAUTH_RATE_LIMITED" },
    { target: "clientDocument", mode: "5xx", code: "OAUTH_TEMPORARILY_UNAVAILABLE" },
    { target: "clientDocument", mode: "404", code: "OAUTH_CLIENT_REGISTRATION_FAILED" },
    { target: "clientDocument", mode: "invalid_json", code: "OAUTH_CLIENT_REGISTRATION_FAILED" },
    { target: "resourceMetadata", mode: "timeout", code: "OAUTH_TEMPORARILY_UNAVAILABLE" },
    { target: "resourceMetadata", mode: "429", code: "OAUTH_RATE_LIMITED" },
    { target: "resourceMetadata", mode: "5xx", code: "OAUTH_TEMPORARILY_UNAVAILABLE" },
    { target: "resourceMetadata", mode: "404", code: "OAUTH_DISCOVERY_FAILED" },
    { target: "resourceMetadata", mode: "invalid_json", code: "OAUTH_DISCOVERY_FAILED" },
    { target: "authorizationServerMetadata", mode: "429", code: "OAUTH_RATE_LIMITED" },
    { target: "authorizationServerMetadata", mode: "5xx", code: "OAUTH_TEMPORARILY_UNAVAILABLE" },
    { target: "authorizationServerMetadata", mode: "404", code: "OAUTH_DISCOVERY_FAILED" },
  ] as const)("P2-09 metadata $target $mode reports $code and keeps the stored session and identity", async ({ target, mode, code }) => {
    const fixture = await start(ENROLLED);
    const key = await adapterKey();
    const url = enroll(fixture, key);
    const harness = await operator(fixture, {
      key,
      client: { type: "cimd", clientIdMetadataDocument: url },
      extra: { requestTimeoutMs: 200 },
    });
    await harness.login();
    const before = await readFile(join(harness.credentialDir, `${credentialHandle}.json`));
    fixture.failures[target] = mode;
    await expect(harness.login()).rejects.toMatchObject({ code });
    expect(await readFile(join(harness.credentialDir, `${credentialHandle}.json`))).toEqual(before);
    expect(harness.authorizationUrls).toHaveLength(1);
    await expect(harness.service.status(harness.request)).resolves.toMatchObject({
      status: "authorized",
      state: "authorized",
      clientMode: "cimd",
      clientAuthentication: "private_key_jwt",
    });
  });

  it("P2-10 logs in the same way with a document another enrollment service publishes at its own host and path", async () => {
    const fixture = await start(ENROLLED);
    const key = await adapterKey();
    // Not SignerSet's origin or path, and no DID in the URL: the CLI reads nothing from either.
    const url = "https://enrollment.example.test/registered/adapter-7";
    fixture.publishClientDocument(url, enrolledAdapterClientDocument(url, key.publicJwk));
    const harness = await operator(fixture, { key, client: { type: "cimd", clientIdMetadataDocument: url } });
    await expect(harness.login()).resolves.toMatchObject({ status: "authorized", clientMode: "cimd", clientAuthentication: "private_key_jwt" });
    expect(fixture.clientDocumentRequests).toContain(url);
    expect(harness.authorizationUrls[0].searchParams.get("client_id")).toBe(url);
    expect(fixture.tokenRequests[0].get("client_id")).toBe(url);
    expect(fixture.clientAssertions[0].claims).toMatchObject({ iss: url, sub: url });
    expect((await readStored(harness.credentialDir)).binding).toMatchObject({ clientMode: "cimd", clientId: url });
  });
});

describe.each(["Ed25519", "P-256"] as const)("Phase 3: private_key_jwt with an %s adapter key", (suite) => {
  const algorithm = suite === "Ed25519" ? "EdDSA" : "ES256";

  async function enrolledSession(options: OAuthProtectedMcpFixtureOptions = ENROLLED) {
    const fixture = await start(options);
    const key = await adapterKey(suite);
    const { url, harness } = await enrolledLogin(fixture, key);
    return { fixture, key, url, harness };
  }

  it("P3-01 carries a client assertion on code exchange, refresh and revocation", async () => {
    const { fixture, key, harness } = await enrolledSession();
    await harness.login();
    await expireAccessToken(harness.credentialDir);
    await expect(prepare(fixture, harness.credentialDir, { key })).resolves.toMatchObject({ ok: true });
    await expect(harness.service.logout(harness.request)).resolves.toMatchObject({ remoteRevocation: "succeeded" });
    const sent = [...fixture.tokenRequests, ...fixture.revocationRequests];
    expect(fixture.tokenRequests.map((request) => request.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    expect(fixture.revocationRequests).toHaveLength(2);
    for (const request of sent) {
      expect(request.get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE);
      expect(request.get("client_assertion")).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    }
    expect(fixture.clientAssertions.map((assertion) => assertion.endpoint)).toEqual(["token", "token", "revocation", "revocation"]);
  });

  it("P3-02 signs with the key's algorithm, typ client-authentication+jwt and the required claims", async () => {
    const { fixture, url, harness } = await enrolledSession();
    await harness.login();
    const [{ header, claims }] = fixture.clientAssertions;
    expect(header).toMatchObject({ alg: algorithm, typ: "client-authentication+jwt" });
    expect(claims).toMatchObject({ iss: url, sub: url, aud: fixture.issuer });
    expect(Buffer.from(String(claims.jti), "base64url").length).toBeGreaterThanOrEqual(16);
    expect(typeof claims.iat).toBe("number");
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(60);
    expect(Number(claims.exp)).toBeGreaterThan(Number(claims.iat));
  });

  it("P3-03 never reuses a jti and never stores an assertion", async () => {
    const { fixture, key, harness } = await enrolledSession();
    await harness.login();
    for (let round = 0; round < 3; round += 1) {
      await expireAccessToken(harness.credentialDir);
      await expect(prepare(fixture, harness.credentialDir, { key })).resolves.toMatchObject({ ok: true });
    }
    const jtis = fixture.clientAssertions.map((assertion) => assertion.claims.jti);
    expect(jtis).toHaveLength(4);
    expect(new Set(jtis).size).toBe(jtis.length);
    const stored = await readFile(join(harness.credentialDir, `${credentialHandle}.json`), "utf8");
    expect(stored).not.toContain("client_assertion");
    for (const assertion of fixture.clientAssertions) expect(stored).not.toContain(assertion.raw);
  });

  it("P3-04 fails with oauth_client_registration_failed before any token request when the server lacks private_key_jwt", async () => {
    const { fixture, harness } = await enrolledSession({ ...ENROLLED, privateKeyJwt: { advertise: false } });
    await expect(harness.login()).rejects.toMatchObject({ code: "OAUTH_CLIENT_REGISTRATION_FAILED" });
    expect(fixture.tokenRequests).toHaveLength(0);
    expect(harness.authorizationUrls).toHaveLength(0);
  });

  it.each([
    { name: "none", overrides: { token_endpoint_auth_method: "none" } },
    { name: "no method", overrides: { token_endpoint_auth_method: undefined, jwks: undefined } },
  ])("P3-05 a document declaring $name sends no assertion", async ({ overrides }) => {
    const fixture = await start(ENROLLED);
    const key = await adapterKey(suite);
    const { harness } = await enrolledLogin(fixture, key, overrides);
    await expect(harness.login()).resolves.toMatchObject({ status: "authorized", clientAuthentication: "none" });
    await expireAccessToken(harness.credentialDir);
    await expect(prepare(fixture, harness.credentialDir)).resolves.toMatchObject({ ok: true });
    expect(fixture.tokenRequests).toHaveLength(2);
    for (const request of fixture.tokenRequests) expect(request.has("client_assertion")).toBe(false);
    expect((await readStored(harness.credentialDir)).binding.clientAuthentication).toBeUndefined();
  });

  it.each<{ name: string; overrides: Record<string, unknown> | "other-key" | "unreadable"; fixtureOptions: OAuthProtectedMcpFixtureOptions }>([
    { name: "an unsupported declared method", overrides: { token_endpoint_auth_method: "tls_client_auth" }, fixtureOptions: {} },
    { name: "a jwks key differing from the DID key", overrides: "other-key", fixtureOptions: {} },
    { name: "an unadvertised signing algorithm", overrides: {}, fixtureOptions: { privateKeyJwt: { signingAlgorithms: ["RS256"] } } },
    { name: "an unreadable key file", overrides: "unreadable", fixtureOptions: {} },
  ])("P3-06 $name stops the request with oauth_client_authentication_failed and sends nothing unauthenticated", async ({ overrides, fixtureOptions }) => {
    const fixture = await start({ ...ENROLLED, ...fixtureOptions });
    const key = await adapterKey(suite);
    const other = await adapterKey(suite);
    // "other-key": the published jwks holds a different key than the one the adapter signs with.
    const url = enroll(fixture, overrides === "other-key" ? other : key, typeof overrides === "object" ? overrides : {});
    const harness = await operator(fixture, {
      client: { type: "cimd", clientIdMetadataDocument: url },
      extra: overrides === "unreadable"
        ? { adapterKeyPath: join(await tempDir("missing-key"), "adapter.json") }
        : { loadSigningKey: keyLoader(key) },
    });
    await expect(harness.login()).rejects.toMatchObject({ code: "OAUTH_CLIENT_AUTHENTICATION_FAILED" });
    expect(fixture.tokenRequests).toHaveLength(0);
    expect(fixture.revocationRequests).toHaveLength(0);

    // The same holds after login: an unavailable key at refresh sends no token request.
    const fresh = await start(ENROLLED);
    const enrolled = await enrolledLogin(fresh, key);
    await enrolled.harness.login();
    await expireAccessToken(enrolled.harness.credentialDir);
    const prepared = await prepare(fresh, enrolled.harness.credentialDir, {
      expected: { signingKey: async () => { throw new Error("EACCES: permission denied"); } },
    });
    expect(prepared).toMatchObject({ ok: false, error: { code: "OAUTH_CLIENT_AUTHENTICATION_FAILED", reason: "oauth_client_authentication_failed" } });
    expect(fresh.tokenRequests).toHaveLength(1);
  });

  it("P3-07 reports token and revocation invalid_client as oauth_client_authentication_failed without starting login", async () => {
    const { fixture, key, harness } = await enrolledSession();
    await harness.login();
    fixture.failures.clientAuthentication = "token";
    await expireAccessToken(harness.credentialDir);
    const prepared = await prepare(fixture, harness.credentialDir, { key });
    expect(prepared).toMatchObject({
      ok: false,
      error: { code: "OAUTH_CLIENT_AUTHENTICATION_FAILED", reason: "oauth_client_authentication_failed" },
    });
    if (prepared.ok) return;
    expect(prepared.error.operatorCommand).toBeUndefined();
    expect(prepared.error.message).not.toContain("mpas oauth login");
    expect((await readStored(harness.credentialDir)).reauthorizationRequired).toBe(false);
    expect(fixture.tokenRequests.filter((request) => request.get("grant_type") === "refresh_token")).toHaveLength(1);

    fixture.failures.clientAuthentication = "revocation";
    await expect(harness.service.logout(harness.request)).resolves.toMatchObject({
      localCredentialsDeleted: true,
      remoteRevocation: "failed",
      revocationReason: "oauth_client_authentication_failed",
    });

    // At login, invalid_client stops the code exchange once and does not restart consent.
    fixture.failures.clientAuthentication = "token";
    const before = fixture.tokenRequests.length;
    await expect(harness.login()).rejects.toMatchObject({ code: "OAUTH_CLIENT_AUTHENTICATION_FAILED" });
    expect(fixture.tokenRequests.length - before).toBe(1);
    expect(harness.authorizationUrls).toHaveLength(2);
  });

  it("P3-08 a document method change after login makes the session unusable until the operator logs in again", async () => {
    const { fixture, key, url, harness } = await enrolledSession();
    await harness.login();
    const published = await (await fixture.fetch(url)).json() as Record<string, unknown>;
    fixture.publishClientDocument(url, { ...published, token_endpoint_auth_method: "none", jwks: undefined });
    await expireAccessToken(harness.credentialDir);
    await expect(prepare(fixture, harness.credentialDir, { key })).resolves.toMatchObject({
      ok: false,
      error: { code: "OAUTH_REAUTHORIZATION_REQUIRED", reason: "oauth_reauthorization_required" },
    });
    await expect(prepare(fixture, harness.credentialDir, { key })).resolves.toMatchObject({ ok: false });
    expect(fixture.tokenRequests).toHaveLength(1);
    expect(await readStored(harness.credentialDir)).toMatchObject({ reauthorizationRequired: true, reauthorizationReason: "binding_mismatch" });
    await expect(harness.login()).resolves.toMatchObject({ status: "authorized", clientAuthentication: "none" });
    await expect(prepare(fixture, harness.credentialDir, { key })).resolves.toMatchObject({ ok: true });
  });

  it("P3-09 an assertion is not an MPAS RFC 9421 signature, and an MPAS signature is not an assertion", async () => {
    const { fixture, key, url, harness } = await enrolledSession();
    await harness.login();
    const [{ raw }] = fixture.clientAssertions;
    const signer = KeyManager.fromJwk(key.privateJwk, { did: key.did });
    const body = new TextEncoder().encode("{}");
    const headers = await signMpasRfc9421({ method: "POST", path: "/mpas/v1/action", body, signer });
    const signatureBytes = Buffer.from(raw.split(".")[2], "base64url").toString("base64");
    const forged = { ...headers, Signature: headers.Signature.replace(/:[^:]+:/, `:${signatureBytes}:`) };
    const verified = await verifyMpasRfc9421({
      method: "POST",
      path: "/mpas/v1/action",
      headers: forged,
      body,
      audiences: ["https://adapter.example"],
    });
    expect(verified.ok).toBe(false);

    const mpasSignature = /:([^:]+):/.exec(headers.Signature)![1];
    const compactJws = await signer.signCompactJws(new TextEncoder().encode(JSON.stringify({ iss: url, sub: url, aud: fixture.issuer })));
    for (const candidate of [mpasSignature, compactJws]) {
      const response = await fetch(fixture.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "fixture-refresh-token",
          client_id: url,
          client_assertion_type: CLIENT_ASSERTION_TYPE,
          client_assertion: candidate,
        }),
      });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "invalid_client" });
    }
  });

  it("P3-10 no assertion appears in logs, status output, errors or audit records", async () => {
    const { fixture, key, harness } = await enrolledSession();
    const output: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => { output.push(args.map(String).join(" ")); });
    }
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    output.push(JSON.stringify(await harness.login()));
    await expireAccessToken(harness.credentialDir);
    output.push(JSON.stringify(await prepare(fixture, harness.credentialDir, { key })));
    fixture.failures.clientAuthentication = "token";
    await expireAccessToken(harness.credentialDir);
    output.push(JSON.stringify(await prepare(fixture, harness.credentialDir, { key })));
    output.push(JSON.stringify(await harness.service.status(harness.request)));
    const cli = { stdout: { text: "", write(chunk: string) { this.text += chunk; return true; } }, stderr: { text: "", write(chunk: string) { this.text += chunk; return true; } } };
    await runCli(["oauth", "status", "--application-did", applicationDid], cli as never, {
      oauthOperator: harness.service,
      resolveOAuthDeployment: async () => ({ ...harness.request, refreshScope: "offline_access", client: harness.request.client!, refresh: { safetyWindowMs: 0, jitterMaxMs: 0 } }),
    });
    output.push(cli.stdout.text, cli.stderr.text);
    fixture.failures.clientAuthentication = "revocation";
    output.push(JSON.stringify(await harness.service.logout(harness.request)));
    output.push(await readFile(join(harness.credentialDir, "oauth-audit.jsonl"), "utf8"));
    const everything = output.join("\n");
    expect(fixture.clientAssertions.length).toBeGreaterThanOrEqual(2);
    for (const assertion of fixture.clientAssertions) expect(everything).not.toContain(assertion.raw);
    expect(everything).not.toContain("client_assertion");
    expect(everything).not.toContain(String(key.privateJwk.d));
  });

  it("P3-11 agent-facing submissions cannot read the adapter key or cause an assertion to be signed", async () => {
    const { fixture, key, harness } = await enrolledSession();
    await harness.login();
    await expireAccessToken(harness.credentialDir);
    const signingKey = vi.fn(keyLoader(key));
    const tampered = await pipeline(fixture, harness.credentialDir, { signingKey, tamper: true });
    const rejected = await tampered.submit();
    expect(rejected.body.result).not.toBe("executed");
    expect(signingKey).not.toHaveBeenCalled();
    expect(fixture.tokenRequests).toHaveLength(1);
    const health = await tampered.app.inject({ method: "GET", url: "/mpas/v1/health" });
    expect(health.body).not.toContain(String(key.privateJwk.d));
    await tampered.app.close();

    // A verified Action is dispatched; its response carries neither key nor assertion.
    const stored = await readStored(harness.credentialDir);
    stored.tokensSavedAt = new Date().toISOString();
    await writeStored(harness.credentialDir, stored);
    const verified = await pipeline(fixture, harness.credentialDir, { signingKey });
    const executed = await verified.submit();
    expect(executed.body, JSON.stringify(executed.body)).toMatchObject({ result: "executed" });
    for (const assertion of fixture.clientAssertions) expect(JSON.stringify(executed.body)).not.toContain(assertion.raw);
    expect(JSON.stringify(executed.body)).not.toContain(String(key.privateJwk.d));
    await verified.app.close();
  });

  it("P3-12 logout with an unavailable key deletes local credentials, reports revocation failed and sends nothing unauthenticated", async () => {
    const { fixture, harness } = await enrolledSession();
    await harness.login();
    const service = fileOAuthOperatorService({
      credentialDir: harness.credentialDir,
      testOnlyAllowHttpLoopback: true,
      fetch: fixture.fetch,
      adapterKeyPath: join(await tempDir("no-key"), "adapter.json"),
    });
    await expect(service.logout(harness.request)).resolves.toEqual({
      status: "logged_out",
      applicationDid,
      localCredentialsDeleted: true,
      remoteRevocation: "failed",
      revocationReason: "oauth_client_authentication_failed",
    });
    expect(fixture.revocationRequests).toHaveLength(0);
    await expect(readFile(join(harness.credentialDir, `${credentialHandle}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    const audit = await readFile(join(harness.credentialDir, "oauth-audit.jsonl"), "utf8");
    expect(audit).toContain('"action":"revocation","outcome":"failed"');
  });

  it("P3-14 a signer that never exposes its private key signs every assertion, and a signature its key does not verify sends nothing", async () => {
    const fixture = await start(ENROLLED);
    const key = await adapterKey(suite);
    const manager = KeyManager.fromJwk(key.privateJwk, { did: key.did });
    const signBytes = vi.fn((payload: Uint8Array) => manager.signBytes(payload));
    // What an HSM or KMS provider offers: the public identity and a sign operation.
    const provider: MpasRawSigner = { did: manager.did, kid: manager.kid, algorithm: manager.algorithm, publicKey: manager.publicKey, signBytes };
    expect(JSON.stringify(provider)).not.toContain(String(key.privateJwk.d));
    const url = enroll(fixture, key);
    const harness = await operator(fixture, {
      client: { type: "cimd", clientIdMetadataDocument: url },
      extra: { loadSigningKey: async () => provider },
    });
    await expect(harness.login()).resolves.toMatchObject({ status: "authorized", clientAuthentication: "private_key_jwt" });
    await expireAccessToken(harness.credentialDir);
    await expect(prepare(fixture, harness.credentialDir, { expected: { signingKey: async () => provider } })).resolves.toMatchObject({ ok: true });
    await expect(harness.service.logout(harness.request)).resolves.toMatchObject({ remoteRevocation: "succeeded" });
    // The fixture records an assertion only after verifying it against the document's jwks.
    expect(fixture.tokenRequests.map((request) => request.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    expect(fixture.clientAssertions.map((assertion) => assertion.endpoint)).toEqual(["token", "token", "revocation", "revocation"]);
    expect(fixture.clientAssertions.every((assertion) => assertion.header.alg === algorithm)).toBe(true);
    expect(signBytes).toHaveBeenCalledTimes(fixture.clientAssertions.length);

    const refusing = await start(ENROLLED);
    const refused = await operator(refusing, {
      client: { type: "cimd", clientIdMetadataDocument: enroll(refusing, key) },
      extra: { loadSigningKey: async () => ({ ...provider, signBytes: async () => new Uint8Array(64) }) },
    });
    await expect(refused.login()).rejects.toMatchObject({ code: "OAUTH_CLIENT_AUTHENTICATION_FAILED" });
    expect(refusing.tokenRequests).toHaveLength(0);
  });
});

describe("Phase 3: the adapter key file", () => {
  /** A home directory whose `~/.mpas/keys/` holds the named key files. */
  async function homeWith(...names: string[]) {
    const home = await tempDir("home");
    const keys = join(home, ".mpas", "keys");
    const dids = new Map<string, string>();
    for (const name of names) dids.set(name, (await generateKeyFile(name, keys)).did);
    return { home, keys, dids };
  }

  it("P3-13 without --adapter-key or MPAS_ADAPTER_KEY, uses the account key signing-key.json, never the old adapter.json", async () => {
    const account = await homeWith("signing-key");
    const accountKey = join(account.keys, "signing-key.json");
    expect(defaultAdapterKeyPath({}, account.home)).toBe(accountKey);
    expect((await loadAdapterKey(defaultAdapterKeyPath({}, account.home))).did).toBe(account.dids.get("signing-key"));

    // The default up to 0.1.0-alpha.4 is not consulted, even when it is the only key.
    const old = await homeWith("adapter");
    expect(defaultAdapterKeyPath({}, old.home)).toBe(join(old.keys, "signing-key.json"));
    await expect(loadAdapterKey(defaultAdapterKeyPath({}, old.home))).rejects.toBeInstanceOf(AdapterKeyNotFoundError);

    expect(defaultAdapterKeyPath({ MPAS_ADAPTER_KEY: "/elsewhere/key.json" }, account.home)).toBe("/elsewhere/key.json");
  });

  it("P3-13 a missing key file stops login with its path and the flag, and sends no token request", async () => {
    const fixture = await start(ENROLLED);
    const key = await adapterKey();
    const url = enroll(fixture, key);
    const missing = join(await tempDir("missing-key"), "adapter.json");
    const harness = await operator(fixture, {
      client: { type: "cimd", clientIdMetadataDocument: url },
      extra: { adapterKeyPath: missing },
    });
    await expect(harness.login()).rejects.toMatchObject({
      code: "OAUTH_CLIENT_AUTHENTICATION_FAILED",
      message: `No adapter key file at ${missing}. Pass --adapter-key <file> or set MPAS_ADAPTER_KEY.`,
    });
    expect(fixture.tokenRequests).toHaveLength(0);
    await expect(loadAdapterKey(missing)).rejects.toBeInstanceOf(AdapterKeyNotFoundError);
  });
});
