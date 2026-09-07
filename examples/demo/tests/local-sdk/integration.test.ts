import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import { FileCredentialProvider } from "../../src/adapter/credential-provider.js";
import { createAdapterApiServer } from "../../src/adapter/adapter-api-server.js";
import { dryRunActionFile } from "../../src/cli/index.js";
import type { ActionPackage, Approval, Did } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
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
  const dir = await mkdtemp(join(tmpdir(), "mpas-local-sdk-credentials-"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "github-mirror-token.json");
  await writeFile(path, `${JSON.stringify({ value: "ghp_test" })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return dir;
}

async function makeAutoApproveConfigDir() {
  const dir = await mkdtemp(join(tmpdir(), "mpas-local-sdk-configs-"));
  const config = await readJson<Record<string, unknown>>(
    join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"),
  );
  config.plugin = {
    ...(config.plugin as Record<string, unknown>),
    path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
  };
  await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

async function makeApp(configDir: string) {
  const configs = await loadDeploymentConfigs(configDir, {
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
    maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER,
  });
  apps.push(app);
  return app;
}

async function submitActionPackage(app: FastifyInstance, actionPackage: unknown) {
  return app.inject({
    method: "POST",
    url: "/mpas/v1/action",
    headers: { "content-type": "application/mpas+json" },
    payload: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("local SDK integration", () => {
  it("resolves @oma3/mpas to this repository's sdk/protocol checkout", () => {
    const demoRoot = join(fixturesDir, "..", "..");
    const localPkg = join(demoRoot, "..", "..", "sdk", "protocol", "package.json");
    const require = createRequire(join(demoRoot, "package.json"));
    const resolvedPkg = require.resolve("@oma3/mpas/package.json");

    expect(existsSync(localPkg)).toBe(true);
    expect(realpathSync(resolvedPkg)).toBe(realpathSync(localPkg));
  });

  it("rejects a fixture with a bad Approval signature through the adapter", async () => {
    const app = await makeApp(await makeAutoApproveConfigDir());
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "invalid-bad-signature.json"));
    const response = await submitActionPackage(app, actionPackage);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: "rejected",
      error: { code: "APPROVAL_BUNDLE_INVALID" },
    });
  });

  it("rejects an HS256 Approval through the adapter verification path", async () => {
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "valid-no-approval-required.json"));
    const hmacJwk: JWK = {
      kty: "oct",
      alg: "HS256",
      k: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url"),
    };
    const hmacKey = await importJWK(hmacJwk, "HS256");
    const value = await new CompactSign(Buffer.from(JSON.stringify({ type: "ApprovalPayload" })))
      .setProtectedHeader({ alg: "HS256" })
      .sign(hmacKey);
    await compactVerify(value, hmacKey);

    const hs256Approval: Approval = {
      ...actionPackage.approvalBundle.approvals[0],
      signature: { format: "jws", value },
    };
    actionPackage.approvalBundle.approvals = [hs256Approval];

    const app = await makeApp(await makeAutoApproveConfigDir());
    const response = await submitActionPackage(app, actionPackage);

    expect(response.json()).toMatchObject({
      result: "rejected",
    });
  });

  it("rejects a signer did:jwk that embeds private key material at config load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-local-sdk-didjwk-"));
    const config = await readJson<Record<string, unknown>>(
      join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"),
    );
    const proposer = await readJson<{ privateJwk: { crv: string; kty: string; x: string; d: string } }>(
      join(fixturesDir, "test-keys", "proposer.json"),
    );
    const { crv, kty, x, d } = proposer.privateJwk;
    const privateDid = `did:jwk:${Buffer.from(JSON.stringify({ crv, d, kty, x }), "utf8").toString("base64url")}`;
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixturesDir, "plugins", "github-mirror-plugin.json"),
    };
    config.signerKeys = [{ did: privateDid, label: "proposer-private" }];

    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = await loadDeploymentConfigs(dir, { confirmPluginUse: async () => true });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "CONFIG_SCHEMA_INVALID",
      },
    });
    if (!result.ok) {
      expect(result.error.message).toMatch(/private key material/);
    }
  });

  it("dry-runs a fixture Action Package through the demo CLI", async () => {
    const configDir = await makeAutoApproveConfigDir();
    const result = await dryRunActionFile(join(fixturesDir, "core", "valid-no-approval-required.json"), {
      configDir,
    });

    expect(result).toMatchObject({
      result: "satisfied",
      operationName: "create_issue_mirror",
    });
  });
});
