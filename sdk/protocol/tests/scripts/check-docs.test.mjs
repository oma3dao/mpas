#!/usr/bin/env node
/**
 * Negative controls for docs:check (N40 / issue 63).
 *
 * Proves the checker fails on a deliberately missing inventory export, on a
 * deliberately broken README snippet (an import naming an unexported symbol),
 * and on a stale inventory path — then passes on the real final README bytes.
 * Runs as a plain node script: `node tests/scripts/check-docs.test.mjs`.
 * Exit 0 = all controls behaved; exit 1 = a control did not.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const checkerPath = join(packageRoot, "tests", "scripts", "check-docs.mjs");
const readmePath = join(packageRoot, "README.md");

// The checker requires the built SDK (dist/).  In CI's test job the SDK is
// tested before it is built, so build on demand if dist/ is absent.
if (!existsSync(join(packageRoot, "dist", "index.js"))) {
  const build = spawn("npm", ["run", "build"], { cwd: packageRoot, stdio: "inherit" });
  await new Promise((resolve, reject) => {
    build.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
    build.on("error", reject);
  });
}

function runChecker(readme) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [checkerPath, "--readme", readme], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

const tempRoot = await mkdtemp(join(tmpdir(), "mpas-docs-check-controls-"));
let failures = 0;
const report = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
};

try {
  const readme = await readFile(readmePath, "utf8");

  // Control 1: a deliberately missing export in the inventory must fail and
  // name the exact missing export.
  {
    const broken = readme.replace(/^\| `@oma3\/mpas\/rfc9421` .*\n/m, "");
    assert.notEqual(broken, readme, "control setup: rfc9421 row not found");
    const candidate = join(tempRoot, "readme-missing-export.md");
    await writeFile(candidate, broken);
    const result = await runChecker(candidate);
    report(
      "missing export is rejected and named",
      result.code === 1 && result.output.includes("@oma3/mpas/rfc9421"),
      `exit ${result.code}`,
    );
  }

  // Control 2: a deliberately broken snippet (import of an unexported symbol)
  // must fail compilation and name the symbol.
  {
    const broken = readme.replace(
      'import { deriveDidJwk, didJwkToKid, generateEd25519Key } from "@oma3/mpas";',
      'import { deriveDidJwk, didJwkToKidMissing, generateEd25519Key } from "@oma3/mpas";',
    );
    assert.notEqual(broken, readme, "control setup: DID import not found");
    const candidate = join(tempRoot, "readme-broken-snippet.md");
    await writeFile(candidate, broken);
    const result = await runChecker(candidate);
    report(
      "broken snippet is rejected and reported",
      result.code === 1 && result.output.includes("didJwkToKidMissing"),
      `exit ${result.code}`,
    );
  }

  // Control 3: a stale documented path with no matching export must fail.
  {
    const broken = readme.replace(
      "| `@oma3/mpas/trace` | Trace logging |",
      "| `@oma3/mpas/trace` | Trace logging |\n| `@oma3/mpas/no-such-module` | Invented module |",
    );
    assert.notEqual(broken, readme, "control setup: trace row not found");
    const candidate = join(tempRoot, "readme-stale-path.md");
    await writeFile(candidate, broken);
    const result = await runChecker(candidate);
    report(
      "stale inventory path is rejected and named",
      result.code === 1 && result.output.includes("@oma3/mpas/no-such-module"),
      `exit ${result.code}`,
    );
  }

  // Positive control: the real final bytes pass.
  {
    const result = await runChecker(readmePath);
    report("final README bytes pass docs:check", result.code === 0, `exit ${result.code}`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

if (failures > 0) {
  process.stderr.write(`check-docs controls: ${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write("check-docs controls: all behaved\n");
