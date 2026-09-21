import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { compactVerify, importJWK, type JWK } from "jose";
import { ActionPackageBuilder, ApprovalBuilder, KeyManager, buildDeliveryEnvelope, parseDispatchRecord, serializeDispatchRecord, signMpasRfc9421, type ActionPackage, type ActionRequest, type DeliveryEnvelope } from "@oma3/mpas";
import "../fixtures/action-fixture-clock.js";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import { FileCredentialProvider } from "../../src/adapter/credential-provider.js";
import {
  buildIndeterminateRecoveryResponse,
  createAdapterApiServer,
} from "../../src/adapter/adapter-api-server.js";
import { DispatchLedger, FileDispatchJournal } from "../../src/adapter/dispatch-ledger.js";
import type { Did, ExecutionReceipt, ReceiptPayload } from "../../src/core/types.js";
import { computeJsonHash } from "../../src/core/verification.js";
import { TraceLogger } from "../../src/core/trace.js";
import { createCoordinationApiServer } from "../../src/coordination/coordination-api-server.js";
import { startOAuthProtectedMcpFixture, type OAuthProtectedMcpFixture } from "../fixtures/oauth-protected-mcp.js";

/** Deterministic clock pinned inside the fixture validity window. */
const FIXTURE_NOW = Date.parse("2026-06-05T19:00:00.000Z");

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const slowFixtureServer = fileURLToPath(new URL("../fixtures/adapter/slow-mcp-server.mjs", import.meta.url));
const errorFixtureServer = fileURLToPath(new URL("../fixtures/adapter/error-mcp-server.mjs", import.meta.url));
const protocolVersionFixtureServer = fileURLToPath(
  new URL("../fixtures/adapter/protocol-version-mcp-server.mjs", import.meta.url),
);
const missingFixtureServer = join(fixturesDir, "adapter", "missing-mcp-server.mjs");
const apps: FastifyInstance[] = [];
const stores: FileDispatchJournal[] = [];
const httpTargets: OAuthProtectedMcpFixture[] = [];

interface KeyFixture {
  did: Did;
  privateJwk: JWK;
  publicJwk: JWK;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function credentialDir() {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "mpas-http-credentials-"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "github-mirror-token.json");
  await writeFile(path, `${JSON.stringify({ value: "ghp_test" })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return dir;
}

async function makeApp(configDir?: string, ledger?: DispatchLedger) {
  // The shared configs dir holds the mirror and live-demo applications. They
  // have distinct applicationDids, so both route cleanly — no shadowing.
  const effectiveConfigDir = configDir ?? join(fixturesDir, "configs");
  const configs = await loadDeploymentConfigs(effectiveConfigDir, {
    confirmPluginUse: async () => true,
  });
  if (!configs.ok) {
    throw new Error(configs.error.message);
  }
  const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
  const app = createAdapterApiServer({
    configsByApplicationDid: configs.configsByApplicationDid,
    credentialProvider: new FileCredentialProvider(await credentialDir()),
    adapterDid: adapter.did,
    adapterSigningKey: adapter.privateJwk,
    // Pin the clock inside the fixture validity window so the
    // max-envelope-validity guard and approval-time checks are deterministic.
    now: FIXTURE_NOW,
    ledger,
  });
  apps.push(app);
  return app;
}

/** Create a config dir with only the auto-approve config (for basic execution tests). */
async function makeAutoApproveConfigDir() {
  const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-auto-"));
  const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"));
  config.plugin = {
    ...(config.plugin as Record<string, unknown>),
    path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
  };
  await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

/** POST a fixture Action Package wrapped in an ActionRequest to /mpas/v1/action. */
async function submitFixture(app: FastifyInstance, fixtureFile: string) {
  const actionPackage = JSON.parse(await readFile(join(fixturesDir, "core", fixtureFile), "utf8")) as unknown;
  return app.inject({
    method: "POST",
    url: "/mpas/v1/action",
    headers: { "content-type": "application/mpas+json" },
    payload: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
  });
}

async function makeTargetConfigDir(server: string, timeoutMs: number, command = "node") {
  const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-"));
  const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"));
  config.plugin = {
    ...(config.plugin as Record<string, unknown>),
    path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
  };
  config.executionTarget = {
    type: "mcp.stdio",
    command,
    args: [server],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "{{credential:github-mirror-token}}",
    },
    timeoutMs,
  };
  await writeFile(join(dir, "github-target.json"), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

async function verifyReceiptPayload(receipt: ExecutionReceipt): Promise<ReceiptPayload> {
  const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
  const publicKey = await importJWK(adapter.publicJwk, "EdDSA");
  const { payload } = await compactVerify(receipt.signature, publicKey);
  return JSON.parse(Buffer.from(payload).toString("utf8")) as ReceiptPayload;
}

/** A real task-owned MCP process records initialization and tools/call separately. */
async function countingTarget() {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "mpas-ledger-target-"));
  const eventsPath = join(dir, "events.jsonl"), server = join(dir, "server.mjs");
  await writeFile(server, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({input: process.stdin});
lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.method !== "initialize" && request.method !== "tools/call") return;
  appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({event:request.method,pid:process.pid})+"\\n");
  const result = request.method === "initialize"
    ? {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"counted-target",version:"1"}}
    : {content:[{type:"text",text:"counted durable target result"}]};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
});
`);
  const configDir = await makeTargetConfigDir(server, 1000);
  const journalPath = join(dir, "dispatch-ledger.jsonl");
  const store = new FileDispatchJournal(journalPath); stores.push(store);
  const ledger = new DispatchLedger(store);
  const app = await makeApp(configDir, ledger);
  const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "valid-no-approval-required.json"));
  const actionId = actionPackage.actionEnvelope.actionId, hash = computeJsonHash(actionPackage.actionEnvelope);
  return {
    app, ledger, store, journalPath, actionPackage, actionId, hash,
    async countAndCheckClosed() {
      const events = (await readFile(eventsPath, "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as { event: string; pid: number });
      for (const pid of new Set(events.map(event => event.pid))) {
        expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      }
      return { calls: events.filter(event => event.event === "tools/call").length,
        initialized: events.filter(event => event.event === "initialize").length, events };
    },
  };
}

/** Real HTTP target and accepted durable store, with only synthetic credentials. */
async function httpBoundaryTarget(status: 200 | 401 | 403 | 307 | 308 = 200, managed = false) {
  const fixture = await startOAuthProtectedMcpFixture({ toolStatus: status, toolDelayMs: 10,
    toolErrorBody: "SECRET_BODY fixture-access-token fixture-refresh-token",
    toolChallenge: 'Bearer error="insufficient_scope", scope="SECRET_SCOPE admin"' });
  httpTargets.push(fixture);
  const configs = await loadDeploymentConfigs(await makeAutoApproveConfigDir(), { confirmPluginUse: async () => true });
  if (!configs.ok) throw new Error(configs.error.message);
  const loaded = configs.configs[0];
  loaded.config.executionTarget = { type: "mcp.http", url: fixture.resourceUrl, timeoutMs: 1000,
    ...(managed ? { auth: { type: "oauth2" as const, session: "fixture-session", scopes: ["mcp:tools"] } }
      : { headers: { authorization: "Bearer {{credential:github-mirror-token}}" } }) };
  const dir = await credentialDir();
  const credentialPath = join(dir, "github-mirror-token.json");
  const applicationDid = loaded.config.target.applicationDid;
  const owner = `local-os-user:${process.getuid!()}`;
  const session = { version: 2, session: "fixture-session", credentialHandle: "github-mirror-token", applicationDid,
    resourceUrl: fixture.resourceUrl, owner, sharing: { applicationDids: [applicationDid], operatorPrincipals: [owner] },
    binding: { applicationDid, resourceUrl: fixture.resourceUrl, issuer: fixture.issuer,
      clientMode: "dynamic", clientId: "fixture-public-client", clientConfiguration: JSON.stringify({ type: "dynamic" }),
      scopeConfiguration: JSON.stringify({ scopes: ["mcp:tools"], refreshScope: "offline_access" }),
      requestedScopes: ["mcp:tools", "offline_access"], redirectUrl: "http://127.0.0.1:49152/oauth/callback" },
    clientInformation: { client_id: "fixture-public-client" },
    tokens: { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" },
    tokensSavedAt: new Date().toISOString(), refreshJitterMs: 0 };
  await writeFile(credentialPath, JSON.stringify(managed ? session : { value: "fixture-access-token" }), { mode: 0o600 });
  const provider = new FileCredentialProvider(dir);
  const credentials = vi.spyOn(provider, "getCredential");
  const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
  const proposer = KeyManager.fromJwk((await readJson<KeyFixture>(join(fixturesDir, "test-keys", "proposer.json"))).privateJwk);
  const builder = new ActionPackageBuilder({ applicationDid, executionProfile: { id: loaded.plugin.executionProfile.id as Did, format: "mcp.toolsCall" }, keyManager: proposer });
  const journalPath = join(dir, "dispatch.sqlite");
  const store = new FileDispatchJournal(journalPath); stores.push(store);
  const ledger = new DispatchLedger(store);
  const options = { configsByApplicationDid: configs.configsByApplicationDid, credentialProvider: provider,
    adapterDid: adapter.did, adapterSigningKey: adapter.privateJwk, ledger };
  const app = createAdapterApiServer(options); apps.push(app);
  return { app, fixture, loaded, credentials, credentialPath, adapter, proposer, builder, ledger, store, journalPath, options };
}

/** Exercise the existing enforcing Action Relay with genuine public-SDK signatures. */
async function signedRelayRequest(app: FastifyInstance, path: string, payload: object, signer: KeyManager,
  audience = "https://relay.example.test", nonce?: string) {
  const body = JSON.stringify({ ...payload, audience });
  const headers = await signMpasRfc9421({ method: "POST", path, body: Buffer.from(body), signer, nonce });
  return app.inject({ method: "POST", url: path,
    headers: { ...headers, "content-type": "application/mpas+json" }, payload: body });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(httpTargets.splice(0).map(target => target.close()));
  vi.restoreAllMocks();
});

describe("HTTP endpoint", () => {
  it.each([200, 401, 403, 307, 308] as const)("stores the signed HTTP %s outcome and forbids concurrent, identical and restarted retransmission", async status => {
    const target = await httpBoundaryTarget(status, true);
    const pkg = await target.builder.buildFromToolCall("create_issue_mirror", { title: "transport receipt proof" });
    const hash = computeJsonHash(pkg.actionEnvelope);
    const request = { method: "POST" as const, url: "/mpas/v1/action", payload: { version: "1", type: "ActionRequest", actionPackage: pkg } };
    const tokenBefore = await readFile(target.credentialPath, "utf8");
    const trace = vi.spyOn(TraceLogger.prototype, "emit");
    const pair = await Promise.all([target.app.inject(request), target.app.inject(request)]);
    const outcome = status === 200 ? "executed" : "indeterminate";
    const winners = pair.filter(response => response.json().result === outcome);
    expect(winners).toHaveLength(1);
    const winner = winners[0].json();
    expect(pair.filter(response => ["pending", "rejected"].includes(response.json().result))).toHaveLength(1);
    expect((await verifyReceiptPayload(winner.executionReceipt)).result).toBe(outcome);
    expect(target.ledger.recoveryFor(pkg.actionEnvelope.actionId, hash)?.response).toEqual(winner);
    if (status !== 200) {
      const code = status === 401 ? "OAUTH_AUTHENTICATION_FAILED" : status === 403 ? "OAUTH_SCOPE_DEMAND" : "TRANSPORT_ERROR";
      expect(winner).toMatchObject({ error: { code }, context: { diagnostic: { code, phase: "tools/call", transport: "streamable-http" } } });
      expect(winner).not.toHaveProperty("executionResult");
    } else expect(winner.executionResult).toEqual({ content: [{ type: "text", text: "authorized" }] });
    expect(JSON.stringify([winner, trace.mock.calls])).not.toMatch(/SECRET_|fixture-access-token|fixture-refresh-token/);
    expect((await target.app.inject(request)).json()).toMatchObject({ result: "rejected", error: { code: "REPLAY_DETECTED" } });
    await target.app.close(); target.ledger.close();
    const reopened = new FileDispatchJournal(target.journalPath); stores.push(reopened);
    const ledger = new DispatchLedger(reopened);
    expect(ledger.recoverExecuting()).toBe(0);
    expect(ledger.recoveryFor(pkg.actionEnvelope.actionId, hash)?.response).toEqual(winner);
    const restarted = createAdapterApiServer({ ...target.options, ledger }); apps.push(restarted);
    expect((await restarted.inject(request)).json()).toMatchObject({ result: "rejected", error: { code: "REPLAY_DETECTED" } });
    expect(target.fixture.requests.filter(r => r.rpcMethod === "tools/call")).toHaveLength(1);
    expect(target.fixture.toolEffects).toEqual([{ name: "create_issue_mirror", arguments: { title: "transport receipt proof" } }]);
    expect(target.fixture.tokenRequests).toEqual([]);
    expect(target.fixture.registrationRequests).toEqual([]);
    expect(await readFile(target.credentialPath, "utf8")).toBe(tokenBefore);
    console.log(JSON.stringify({ case: "durable transport", status, targetEffects: 1, realToolRequests: 1,
      initialized: target.fixture.requests.filter(r => r.rpcMethod === "initialize").length,
      authFollowups: 0, tokenBytesUnchanged: true, exactRecoveredResponse: winner }));
  });

  it.each([undefined, "deny", "allow"] as const)("applies trusted pass-through %s before credential or target access", async passThrough => {
    const target = await httpBoundaryTarget();
    target.loaded.config.passThrough = passThrough;
    target.loaded.config.policy.defaultRequirement = { type: "threshold", threshold: 2, eligibleSignerGroup: "maintainers" };
    const pkg = await target.builder.buildFromToolCall("create_issue_mirror", { title: "unknown operation" });
    const response = await target.app.inject({ method: "POST", url: "/mpas/v1/action",
      payload: { version: "1", type: "ActionRequest", actionPackage: pkg, passThrough: "allow" } });
    // The routing parser permits extension fields. This untrusted field is
    // ignored: only the loaded deployment configuration can grant pass-through.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(passThrough === "allow" ? { result: "executed" }
      : { result: "rejected", error: { code: "OPERATION_NOT_GOVERNED" } });
    expect(target.credentials).toHaveBeenCalledTimes(passThrough === "allow" ? 1 : 0);
    expect(target.fixture.toolEffects).toHaveLength(passThrough === "allow" ? 1 : 0);
    expect(target.fixture.requests.filter(r => r.rpcMethod === "initialize")).toHaveLength(passThrough === "allow" ? 1 : 0);
    console.log(JSON.stringify({ case: "trusted pass through", setting: passThrough ?? "omitted", credentialReads: target.credentials.mock.calls.length,
      initialized: target.fixture.requests.filter(r => r.rpcMethod === "initialize").length, targetCalls: target.fixture.toolEffects.length }));
  });

  it.each(["private direct", "authenticated relay"] as const)("preserves Application, profile, payload, Approval and proposer binding over %s", async route => {
    const target = await httpBoundaryTarget();
    const adapterSigner = KeyManager.fromJwk(target.adapter.privateJwk);
    const otherSigner = KeyManager.fromJwk((await readJson<KeyFixture>(join(fixturesDir, "test-keys", "maintainer-a.json"))).privateJwk);
    const cases = ["application", "profile", "format", "payload hash", "payload shape", "Approval signature", "Approval binding", "proposer", "positive"] as const;
    const trace = vi.spyOn(TraceLogger.prototype, "emit");
    for (const scenario of cases) {
      const signer = scenario === "proposer" ? otherSigner : target.proposer;
      const builder = new ActionPackageBuilder({ keyManager: signer,
        applicationDid: scenario === "application" ? "did:web:other.example" : target.loaded.config.target.applicationDid,
        executionProfile: { id: scenario === "profile" ? "did:web:profiles.example:unsupported" : target.loaded.plugin.executionProfile.id as Did,
          format: scenario === "format" ? "unsupported.format" : "mcp.toolsCall" } });
      const pkg = await builder.buildFromPayload(scenario === "payload shape" || scenario === "profile"
        ? { name: "create_issue_mirror", arguments: [], extra: true }
        : { name: "create_issue_mirror", arguments: { title: scenario } });
      if (scenario === "payload hash") pkg.executionPayload = { name: "create_issue_mirror", arguments: { changed: true } };
      if (scenario === "Approval signature") {
        const parts = pkg.approvalBundle.approvals[0].signature.value.split(".");
        parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
        pkg.approvalBundle.approvals[0].signature.value = parts.join(".");
      }
      if (scenario === "Approval binding") {
        const different = await builder.buildFromToolCall("create_issue_mirror", { title: "different envelope" });
        pkg.approvalBundle.approvals = different.approvalBundle.approvals;
      }
      const request: ActionRequest = { version: "1", type: "ActionRequest", actionPackage: pkg };
      trace.mockClear();
      let response;
      if (route === "private direct") {
        // This supported private, unenforcing surface deliberately has no HTTP signature.
        response = await target.app.inject({ method: "POST", url: "/mpas/v1/action", payload: request });
      } else {
        const relay = createCoordinationApiServer({ designatedVerifierDid: target.adapter.did,
          authorizedRecipientDids: [target.proposer.did, otherSigner.did], relayResponseWaitMs: 5,
          auth: { enforcement: true, audiences: ["https://relay.example.test"] } });
        apps.push(relay);
        const envelope = buildDeliveryEnvelope({ sender: signer.did, recipients: [target.adapter.did], payload: request });
        const submitted = await signedRelayRequest(relay, "/mpas/v1/verifier/action", envelope, signer);
        const polled = await signedRelayRequest(relay, "/mpas/v1/relay/poll",
          { version: "1", type: "RelayPollRequest", did: target.adapter.did }, adapterSigner);
        expect(polled.statusCode).toBe(200);
        const deliveries = polled.json().deliveries as DeliveryEnvelope<ActionRequest>[];
        if (scenario === "payload hash") {
          expect(submitted.statusCode).toBe(400);
          expect(submitted.json().error.code).toBe("artifact_hash_mismatch");
          expect(deliveries).toEqual([]);
          response = submitted;
        } else {
          expect(submitted.statusCode).toBe(503); // Bounded relay wait; queued delivery is retained.
          expect(submitted.json().error.code).toBe("timeout");
          expect(deliveries).toHaveLength(1);
          expect(deliveries[0].payload).toEqual(request);
          // Trusted internal delivery after authenticated relay retrieval does not
          // invent an HTTP-signature requirement at the private adapter endpoint.
          response = await target.app.inject({ method: "POST", url: "/mpas/v1/verifier/action", payload: deliveries[0] });
          if (scenario === "positive") {
            const delivered = await signedRelayRequest(relay, "/mpas/v1/relay/delivery",
              buildDeliveryEnvelope({ sender: target.adapter.did, recipients: [target.proposer.did], payload: response.json() }), adapterSigner);
            expect(delivered.statusCode).toBe(200);
            const received = await signedRelayRequest(relay, "/mpas/v1/relay/poll",
              { version: "1", type: "RelayPollRequest", did: target.proposer.did }, target.proposer);
            expect(received.json().deliveries[0].payload).toEqual(response.json());
          }
        }
      }
      const body = response.json();
      if (scenario === "positive") {
        expect(body).toMatchObject({ result: "executed", executionResult: { content: [{ type: "text", text: "authorized" }] } });
        expect((await verifyReceiptPayload(body.executionReceipt)).result).toBe("executed");
      } else if (scenario === "profile" || scenario === "format") {
        expect(body).toMatchObject({ result: "notSupported", error: { code: "UNSUPPORTED_EXECUTION_PROFILE" } });
      } else if (scenario === "payload shape") {
        // The accepted public SDK rejects this shape before adapter-specific
        // structure/proposer/routing checks; preserve that existing ordering.
        expect(body).toMatchObject({ result: "rejected", error: { code: "INVALID_EXECUTION_PAYLOAD" } });
      } else if (scenario === "payload hash" && route === "authenticated relay") {
        expect(body.error.code).toBe("artifact_hash_mismatch");
      } else {
        const code = scenario === "application" ? "UNKNOWN_APPLICATION" : scenario === "payload hash" ? "PAYLOAD_HASH_MISMATCH"
          : scenario === "proposer" ? "PROPOSER_NOT_AUTHORIZED" : "APPROVAL_BUNDLE_INVALID";
        expect(body).toMatchObject({ result: "rejected", error: { code } });
      }
      const steps = trace.mock.calls.filter(call => call[0] === "verification_step").map(call => call[1]?.step);
      if (scenario === "profile" || scenario === "format") expect(steps).toEqual(["structural_validation", "expiry_check", "execution_profile_check"]);
      if (scenario === "payload shape") expect(steps).not.toContain("proposer_gating");
      if (scenario === "proposer") expect(steps.at(-1)).toBe("proposer_gating");
      expect(target.credentials).toHaveBeenCalledTimes(scenario === "positive" ? 1 : 0);
      expect(target.fixture.requests.filter(r => r.rpcMethod === "initialize")).toHaveLength(scenario === "positive" ? 1 : 0);
      expect(target.fixture.toolEffects).toHaveLength(scenario === "positive" ? 1 : 0);
      console.log(JSON.stringify({ case: "binding", route, scenario, status: response.statusCode, result: body.result,
        code: body.error?.code, steps, targetEffects: target.fixture.toolEffects.length, credentialReads: target.credentials.mock.calls.length }));
    }
  });

  it("rejects relay transport identity and DeliveryEnvelope mismatches before any target access", async () => {
    const target = await httpBoundaryTarget();
    const adapterSigner = KeyManager.fromJwk(target.adapter.privateJwk);
    const relay = createCoordinationApiServer({ designatedVerifierDid: target.adapter.did, relayResponseWaitMs: 5,
      authorizedRecipientDids: [target.proposer.did], auth: { enforcement: true, audiences: ["https://relay.example.test"] } });
    apps.push(relay);
    const pkg = await target.builder.buildFromToolCall("create_issue_mirror", { title: "identity binding" });
    const envelope = buildDeliveryEnvelope({ sender: target.proposer.did, recipients: [target.adapter.did],
      payload: { version: "1", type: "ActionRequest", actionPackage: pkg } });
    expect((await relay.inject({ method: "POST", url: "/mpas/v1/verifier/action", payload: envelope })).statusCode).toBe(401);
    expect((await signedRelayRequest(relay, "/mpas/v1/verifier/action", envelope, adapterSigner)).statusCode).toBe(403);
    expect((await signedRelayRequest(relay, "/mpas/v1/verifier/action", envelope, target.proposer, "https://wrong.example.test")).statusCode).toBe(401);
    for (const altered of [{ ...envelope, sender: target.adapter.did }, { ...envelope, recipients: [target.proposer.did] }]) {
      expect((await signedRelayRequest(relay, "/mpas/v1/verifier/action", altered, target.proposer)).statusCode).toBe(400);
      expect((await target.app.inject({ method: "POST", url: "/mpas/v1/verifier/action", payload: altered })).statusCode).toBe(400);
    }
    const poll = await signedRelayRequest(relay, "/mpas/v1/relay/poll", { version: "1", type: "RelayPollRequest", did: target.adapter.did }, adapterSigner);
    expect(poll.json().deliveries).toEqual([]);
    expect((await signedRelayRequest(relay, "/mpas/v1/verifier/action", envelope,
      target.proposer, "https://relay.example.test", "single-use-transport-control")).statusCode).toBe(503);
    expect((await signedRelayRequest(relay, "/mpas/v1/verifier/action", envelope,
      target.proposer, "https://relay.example.test", "single-use-transport-control")).statusCode).toBe(401);
    const queued = await signedRelayRequest(relay, "/mpas/v1/relay/poll",
      { version: "1", type: "RelayPollRequest", did: target.adapter.did }, adapterSigner);
    expect(queued.json().deliveries).toHaveLength(1);
    expect(target.credentials).not.toHaveBeenCalled();
    expect(target.fixture.requests).toEqual([]);
    expect(target.fixture.toolEffects).toEqual([]);
    console.log(JSON.stringify({ case: "relay authentication and envelope", negatives: 8, nonceControl: "first queued, reuse rejected",
      negativeDeliveries: 0, permittedNonceControlDeliveries: 1, credentialReads: 0, targetEffects: 0 }));
  });

  it("preserves the original strict-default C07 minimum-difference pair and known-plugin governance", async () => {
    const target = await httpBoundaryTarget();
    delete target.loaded.config.passThrough;
    target.loaded.config.policy.defaultRequirement = { type: "threshold", threshold: 2, eligibleSignerGroup: "maintainers" };
    const pkg = await target.builder.buildFromToolCall("create_issue_mirror", { title: "same signed request" });
    const request = { method: "POST" as const, url: "/mpas/v1/action", payload: { version: "1", type: "ActionRequest", actionPackage: pkg } };
    const first = await target.app.inject(request);
    expect(first.json()).toMatchObject({ result: "rejected", error: { code: "OPERATION_NOT_GOVERNED" } });
    target.loaded.config.policy.policies = { create_issue_mirror: [] };
    const second = await target.app.inject(request);
    expect(second.json()).toMatchObject({ result: "additionalApprovalsRequired" });
    const known = await target.builder.buildFromToolCall("delete_branch_mirror", { owner: "synthetic", repo: "test", branch: "draft" });
    const knownRequest = { ...request, payload: { ...request.payload, actionPackage: known } };
    expect((await target.app.inject(knownRequest)).json()).toMatchObject({ result: "additionalApprovalsRequired" });
    expect(target.credentials).not.toHaveBeenCalled();
    expect(target.fixture.requests).toHaveLength(0);
    for (const key of ["maintainer-a", "maintainer-b"]) {
      const signer = new ApprovalBuilder({ keyManager: KeyManager.fromJwk((await readJson<KeyFixture>(join(fixturesDir, "test-keys", key + ".json"))).privateJwk) });
      known.approvalBundle.approvals.push(await signer.buildApproval(known.actionEnvelope, "approve"));
      pkg.approvalBundle.approvals.push(await signer.buildApproval(pkg.actionEnvelope, "approve"));
    }
    expect((await target.app.inject(knownRequest)).json()).toMatchObject({ result: "executed" });
    expect((await target.app.inject(request)).json()).toMatchObject({ result: "executed" });
    expect(target.fixture.toolEffects.map(effect => effect.name)).toEqual(["delete_branch_mirror", "create_issue_mirror"]);
    console.log(JSON.stringify({ case: "C07 exact policy-key difference", ungovernedCalls: 0, emptyPolicyKeyCalls: 0,
      knownWithoutApprovals: 0, knownWithApprovals: 1, policyNamedWithApprovals: 1 }));
  });

  it("simultaneous direct and verifier requests share one durable grant and target call", async () => {
    const target = await countingTarget();
    const direct = submitFixture(target.app, "valid-no-approval-required.json");
    const relayed = target.app.inject({ method: "POST", url: "/mpas/v1/verifier/action",
      payload: { version: "1", type: "ActionRequest", actionPackage: target.actionPackage } });
    const responses = await Promise.all([direct, relayed]);
    expect(responses.map(value => value.statusCode)).toEqual([200, 200]);
    expect(responses.filter(value => value.json().result === "executed")).toHaveLength(1);
    expect(responses.filter(value => ["pending", "rejected"].includes(value.json().result))).toHaveLength(1);
    const evidence = await target.countAndCheckClosed();
    expect(evidence.calls).toBe(1);
    const winner = responses.find(value => value.json().result === "executed")!.json();
    expect(target.ledger.recoveryFor(target.actionId, target.hash)?.response).toEqual(winner);
    expect((await verifyReceiptPayload(winner.executionReceipt)).result).toBe("executed");
    console.log(JSON.stringify({ case: "adapter simultaneous routes", journalPath: target.journalPath, ...evidence }));
  });

  it.each(["write", "fsync", "ambiguous-commit"])("%s failure before grant closes prepared resources and sends zero calls", async fault => {
    const target = await countingTarget();
    const insert = target.store.insertIfAbsent.bind(target.store);
    vi.spyOn(target.store, "insertIfAbsent").mockImplementation((key, bytes) => {
      if (fault === "ambiguous-commit") insert(key, bytes);
      throw new Error("injected storage " + fault);
    });
    const response = await submitFixture(target.app, "valid-no-approval-required.json");
    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty("executionReceipt");
    const evidence = await target.countAndCheckClosed();
    expect(evidence).toMatchObject({ calls: 0, initialized: 1 });
    expect(target.ledger.check(target.actionId, target.hash).kind).toBe(fault === "ambiguous-commit" ? "pending" : "absent");
    target.store.close();
    const reopened = new FileDispatchJournal(target.journalPath); stores.push(reopened);
    const restarted = new DispatchLedger(reopened);
    expect(restarted.recoverExecuting()).toBe(fault === "ambiguous-commit" ? 1 : 0);
    console.log(JSON.stringify({ case: "adapter injected pre-grant " + fault, injected: true,
      physicalPowerCut: false, journalPath: target.journalPath, ...evidence }));
  });

  it("a post-target persistence failure emits no terminal result and never grants a retry", async () => {
    const target = await countingTarget();
    const trace = vi.spyOn(TraceLogger.prototype, "emit");
    const failure = vi.spyOn(target.store, "compareAndSwap").mockImplementation(() => {
      throw new Error("injected response commit failure");
    });
    const response = await submitFixture(target.app, "valid-no-approval-required.json");
    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty("executionReceipt");
    expect(response.json()).not.toHaveProperty("executionResult");
    expect(trace.mock.calls.filter(([type]) => type === "dispatch" || type === "receipt_generated")).toEqual([]);
    expect(target.ledger.check(target.actionId, target.hash).kind).toBe("pending");
    const retry = await submitFixture(target.app, "valid-no-approval-required.json");
    expect(retry.json()).toMatchObject({ result: "pending" });
    failure.mockRestore(); target.store.close();
    const reopened = new FileDispatchJournal(target.journalPath); stores.push(reopened);
    const restarted = new DispatchLedger(reopened);
    expect(restarted.recoverExecuting()).toBe(1);
    expect(restarted.recoveryFor(target.actionId, target.hash)?.resolution).toBe("indeterminate");
    const evidence = await target.countAndCheckClosed(); expect(evidence.calls).toBe(1);
    console.log(JSON.stringify({ case: "adapter post-target commit failure", journalPath: target.journalPath, ...evidence }));
  });

  it("returns the persisted competing winner, including a once-only signed recovery response", async () => {
    const target = await countingTarget();
    const trace = vi.spyOn(TraceLogger.prototype, "emit");
    const compare = target.store.compareAndSwap.bind(target.store);
    vi.spyOn(target.store, "compareAndSwap").mockImplementationOnce((key, expected, bytes) => {
      const proposed = parseDispatchRecord(bytes);
      if (proposed.status !== "resolved") throw new Error("Expected terminal candidate");
      const { response: _losingResponse, ...record } = proposed;
      expect(compare(key, expected, serializeDispatchRecord({ ...record, resolution: "indeterminate" }))).toBe(true);
      return false;
    });
    const response = await submitFixture(target.app, "valid-no-approval-required.json");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: "indeterminate", error: { code: "DISPATCH_RECOVERY_INDETERMINATE" } });
    expect(response.json()).not.toHaveProperty("executionResult");
    expect((await verifyReceiptPayload(response.json().executionReceipt)).result).toBe("indeterminate");
    expect(target.ledger.recoveryFor(target.actionId, target.hash)?.response).toEqual(response.json());
    expect(trace.mock.calls.filter(([type]) => type === "dispatch" || type === "receipt_generated"))
      .toEqual([["receipt_generated", expect.objectContaining({ result: "indeterminate" })],
        ["dispatch", expect.objectContaining({ result: "indeterminate" })]]);
    expect((await target.countAndCheckClosed()).calls).toBe(1);
  });

  it("responds to health checks", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/mpas/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      loadedConfigs: expect.arrayContaining([
        expect.objectContaining({ applicationDid: "did:web:github-mirror.example" }),
        expect.objectContaining({ applicationDid: "did:web:github-live-demo.example" }),
      ]),
    });
  });

  it("executes valid-no-approval-required.json and returns an ActionResponse with a receipt", async () => {
    const app = await makeApp(await makeAutoApproveConfigDir());
    const response = await submitFixture(app, "valid-no-approval-required.json");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: "1",
      type: "ActionResponse",
      verifier: { did: expect.any(String) },
      result: "executed",
      executionReceipt: { version: "1", type: "ExecutionReceipt", format: "jws" },
      executionResult: { content: [{ type: "text" }] },
    });
  });

  it("initializes the upstream with the protocol revision from the installed plugin", async () => {
    const app = await makeApp(await makeTargetConfigDir(protocolVersionFixtureServer, 1000));
    const response = await submitFixture(app, "valid-no-approval-required.json");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "executed",
      executionResult: {
        content: [{ type: "text", text: expect.stringContaining('"protocolVersion":"2024-11-05"') }],
      },
    });
  });

  it("rejects a second submission of a resolved actionId as replay", async () => {
    const ledger = new DispatchLedger();
    const app = await makeApp(await makeAutoApproveConfigDir(), ledger);
    const first = await submitFixture(app, "valid-no-approval-required.json");
    expect(first.json()).toMatchObject({ result: "executed" });

    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "core", "valid-no-approval-required.json"),
    );
    expect(ledger.recoveryFor(
      actionPackage.actionEnvelope.actionId,
      computeJsonHash(actionPackage.actionEnvelope),
    )?.response).toEqual(first.json());

    const second = await submitFixture(app, "valid-no-approval-required.json");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ result: "rejected", error: { code: "REPLAY_DETECTED" } });
  });

  it("reports a sanitized initialization diagnostic without issuing a receipt", async () => {
    const app = await makeApp(await makeTargetConfigDir(missingFixtureServer, 1000, "definitely-not-an-mcp-command"));
    const response = await submitFixture(app, "valid-no-approval-required.json");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "rejected",
      error: { code: "TARGET_UNAVAILABLE" },
      context: {
        diagnostic: {
          code: "TARGET_UNAVAILABLE",
          phase: "initialize",
          transport: "stdio",
          message: "The upstream MCP target could not be launched or initialized.",
        },
      },
    });
    expect(response.json()).not.toHaveProperty("executionReceipt");
  });

  it("resolves a dispatch timeout as indeterminate, not failed", async () => {
    // timeoutMs must allow initialize on slow CI, but stay below the slow
    // fixture's tools/call delay so the timeout happens after ledger write.
    const app = await makeApp(await makeTargetConfigDir(slowFixtureServer, 1_000));
    const response = await submitFixture(app, "valid-no-approval-required.json");

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      result: string;
      executionReceipt: ExecutionReceipt;
      executionResult?: unknown;
      context?: { diagnostic?: Record<string, unknown> };
    };
    expect(body.result).toBe("indeterminate");
    expect(body.executionResult).toBeUndefined();
    expect(body.context?.diagnostic).toEqual({
      code: "DISPATCH_TIMEOUT",
      phase: "tools/call",
      transport: "stdio",
      message: "The upstream MCP server did not respond before the dispatch timeout.",
    });
    expect((await verifyReceiptPayload(body.executionReceipt)).result).toBe("indeterminate");
  });

  it("builds a signed indeterminate response for a dispatch interrupted by restart", async () => {
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "core", "valid-no-approval-required.json"),
    );
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));

    const response = await buildIndeterminateRecoveryResponse(actionPackage, {
      adapterDid: adapter.did,
      adapterSigningKey: adapter.privateJwk,
    });

    expect(response).toMatchObject({
      result: "indeterminate",
      verifier: { did: adapter.did },
      error: { code: "DISPATCH_RECOVERY_INDETERMINATE" },
      executionReceipt: { type: "ExecutionReceipt" },
    });
    expect(await verifyReceiptPayload(response.executionReceipt!)).toMatchObject({
      result: "indeterminate",
      actionEnvelopeHash: computeJsonHash(actionPackage.actionEnvelope),
    });
  });

  it("resolves a definitive target error as failed", async () => {
    const app = await makeApp(await makeTargetConfigDir(errorFixtureServer, 1000));
    const response = await submitFixture(app, "valid-no-approval-required.json");

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      result: string;
      executionReceipt: ExecutionReceipt;
      context?: { diagnostic?: Record<string, unknown> };
    };
    expect(body.result).toBe("failed");
    expect(body.context?.diagnostic).toEqual({
      code: "INVALID_RESPONSE",
      phase: "tools/call",
      transport: "stdio",
      message: "The upstream MCP server returned a protocol error.",
    });
    expect((await verifyReceiptPayload(body.executionReceipt)).result).toBe("failed");
  });

  it("returns Authorization Requirements for insufficient approvals, repeatably and without consuming the actionId", async () => {
    const app = await makeApp();
    const first = await submitFixture(app, "insufficient-approvals.json");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      result: "additionalApprovalsRequired",
      authorizationRequirements: { version: "1", type: "AuthorizationRequirements", result: "additionalApprovalsRequired" },
    });

    // Repeating the same package yields the same verdict — the actionId was not consumed.
    const second = await submitFixture(app, "insufficient-approvals.json");
    expect(second.json()).toMatchObject({ result: "additionalApprovalsRequired" });
  });

  it("accepts a canonical multi-recipient Action envelope when the configured Verifier DID is a recipient", async () => {
    const app = await makeApp();
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "insufficient-approvals.json"));
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
    const envelope = buildDeliveryEnvelope({
      sender: actionPackage.actionEnvelope.proposer.did,
      recipients: [adapter.did, "did:jwk:observer" as Did],
      payload: { version: "1", type: "ActionRequest", idempotencyKey: "direct-1", actionPackage },
    });

    const response = await app.inject({ method: "POST", url: "/mpas/v1/action", payload: envelope });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ type: "ActionResponse", result: "additionalApprovalsRequired" });

    const missingVerifier = await app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      payload: { ...envelope, recipients: ["did:jwk:observer"] },
    });
    expect(missingVerifier.statusCode).toBe(400);
  });

  it("returns a 400 MpasHttpError for an unparseable package (missing Action Envelope)", async () => {
    const app = await makeApp();
    const response = await submitFixture(app, "malformed-missing-envelope.json");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      version: "1",
      type: "MpasHttpError",
      error: { code: "artifact_malformed" },
    });
  });

  it("rejects a body with duplicate JSON member names as a 400 MpasHttpError (Core §5.1.2)", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      headers: { "content-type": "application/mpas+json" },
      payload: '{"version":"1","type":"ActionRequest","actionPackage":{"a":1,"a":2}}',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: "MpasHttpError",
      error: { code: "artifact_malformed" },
    });
  });

  it("resolves an unsupported execution profile as notSupported (MCP profile §2)", async () => {
    const app = await makeApp(await makeAutoApproveConfigDir());
    const actionPackage = JSON.parse(
      await readFile(join(fixturesDir, "core", "valid-no-approval-required.json"), "utf8"),
    ) as { actionEnvelope: { executionProfile: { id: string } } };
    actionPackage.actionEnvelope.executionProfile.id = "did:web:profiles.example:other";

    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      headers: { "content-type": "application/mpas+json" },
      payload: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "notSupported",
      error: { code: "UNSUPPORTED_EXECUTION_PROFILE" },
    });
  });

  it("returns an immediate policy rejection for a blocked action without requesting approvals or dispatching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-policy-deny-"));
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
    };
    const policy = config.policy as { policies: Record<string, unknown[]> };
    policy.policies.create_issue_mirror = [
      {
        reject: true,
        description: "This operator-only rationale must not be returned.",
      },
    ];
    await writeFile(join(dir, "github-policy-deny.json"), `${JSON.stringify(config, null, 2)}\n`);

    const app = await makeApp(dir);
    const first = await submitFixture(app, "valid-no-approval-required.json");
    const firstBody = first.json() as Record<string, unknown>;

    expect(first.statusCode).toBe(200);
    expect(firstBody).toMatchObject({
      result: "rejected",
      error: {
        code: "ACTION_BLOCKED_BY_POLICY",
        message: "Action create_issue_mirror is blocked by policy.",
      },
    });
    expect(firstBody.authorizationRequirements).toBeUndefined();

    // A policy denial is stateless: the actionId was not dispatched or consumed.
    const second = await submitFixture(app, "valid-no-approval-required.json");
    expect(second.json()).toMatchObject({
      result: "rejected",
      error: { code: "ACTION_BLOCKED_BY_POLICY" },
    });
  });

  it("rejects an ungoverned operation when passThrough is deny", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-deny-"));
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
    };
    config.passThrough = "deny";
    await writeFile(join(dir, "github-deny.json"), `${JSON.stringify(config, null, 2)}\n`);

    const app = await makeApp(dir);
    // create_issue_mirror is deliberately absent from the demo plugin and policy —
    // the canonical pass-through operation.
    const response = await submitFixture(app, "valid-no-approval-required.json");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "rejected",
      error: { code: "OPERATION_NOT_GOVERNED" },
    });
  });

  it("rejects a proposer outside the allowed proposer set (proposer gating)", async () => {
    // Config identical to auto-approve, but the proposers group excludes the
    // fixture proposer (maintainers only). The package still verifies
    // cryptographically; gating must reject it before policy evaluation.
    const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-gating-"));
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
    };
    const policy = config.policy as { signerGroups: Record<string, string[]> };
    policy.signerGroups.proposers = policy.signerGroups.maintainers;
    await writeFile(join(dir, "github-gating.json"), `${JSON.stringify(config, null, 2)}\n`);

    const app = await makeApp(dir);
    const response = await submitFixture(app, "valid-no-approval-required.json");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "rejected",
      error: { code: "PROPOSER_NOT_AUTHORIZED" },
    });
  });
});
