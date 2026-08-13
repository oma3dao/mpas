import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";

const mockServer = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));

describe("low-level bridge generation", () => {
  it("writes a sibling tools.json next to the generated runtime", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-low-level-"));
    const bridgePath = join(outDir, "bridge.ts");

    await run([
      "--output-bridge",
      bridgePath,
      "--",
      "node",
      mockServer,
    ]);

    const source = await readFile(bridgePath, "utf8");
    const tools = JSON.parse(await readFile(join(outDir, "tools.json"), "utf8")) as Array<{ name: string }>;
    expect(source).toContain('new URL("./tools.json", import.meta.url)');
    expect(source).not.toContain('"name": "create_issue"');
    expect(tools.map((tool) => tool.name)).toEqual(["create_issue", "delete_branch", "merge_pull_request"]);
  });

  it("writes an optional plugin beside the bridge", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-plugin-"));
    const bridgePath = join(outDir, "bridge.ts");
    const pluginPath = join(outDir, "plugin.json");

    await run([
      "--output-bridge",
      bridgePath,
      "--output-plugin",
      pluginPath,
      "--",
      "node",
      mockServer,
    ]);

    const plugin = JSON.parse(await readFile(pluginPath, "utf8")) as {
      type: string;
      operations: Record<string, unknown>;
    };
    expect(plugin.type).toBe("MpasApplicationPlugin");
    expect(Object.keys(plugin.operations)).toEqual(["create_issue", "delete_branch", "merge_pull_request"]);
  });

  it("skips prompting when --prompt-secret env vars are already set", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-secret-"));
    const bridgePath = join(outDir, "bridge.ts");
    const previous = process.env.BRIDGE_GEN_TOKEN;
    process.env.BRIDGE_GEN_TOKEN = "already-set";

    try {
      await run([
        "--prompt-secret",
        "BRIDGE_GEN_TOKEN",
        "--output-bridge",
        bridgePath,
        "--",
        "node",
        mockServer,
      ]);
      expect(await readFile(bridgePath, "utf8")).toContain("GeneratedBridge");
    } finally {
      if (previous === undefined) {
        delete process.env.BRIDGE_GEN_TOKEN;
      } else {
        process.env.BRIDGE_GEN_TOKEN = previous;
      }
    }
  });
});

describe("CLI usage errors", () => {
  it.each([
    [[], "Missing required --output-bridge"],
    [["--output-bridge", "bridge.ts"], "Missing upstream command after --."],
    [["--unknown", "x", "--", "node", "server"], "Unknown argument: --unknown"],
    [["--prompt-secret", "--", "node", "server"], "Missing value for --prompt-secret"],
  ])("rejects %j", async (argv, message) => {
    await expect(run(argv)).rejects.toThrow(message);
  });
});

describe("generate subcommand", () => {
  it("rejects missing generate flags", async () => {
    await expect(run(["generate", "--app", "demo"])).rejects.toThrow("Missing required --out");
    await expect(run(["generate", "--out", "out"])).rejects.toThrow("Missing required --app");
    await expect(run(["generate", "--app", "demo", "--out", "out"])).rejects.toThrow(
      "Missing upstream command after --.",
    );
    await expect(run(["generate", "--app", "demo", "--out", "out", "--bogus"])).rejects.toThrow(
      "Unknown argument: --bogus",
    );
  });

  it("generates an application package via generate", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-generate-"));

    await run(["generate", "--app", "demo-app", "--out", outDir, "--", "node", mockServer]);

    const bridge = await readFile(join(outDir, "demo-app", "bridge", "src", "index.ts"), "utf8");
    expect(bridge).toContain("GeneratedBridge");
    const tools = JSON.parse(
      await readFile(join(outDir, "demo-app", "bridge", "src", "tools.json"), "utf8"),
    ) as unknown[];
    expect(tools.length).toBeGreaterThan(0);
  });

  it("honors --application-did and --org-config during generate", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-generate-flags-"));
    const orgConfigPath = join(outDir, "org.json");
    await writeFile(
      orgConfigPath,
      JSON.stringify({
        publisher: { name: "OMA3", githubOrg: "oma3dao" },
        application: {
          name: "flagged-app",
          description: "Flagged application",
          applicationDid: "did:web:org-config.example",
        },
      }),
    );

    await run([
      "generate",
      "--app",
      "flagged-app",
      "--out",
      outDir,
      "--org-config",
      orgConfigPath,
      "--application-did",
      "did:web:cli-override.example",
      "--",
      "node",
      mockServer,
    ]);

    const plugin = JSON.parse(
      await readFile(join(outDir, "flagged-app", "plugin.json"), "utf8"),
    ) as { applicationDid?: string };
    expect(plugin.applicationDid).toBe("did:web:cli-override.example");
  });

  it("applies org-config applicationDid when --application-did is omitted", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-org-only-"));
    const orgConfigPath = join(outDir, "org.json");
    await writeFile(
      orgConfigPath,
      JSON.stringify({
        publisher: { name: "OMA3", githubOrg: "oma3dao" },
        application: {
          name: "org-app",
          description: "Org-configured application",
          applicationDid: "did:web:org-only.example",
        },
      }),
    );

    await run([
      "generate",
      "--app",
      "org-app",
      "--out",
      outDir,
      "--org-config",
      orgConfigPath,
      "--",
      "node",
      mockServer,
    ]);

    const plugin = JSON.parse(await readFile(join(outDir, "org-app", "plugin.json"), "utf8")) as {
      applicationDid?: string;
    };
    expect(plugin.applicationDid).toBe("did:web:org-only.example");
  });

  it("rejects generate --prompt-secret without a value", async () => {
    await expect(
      run(["generate", "--app", "demo", "--out", "out", "--prompt-secret", "--", "node", mockServer]),
    ).rejects.toThrow("Missing value for --prompt-secret");
  });

  it("honors generate --prompt-secret when the env var is already set", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-generate-secret-"));
    const previous = process.env.BRIDGE_GEN_TOKEN;
    process.env.BRIDGE_GEN_TOKEN = "already-set";
    try {
      await run([
        "generate",
        "--app",
        "secret-app",
        "--out",
        outDir,
        "--prompt-secret",
        "BRIDGE_GEN_TOKEN",
        "--",
        "node",
        mockServer,
      ]);
      const plugin = JSON.parse(await readFile(join(outDir, "secret-app", "plugin.json"), "utf8")) as {
        type: string;
      };
      expect(plugin.type).toBe("MpasApplicationPlugin");
    } finally {
      if (previous === undefined) delete process.env.BRIDGE_GEN_TOKEN;
      else process.env.BRIDGE_GEN_TOKEN = previous;
    }
  });
});

describe("CLI process entry", () => {
  it("exits with UpstreamSpawnError code when the binary cannot spawn upstream", async () => {
    const { spawn } = await import("node:child_process");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const tsxCli = require.resolve("tsx/cli");
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-cli-entry-"));
    const bridgePath = join(outDir, "bridge.ts");

    const child = spawn(
      process.execPath,
      [tsxCli, entry, "--output-bridge", bridgePath, "--", "definitely-not-a-real-command-xyz"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    expect(code).toBe(2);
    expect(Buffer.concat(stderrChunks).toString("utf8")).toMatch(/ERROR:/);
  }, 20_000);
});
