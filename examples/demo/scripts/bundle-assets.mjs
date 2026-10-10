#!/usr/bin/env node

// Copies the application registry and the role skills into the package so the
// published CLI can resolve applications and print role preambles without a
// repository checkout. Runs as part of `npm run build`.

import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUNDLED_SKILLS = ["mpas-proposer", "mpas-maintainer"];

export async function bundleAssets({ repoRoot, outDir }) {
  await rm(outDir, { recursive: true, force: true });

  const registryDir = join(repoRoot, "application-registry");
  const registryOut = join(outDir, "registry");
  await mkdir(registryOut, { recursive: true });
  for (const name of (await readdir(registryDir)).filter((file) => file.endsWith(".json")).sort()) {
    await copyFile(join(registryDir, name), join(registryOut, name));
  }

  for (const skill of BUNDLED_SKILLS) {
    await cp(join(repoRoot, "integrations", "skills", skill), join(outDir, "skills", skill), { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundleAssets({
    repoRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    outDir: fileURLToPath(new URL("../dist/bundled/", import.meta.url)),
  });
}
