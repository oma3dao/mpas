import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../src/adapter/daemon.js";
import { dryRunActionFile, runCli, validateConfig } from "../../src/cli/index.js";

/** Deterministic clock pinned inside the fixture validity window. */
const FIXTURE_NOW = Date.parse("2026-06-05T19:00:00.000Z");

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const startedApps: FastifyInstance[] = [];

class MemoryWriter {
  text = "";

  write(chunk: string | Uint8Array): boolean {
    this.text += chunk.toString();
    return true;
  }
}

async function credentialDir() {
  const dir = await mkdtemp(join(tmpdir(), "mpas-cli-credentials-"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "github-mirror-token.json");
  await writeFile(path, `${JSON.stringify({ value: "ghp_test" })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return dir;
}

async function startFixtureDaemon() {
  // Use only the auto-approve config so that create_issue_mirror passes with proposerOnly.
  const tmpDir = await mkdtemp(join(tmpdir(), "mpas-cli-daemon-cfg-"));
  const config = JSON.parse(await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8")) as Record<string, unknown>;
  (config.plugin as Record<string, unknown>).path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
  await writeFile(join(tmpDir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

  const journalDir = await mkdtemp(join(realpathSync(tmpdir()), "mpas-cli-journal-"));
  const daemon = await startDaemon({
    configDir: tmpDir,
    credentialDir: await credentialDir(),
    adapterKeyPath: join(fixturesDir, "test-keys", "adapter.json"),
    port: 0,
    now: FIXTURE_NOW,
    journalPath: join(journalDir, "dispatch-ledger.jsonl"),
    trustContext: null,
    confirmPluginUse: async () => true,
  });
  startedApps.push(daemon.app);
  return daemon;
}

async function managedOAuthConfigDir() {
  const configDir = await mkdtemp(join(tmpdir(), "mpas-cli-oauth-config-"));
  const config = JSON.parse(
    await readFile(join(fixturesDir, "configs", "github-mirror-adapter-config.json"), "utf8"),
  ) as Record<string, any>;
  config.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
  config.credentialBindings = [{ credentialHandle: "managed-session", provider: "file" }];
  config.executionTarget = {
    type: "mcp.http",
    url: "https://mcp.example/mcp",
    auth: {
      type: "oauth2",
      session: "managed-session",
      scopes: ["mcp:tools"],
      client: { type: "dynamic" },
      refresh: { safetyWindowMs: 0, jitterMaxMs: 0 },
    },
  };
  await writeFile(join(configDir, "managed.json"), `${JSON.stringify(config, null, 2)}\n`);
  return { configDir, config };
}

function managedOAuthSession(config: Record<string, any>, tokens: Record<string, unknown>, tokensSavedAt: string) {
  const applicationDid = config.target.applicationDid;
  const resourceUrl = config.executionTarget.url;
  const operatorPrincipal = `local-os-user:${typeof process.getuid === "function" ? process.getuid() : "test"}`;
  return {
    version: 2,
    session: "managed-session",
    credentialHandle: "managed-session",
    applicationDid,
    resourceUrl,
    owner: operatorPrincipal,
    sharing: { applicationDids: [applicationDid], operatorPrincipals: [operatorPrincipal] },
    binding: {
      applicationDid,
      resourceUrl,
      issuer: "https://issuer.example",
      clientMode: "dynamic",
      clientId: "synthetic-client",
      clientConfiguration: JSON.stringify({ type: "dynamic" }),
      scopeConfiguration: JSON.stringify({ scopes: ["mcp:tools"], refreshScope: "offline_access" }),
      requestedScopes: ["mcp:tools", "offline_access"],
      redirectUrl: "http://127.0.0.1:49152/oauth/callback",
    },
    clientInformation: { client_id: "synthetic-client" },
    tokens,
    tokensSavedAt,
    refreshJitterMs: 0,
  };
}

afterEach(async () => {
  await Promise.all(startedApps.splice(0).map((app) => app.close()));
});

describe("CLI daemon and testing commands", () => {
  it("keeps hosted-Verifier mode out of the combined local daemon command", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    const result = await runCli([
      "daemon",
      "start",
      "--verifier-coordination-url",
      "https://api.signerset.com",
    ], { stdout, stderr });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("mpas adapter start");
  });

  it("fails closed when coordination authentication is enabled without an audience", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    const result = await runCli(["coordination", "start", "--port", "0", "--auth-enforcement"], {
      stdout,
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("non-empty set of valid canonical audience origins");
  });

  it("adapter status shows loaded configs and listen address", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(["adapter", "status", "--config-dir", join(fixturesDir, "configs")], { stdout, stderr });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(JSON.parse(stdout.text)).toMatchObject({
      listen: {
        address: "127.0.0.1",
        port: 7544,
      },
      loadedConfigs: [
        {
          name: "github-live-demo",
          applicationDid: "did:web:github-live-demo.example",
        },
        {
          name: "github-mirror",
          applicationDid: "did:web:github-mirror.example",
        },
      ],
    });
  });

  it("test dry-run reports satisfied for valid-no-approval-required.json", async () => {
    // Use a single-config dir with auto-approve so create_issue_mirror passes policy
    const tmpDir = await mkdtemp(join(tmpdir(), "mpas-cli-dryrun-"));
    const config = JSON.parse(await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8")) as Record<string, unknown>;
    (config.plugin as Record<string, unknown>).path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    await writeFile(join(tmpDir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = await dryRunActionFile(join(fixturesDir, "core", "valid-no-approval-required.json"), {
      configDir: tmpDir,
      now: FIXTURE_NOW,
    });

    expect(result).toMatchObject({
      result: "satisfied",
      operationName: "create_issue_mirror",
    });
  });

  it("test dry-run reports additional approvals for insufficient-approvals.json", async () => {
    const result = await dryRunActionFile(join(fixturesDir, "core", "insufficient-approvals.json"), {
      configDir: join(fixturesDir, "configs"),
      now: FIXTURE_NOW,
    });

    expect(result).toMatchObject({
      result: "additionalApprovalsRequired",
      policyResult: {
        status: "additionalApprovalsRequired",
      },
    });
  });

  it("daemon starts and responds to health and action submissions", async () => {
    const daemon = await startFixtureDaemon();

    const health = await daemon.app.inject({ method: "GET", url: "/mpas/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok" });

    const actionPackage = JSON.parse(
      await readFile(join(fixturesDir, "core", "valid-no-approval-required.json"), "utf8"),
    ) as unknown;
    const response = await daemon.app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      headers: { "content-type": "application/mpas+json" },
      payload: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "ActionResponse",
      result: "executed",
      executionReceipt: { type: "ExecutionReceipt" },
    });
  });

  it("test submit sends an Action Package to a running daemon", async () => {
    const daemon = await startFixtureDaemon();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    const result = await runCli(
      [
        "test",
        "submit",
        join(fixturesDir, "core", "valid-no-approval-required.json"),
        "--url",
        daemon.address,
      ],
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(JSON.parse(stdout.text)).toMatchObject({
      type: "ActionResponse",
      result: "executed",
      executionReceipt: {
        type: "ExecutionReceipt",
      },
    });
  });

  it.each([
    {
      name: "valid",
      tokens: { access_token: "synthetic", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600 },
      savedAt: (): string => new Date().toISOString(),
      expected: { valid: true, ok: true, state: "authorized" },
    },
    {
      name: "refreshable-expired",
      tokens: { access_token: "synthetic", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 0 },
      savedAt: (): string => "2020-01-01T00:00:00.000Z",
      expected: { valid: true, ok: true, state: "refresh_due" },
    },
    {
      name: "nonrefreshable-expired",
      tokens: { access_token: "synthetic", token_type: "Bearer", expires_in: 0 },
      savedAt: (): string => "2020-01-01T00:00:00.000Z",
      expected: { valid: false, ok: false, state: "reauthorization_required" },
    },
  ])("config validate classifies managed OAuth state $name without static-secret parsing", async ({ tokens, savedAt, expected }) => {
    const { configDir, config } = await managedOAuthConfigDir();
    const oauthCredentialDir = await mkdtemp(join(tmpdir(), "mpas-cli-oauth-session-"));
    await writeFile(
      join(oauthCredentialDir, "managed-session.json"),
      `${JSON.stringify(managedOAuthSession(config, tokens, savedAt()))}\n`,
      { mode: 0o600 },
    );

    const result = await validateConfig("github-mirror", { configDir, credentialDir: oauthCredentialDir });
    expect(result.valid).toBe(expected.valid);
    expect(result.credentials).toEqual([expect.objectContaining({
      provider: "managed-oauth",
      ok: expected.ok,
      state: expected.state,
    })]);
  });

  it.each([
    { name: "missing", contents: undefined, mode: 0o600, error: "OAUTH_SESSION_NOT_FOUND", state: "missing" },
    { name: "malformed", contents: "not-json", mode: 0o600, error: "OAUTH_SESSION_MALFORMED", state: "malformed" },
    { name: "insecure", contents: "valid", mode: 0o644, error: "OAUTH_SESSION_INSECURE_PERMISSIONS", state: "insecure_permissions" },
  ])("config validate rejects $name managed OAuth sessions on the managed path", async ({ contents, mode, error, state }) => {
    const { configDir, config } = await managedOAuthConfigDir();
    const oauthCredentialDir = await mkdtemp(join(tmpdir(), "mpas-cli-oauth-negative-"));
    const path = join(oauthCredentialDir, "managed-session.json");
    if (contents !== undefined) {
      const body = contents === "valid"
        ? JSON.stringify(managedOAuthSession(
            config,
            { access_token: "synthetic", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600 },
            new Date().toISOString(),
          ))
        : contents;
      await writeFile(path, `${body}\n`, { mode });
      await chmod(path, mode);
    }

    const result = await validateConfig("github-mirror", { configDir, credentialDir: oauthCredentialDir });
    expect(result).toMatchObject({
      valid: false,
      credentials: [{ provider: "managed-oauth", ok: false, error, state }],
    });
    expect(result.credentials[0]?.error).not.toBe("CREDENTIAL_INVALID_SHAPE");
  });

  it("preserves the static-secret validation control", async () => {
    const result = await validateConfig("github-mirror", {
      configDir: join(fixturesDir, "configs"),
      credentialDir: await credentialDir(),
    });
    expect(result).toMatchObject({
      valid: true,
      credentials: [{ provider: "file", ok: true }],
    });
  });
});
