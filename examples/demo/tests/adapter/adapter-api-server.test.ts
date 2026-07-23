import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { compactVerify, importJWK, type JWK } from "jose";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import { FileCredentialProvider } from "../../src/adapter/credential-provider.js";
import { createAdapterApiServer } from "../../src/adapter/adapter-api-server.js";
import type { Did, ExecutionReceipt, ReceiptPayload } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const slowFixtureServer = fileURLToPath(new URL("../fixtures/adapter/slow-mcp-server.mjs", import.meta.url));
const errorFixtureServer = fileURLToPath(new URL("../fixtures/adapter/error-mcp-server.mjs", import.meta.url));
const apps: FastifyInstance[] = [];

interface KeyFixture {
  did: Did;
  privateJwk: JWK;
  publicJwk: JWK;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function credentialDir() {
  const dir = await mkdtemp(join(tmpdir(), "mpas-http-credentials-"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "github-test-token.json");
  await writeFile(path, `${JSON.stringify({ value: "ghp_test" })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return dir;
}

async function makeApp(configDir?: string) {
  // Default to only the auto-approve config to avoid strict overriding it (both
  // target the same application DID, so the last loaded wins).
  const effectiveConfigDir = configDir ?? join(fixturesDir, "configs");
  const configs = await loadDeploymentConfigs(effectiveConfigDir);
  if (!configs.ok) {
    throw new Error(configs.error.message);
  }
  const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
  const app = createAdapterApiServer({
    configsByApplicationDid: configs.configsByApplicationDid,
    credentialProvider: new FileCredentialProvider(await credentialDir()),
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
  const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-auto-approve.json"));
  config.plugin = {
    ...(config.plugin as Record<string, unknown>),
    path: join(fixturesDir, "plugins", "github-demo-plugin.json"),
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

async function makeTargetConfigDir(server: string, timeoutMs: number) {
  const dir = await mkdtemp(join(tmpdir(), "mpas-http-configs-"));
  const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-auto-approve.json"));
  config.plugin = {
    ...(config.plugin as Record<string, unknown>),
    path: join(fixturesDir, "plugins", "github-demo-plugin.json"),
  };
  config.executionTarget = {
    type: "mcp.stdio",
    command: "node",
    args: [server],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "{{credential:github-test-token}}",
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
      loadedConfigs: [{ applicationDid: "did:web:github.example" }],
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

  it("rejects a second submission of a resolved actionId as replay", async () => {
    const app = await makeApp(await makeAutoApproveConfigDir());
    const first = await submitFixture(app, "valid-no-approval-required.json");
    expect(first.json()).toMatchObject({ result: "executed" });

    const second = await submitFixture(app, "valid-no-approval-required.json");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ result: "rejected", error: { code: "REPLAY_DETECTED" } });
  });

  it("resolves a dispatch timeout as indeterminate, not failed", async () => {
    const app = await makeApp(await makeTargetConfigDir(slowFixtureServer, 10));
    const response = await submitFixture(app, "valid-no-approval-required.json");

    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: string; executionReceipt: ExecutionReceipt; executionResult?: unknown };
    expect(body.result).toBe("indeterminate");
    expect(body.executionResult).toBeUndefined();
    expect((await verifyReceiptPayload(body.executionReceipt)).result).toBe("indeterminate");
  });

  it("resolves a definitive target error as failed", async () => {
    const app = await makeApp(await makeTargetConfigDir(errorFixtureServer, 1000));
    const response = await submitFixture(app, "valid-no-approval-required.json");

    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: string; executionReceipt: ExecutionReceipt };
    expect(body.result).toBe("failed");
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
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-auto-approve.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-demo-plugin.json"),
    };
    const policy = config.policy as { policies: Record<string, unknown[]> };
    policy.policies.create_issue = [
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
        message: "Action create_issue is blocked by policy.",
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
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-auto-approve.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-demo-plugin.json"),
    };
    config.passThrough = "deny";
    await writeFile(join(dir, "github-deny.json"), `${JSON.stringify(config, null, 2)}\n`);

    const app = await makeApp(dir);
    // create_issue is deliberately absent from the demo plugin and policy —
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
    const config = await readJson<Record<string, unknown>>(join(fixturesDir, "configs", "github-auto-approve.json"));
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-demo-plugin.json"),
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
