import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  daemonStatus,
  defaultAdapterKeyPath,
  defaultConfigDir,
  defaultCredentialDir,
  defaultJournalPath,
  loadAdapterKey,
  startDaemon,
  type StartedDaemon,
} from "../../src/adapter/daemon.js";
import { DEFAULT_TRUST_CONTEXT } from "../../src/adapter/trust.js";
import * as configLoader from "../../src/adapter/config-loader.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const daemons: StartedDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.app.close()));
});

describe("adapter daemon helpers", () => {
  it("exposes default path helpers from env or home layout", () => {
    expect(defaultConfigDir()).toMatch(/\.mpas[/\\]config$/);
    expect(defaultCredentialDir()).toMatch(/\.mpas[/\\]credentials$/);
    expect(defaultAdapterKeyPath()).toMatch(/\.mpas[/\\]keys[/\\]adapter\.json$/);
    expect(defaultJournalPath()).toMatch(/\.mpas[/\\]journal[/\\]dispatch-ledger\.jsonl$/);
  });

  it("loads a valid adapter key file", async () => {
    const key = await loadAdapterKey(join(fixturesDir, "test-keys", "adapter.json"));
    expect(key.did).toMatch(/^did:jwk:/);
    expect(key.privateJwk.d).toBeDefined();
  });

  it("rejects an incomplete adapter key file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-adapter-key-"));
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify({ did: "did:jwk:abc" }));
    await expect(loadAdapterKey(path)).rejects.toThrow(/Adapter key file is invalid/);
  });

  it("daemonStatus reports listen defaults and loaded configs", async () => {
    const status = await daemonStatus({
      configDir: join(fixturesDir, "configs"),
      host: "0.0.0.0",
      port: 9001,
    });

    expect(status).toMatchObject({
      listen: { address: "0.0.0.0", port: 9001 },
      configDir: join(fixturesDir, "configs"),
    });
    expect(status.loadedConfigs.length).toBeGreaterThan(0);
    expect(status.loadedConfigs[0]).toMatchObject({
      name: expect.any(String),
      applicationDid: expect.stringMatching(/^did:/),
      pluginDid: expect.any(String),
    });
  });

  it("starts with an optional trace path and custom listen port", async () => {
    const journalDir = await mkdtemp(join(tmpdir(), "mpas-daemon-journal-"));
    const traceDir = await mkdtemp(join(tmpdir(), "mpas-daemon-trace-"));
    const daemon = await startDaemon({
      configDir: join(fixturesDir, "configs"),
      adapterKeyPath: join(fixturesDir, "test-keys", "adapter.json"),
      credentialDir: await mkdtemp(join(tmpdir(), "mpas-daemon-creds-")),
      journalPath: join(journalDir, "dispatch-ledger.jsonl"),
      tracePath: join(traceDir, "adapter.ndjson"),
      port: 0,
      trustContext: null,
      confirmPluginUse: async () => true,
    });
    daemons.push(daemon);

    const health = await fetch(`${daemon.address}/mpas/v1/health`);
    expect(health.status).toBe(200);
    expect(daemon.loadedConfigs.length).toBeGreaterThan(0);
  });

  it("uses DEFAULT_TRUST_CONTEXT when trustContext is omitted and surfaces load failures", async () => {
    const spy = vi.spyOn(configLoader, "loadDeploymentConfigs").mockResolvedValue({
      ok: false,
      error: { code: "CONFIG_DIR_READ_FAILED", message: "boom-load", configDir: "x" },
    } as never);

    try {
      await expect(
        startDaemon({
          adapterKeyPath: join(fixturesDir, "test-keys", "adapter.json"),
          credentialDir: await mkdtemp(join(tmpdir(), "mpas-daemon-creds-")),
          journalPath: join(await mkdtemp(join(tmpdir(), "mpas-daemon-journal-")), "ledger.jsonl"),
          port: 0,
          confirmPluginUse: async () => true,
        }),
      ).rejects.toThrow("boom-load");
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ trustContext: DEFAULT_TRUST_CONTEXT }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("daemonStatus throws when configs fail to load", async () => {
    await expect(daemonStatus({ configDir: join(tmpdir(), `mpas-missing-cfg-${Date.now()}`) })).rejects.toThrow(
      /Unable to read config directory|CONFIG/,
    );
  });
});
