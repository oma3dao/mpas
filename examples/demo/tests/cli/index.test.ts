import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../src/adapter/daemon.js";
import { dryRunActionFile, runCli } from "../../src/cli/index.js";

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
  const path = join(dir, "github-test-token.json");
  await writeFile(path, `${JSON.stringify({ value: "ghp_test" })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return dir;
}

async function startFixtureDaemon() {
  // Use only the auto-approve config so that create_issue passes with proposerOnly.
  const tmpDir = await mkdtemp(join(tmpdir(), "mpas-cli-daemon-cfg-"));
  const config = JSON.parse(await readFile(join(fixturesDir, "configs", "github-auto-approve.json"), "utf8")) as Record<string, unknown>;
  (config.plugin as Record<string, unknown>).path = join(fixturesDir, "plugins", "github-demo-plugin.json");
  await writeFile(join(tmpDir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

  const journalDir = await mkdtemp(join(tmpdir(), "mpas-cli-journal-"));
  const daemon = await startDaemon({
    configDir: tmpDir,
    credentialDir: await credentialDir(),
    adapterKeyPath: join(fixturesDir, "test-keys", "adapter.json"),
    port: 0,
    maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER,
    journalPath: join(journalDir, "dispatch-ledger.jsonl"),
    confirmPluginUse: async () => true,
  });
  startedApps.push(daemon.app);
  return daemon;
}

afterEach(async () => {
  await Promise.all(startedApps.splice(0).map((app) => app.close()));
});

describe("CLI daemon and testing commands", () => {
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
          name: "github-auto-approve",
          applicationDid: "did:web:github.example",
        },
        {
          name: "github-strict",
          applicationDid: "did:web:github.example",
        },
      ],
    });
  });

  it("test dry-run reports satisfied for valid-no-approval-required.json", async () => {
    // Use a single-config dir with auto-approve so create_issue passes policy
    const tmpDir = await mkdtemp(join(tmpdir(), "mpas-cli-dryrun-"));
    const config = JSON.parse(await readFile(join(fixturesDir, "configs", "github-auto-approve.json"), "utf8")) as Record<string, unknown>;
    (config.plugin as Record<string, unknown>).path = join(fixturesDir, "plugins", "github-demo-plugin.json");
    await writeFile(join(tmpDir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = await dryRunActionFile(join(fixturesDir, "core", "valid-no-approval-required.json"), {
      configDir: tmpDir,
    });

    expect(result).toMatchObject({
      result: "satisfied",
      operationName: "create_issue",
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
});
