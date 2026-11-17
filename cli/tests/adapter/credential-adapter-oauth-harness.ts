import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { JWK } from "jose";
import { generateMpasKey, KeyManager } from "@oma3/mpas";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import { FileCredentialProvider } from "../../src/adapter/credential-provider.js";
import { createAdapterApiServer } from "../../src/adapter/adapter-api-server.js";
import { DispatchLedger, MemoryDispatchJournal } from "../../src/adapter/dispatch-ledger.js";
import type { LoadClientSigningKey } from "../../src/adapter/oauth-client-auth.js";
import {
  fileOAuthOperatorService,
  prepareOAuthForDispatch,
  type FileOAuthOperatorServiceOptions,
  type OAuthClientConfiguration,
  type OAuthLoginRequest,
  type OAuthPrepareOptions,
} from "../../src/adapter/oauth-operator.js";
import type { Did } from "../../src/core/types.js";
import {
  authorizeFixture,
  enrolledAdapterClientDocument,
  type OAuthProtectedMcpFixture,
} from "../fixtures/oauth-protected-mcp.js";

/** The fixture Action Packages target this Application DID. */
export const applicationDid = "did:web:github-mirror.example";
export const session = "fixture-session";
export const credentialHandle = "fixture-oauth";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
/** Pinned inside the fixture Action Packages' validity window. */
const FIXTURE_NOW = Date.parse("2026-06-05T19:00:00.000Z");

export interface TestKey {
  did: Did;
  privateJwk: JWK;
  publicJwk: JWK;
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `mpas-ca-oauth-${prefix}-`));
}

export async function adapterKey(suite: "Ed25519" | "P-256" = "Ed25519"): Promise<TestKey> {
  const key = await generateMpasKey(suite);
  return { did: key.did, privateJwk: key.privateJwk, publicJwk: key.publicJwk };
}

export function keyLoader(key: TestKey): LoadClientSigningKey {
  return async () => KeyManager.fromJwk(key.privateJwk, { did: key.did });
}

/** Publishes the adapter's SignerSet-style client document and returns its URL. */
export function enroll(
  fixture: OAuthProtectedMcpFixture,
  key: TestKey,
  overrides: Record<string, unknown> = {},
): string {
  const url = fixture.clientDocumentUrlForDid(key.did);
  fixture.publishClientDocument(url, enrolledAdapterClientDocument(url, key.publicJwk, overrides));
  return url;
}

export interface OperatorHarness {
  credentialDir: string;
  authorizationUrls: URL[];
  service: ReturnType<typeof fileOAuthOperatorService>;
  request: OAuthLoginRequest;
  login(overrides?: Partial<OAuthLoginRequest>): ReturnType<ReturnType<typeof fileOAuthOperatorService>["login"]>;
}

export async function operator(
  fixture: OAuthProtectedMcpFixture,
  options: {
    credentialDir?: string;
    key?: TestKey;
    client?: OAuthClientConfiguration;
    scopes?: string[];
    resourceUrl?: string;
    handle?: string;
    authorize?: (url: URL) => Promise<void>;
    extra?: Partial<FileOAuthOperatorServiceOptions>;
  } = {},
): Promise<OperatorHarness> {
  const credentialDir = options.credentialDir ?? await tempDir("login");
  const authorizationUrls: URL[] = [];
  const service = fileOAuthOperatorService({
    credentialDir,
    testOnlyAllowHttpLoopback: true,
    fetch: fixture.fetch,
    callbackTimeoutMs: 5_000,
    ...(options.key ? { loadSigningKey: keyLoader(options.key) } : {}),
    onAuthorizationUrl: async (url) => {
      authorizationUrls.push(url);
      await (options.authorize ?? authorizeFixture)(url);
    },
    ...options.extra,
  });
  const request: OAuthLoginRequest = {
    applicationDid,
    resourceUrl: options.resourceUrl ?? fixture.resourceUrl,
    session,
    credentialHandle: options.handle ?? credentialHandle,
    openBrowser: false,
    ...(options.scopes ? { scopes: options.scopes } : {}),
    ...(options.client ? { client: options.client } : {}),
  };
  return {
    credentialDir,
    authorizationUrls,
    service,
    request,
    login: (overrides = {}) => service.login({ ...request, ...overrides }),
  };
}

export async function readStored(credentialDir: string, handle = credentialHandle): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(credentialDir, `${handle}.json`), "utf8"));
}

export async function writeStored(credentialDir: string, value: unknown, handle = credentialHandle): Promise<void> {
  await writeFile(join(credentialDir, `${handle}.json`), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** Makes the stored access token expired so the next preparation refreshes. */
export async function expireAccessToken(credentialDir: string, handle = credentialHandle): Promise<void> {
  const stored = await readStored(credentialDir, handle);
  stored.tokensSavedAt = "2020-01-01T00:00:00.000Z";
  stored.refreshJitterMs = 0;
  await writeStored(credentialDir, stored, handle);
}

export function prepare(
  fixture: OAuthProtectedMcpFixture,
  credentialDir: string,
  options: { key?: TestKey; resourceUrl?: string; handle?: string; expected?: OAuthPrepareOptions } = {},
) {
  return prepareOAuthForDispatch(
    session,
    options.handle ?? credentialHandle,
    applicationDid,
    options.resourceUrl ?? fixture.resourceUrl,
    credentialDir,
    {
      refresh: { safetyWindowMs: 0, jitterMaxMs: 0 },
      fetch: fixture.fetch,
      ...(options.key ? { signingKey: keyLoader(options.key) } : {}),
      ...options.expected,
    },
  );
}

export interface PipelineHarness {
  app: FastifyInstance;
  journal: MemoryDispatchJournal;
  submit(): Promise<{ statusCode: number; body: Record<string, any> }>;
  executingCount(): number;
}

/**
 * The full Verifier path: the fixture Action Package is verified, OAuth preparation
 * runs before the ledger's executing write, and the MCP call goes to the fixture.
 */
export async function pipeline(
  fixture: OAuthProtectedMcpFixture,
  credentialDir: string,
  options: { signingKey?: LoadClientSigningKey; tamper?: boolean } = {},
): Promise<PipelineHarness> {
  const configDir = await tempDir("configs");
  const config = JSON.parse(await readFile(
    join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"),
    "utf8",
  )) as Record<string, any>;
  config.plugin = { ...config.plugin, path: join(fixturesDir, "plugins", "github-mirror-plugin.json") };
  await writeFile(join(configDir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);
  const loaded = await loadDeploymentConfigs(configDir, { confirmPluginUse: async () => true });
  if (!loaded.ok) throw new Error(loaded.error.message);
  for (const entry of loaded.configsByApplicationDid.values()) {
    (entry.config as any).executionTarget = {
      type: "mcp.http",
      url: fixture.resourceUrl,
      auth: { type: "oauth2", session },
    };
    (entry.config as any).credentialBindings = [{ credentialHandle, provider: "file" }];
  }
  const adapter = JSON.parse(await readFile(join(fixturesDir, "test-keys", "adapter.json"), "utf8")) as TestKey;
  const journal = new MemoryDispatchJournal();
  const app = createAdapterApiServer({
    configsByApplicationDid: loaded.configsByApplicationDid,
    credentialProvider: new FileCredentialProvider(credentialDir),
    adapterDid: adapter.did,
    adapterSigningKey: adapter.privateJwk,
    now: FIXTURE_NOW,
    ledger: new DispatchLedger(journal),
    ...(options.signingKey ? { oauthClientSigningKey: options.signingKey } : {}),
  });
  const actionPackage = JSON.parse(await readFile(join(fixturesDir, "core", "valid-no-approval-required.json"), "utf8"));
  if (options.tamper) actionPackage.executionPayload.arguments.title = "Tampered after approval";
  return {
    app,
    journal,
    async submit() {
      const response = await app.inject({
        method: "POST",
        url: "/mpas/v1/action",
        headers: { "content-type": "application/mpas+json" },
        payload: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
      });
      return { statusCode: response.statusCode, body: response.json() };
    },
    executingCount: () => journal.readAll().filter((event) => event.event === "executing").length,
  };
}
