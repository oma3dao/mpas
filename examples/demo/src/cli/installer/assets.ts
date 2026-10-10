import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledAssets {
  registryDir: string;
  skillsDir: string;
}

/**
 * Locates the registry snapshot and skills. A built package carries them in
 * `dist/bundled/`; a source checkout falls back to the repository folders.
 */
export function bundledAssets(): BundledAssets {
  const bundled = fileURLToPath(new URL("../../bundled/", import.meta.url));
  if (existsSync(join(bundled, "registry"))) {
    return { registryDir: join(bundled, "registry"), skillsDir: join(bundled, "skills") };
  }
  const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
  return {
    registryDir: join(repoRoot, "application-registry"),
    skillsDir: join(repoRoot, "integrations", "skills"),
  };
}
