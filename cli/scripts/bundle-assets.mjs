#!/usr/bin/env node

// Copies the role skills into the package so the published CLI can install
// them and print role preambles without a repository checkout. Application
// data is never bundled: `mpas mcp add` reads it from the URL it is given.
// Runs as part of `npm run build`.

import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUNDLED_SKILLS = ["mpas-proposer", "mpas-maintainer"];

export async function bundleAssets({ repoRoot, outDir }) {
  await rm(outDir, { recursive: true, force: true });

  for (const skill of BUNDLED_SKILLS) {
    await cp(join(repoRoot, "integrations", "skills", skill), join(outDir, "skills", skill), { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundleAssets({
    repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
    outDir: fileURLToPath(new URL("../dist/bundled/", import.meta.url)),
  });
}
