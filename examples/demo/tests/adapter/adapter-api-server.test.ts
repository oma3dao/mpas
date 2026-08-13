import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { compactVerify, importJWK, type JWK } from "jose";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import { FileCredentialProvider } from "../../src/adapter/credential-provider.js";
import { classifyDispatch, createAdapterApiServer } from "../../src/adapter/adapter-api-server.js";
import * as mcpHttp from "../../src/adapter/dispatch/mcp-http.js";
import * as mcpStdio from "../../src/adapter/dispatch/mcp-stdio.js";
import type { Did, ExecutionReceipt, ReceiptPayload } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const slowFixtureServer = fileURLToPath(new URL("../fixtures/adapter/slow-mcp-server.mjs", import.meta.url));
const errorFixtureServer = fileURLToPath(new URL("../fixtures/adapter/error-mcp-server.mjs", import.meta.url));
const protocolVersionFixtureServer = fileURLToPath(
  new URL("../fixtures/adapter/protocol-version-mcp-server.mjs", import.meta.url),
);
const missingFixtureServer = join(fixturesDir, "adapter", "missing-mcp-server.mjs");
const apps: FastifyInstance[] = [];

/** Avoids Windows chmod/mode flakiness for dispatch-path coverage. */
function staticCredentialProvider(value = "ghp_test"): FileCredentialProvider {
  return {
    getCredential: async () => ({ ok: true as const, value }),
  } as FileCredentialProvider;
}

interface KeyFixture {
  did: Did;
  privateJwk: JWK;
  publicJwk: JWK;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function makeApp(configDir?: string) {
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
    credentialProvider: staticCredentialProvider(),
    adapterDid: adapter.did,
    adapterSigningKey: adapter.privateJwk,
    // Test fixtures are signed with a far-future expiresAt; widen the window so the
    // max-validity guard does not reject them.
    maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER,
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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("HTTP endpoint", () => {
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
    const app = await makeApp(await makeAutoApproveConfigDir());
    const first = await submitFixture(app, "valid-no-approval-required.json");
    expect(first.json()).toMatchObject({ result: "executed" });

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

  it("governs an operator-only policy entry even when the plugin omits the operation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-operator-"));
    const config = await readJson<Record<string, unknown>>(
      join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"),
    );
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
    };
    const policy = config.policy as { policies: Record<string, unknown[]> };
    policy.policies = {
      create_issue_mirror: [{ requirements: { type: "proposerOnly" } }],
    };
    config.executionTarget = {
      type: "mcp.stdio",
      command: "node",
      args: [join(fixturesDir, "adapter", "echo-mcp-server.mjs")],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{credential:github-mirror-token}}" },
      timeoutMs: 2000,
    };
    await writeFile(join(dir, "github-operator.json"), `${JSON.stringify(config, null, 2)}\n`);

    const app = await makeApp(dir);
    const response = await submitFixture(app, "valid-no-approval-required.json");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "executed",
      executionReceipt: { type: "ExecutionReceipt" },
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

  it.each([
    ["invalid-unknown-application.json", "rejected", "UNKNOWN_APPLICATION"],
    ["invalid-bad-signature.json", "rejected", "APPROVAL_BUNDLE_INVALID"],
    ["invalid-payload-hash-mismatch.json", "rejected", "PAYLOAD_HASH_MISMATCH"],
  ])("rejects %s as %s with %s and a receipt", async (fixtureFile, result, code) => {
    const app = await makeApp();
    const response = await submitFixture(app, fixtureFile);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result,
      error: { code },
      executionReceipt: { type: "ExecutionReceipt" },
    });
  });

  it("marks expired envelopes as expired with a receipt", async () => {
    const app = await makeApp();
    const response = await submitFixture(app, "invalid-expired-envelope.json");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "expired",
      error: { code: "EXPIRED_ACTION_ENVELOPE" },
      executionReceipt: { type: "ExecutionReceipt" },
    });
  });

  it("rejects envelopes whose validity window exceeds the verifier maximum", async () => {
    const configs = await loadDeploymentConfigs(await makeAutoApproveConfigDir(), {
      confirmPluginUse: async () => true,
    });
    if (!configs.ok) throw new Error(configs.error.message);
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
    const app = createAdapterApiServer({
      configsByApplicationDid: configs.configsByApplicationDid,
      credentialProvider: staticCredentialProvider(),
      adapterDid: adapter.did,
      adapterSigningKey: adapter.privateJwk,
      maxEnvelopeValidityMs: 60_000,
    });
    apps.push(app);

    const response = await submitFixture(app, "valid-no-approval-required.json");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "rejected",
      error: { code: "ENVELOPE_VALIDITY_TOO_LONG" },
    });
  });

  it("rejects when the credential handle cannot be resolved", async () => {
    const configs = await loadDeploymentConfigs(await makeAutoApproveConfigDir(), {
      confirmPluginUse: async () => true,
    });
    if (!configs.ok) throw new Error(configs.error.message);
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
    const app = createAdapterApiServer({
      configsByApplicationDid: configs.configsByApplicationDid,
      credentialProvider: {
        getCredential: async () => ({
          ok: false as const,
          error: { code: "CREDENTIAL_NOT_FOUND", message: "missing" },
        }),
      } as FileCredentialProvider,
      adapterDid: adapter.did,
      adapterSigningKey: adapter.privateJwk,
      maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER,
    });
    apps.push(app);

    const response = await submitFixture(app, "valid-no-approval-required.json");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "rejected",
      error: { code: "CREDENTIAL_NOT_FOUND" },
    });
  });

  it("returns pending when the ledger already has the action in flight", async () => {
    const configs = await loadDeploymentConfigs(await makeAutoApproveConfigDir(), {
      confirmPluginUse: async () => true,
    });
    if (!configs.ok) throw new Error(configs.error.message);
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
    const ledger = {
      check: () => ({ kind: "pending" as const }),
      authorizeDispatch: () => ({ kind: "absent" as const }),
      resolve() {},
    };
    const app = createAdapterApiServer({
      configsByApplicationDid: configs.configsByApplicationDid,
      credentialProvider: staticCredentialProvider(),
      adapterDid: adapter.did,
      adapterSigningKey: adapter.privateJwk,
      maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER,
      ledger: ledger as never,
    });
    apps.push(app);

    const response = await submitFixture(app, "valid-no-approval-required.json");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: "pending" });
    expect(response.json().executionReceipt).toBeUndefined();
  });

  it("returns pending when authorizeDispatch races after prepare", async () => {
    const dir = await makeTargetConfigDir(join(fixturesDir, "adapter", "echo-mcp-server.mjs"), 2000);
    const configs = await loadDeploymentConfigs(dir, { confirmPluginUse: async () => true });
    if (!configs.ok) throw new Error(configs.error.message);
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
    const ledger = {
      check: () => ({ kind: "absent" as const }),
      authorizeDispatch: () => ({ kind: "pending" as const }),
      resolve() {},
    };
    const app = createAdapterApiServer({
      configsByApplicationDid: configs.configsByApplicationDid,
      credentialProvider: staticCredentialProvider(),
      adapterDid: adapter.did,
      adapterSigningKey: adapter.privateJwk,
      maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER,
      ledger: ledger as never,
    });
    apps.push(app);

    const response = await submitFixture(app, "valid-delete-branch.json");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: "pending" });
  });

  it("rejects when authorizeDispatch loses a race to a replay", async () => {
    const dir = await makeTargetConfigDir(join(fixturesDir, "adapter", "echo-mcp-server.mjs"), 2000);
    const configs = await loadDeploymentConfigs(dir, { confirmPluginUse: async () => true });
    if (!configs.ok) throw new Error(configs.error.message);
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
    const ledger = {
      check: () => ({ kind: "absent" as const }),
      authorizeDispatch: () => ({
        kind: "reject" as const,
        code: "REPLAY_DETECTED" as const,
        message: "already dispatched",
      }),
      resolve() {},
    };
    const app = createAdapterApiServer({
      configsByApplicationDid: configs.configsByApplicationDid,
      credentialProvider: staticCredentialProvider(),
      adapterDid: adapter.did,
      adapterSigningKey: adapter.privateJwk,
      maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER,
      ledger: ledger as never,
    });
    apps.push(app);

    const response = await submitFixture(app, "valid-delete-branch.json");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "rejected",
      error: { code: "REPLAY_DETECTED" },
      executionReceipt: { type: "ExecutionReceipt" },
    });
  });

  it("marks an empty approval bundle as malformed without a receipt", async () => {
    const app = await makeApp(await makeAutoApproveConfigDir());
    const actionPackage = JSON.parse(
      await readFile(join(fixturesDir, "core", "valid-no-approval-required.json"), "utf8"),
    ) as { approvalBundle: { approvals: unknown[] } };
    actionPackage.approvalBundle = { ...actionPackage.approvalBundle, approvals: [] };

    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      headers: { "content-type": "application/mpas+json" },
      payload: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "malformed",
      error: { code: "MALFORMED_APPROVAL_BUNDLE" },
    });
    expect(response.json().executionReceipt).toBeUndefined();
  });

  it("marks a numeric policy condition over a string title as malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-numeric-"));
    const config = await readJson<Record<string, unknown>>(
      join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"),
    );
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
    };
    const policy = config.policy as { policies: Record<string, unknown[]> };
    policy.policies = {
      create_issue_mirror: [
        {
          match: {
            conditions: [{ source: "executionPayload", path: "/arguments/title", op: "gt", value: 10 }],
          },
          requirements: { type: "proposerOnly" },
        },
      ],
    };
    await writeFile(join(dir, "github-numeric.json"), `${JSON.stringify(config, null, 2)}\n`);

    const app = await makeApp(dir);
    const response = await submitFixture(app, "valid-no-approval-required.json");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "malformed",
      error: { code: "NUMERIC_CONDITION_UNPARSEABLE" },
    });
  });

  it("accepts a raw ActionPackage body without an ActionRequest wrapper", async () => {
    const app = await makeApp(await makeAutoApproveConfigDir());
    const actionPackage = JSON.parse(
      await readFile(join(fixturesDir, "core", "valid-no-approval-required.json"), "utf8"),
    ) as unknown;

    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      headers: { "content-type": "application/mpas+json" },
      payload: JSON.stringify(actionPackage),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "executed",
      executionReceipt: { type: "ExecutionReceipt" },
    });
  });

  it("rejects a governed plugin operation whose payload fails schema validation", async () => {
    const { ActionPackageBuilder, KeyManager } = await import("@oma3/mpas");
    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const builder = new ActionPackageBuilder({
      keyManager,
      applicationDid: "did:web:github-mirror.example",
      executionProfile: { id: "did:web:profiles.oma3.org:mcp", format: "mcp.toolsCall" },
    });
    const actionPackage = await builder.buildFromToolCall("delete_branch_mirror", { owner: "example-org" });

    const app = await makeApp(await makeAutoApproveConfigDir());
    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      headers: { "content-type": "application/mpas+json" },
      payload: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "rejected",
      error: { code: expect.stringMatching(/PAYLOAD|SCHEMA|INVALID|ARGUMENT/) },
      executionReceipt: { type: "ExecutionReceipt" },
    });
  });

  it("marks a hashable package with non-millisecond createdAt as malformed before the ledger", async () => {
    const app = await makeApp(await makeAutoApproveConfigDir());
    const actionPackage = JSON.parse(
      await readFile(join(fixturesDir, "core", "valid-no-approval-required.json"), "utf8"),
    ) as { actionEnvelope: { createdAt: string } };
    actionPackage.actionEnvelope.createdAt = "2026-06-05T18:00:00Z";

    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      headers: { "content-type": "application/mpas+json" },
      payload: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "malformed",
      error: { code: "INVALID_ACTION_ENVELOPE" },
    });
    expect(response.json().executionReceipt).toBeUndefined();
  });

  it("marks a verified package missing executionPayload.arguments as malformed", async () => {
    const { ActionPackageBuilder, KeyManager } = await import("@oma3/mpas");
    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const builder = new ActionPackageBuilder({
      keyManager,
      applicationDid: "did:web:github-mirror.example",
      executionProfile: { id: "did:web:profiles.oma3.org:mcp", format: "mcp.toolsCall" },
    });
    const payload = { name: "create_issue_mirror" } as never;
    const envelope = builder.buildEnvelope(payload);
    const approval = await builder.signProposerApproval(envelope);
    const actionPackage = builder.assemblePackage(payload, envelope, approval);

    const app = await makeApp(await makeAutoApproveConfigDir());
    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      headers: { "content-type": "application/mpas+json" },
      payload: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "malformed",
      error: { code: "PAYLOAD_STRUCTURE_INVALID" },
    });
  });

  it.each([
    ["PROCESS_EXITED", "The upstream MCP process exited before responding."],
    ["TRANSPORT_ERROR", "The upstream MCP transport failed after dispatch."],
    ["WEIRD_CODE", "The upstream MCP operation did not complete normally."],
  ] as const)("surfaces tools/call diagnostic message for %s", async (code, message) => {
    const prepareSpy = vi.spyOn(mcpStdio, "prepareMcpStdio").mockResolvedValue({
      ok: true,
      session: {
        transmit: async () => ({
          ok: false as const,
          error: { kind: "McpDispatchError" as const, code, message: "boom" },
        }),
        close: async () => undefined,
      },
    });

    try {
      const app = await makeApp(await makeAutoApproveConfigDir());
      const response = await submitFixture(app, "valid-no-approval-required.json");
      expect(response.statusCode).toBe(200);
      const body = response.json() as { result: string; context?: { diagnostic?: Record<string, unknown> } };
      expect(body.result === "indeterminate" || body.result === "failed").toBe(true);
      expect(body.context?.diagnostic).toMatchObject({
        code,
        phase: "tools/call",
        transport: "stdio",
        message,
      });
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("dispatches through mcp.http targets via prepareTarget", async () => {
    const prepareHttpSpy = vi.spyOn(mcpHttp, "prepareMcpHttp").mockResolvedValue({
      ok: true,
      session: {
        transmit: async () => ({ ok: true as const, result: { content: [{ type: "text", text: "ok" }] } }),
        close: async () => undefined,
      },
    });

    try {
      const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-http-target-"));
      const config = await readJson<Record<string, unknown>>(
        join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"),
      );
      config.plugin = {
        ...(config.plugin as Record<string, unknown>),
        path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
      };
      config.executionTarget = {
        type: "mcp.http",
        url: "http://127.0.0.1:9/mcp",
        headers: {
          Authorization: "Bearer {{credential:github-mirror-token}}",
        },
        timeoutMs: 5_000,
      };
      await writeFile(join(dir, "github-http.json"), `${JSON.stringify(config, null, 2)}\n`);

      const app = await makeApp(dir);
      const response = await submitFixture(app, "valid-no-approval-required.json");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        result: "executed",
        executionReceipt: { type: "ExecutionReceipt" },
      });
      expect(prepareHttpSpy).toHaveBeenCalled();
    } finally {
      prepareHttpSpy.mockRestore();
    }
  });

  it("rejects OAuth HTTP targets that have no stored session without requiring a static credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-oauth-"));
    const config = await readJson<Record<string, unknown>>(
      join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"),
    );
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
    };
    config.credentialBindings = [{ credentialHandle: "coverage-oauth-token-s13", provider: "file" }];
    config.executionTarget = {
      type: "mcp.http",
      url: "https://mcp.example/mcp",
      auth: { type: "oauth2", session: "coverage-oauth-session" },
      timeoutMs: 5_000,
    };
    await writeFile(join(dir, "github-oauth.json"), `${JSON.stringify(config, null, 2)}\n`);

    const app = await makeApp(dir);
    const response = await submitFixture(app, "valid-no-approval-required.json");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "rejected",
      error: {
        code: "TARGET_UNAVAILABLE",
        message: expect.stringContaining("mpas oauth login --application-did"),
      },
    });
    expect(response.json().error.message).not.toContain("CREDENTIAL_NOT_FOUND");
  });
});

describe("classifyDispatch", () => {
  it("classifies successful tool results as executed", () => {
    expect(classifyDispatch({ ok: true, result: { content: [] } })).toEqual({
      result: "executed",
      executionResult: { content: [] },
    });
  });

  it("classifies tool isError as failed", () => {
    expect(classifyDispatch({ ok: true, result: { isError: true, content: [] } })).toEqual({
      result: "failed",
      executionResult: { isError: true, content: [] },
    });
  });

  it.each(["DISPATCH_TIMEOUT", "PROCESS_EXITED", "TRANSPORT_ERROR"] as const)(
    "classifies %s as indeterminate",
    (code) => {
      expect(
        classifyDispatch({
          ok: false,
          error: { kind: "McpDispatchError", code, message: "boom" },
        }),
      ).toEqual({
        result: "indeterminate",
        error: { code, message: "boom" },
      });
    },
  );

  it("classifies other dispatch errors as failed", () => {
    expect(
      classifyDispatch({
        ok: false,
        error: { kind: "McpDispatchError", code: "INVALID_RESPONSE", message: "bad" },
      }),
    ).toEqual({
      result: "failed",
      error: { code: "INVALID_RESPONSE", message: "bad" },
    });
  });
});
