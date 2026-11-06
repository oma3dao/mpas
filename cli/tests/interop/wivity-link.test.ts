/**
 * Credential Adapter OAuth plan, Phase 7: interoperability with a local Wivity Link.
 *
 * Gated: runs only through `npm run test:interop:wivity-link` with WIVITY_LINK_DIR
 * set (see vitest.wivity-link.config.ts). It drives Wivity Link's own test harness
 * and changes nothing in that repository. The adapter code under test is this
 * checkout's, used exactly as `mpas oauth login|logout` and the daemon use it.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateMpasKey } from "@oma3/mpas";
import { prepareMcpHttp } from "../../src/adapter/dispatch/mcp-http.js";
import { fileOAuthOperatorService, prepareOAuthForDispatch, type OAuthLoginRequest } from "../../src/adapter/oauth-operator.js";
import { loadAdapterKey } from "../../src/adapter/adapter-key.js";

const wivityLinkDir = process.env.WIVITY_LINK_DIR;
const enabled = Boolean(wivityLinkDir) && process.env.WIVITY_LINK_INTEROP === "1";
const applicationDid = "did:web:agent.example";
const OPEN_CLIENT_DOCUMENT = "https://adapter.example/mpas/client-metadata.json";

/* eslint-disable @typescript-eslint/no-explicit-any -- the harness is another repository's untyped test support */
let support: { harness: any; browser: any; oauthClient: any };
let h: any;
let workDir: string;

async function importSupport(name: string): Promise<any> {
  return import(pathToFileURL(join(wivityLinkDir!, "tests", "support", name)).href);
}

/** The operator's browser: Wivity Link sign-in through the stub account service, then consent. */
function operatorBrowser(expectedClientText?: string) {
  return async (url: URL) => {
    const browser = new support.browser.TestBrowser();
    const stop = support.oauthClient.atRedirect(url.searchParams.get("redirect_uri")!);
    let result = await browser.follow(url.toString(), stop);
    if (result.page?.html.includes('name="csrf"')) {
      if (expectedClientText) expect(result.page.html).toContain(expectedClientText);
      result = await browser.submitConsent(result.page, "allow", stop);
    }
    expect(stop(result.url), `login stopped at ${result.url}: ${result.page?.html?.slice(0, 400) ?? ""}`).toBe(true);
    await fetch(result.url);
  };
}

/** The adapter reads client documents through this; Wivity Link reads them through its own fake SignerSet. */
function adapterFetch(documents: () => Map<string, unknown>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const document = documents().get(url);
    return document ? Response.json(document) : fetch(input, init);
  };
}

async function expire(credentialDir: string, handle: string) {
  const path = join(credentialDir, `${handle}.json`);
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.tokensSavedAt = "2020-01-01T00:00:00.000Z";
  stored.refreshJitterMs = 0;
  await writeFile(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
}

async function callTool(
  request: OAuthLoginRequest,
  credentialDir: string,
  documents: Map<string, unknown>,
  signingKey?: () => Promise<any>,
) {
  const prepared = await prepareOAuthForDispatch(request.session, request.credentialHandle, applicationDid, request.resourceUrl, credentialDir, {
    refresh: { safetyWindowMs: 0, jitterMaxMs: 0 },
    ...(signingKey ? { signingKey } : {}),
    fetch: adapterFetch(() => documents),
  });
  expect(prepared.ok, prepared.ok ? "" : JSON.stringify(prepared.error)).toBe(true);
  if (!prepared.ok) throw new Error("preparation failed");
  const dispatch = await prepareMcpHttp(
    { type: "mcp.http", url: request.resourceUrl, auth: { type: "oauth2", session: request.session } },
    undefined, "2025-11-25", prepared.provider,
  );
  expect(dispatch.ok, dispatch.ok ? "" : JSON.stringify(dispatch.error)).toBe(true);
  if (!dispatch.ok) throw new Error("connection failed");
  try {
    return await dispatch.session.transmit("synthetic_create_item", {
      text: `from the credential adapter at ${request.resourceUrl}`,
      expectedAccountId: `${new URL(request.resourceUrl).pathname.split("/").at(-1)}:wl-synthetic:member-0001`,
    });
  } finally {
    await dispatch.session.close();
  }
}

describe.skipIf(!enabled)("Phase 7: local Wivity Link", () => {
  beforeAll(async () => {
    support = {
      harness: await importSupport("harness.ts"),
      browser: await importSupport("browser.ts"),
      oauthClient: await importSupport("oauth-client.ts"),
    };
    h = await support.harness.createHarness();
    workDir = await mkdtemp(join(tmpdir(), "mpas-wivity-link-"));
  });
  afterAll(async () => {
    await h?.close();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("P7-01 enrolled_adapter: login with private_key_jwt, tool call, refresh, and logout with revocation", async () => {
    // The adapter's DID key in the daemon's key-file format; login and logout load this file.
    const key = await generateMpasKey("Ed25519");
    const keyPath = join(workDir, "adapter.json");
    await writeFile(keyPath, `${JSON.stringify({ did: key.did, privateJwk: key.privateJwk, publicJwk: key.publicJwk })}\n`, { mode: 0o600 });
    const clientId = `${support.harness.SIGNERSET_PREFIX}/${key.did}`;
    const document = {
      client_id: clientId,
      client_name: "Enrolled MPAS Credential Adapter",
      redirect_uris: ["http://127.0.0.1/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "private_key_jwt",
      jwks: { keys: [key.publicJwk] },
    };
    h.enrolled.set(key.did, document);
    const credentialDir = join(workDir, "enrolled");
    const request: OAuthLoginRequest = {
      applicationDid,
      resourceUrl: h.resource("synthetic-enrolled"),
      session: "wivity-link-enrolled",
      credentialHandle: "wivity-link-enrolled-oauth",
      openBrowser: false,
      client: { type: "cimd", clientIdMetadataDocument: clientId },
    };
    const documents = new Map<string, unknown>([[clientId, document]]);
    const service = fileOAuthOperatorService({
      credentialDir,
      testOnlyAllowHttpLoopback: true,
      adapterKeyPath: keyPath,
      fetch: adapterFetch(() => documents),
      onAuthorizationUrl: operatorBrowser(),
    });

    const login = await service.login(request);
    expect(login).toMatchObject({
      status: "authorized",
      issuer: h.issuer,
      clientMode: "cimd",
      clientAuthentication: "private_key_jwt",
      refreshable: true,
    });
    const signingKey = () => loadAdapterKey(keyPath);
    const created = await callTool(request, credentialDir, documents, signingKey);
    expect(JSON.stringify(created)).toContain("item-");
    expect(h.upstream.items.at(-1)?.text).toBe(`from the credential adapter at ${request.resourceUrl}`);

    const before = JSON.parse(await readFile(join(credentialDir, `${request.credentialHandle}.json`), "utf8")).tokens;
    await expire(credentialDir, request.credentialHandle);
    await callTool(request, credentialDir, documents, signingKey);
    const after = JSON.parse(await readFile(join(credentialDir, `${request.credentialHandle}.json`), "utf8")).tokens;
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.refresh_token).not.toBe(before.refresh_token);

    await expect(service.logout(request)).resolves.toMatchObject({
      status: "logged_out",
      localCredentialsDeleted: true,
      remoteRevocation: "succeeded",
    });
    const logs = h.logs.join("\n");
    expect(logs).not.toContain(after.refresh_token);
    expect(logs).not.toContain("client_assertion=");
  });

  it("P7-02 open endpoint: the same as a public client, unchanged from the shipped behavior", async () => {
    const document = {
      client_id: OPEN_CLIENT_DOCUMENT,
      client_name: "MPAS Credential Adapter",
      redirect_uris: ["http://127.0.0.1/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    h.serveDocument(OPEN_CLIENT_DOCUMENT, document);
    const credentialDir = join(workDir, "open");
    const request: OAuthLoginRequest = {
      applicationDid,
      resourceUrl: h.resource("synthetic"),
      session: "wivity-link-synthetic",
      credentialHandle: "wivity-link-synthetic-oauth",
      openBrowser: false,
      client: { type: "cimd", clientIdMetadataDocument: OPEN_CLIENT_DOCUMENT },
    };
    const documents = new Map<string, unknown>([[OPEN_CLIENT_DOCUMENT, document]]);
    const service = fileOAuthOperatorService({
      credentialDir,
      testOnlyAllowHttpLoopback: true,
      fetch: adapterFetch(() => documents),
      onAuthorizationUrl: operatorBrowser("MPAS Credential Adapter, from <strong>adapter.example</strong>"),
    });
    await expect(service.login(request)).resolves.toMatchObject({
      status: "authorized",
      clientMode: "cimd",
      clientAuthentication: "none",
      refreshable: true,
    });
    expect(JSON.stringify(await callTool(request, credentialDir, documents))).toContain("item-");
    await expire(credentialDir, request.credentialHandle);
    expect(JSON.stringify(await callTool(request, credentialDir, documents))).toContain("item-");
    await expect(service.logout(request)).resolves.toMatchObject({
      status: "logged_out",
      localCredentialsDeleted: true,
      remoteRevocation: "succeeded",
    });
  });
});
