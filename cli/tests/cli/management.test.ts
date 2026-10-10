import { mkdir, mkdtemp, readFile } from "node:fs/promises";
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
    const install = await installPlugin(join(fixturesDir, "plugins", "github-mirror-plugin.json"), pluginDir);
    const list = await listPlugins(pluginDir);

    expect(install).toMatchObject({
      installed: true,
      pluginDid: "did:web:plugins.oma3.org:github-mirror-plugin",
    });
    expect(list).toMatchObject({
      plugins: [
        {
          file: "github-mirror-plugin.json",
          pluginDid: "did:web:plugins.oma3.org:github-mirror-plugin",
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

  it("validates a config including file credential handles", async () => {
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
      pluginDid: "did:web:plugins.oma3.org:github-mirror-plugin",
      credentials: [
        {
          handle: "github-mirror-token",
          ok: true,
        },
      ],
    });
  });

  it("warns when bridge configs use different DIDs (potential Sybil footgun)", async () => {
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
});
