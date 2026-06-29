import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installPlugin, listCredentials, listPlugins, runCli, setCredential, validateConfig } from "../../src/cli/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

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
    const install = await installPlugin(join(fixturesDir, "plugins", "github-repo.json"), pluginDir);
    const list = await listPlugins(pluginDir);

    expect(install).toMatchObject({
      installed: true,
      pluginDid: "did:web:plugins.example.com:github-repo",
    });
    expect(list).toMatchObject({
      plugins: [
        {
          file: "github-repo.json",
          pluginDid: "did:web:plugins.example.com:github-repo",
        },
      ],
    });
  });

  it("sets and lists credentials without exposing values", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");

    await expect(setCredential("github-test-token", "ghp_test", credentialDir)).resolves.toMatchObject({
      stored: true,
      handle: "github-test-token",
    });
    await expect(listCredentials(credentialDir)).resolves.toEqual({
      credentials: ["github-test-token"],
    });
  });

  it("validates a config including file credential handles", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    await setCredential("github-test-token", "ghp_test", credentialDir);

    await expect(
      validateConfig("github-strict", {
        configDir: join(fixturesDir, "configs"),
        credentialDir,
      }),
    ).resolves.toMatchObject({
      valid: true,
      name: "github-strict",
      pluginDid: "did:web:plugins.example.com:github-repo",
      credentials: [
        {
          handle: "github-test-token",
          ok: true,
        },
      ],
    });
  });

  it("warns when bridge configs use different DIDs (potential Sybil footgun)", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    await setCredential("github-test-token", "ghp_test", credentialDir);
    const bridgeDir = await tempDir("mpas-cli-bridges-");

    // Create two bridge configs with different DIDs from trustedSigners
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(bridgeDir, "proposer.json"),
      JSON.stringify({ mode: "proposer", agent: { did: "did:key:z6MkpPanM5XyyGcp6HAwJSm7SmWmmb4MpfmBfgRSq4t7GokV", keyFile: "x" } }),
    );
    await writeFile(
      join(bridgeDir, "signer.json"),
      JSON.stringify({ mode: "signer", agent: { did: "did:key:z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi", keyFile: "x" } }),
    );

    const result = await validateConfig("github-strict", {
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

  it("bridge config validation fails for DID not in trustedSigners", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    await setCredential("github-test-token", "ghp_test", credentialDir);
    const bridgeDir = await tempDir("mpas-cli-bridges-");

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(bridgeDir, "unknown.json"),
      JSON.stringify({ mode: "proposer", agent: { did: "did:key:z6MkUnknownDid", keyFile: "x" } }),
    );

    const result = await validateConfig("github-strict", {
      configDir: join(fixturesDir, "configs"),
      credentialDir,
      bridgeDir,
    });

    expect(result.valid).toBe(false);
    expect(result.bridgeConfigs![0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("not in trustedSigners"),
    });
  });

  it("runs management commands through runCli", async () => {
    const credentialDir = await tempDir("mpas-cli-credentials-");
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    const result = await runCli(
      ["credential", "set", "github-test-token", "--credential-dir", credentialDir, "--value", "ghp_test"],
      { stdout, stderr },
    );

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(JSON.parse(stdout.text)).toMatchObject({
      stored: true,
      handle: "github-test-token",
    });
  });
});
