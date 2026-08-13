import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon } from "../../src/adapter/daemon.js";
import { dryRunActionFile, runCli } from "../../src/cli/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const startedApps: FastifyInstance[] = [];
const unixModesSupported = process.platform !== "win32";

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

  const journalDir = await mkdtemp(join(tmpdir(), "mpas-cli-journal-"));
  const daemon = await startDaemon({
    configDir: tmpDir,
    credentialDir: await credentialDir(),
    adapterKeyPath: join(fixturesDir, "test-keys", "adapter.json"),
    port: 0,
    maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER,
    journalPath: join(journalDir, "dispatch-ledger.jsonl"),
    trustContext: null,
    confirmPluginUse: async () => true,
  });
  startedApps.push(daemon.app);
  return daemon;
}

afterEach(async () => {
  await Promise.all(startedApps.splice(0).map((app) => app.close()));
});

describe("CLI daemon and testing commands", () => {
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

  it("daemon status shows loaded configs and listen address", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(["daemon", "status", "--config-dir", join(fixturesDir, "configs")], { stdout, stderr });

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
    });

    expect(result).toMatchObject({
      result: "satisfied",
      operationName: "create_issue_mirror",
    });
  });

  it("test dry-run reports additional approvals for insufficient-approvals.json", async () => {
    const result = await dryRunActionFile(join(fixturesDir, "core", "insufficient-approvals.json"), {
      configDir: join(fixturesDir, "configs"),
    });

    expect(result).toMatchObject({
      result: "additionalApprovalsRequired",
      policyResult: {
        status: "additionalApprovalsRequired",
      },
    });
  });

  it.skipIf(!unixModesSupported)("daemon starts and responds to health and action submissions", async () => {
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

  it.skipIf(!unixModesSupported)("test submit sends an Action Package to a running daemon", async () => {
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

  it("trace inspect routes through runCli", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-cli-trace-"));
    const path = join(dir, "trace.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        timestamp: "2026-08-05T12:00:00.000Z",
        service: "adapter",
        type: "incoming_action",
        actionId: "act-cli",
        did: "did:jwk:proposer",
      })}\n`,
    );

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(["trace", "inspect", path], { stdout, stderr });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(stdout.text).toContain("Total events: 1");
    expect(stdout.text).toContain("receives ActionPackage from did:jwk:proposer");
  });

  it("key generate writes a key file", async () => {
    const keyDir = await mkdtemp(join(tmpdir(), "mpas-cli-keys-"));
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(["key", "generate", "agent", "--key-dir", keyDir], { stdout, stderr });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("");
    const written = JSON.parse(await readFile(join(keyDir, "agent.json"), "utf8")) as {
      did: string;
      privateJwk: { d?: string };
      publicJwk: { d?: string };
    };
    expect(written.did).toMatch(/^did:jwk:/);
    expect(written.privateJwk.d).toBeDefined();
    expect(written.publicJwk.d).toBeUndefined();
    expect(JSON.parse(stdout.text)).toMatchObject({ did: written.did, path: join(keyDir, "agent.json") });
  });

  it("unknown command prints usage and exits 1", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(["not-a-command"], { stdout, stderr });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("Usage:");
    expect(stderr.text).toContain("mpas trace inspect");
  });

  it("test dry-run rejects invalid-unknown-application.json", async () => {
    await expect(
      dryRunActionFile(join(fixturesDir, "core", "invalid-unknown-application.json"), {
        configDir: join(fixturesDir, "configs"),
      }),
    ).resolves.toMatchObject({
      result: "rejected",
      error: { code: "UNKNOWN_APPLICATION" },
    });
  });

  it("test dry-run reports malformed for missing envelope", async () => {
    await expect(
      dryRunActionFile(join(fixturesDir, "core", "malformed-missing-envelope.json"), {
        configDir: join(fixturesDir, "configs"),
      }),
    ).resolves.toMatchObject({
      result: "malformed",
    });
  });

  it("plugin install and list work through runCli", async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), "mpas-cli-plugins-"));
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    const install = await runCli(
      ["plugin", "install", join(fixturesDir, "plugins", "github-mirror-plugin.json"), "--plugin-dir", pluginDir],
      { stdout, stderr },
    );
    expect(install.exitCode).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      installed: true,
      pluginDid: "did:web:plugins.oma3.example:github-mirror-plugin",
    });

    stdout.text = "";
    const list = await runCli(["plugin", "list", "--plugin-dir", pluginDir], { stdout, stderr });
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      plugins: [{ file: "github-mirror-plugin.json" }],
    });
  });

  it("credential list works through runCli", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-cli-credentials-"));
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    await runCli(
      ["credential", "set", "token", "--credential-dir", credentialDir, "--value", "secret"],
      { stdout, stderr },
    );
    stdout.text = "";

    const list = await runCli(["credential", "list", "--credential-dir", credentialDir], { stdout, stderr });
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(stdout.text)).toEqual({ credentials: ["token"] });
  });

  it("test dry-run rejects a bad signature", async () => {
    await expect(
      dryRunActionFile(join(fixturesDir, "core", "invalid-bad-signature.json"), {
        configDir: join(fixturesDir, "configs"),
      }),
    ).resolves.toMatchObject({
      result: "rejected",
      error: { code: "APPROVAL_BUNDLE_INVALID" },
    });
  });

  it("config validate routes through runCli", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(
      ["config", "validate", "github-mirror", "--config-dir", join(fixturesDir, "configs")],
      { stdout, stderr },
    );

    // On Windows credential files cannot be chmod 600, so validation may be invalid;
    // still exercise the CLI formatting path.
    expect([0, 1]).toContain(result.exitCode);
    expect(stdout.text.length + stderr.text.length).toBeGreaterThan(0);
  });

  it("runCli surfaces thrown errors on stderr", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(
      ["test", "dry-run", join(fixturesDir, "core", "valid-no-approval-required.json"), "--config-dir", join(fixturesDir, "does-not-exist")],
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(1);
    expect(stderr.text.length).toBeGreaterThan(0);
  });

  it("coordination start routes through runCli", async () => {
    const coordinationDaemon = await import("../../src/coordination/daemon.js");
    const started: Awaited<ReturnType<typeof coordinationDaemon.startCoordinationDaemon>>[] = [];
    const original = coordinationDaemon.startCoordinationDaemon.bind(coordinationDaemon);
    const spy = vi.spyOn(coordinationDaemon, "startCoordinationDaemon").mockImplementation(async (options) => {
      const daemon = await original(options);
      started.push(daemon);
      return daemon;
    });

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    try {
      const result = await runCli(["coordination", "start", "--host", "127.0.0.1", "--port", "0"], {
        stdout,
        stderr,
      });
      expect(result.exitCode).toBe(0);
      expect(stderr.text).toBe("");
      expect(JSON.parse(stdout.text)).toMatchObject({ status: "started" });
      expect(started).toHaveLength(1);
    } finally {
      spy.mockRestore();
      await Promise.all(started.map((daemon) => daemon.app.close()));
    }
  });

  it("starts coordination with RFC 9421 audience and freshness flags", async () => {
    const coordinationDaemon = await import("../../src/coordination/daemon.js");
    const started: Awaited<ReturnType<typeof coordinationDaemon.startCoordinationDaemon>>[] = [];
    const original = coordinationDaemon.startCoordinationDaemon.bind(coordinationDaemon);
    const spy = vi.spyOn(coordinationDaemon, "startCoordinationDaemon").mockImplementation(async (options) => {
      const daemon = await original(options);
      started.push(daemon);
      return daemon;
    });

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    try {
      const result = await runCli([
        "coordination", "start",
        "--host", "127.0.0.1",
        "--port", "0",
        "--auth-enforcement",
        "--auth-audience", "https://coordination.example.com",
        "--auth-clock-skew-seconds", "15",
        "--auth-signature-lifetime-seconds", "30",
      ], { stdout, stderr });
      expect(result.exitCode).toBe(0);
      expect(stderr.text).toBe("");
      expect(JSON.parse(stdout.text)).toMatchObject({ status: "started" });
      expect(started[0]).toBeDefined();

      const poll = await fetch(`${JSON.parse(stdout.text).address}/mpas/v1/coordination/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "1", type: "CoordinationPollRequest", did: "did:web:x" }),
      });
      expect(poll.status).toBe(401);
    } finally {
      spy.mockRestore();
      await Promise.all(started.map((daemon) => daemon.app.close()));
    }
  });

  it("daemon status accepts --host and --port overrides", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(
      ["daemon", "status", "--config-dir", join(fixturesDir, "configs"), "--host", "0.0.0.0", "--port", "9000"],
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      listen: { address: "0.0.0.0", port: 9000 },
    });
  });

  it("test submit posts an Action Package to a mock adapter URL", async () => {
    const http = await import("node:http");
    const actionPackage = JSON.parse(
      await readFile(join(fixturesDir, "core", "valid-no-approval-required.json"), "utf8"),
    );
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "1", type: "ActionResponse", result: "executed" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}`;

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    try {
      const result = await runCli(
        ["test", "submit", join(fixturesDir, "core", "valid-no-approval-required.json"), "--url", url],
        { stdout, stderr },
      );
      expect(result.exitCode).toBe(0);
      expect(stderr.text).toBe("");
      expect(JSON.parse(stdout.text)).toMatchObject({ type: "ActionResponse", result: "executed" });
      expect(actionPackage).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("signer-server start routes through runCli", async () => {
    const signer = await import("../../src/signer-server/index.js");
    const spy = vi.spyOn(signer, "runSignerServer").mockResolvedValue(undefined);
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    try {
      const result = await runCli(["signer-server", "start", "--config", "cfg.json"], { stdout, stderr });
      expect(result.exitCode).toBe(0);
      expect(spy).toHaveBeenCalledWith(["--config", "cfg.json"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("daemon start routes through runCli with mocked daemons", async () => {
    const adapterDaemon = await import("../../src/adapter/daemon.js");
    const coordinationDaemon = await import("../../src/coordination/daemon.js");
    const close = vi.fn(async () => undefined);
    const startDaemonSpy = vi.spyOn(adapterDaemon, "startDaemon").mockResolvedValue({
      app: { close } as never,
      address: "http://127.0.0.1:7544",
      loadedConfigs: [{ config: { name: "x" } } as never],
    });
    const startCoordSpy = vi.spyOn(coordinationDaemon, "startCoordinationDaemon").mockResolvedValue({
      app: { close } as never,
      address: "http://127.0.0.1:7545",
    });

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    try {
      const result = await runCli(
        [
          "daemon",
          "start",
          "--config-dir",
          join(fixturesDir, "configs"),
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--coordination-port",
          "0",
          "--journal-path",
          join(tmpdir(), "journal.jsonl"),
          "--trace-path",
          join(tmpdir(), "trace.jsonl"),
        ],
        { stdout, stderr },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({
        status: "started",
        address: "http://127.0.0.1:7544",
        coordinationAddress: "http://127.0.0.1:7545",
        loadedConfigs: 1,
      });
      expect(startDaemonSpy).toHaveBeenCalled();
      expect(startCoordSpy).toHaveBeenCalled();
    } finally {
      startDaemonSpy.mockRestore();
      startCoordSpy.mockRestore();
    }
  });

  it("test dry-run routes through runCli and reports pass-through", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-cli-dry-pass-"));
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as Record<string, unknown>;
    (config.plugin as Record<string, unknown>).path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(
      ["test", "dry-run", join(fixturesDir, "core", "valid-no-approval-required.json"), "--config-dir", dir],
      { stdout, stderr },
    );

    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      result: "satisfied",
      path: "pass-through",
      operationName: "create_issue_mirror",
    });
  });

  it("credential set reads the secret from stdin when --value is omitted", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-cli-stdin-cred-"));
    const previous = process.stdin;
    const chunks = [Buffer.from("stdin-secret\n")];
    const fakeStdin = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
    Object.defineProperty(process, "stdin", { configurable: true, value: fakeStdin });

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    try {
      const result = await runCli(["credential", "set", "from-stdin", "--credential-dir", credentialDir], {
        stdout,
        stderr,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({ stored: true, handle: "from-stdin" });
      const stored = JSON.parse(await readFile(join(credentialDir, "from-stdin.json"), "utf8")) as { value: string };
      expect(stored.value).toBe("stdin-secret");
    } finally {
      Object.defineProperty(process, "stdin", { configurable: true, value: previous });
    }
  });

  it("daemon start closes the adapter when coordination fails to start", async () => {
    const adapterDaemon = await import("../../src/adapter/daemon.js");
    const coordinationDaemon = await import("../../src/coordination/daemon.js");
    const close = vi.fn(async () => undefined);
    const startDaemonSpy = vi.spyOn(adapterDaemon, "startDaemon").mockResolvedValue({
      app: { close } as never,
      address: "http://127.0.0.1:7544",
      loadedConfigs: [],
    });
    const startCoordSpy = vi
      .spyOn(coordinationDaemon, "startCoordinationDaemon")
      .mockRejectedValue(new Error("coord down"));

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    try {
      const result = await runCli(["daemon", "start", "--host", "127.0.0.1", "--port", "0"], {
        stdout,
        stderr,
      });
      expect(result.exitCode).toBe(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(stderr.text).toContain("coord down");
      expect(stdout.text).toBe("");
    } finally {
      startDaemonSpy.mockRestore();
      startCoordSpy.mockRestore();
    }
  });

  it("test dry-run reports satisfied for a governed plugin operation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-cli-dry-gov-"));
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as Record<string, unknown>;
    (config.plugin as Record<string, unknown>).path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = await dryRunActionFile(join(fixturesDir, "core", "valid-delete-branch.json"), {
      configDir: dir,
    });
    expect(result).toMatchObject({
      result: "satisfied",
      operationName: "delete_branch_mirror",
    });
    expect(result).not.toHaveProperty("path");
  });

  it("test dry-run rejects when an unknown plugin op is listed in policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-cli-dry-in-pol-"));
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as {
      plugin: Record<string, unknown>;
      policy: { policies: Record<string, unknown[]> };
    };
    config.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    config.policy.policies.create_issue_mirror = [{ requirements: { type: "proposerOnly" } }];
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = await dryRunActionFile(join(fixturesDir, "core", "valid-no-approval-required.json"), {
      configDir: dir,
    });
    expect(result).toMatchObject({
      result: "rejected",
      error: { code: "UNKNOWN_OPERATION" },
    });
  });

  it("test dry-run reports rejected when policy blocks the operation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-cli-dry-deny-"));
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as {
      plugin: Record<string, unknown>;
      policy: { policies: Record<string, unknown[]> };
    };
    config.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    config.policy.policies.delete_branch_mirror = [{ reject: true }];
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = await dryRunActionFile(join(fixturesDir, "core", "valid-delete-branch.json"), {
      configDir: dir,
    });
    expect(result).toMatchObject({
      result: "rejected",
      policyResult: { status: "rejected", code: "ACTION_BLOCKED_BY_POLICY" },
    });
  });

  it("config validate formats a singular credential failure", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-cli-one-cred-miss-"));
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(
      [
        "config",
        "validate",
        "github-mirror",
        "--config-dir",
        join(fixturesDir, "configs"),
        "--credential-dir",
        credentialDir,
      ],
      { stdout, stderr },
    );
    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("Validation failed: 1 error.");
  });

  it("listCredentials returns empty for a missing directory", async () => {
    const { listCredentials } = await import("../../src/cli/index.js");
    await expect(listCredentials(join(tmpdir(), `mpas-missing-creds-${Date.now()}`))).resolves.toEqual({
      credentials: [],
    });
  });

  it("config validate skips a missing bridge-dir without failing", async () => {
    const { validateConfig } = await import("../../src/cli/index.js");
    const dir = await mkdtemp(join(tmpdir(), "mpas-cli-bridge-skip-"));
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as {
      plugin: Record<string, unknown>;
      credentialBindings: Array<{ provider: string; credentialHandle: string }>;
    };
    config.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    config.credentialBindings = [{ provider: "macos-keychain", credentialHandle: "github-mirror-token" }];
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = await validateConfig("github-auto-approve", {
      configDir: dir,
      bridgeDir: join(tmpdir(), `mpas-missing-bridges-${Date.now()}`),
    });
    expect(result.valid).toBe(true);
    expect(result.bridgeConfigs ?? []).toEqual([]);
  });

  it("config validate formats bridge ✓ and ✗ lines through runCli", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-cli-bridge-fmt-"));
    const bridgeDir = await mkdtemp(join(tmpdir(), "mpas-cli-bridge-fmt-bridges-"));
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as {
      plugin: Record<string, unknown>;
      credentialBindings: Array<{ provider: string; credentialHandle: string }>;
      signerKeys: Array<{ did: string }>;
      target: { applicationDid: string };
    };
    config.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    config.credentialBindings = [{ provider: "macos-keychain", credentialHandle: "github-mirror-token" }];
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const toolsPath = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    await writeFile(
      join(bridgeDir, "good.json"),
      `${JSON.stringify({
        mode: "proposer",
        agent: { did: config.signerKeys[0].did, keyFile: "x" },
        target: { applicationDid: config.target.applicationDid },
        tools: toolsPath,
      })}\n`,
    );
    await writeFile(
      join(bridgeDir, "bad-tools.json"),
      `${JSON.stringify({
        mode: "proposer",
        agent: { did: config.signerKeys[0].did, keyFile: "x" },
        target: { applicationDid: config.target.applicationDid },
        tools: "missing-tools.json",
      })}\n`,
    );

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(
      ["config", "validate", "github-auto-approve", "--config-dir", dir, "--bridge-dir", bridgeDir],
      { stdout, stderr },
    );
    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("✓ good.json");
    expect(stdout.text).toContain("✗ bad-tools.json");
    expect(stdout.text).toContain("tools file not found");
  });

  it("daemon start forwards --adapter-key and --trace to startDaemon", async () => {
    const adapterDaemon = await import("../../src/adapter/daemon.js");
    const coordinationDaemon = await import("../../src/coordination/daemon.js");
    const close = vi.fn(async () => undefined);
    const adapterKey = join(fixturesDir, "test-keys", "adapter.json");
    const tracePath = join(tmpdir(), `mpas-cli-trace-${Date.now()}.jsonl`);
    const startDaemonSpy = vi.spyOn(adapterDaemon, "startDaemon").mockResolvedValue({
      app: { close } as never,
      address: "http://127.0.0.1:7544",
      loadedConfigs: [{ config: { name: "x" } } as never],
    });
    const startCoordSpy = vi.spyOn(coordinationDaemon, "startCoordinationDaemon").mockResolvedValue({
      app: { close } as never,
      address: "http://127.0.0.1:7545",
    });

    try {
      const result = await runCli(
        [
          "daemon",
          "start",
          "--config-dir",
          join(fixturesDir, "configs"),
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--coordination-port",
          "0",
          "--adapter-key",
          adapterKey,
          "--trace",
          tracePath,
        ],
        { stdout: new MemoryWriter(), stderr: new MemoryWriter() },
      );
      expect(result.exitCode).toBe(0);
      expect(startDaemonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterKeyPath: adapterKey,
          tracePath,
        }),
      );
    } finally {
      startDaemonSpy.mockRestore();
      startCoordSpy.mockRestore();
    }
  });

  it("plugin list and key generate use default dirs when flags are omitted", async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), "mpas-cli-default-plugins-"));
    const keyDir = await mkdtemp(join(tmpdir(), "mpas-cli-default-keys-"));
    const previousPlugin = process.env.MPAS_PLUGIN_DIR;
    const previousKey = process.env.MPAS_KEY_DIR;
    process.env.MPAS_PLUGIN_DIR = pluginDir;
    process.env.MPAS_KEY_DIR = keyDir;

    try {
      const list = await runCli(["plugin", "list"], { stdout: new MemoryWriter(), stderr: new MemoryWriter() });
      expect(list.exitCode).toBe(0);

      const generate = await runCli(["key", "generate", "agent"], {
        stdout: new MemoryWriter(),
        stderr: new MemoryWriter(),
      });
      expect(generate.exitCode).toBe(0);
      await expect(readFile(join(keyDir, "agent.json"), "utf8")).resolves.toContain("privateJwk");
    } finally {
      if (previousPlugin === undefined) delete process.env.MPAS_PLUGIN_DIR;
      else process.env.MPAS_PLUGIN_DIR = previousPlugin;
      if (previousKey === undefined) delete process.env.MPAS_KEY_DIR;
      else process.env.MPAS_KEY_DIR = previousKey;
    }
  });
});
