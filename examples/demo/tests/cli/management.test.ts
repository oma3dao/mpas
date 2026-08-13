import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configLoader from "../../src/adapter/config-loader.js";
import { installPlugin, listCredentials, listPlugins, runCli, setCredential, validateConfig } from "../../src/cli/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const unixModesSupported = process.platform !== "win32";

class MemoryWriter {
  text = "";

  write(chunk: string | Uint8Array): boolean {
    this.text += chunk.toString();
    return true;
  }
}

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("CLI management commands", () => {
  it("installs and lists plugins", async () => {
    const pluginDir = await tempDir("mpas-cli-plugins-");
    const install = await installPlugin(join(fixturesDir, "plugins", "github-mirror-plugin.json"), pluginDir);
    const list = await listPlugins(pluginDir);

    expect(install).toMatchObject({
      installed: true,
      pluginDid: "did:web:plugins.oma3.example:github-mirror-plugin",
    });
    expect(list).toMatchObject({
      plugins: [
        {
          file: "github-mirror-plugin.json",
          pluginDid: "did:web:plugins.oma3.example:github-mirror-plugin",
        },
      ],
    });
  });

  it("sets and lists credentials without exposing values", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");

    await expect(setCredential("github-mirror-token", "ghp_test", credentialDir)).resolves.toMatchObject({
      stored: true,
      handle: "github-mirror-token",
    });
    await expect(listCredentials(credentialDir)).resolves.toEqual({
      credentials: ["github-mirror-token"],
    });
  });

  it.skipIf(!unixModesSupported)("validates a config including file credential handles", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    await setCredential("github-mirror-token", "ghp_test", credentialDir);

    await expect(
      validateConfig("github-mirror", {
        configDir: join(fixturesDir, "configs"),
        credentialDir,
      }),
    ).resolves.toMatchObject({
      valid: true,
      name: "github-mirror",
      pluginDid: "did:web:plugins.oma3.example:github-mirror-plugin",
      credentials: [
        {
          handle: "github-mirror-token",
          ok: true,
        },
      ],
    });
  });

  it.skipIf(!unixModesSupported)("warns when bridge configs use different DIDs (potential Sybil footgun)", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    await setCredential("github-mirror-token", "ghp_test", credentialDir);
    const bridgeDir = await tempDir("mpas-cli-bridges-");

    // Create two bridge configs with different DIDs from signerKeys
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(bridgeDir, "proposer.json"),
      JSON.stringify({ mode: "proposer", agent: { did: "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Ims2TzdjaVFrbXBodUVFdDFpM3lBaW1KSldlR0ttT3EzdF9mc05renphNm8ifQ", keyFile: "x" } }),
    );
    await writeFile(
      join(bridgeDir, "signer.json"),
      JSON.stringify({ mode: "signer", agent: { did: "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6IjhzRFY3NmI4aUY3NlBJbUF3NUk5V3ZlanNfOGJTOE4xMld2SHpQYTVWdzgifQ", keyFile: "x" } }),
    );

    const result = await validateConfig("github-mirror", {
      configDir: join(fixturesDir, "configs"),
      credentialDir,
      bridgeDir,
    });

    // Validation passes (warning, not error)
    expect(result.valid).toBe(true);
    // Both bridge configs are ok (no hard failure)
    expect(result.bridgeConfigs).toHaveLength(2);
    expect(result.bridgeConfigs!.every((b) => b.ok)).toBe(true);
    // But both have warning messages about different DIDs
    expect(result.bridgeConfigs!.every((b) => b.error?.includes("different DID"))).toBe(true);
  });

  it("warns when bridge configs use different DIDs without requiring file credentials", async () => {
    const dir = await tempDir("mpas-cli-sybil-win-");
    const bridgeDir = await tempDir("mpas-cli-sybil-bridges-");
    const { writeFile } = await import("node:fs/promises");
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as {
      plugin: Record<string, unknown>;
      credentialBindings: Array<{ provider: string; credentialHandle: string }>;
      signerKeys: Array<{ did: string }>;
    };
    config.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    config.credentialBindings = [{ provider: "macos-keychain", credentialHandle: "github-mirror-token" }];
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      join(bridgeDir, "proposer.json"),
      JSON.stringify({ mode: "proposer", agent: { did: config.signerKeys[0].did, keyFile: "x" } }),
    );
    await writeFile(
      join(bridgeDir, "signer.json"),
      JSON.stringify({ mode: "signer", agent: { did: config.signerKeys[1].did, keyFile: "x" } }),
    );

    const result = await validateConfig("github-auto-approve", { configDir: dir, bridgeDir });
    expect(result.valid).toBe(true);
    expect(result.bridgeConfigs).toHaveLength(2);
    expect(result.bridgeConfigs!.every((b) => b.ok)).toBe(true);
    expect(result.bridgeConfigs!.every((b) => b.error?.includes("different DID"))).toBe(true);

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const cli = await runCli(
      ["config", "validate", "github-auto-approve", "--config-dir", dir, "--bridge-dir", bridgeDir],
      { stdout, stderr },
    );
    expect(cli.exitCode).toBe(0);
    expect(stdout.text).toContain("Bridge Configs:");
    expect(stdout.text).toContain("⚠");
    expect(stdout.text).toContain("Validation passed");
  });

  it("bridge config validation fails for DID not in signerKeys", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    await setCredential("github-mirror-token", "ghp_test", credentialDir);
    const bridgeDir = await tempDir("mpas-cli-bridges-");

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(bridgeDir, "unknown.json"),
      JSON.stringify({ mode: "proposer", agent: { did: "did:web:agents.example:unknowndid", keyFile: "x" } }),
    );

    const result = await validateConfig("github-mirror", {
      configDir: join(fixturesDir, "configs"),
      credentialDir,
      bridgeDir,
    });

    expect(result.valid).toBe(false);
    expect(result.bridgeConfigs![0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("not in signerKeys"),
    });
  });

  it("bridge config validation fails when it targets an application no config serves", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    await setCredential("github-mirror-token", "ghp_test", credentialDir);
    const bridgeDir = await tempDir("mpas-cli-bridges-");
    const { writeFile } = await import("node:fs/promises");

    // A valid signer DID, but proposing to an application the adapter does not
    // serve — at runtime this would surface as UNKNOWN_APPLICATION.
    const proposer = JSON.parse(
      await readFile(join(fixturesDir, "test-keys", "proposer.json"), "utf8"),
    ) as { did: string };
    await writeFile(
      join(bridgeDir, "wrong-app.json"),
      JSON.stringify({
        mode: "proposer",
        agent: { did: proposer.did, keyFile: "x" },
        target: { applicationDid: "did:web:not-served.example" },
      }),
    );

    const result = await validateConfig("github-mirror", {
      configDir: join(fixturesDir, "configs"),
      credentialDir,
      bridgeDir,
    });

    expect(result.valid).toBe(false);
    expect(result.bridgeConfigs![0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("is not served by any deployment config"),
    });
  });

  it("bridge config validation fails when its tools file is missing", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    await setCredential("github-mirror-token", "ghp_test", credentialDir);
    const bridgeDir = await tempDir("mpas-cli-bridges-");
    const { writeFile } = await import("node:fs/promises");

    const proposer = JSON.parse(
      await readFile(join(fixturesDir, "test-keys", "proposer.json"), "utf8"),
    ) as { did: string };
    await writeFile(
      join(bridgeDir, "bad-tools.json"),
      JSON.stringify({
        mode: "proposer",
        agent: { did: proposer.did, keyFile: "x" },
        target: { applicationDid: "did:web:github-mirror.example" },
        tools: "./no-such-tools.json",
      }),
    );

    const result = await validateConfig("github-mirror", {
      configDir: join(fixturesDir, "configs"),
      credentialDir,
      bridgeDir,
    });

    expect(result.valid).toBe(false);
    expect(result.bridgeConfigs![0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("tools file not found"),
    });
  });

  it("runs management commands through runCli", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    const result = await runCli(
      ["credential", "set", "github-mirror-token", "--credential-dir", credentialDir, "--value", "ghp_test"],
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(JSON.parse(stdout.text)).toMatchObject({
      stored: true,
      handle: "github-mirror-token",
    });
  });

  it("validateConfig rejects unknown config names", async () => {
    await expect(
      validateConfig("no-such-config", { configDir: join(fixturesDir, "configs") }),
    ).rejects.toThrow(/Config not found/);
  });

  it("validateConfig rejects configs whose did:jwk publicJwk does not match the DID", async () => {
    const dir = await tempDir("mpas-cli-bad-signer-");
    const { writeFile } = await import("node:fs/promises");
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as {
      name: string;
      plugin: Record<string, unknown>;
      signerKeys: Array<{ did: string; publicJwk?: { x?: string; crv?: string; kty?: string } }>;
    };
    config.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    const proposer = config.signerKeys[0];
    proposer.publicJwk = { ...proposer.publicJwk, x: "tamperedxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" };
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    // Loader rejects mismatched publicJwk before validateConfig's soft signer checks run.
    await expect(validateConfig("github-auto-approve", { configDir: dir })).rejects.toThrow(
      /publicJwk does not match the key embedded in did:jwk/,
    );
  });

  it("validateConfig treats non-file credential providers as ok without reading secrets", async () => {
    const dir = await tempDir("mpas-cli-keychain-provider-");
    const { writeFile } = await import("node:fs/promises");
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as {
      name: string;
      plugin: Record<string, unknown>;
      credentialBindings: Array<{ provider: string; credentialHandle: string }>;
    };
    config.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    config.credentialBindings = [{ provider: "macos-keychain", credentialHandle: "github-mirror-token" }];
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);

    const result = await validateConfig("github-auto-approve", { configDir: dir });
    expect(result.credentials).toEqual([
      { handle: "github-mirror-token", provider: "macos-keychain", ok: true },
    ]);
    expect(result.signerKeys.every((signer) => signer.ok)).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("listPlugins returns empty for a missing directory and records bad plugin files", async () => {
    const missing = join(tmpdir(), `mpas-missing-plugins-${Date.now()}`);
    await expect(listPlugins(missing)).resolves.toEqual({ plugins: [] });

    const pluginDir = await tempDir("mpas-cli-bad-plugins-");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(pluginDir, "junk.json"), `${JSON.stringify({ not: "a plugin" })}\n`);
    const list = await listPlugins(pluginDir);
    expect(list.plugins).toEqual([
      expect.objectContaining({
        file: "junk.json",
        error: expect.any(String),
      }),
    ]);
  });

  it("plugin install fails through runCli for a malformed plugin", async () => {
    const pluginDir = await tempDir("mpas-cli-install-fail-");
    const { writeFile } = await import("node:fs/promises");
    const badPath = join(pluginDir, "bad-plugin.json");
    await writeFile(badPath, `${JSON.stringify({ version: "1" })}\n`);

    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(["plugin", "install", badPath, "--plugin-dir", pluginDir], { stdout, stderr });
    expect(result.exitCode).toBe(1);
    expect(stderr.text.length).toBeGreaterThan(0);
    expect(stdout.text).toBe("");
  });

  it("validateConfig reports missing agent.did and unreadable bridge JSON", async () => {
    const dir = await tempDir("mpas-cli-bridge-soft-");
    const bridgeDir = await tempDir("mpas-cli-bridge-files-");
    const { writeFile } = await import("node:fs/promises");
    const config = JSON.parse(
      await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
    ) as {
      plugin: Record<string, unknown>;
      credentialBindings: Array<{ provider: string; credentialHandle: string }>;
    };
    config.plugin.path = join(fixturesDir, "plugins", "github-mirror-plugin.json");
    config.credentialBindings = [{ provider: "macos-keychain", credentialHandle: "github-mirror-token" }];
    await writeFile(join(dir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(join(bridgeDir, "no-agent.json"), `${JSON.stringify({ mode: "proposer" })}\n`);
    await writeFile(join(bridgeDir, "broken.json"), "{ not-json");

    const result = await validateConfig("github-auto-approve", { configDir: dir, bridgeDir });
    expect(result.valid).toBe(false);
    expect(result.bridgeConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "no-agent.json", ok: false, error: expect.stringContaining("agent.did") }),
        expect.objectContaining({ file: "broken.json", ok: false, error: expect.stringContaining("Failed to read") }),
      ]),
    );
  });

  it("validateConfig soft-checks signer keys when the loader returns them", async () => {
    const proposer = JSON.parse(
      await readFile(join(fixturesDir, "test-keys", "proposer.json"), "utf8"),
    ) as { did: string; publicJwk: { x: string; crv: string; kty: string } };

    const loaded = {
      filePath: "soft-check.json",
      config: {
        name: "soft-check",
        target: { applicationDid: "did:web:github-mirror.example" },
        credentialBindings: [{ provider: "macos-keychain", credentialHandle: "tok" }],
        signerKeys: [
          {
            did: proposer.did,
            label: "mismatch",
            publicJwk: { ...proposer.publicJwk, x: "tamperedxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
          },
          { did: "did:web:agents.example:signer", label: "missing-jwk" },
          { did: "did:jwk:!!!", label: "bad-jwk" },
        ],
      },
      plugin: { pluginDid: "did:web:plugins.example:soft" },
    };

    const spy = vi.spyOn(configLoader, "loadDeploymentConfigs").mockResolvedValue({
      ok: true,
      configs: [loaded as never],
      configsByApplicationDid: new Map(),
    });

    try {
      const result = await validateConfig("soft-check", { configDir: join(fixturesDir, "configs") });
      expect(result.valid).toBe(false);
      expect(result.signerKeys).toEqual([
        expect.objectContaining({
          label: "mismatch",
          ok: false,
          error: expect.stringContaining("publicJwk does not match"),
        }),
        expect.objectContaining({
          label: "missing-jwk",
          ok: false,
          error: expect.stringContaining("publicJwk is required"),
        }),
        expect.objectContaining({
          label: "bad-jwk",
          ok: false,
          error: expect.stringContaining("Invalid did:jwk"),
        }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
