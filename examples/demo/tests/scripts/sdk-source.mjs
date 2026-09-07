import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Detect whether the demo's `@oma3/mpas` install is the repository's local
 * `sdk/protocol` checkout (symlink / install-links) or a published package.
 */
export function detectMpasSdkSource(demoRoot = defaultDemoRoot()) {
  const localPkgPath = join(demoRoot, "..", "..", "sdk", "protocol", "package.json");
  const require = createRequire(join(demoRoot, "package.json"));

  let resolvedPkg;
  try {
    resolvedPkg = require.resolve("@oma3/mpas/package.json");
  } catch (error) {
    return {
      mode: "missing",
      version: undefined,
      resolvedPkg: undefined,
      message: `MPAS SDK: not installed — ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const version = JSON.parse(readFileSync(resolvedPkg, "utf8")).version;
  let isLocal = false;
  if (existsSync(localPkgPath)) {
    try {
      isLocal = realpathSync(resolvedPkg) === realpathSync(localPkgPath);
    } catch {
      isLocal = false;
    }
  }

  if (isLocal) {
    return {
      mode: "local",
      version,
      resolvedPkg,
      message: "MPAS SDK: local checkout — including local SDK integration tests",
    };
  }

  return {
    mode: "published",
    version,
    resolvedPkg,
    message: `MPAS SDK: published package ${version} — skipping local SDK integration tests`,
  };
}

export function defaultDemoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function formatSdkSourceMessage(source = detectMpasSdkSource()) {
  return source.message;
}
