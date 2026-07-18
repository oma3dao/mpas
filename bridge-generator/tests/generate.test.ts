import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GenerateError, runGenerate, type GenerateOptions } from "../src/generate.js";

const mockServer = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));

async function generate(overrides: Partial<GenerateOptions> = {}): Promise<string> {
  const outDir = overrides.outDir ?? (await mkdtemp(join(tmpdir(), "bridge-gen-")));
  await runGenerate({
    appName: "mockapp",
    outDir,
    upstreamCommand: "node",
    upstreamArgs: [mockServer],
    capturedAt: "2026-07-18T00:00:00.000Z",
    log: () => {},
    ...overrides,
  });
  return join(outDir, overrides.appName ?? "mockapp");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("runGenerate", () => {
  it("writes the full applications/<name>/ layout (spec §3.1)", async () => {
    const appDir = await generate();

    expect((await readdir(appDir)).sort()).toEqual([
      "CHANGELOG.md",
      "bridge",
      "build-artifacts",
      "harness-config.json",
      "plugin.json",
      "registry-entry.json",
    ]);
    expect((await readdir(join(appDir, "build-artifacts"))).sort()).toEqual([
      "classification.json",
      "metadata.json",
      "tools-list.snapshot.json",
    ]);
    expect((await readdir(join(appDir, "bridge"))).sort()).toEqual(["README.md", "package.json", "src", "tsconfig.json"]);
  });

  it("snapshot, classification, and plugin agree on the tool surface", async () => {
    const appDir = await generate();

    const snapshot = await readJson<{ tools: Array<{ name: string }>; toolSurface: { value: string } }>(
      join(appDir, "build-artifacts", "tools-list.snapshot.json"),
    );
    const classification = await readJson<{ operations: Record<string, { impact: string }> }>(
      join(appDir, "build-artifacts", "classification.json"),
    );
    const plugin = await readJson<{ operations: Record<string, { impact: string }> }>(join(appDir, "plugin.json"));

    const names = ["create_issue", "delete_branch", "merge_pull_request"];
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(names);
    expect(Object.keys(classification.operations)).toEqual(names);
    expect(Object.keys(plugin.operations)).toEqual(names);
    expect(plugin.operations.delete_branch.impact).toBe("critical");
  });

  it("registry entry pins the plugin artifactDid and upstream toolSurface (spec §3.6)", async () => {
    const appDir = await generate();

    const entry = await readJson<{
      native: boolean;
      protocol: string;
      status: string;
      upstream: { name: string; toolSurface: { alg: string; value: string } };
      plugin: { artifactDid: string };
    }>(join(appDir, "registry-entry.json"));
    const snapshot = await readJson<{ toolSurface: { value: string } }>(
      join(appDir, "build-artifacts", "tools-list.snapshot.json"),
    );

    expect(entry.native).toBe(false);
    expect(entry.protocol).toBe("mcp");
    expect(entry.status).toBe("beta");
    expect(entry.upstream.toolSurface.value).toBe(snapshot.toolSurface.value);
    expect(entry.plugin.artifactDid).toMatch(/^did:artifact:baf/);
  });

  it("is deterministic except for metadata.json (spec §4)", async () => {
    const appDir = await generate();
    const before = await readAllFiles(appDir);

    await generate({ outDir: join(appDir, ".."), capturedAt: "2027-01-01T00:00:00.000Z" });
    const after = await readAllFiles(appDir);

    for (const [file, contents] of Object.entries(before)) {
      if (file.endsWith("metadata.json")) {
        expect(after[file]).not.toBe(contents);
      } else {
        expect(after[file], `expected ${file} to be byte-stable`).toBe(contents);
      }
    }
  });

  it("never overwrites CHANGELOG.md and respects .generator-keep (spec §5)", async () => {
    const appDir = await generate();
    await writeFile(join(appDir, "CHANGELOG.md"), "# my notes\n");
    await writeFile(join(appDir, ".generator-keep"), "bridge/README.md\n");
    await writeFile(join(appDir, "bridge", "README.md"), "hand-edited\n");

    await generate({ outDir: join(appDir, "..") });

    expect(await readFile(join(appDir, "CHANGELOG.md"), "utf8")).toBe("# my notes\n");
    expect(await readFile(join(appDir, "bridge", "README.md"), "utf8")).toBe("hand-edited\n");
  });

  it("preserves reviewed classification entries and harness deviations across regeneration (spec §5)", async () => {
    const appDir = await generate();

    // Manual review: change an impact, mark reviewed, flip draft off.
    const classificationPath = join(appDir, "build-artifacts", "classification.json");
    const classification = await readJson<{
      draft: boolean;
      operations: Record<string, { impact: string; rationale: string }>;
    }>(classificationPath);
    classification.operations.create_issue = { impact: "high", rationale: "reviewed: externally visible" };
    classification.draft = false;
    await writeFile(classificationPath, `${JSON.stringify(classification, null, 2)}\n`);

    // Manual harness edit.
    const harnessPath = join(appDir, "harness-config.json");
    const harness = await readJson<{ intentionalDeviations: { wrappedSchemas: string[] } }>(harnessPath);
    harness.intentionalDeviations.wrappedSchemas = ["create_issue"];
    await writeFile(harnessPath, `${JSON.stringify(harness, null, 2)}\n`);

    await generate({ outDir: join(appDir, "..") });

    const mergedClassification = await readJson<typeof classification>(classificationPath);
    expect(mergedClassification.operations.create_issue).toEqual({
      impact: "high",
      rationale: "reviewed: externally visible",
    });
    expect(mergedClassification.draft).toBe(false);

    // Reviewed impact flows into the regenerated plugin.
    const plugin = await readJson<{ operations: Record<string, { impact: string }> }>(join(appDir, "plugin.json"));
    expect(plugin.operations.create_issue.impact).toBe("high");

    const mergedHarness = await readJson<typeof harness>(harnessPath);
    expect(mergedHarness.intentionalDeviations.wrappedSchemas).toEqual(["create_issue"]);
  });

  it("applies --application-did and org config to plugin and registry entry", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-org-"));
    const orgConfigPath = join(outDir, "org.json");
    await writeFile(
      orgConfigPath,
      JSON.stringify({
        publisher: { name: "Wivity", githubOrg: "wivity", publisherDid: "did:web:wivity.example" },
        application: {
          name: "Mock App",
          description: "MPAS-protected mock application.",
          applicationDid: "did:web:mock.example",
          website: "https://mock.example",
        },
      }),
    );

    const appDir = await generate({ outDir, orgConfigPath });

    const plugin = await readJson<{ applicationDid: string }>(join(appDir, "plugin.json"));
    expect(plugin.applicationDid).toBe("did:web:mock.example");

    const entry = await readJson<{ application: { name: string }; publisher: { githubOrg: string } }>(
      join(appDir, "registry-entry.json"),
    );
    expect(entry.application.name).toBe("Mock App");
    expect(entry.publisher.githubOrg).toBe("wivity");
  });

  it("rejects invalid app names", async () => {
    await expect(generate({ appName: "Bad Name!" })).rejects.toBeInstanceOf(GenerateError);
  });
});

async function readAllFiles(dir: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await readAllFiles(join(dir, entry.name), relative));
    } else {
      result[relative] = await readFile(join(dir, entry.name), "utf8");
    }
  }
  return result;
}
