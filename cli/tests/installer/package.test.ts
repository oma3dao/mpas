import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleAssets } from "../../scripts/bundle-assets.mjs";
import { loadRegistry } from "../../src/cli/installer/registry.js";
import { extractPreamble } from "../../src/cli/installer/skills.js";

const demoDir = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

describe("Phase 0: package and bundled inputs", () => {
  it("declares the publishable @oma3/mpas-cli package", async () => {
    const pkg = JSON.parse(await readFile(join(demoDir, "package.json"), "utf8"));
    const sdk = JSON.parse(await readFile(join(repoRoot, "sdk", "protocol", "package.json"), "utf8"));

    expect(pkg.name).toBe("@oma3/mpas-cli");
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin.mpas).toBe("./dist/cli/index.js");
    // npm's one-shot `npx @oma3/mpas-cli` runs the command named after the package, so it must exist.
    expect(pkg.bin["mpas-cli"]).toBe(pkg.bin.mpas);
    expect(pkg.bin["mpas-demo"]).toBe("./dist/index.js");
    // The registry snapshot and skills are bundled under dist/bundled, so "dist" covers them.
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE", "NOTICE"]);
    expect(pkg.publishConfig).toEqual(sdk.publishConfig);
    expect(pkg.repository).toEqual({ ...sdk.repository, directory: "cli" });
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.scripts.build).toContain("scripts/bundle-assets.mjs");
  });

  it("packs only dist, package.json, README.md, LICENSE, and NOTICE", () => {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: demoDir,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const [packed] = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = packed.files.map((file) => file.path);

    expect(paths).toEqual(expect.arrayContaining(["package.json", "README.md", "LICENSE", "NOTICE"]));
    for (const path of paths) {
      expect(path === "package.json" || path === "README.md" || path === "LICENSE" || path === "NOTICE" || path.startsWith("dist/")).toBe(true);
      expect(path.startsWith("tests/")).toBe(false);
      expect(path).not.toMatch(/(^|\/)(test-keys|keys|credentials)\//);
    }
  });

  it("copies the registry and both role skills byte-identically", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "mpas-bundle-"));
    await bundleAssets({ repoRoot, outDir });

    const registrySource = join(repoRoot, "application-registry");
    const registryFiles = (await readdir(registrySource)).filter((name) => name.endsWith(".json")).sort();
    expect(await readdir(join(outDir, "registry")).then((names) => names.sort())).toEqual(registryFiles);
    for (const name of registryFiles) {
      expect(await readFile(join(outDir, "registry", name))).toEqual(await readFile(join(registrySource, name)));
    }

    for (const skill of ["mpas-proposer", "mpas-maintainer"]) {
      const source = join(repoRoot, "integrations", "skills", skill);
      const files = await listFiles(source);
      expect(await listFiles(join(outDir, "skills", skill))).toEqual(files);
      for (const file of files) {
        expect(await readFile(join(outDir, "skills", skill, file))).toEqual(await readFile(join(source, file)));
      }
    }
  });

  it("loads the real registry and an entry with install data", async () => {
    const real = await loadRegistry(join(repoRoot, "application-registry"));
    expect(real.length).toBeGreaterThan(0);
    expect(real.find((entry) => entry.name === "github-wivity")?.applicationPart).toBe("github");

    const dir = await mkdtemp(join(tmpdir(), "mpas-registry-"));
    const entry = JSON.parse(await readFile(join(repoRoot, "application-registry", "github-wivity.json"), "utf8"));
    entry.install = {
      manifestUrl: "https://example.test/applications/github/install.json",
      manifestDigest: { alg: "sha-256", value: "abc" },
    };
    await writeFile(join(dir, "github-wivity.json"), JSON.stringify(entry));
    const [loaded] = await loadRegistry(dir);
    expect(loaded.entry.install).toEqual(entry.install);

    entry.install.manifestDigest.alg = "md5";
    await writeFile(join(dir, "github-wivity.json"), JSON.stringify(entry));
    await expect(loadRegistry(dir)).rejects.toThrow(/manifestDigest/);
  });

  it("documents the install object in the registry README", async () => {
    const readme = await readFile(join(repoRoot, "application-registry", "README.md"), "utf8");
    expect(readme).toMatch(/### `install` Object/);
    expect(readme).toContain("manifestUrl");
    expect(readme).toContain("manifestDigest");
  });

  it("extracts the prime directive from each bundled SKILL.md", async () => {
    const proposer = extractPreamble(await readFile(join(repoRoot, "integrations", "skills", "mpas-proposer", "SKILL.md"), "utf8"));
    const maintainer = extractPreamble(await readFile(join(repoRoot, "integrations", "skills", "mpas-maintainer", "SKILL.md"), "utf8"));

    expect(proposer.startsWith("## Prime Directive — MPAS Proposer\n")).toBe(true);
    expect(maintainer.startsWith("## Prime Directive — MPAS Maintainer\n")).toBe(true);
    expect(proposer).not.toContain("```");
    expect(() => extractPreamble("# A skill\n\nNo preamble here.\n")).toThrow(/prime directive/i);
  });
});
