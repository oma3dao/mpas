#!/usr/bin/env node
/**
 * docs:check — the single documentation check for the @oma3/mpas SDK.
 *
 * Three checks against the built current package, all reported exactly:
 *
 * 1. Inventory completeness: every public `package.json` export appears in the
 *    README "Subpath Exports" inventory, and no documented path is stale.
 * 2. Snippet compilation: every fenced ```typescript block in the README is
 *    compiled with the installed TypeScript compiler in a minimal temporary
 *    consumer that resolves `@oma3/mpas` through the real package exports map
 *    (a symlink to this package) — a documented import naming an unexported or
 *    nonexistent symbol fails here.
 * 3. Runnable examples: snippets whose first non-empty line is the directive
 *    `// @docs-check: run` are additionally executed with synthetic material
 *    using the installed tsx runner (DID examples must run, not only compile).
 *
 * The `ws` module used by the WebSocket-notification example is an external
 * consumer-side install (the README prose says so); the scaffold carries one
 * ambient declaration for it, noted in the output. No other module is shimmed.
 *
 * Temporary consumer files are created under the OS temp dir and always
 * removed. Usage: `node tests/scripts/check-docs.mjs [--readme <path>]`.
 * Exit 0 = pass, 1 = check failure, 2 = usage/setup error.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = join(packageRoot, "package.json");

function fail(message) {
  process.stderr.write(`docs:check FAIL: ${message}\n`);
  process.exit(1);
}

function usage(message) {
  process.stderr.write(`docs:check ERROR: ${message}\n`);
  process.exit(2);
}

// --- args ---
const args = process.argv.slice(2);
let readmePath = join(packageRoot, "README.md");
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--readme" && args[index + 1]) {
    readmePath = args[index + 1];
    index += 1;
  } else {
    usage(`unknown argument: ${args[index]}`);
  }
}

// --- inputs ---
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const readme = await readFile(readmePath, "utf8");

if (!existsSync(join(packageRoot, "dist", "index.js")) || !existsSync(join(packageRoot, "dist", "index.d.ts"))) {
  fail("dist/ is missing or incomplete; run `npm run build` before `npm run docs:check`.");
}

const failures = [];

// --- check 1: export inventory ---
const exportPaths = Object.keys(manifest.exports).map((key) =>
  key === "." ? "@oma3/mpas" : `@oma3/mpas/${key.slice(2)}`);
const inventorySection = readme.split(/^## /m).find((section) => section.startsWith("Subpath Exports"));
if (!inventorySection) {
  fail("README has no `## Subpath Exports` section.");
}
const documented = new Set();
for (const line of inventorySection.split("\n")) {
  const match = line.match(/^\|\s*`(@oma3\/mpas[^`]*)`\s*\|/);
  if (match) {
    documented.add(match[1]);
  }
}
const missingFromInventory = exportPaths.filter((path) => !documented.has(path));
const staleInventory = [...documented].filter((path) => !exportPaths.includes(path));
if (missingFromInventory.length > 0) {
  failures.push(`public export(s) absent from the README inventory: ${missingFromInventory.join(", ")}`);
}
if (staleInventory.length > 0) {
  failures.push(`README inventory path(s) with no matching package export: ${staleInventory.join(", ")}`);
}

// --- collect snippets ---
const snippets = [];
const lines = readme.split("\n");
let fenceStart = -1;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (fenceStart === -1 && line.trim() === "```typescript") {
    fenceStart = index;
  } else if (fenceStart !== -1 && line.trim() === "```") {
    const body = lines.slice(fenceStart + 1, index).join("\n");
    const firstNonEmpty = body.split("\n").find((entry) => entry.trim().length > 0) ?? "";
    snippets.push({
      line: fenceStart + 1,
      body,
      run: /^\/\/\s*@docs-check:\s*run\s*$/.test(firstNonEmpty.trim()),
    });
    fenceStart = -1;
  }
}
if (snippets.length === 0) {
  fail(`no TypeScript snippets found in ${readmePath}.`);
}

// --- checks 2+3: compile and run in a temporary consumer ---
const consumerRoot = await mkdtemp(join(tmpdir(), "mpas-docs-check-"));
try {
  const consumer = join(consumerRoot, "consumer");
  await mkdir(join(consumer, "node_modules", "@oma3"), { recursive: true });
  await mkdir(join(consumer, "node_modules", "@types"), { recursive: true });
  await mkdir(join(consumer, "snippets"), { recursive: true });
  await mkdir(join(consumer, "shims"), { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "mpas-docs-check-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  await symlink(packageRoot, join(consumer, "node_modules", "@oma3", "mpas"), "dir");
  await symlink(
    join(packageRoot, "node_modules", "@types", "node"),
    join(consumer, "node_modules", "@types", "node"),
    "dir",
  );
  await writeFile(
    join(consumer, "shims", "ws.d.ts"),
    [
      "// The README WebSocket example uses the external `ws` package, which the",
      "// prose tells consumers to install; it is not a dependency of @oma3/mpas.",
      "// Only the default-export constructability the example uses is declared.",
      'declare module "ws" {',
      "  const WebSocket: any;",
      "  export default WebSocket;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022"],
          types: ["node"],
          typeRoots: ["./node_modules/@types"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
        },
        include: ["snippets/**/*.ts", "shims/**/*.d.ts"],
      },
      null,
      2,
    )}\n`,
  );
  for (const [index, snippet] of snippets.entries()) {
    snippet.file = `snippets/snippet-${index + 1}.ts`;
    await writeFile(join(consumer, snippet.file), `${snippet.body}\n`);
  }

  const tsc = await run(process.execPath, [join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], consumer);
  if (tsc.code !== 0) {
    failures.push(
      `TypeScript snippet compilation failed against the built current package:\n${tsc.output.trim()}`,
    );
  }

  const runnable = snippets.filter((snippet) => snippet.run);
  for (const snippet of runnable) {
    const executed = await run(join(packageRoot, "node_modules", ".bin", "tsx"), [snippet.file], consumer);
    if (executed.code !== 0) {
      failures.push(
        `runnable snippet at README line ${snippet.line} exited ${executed.code}:\n${executed.output.trim()}`,
      );
    }
  }

  if (failures.length > 0) {
    fail(failures.map((failure) => `  - ${failure}`).join("\n"));
  }
  process.stdout.write(
    [
      `exports: ${exportPaths.length} public export(s), all present in the README inventory`,
      `snippets: ${snippets.length} TypeScript snippet(s) compile against the built current package`,
      `runnable: ${runnable.length} snippet(s) executed with synthetic material (ws shimmed per README prose)`,
      "docs:check PASS",
      "",
    ].join("\n"),
  );
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
