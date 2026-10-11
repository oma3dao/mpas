import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledAssets {
  skillsDir: string;
}

/**
 * Locates the role skills. A built package carries them in `dist/bundled/`;
 * a source checkout falls back to the repository folder.
 */
export function bundledAssets(): BundledAssets {
  const bundled = fileURLToPath(new URL("../../bundled/", import.meta.url));
  if (existsSync(join(bundled, "skills"))) {
    return { skillsDir: join(bundled, "skills") };
  }
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  return { skillsDir: join(repoRoot, "integrations", "skills") };
}
