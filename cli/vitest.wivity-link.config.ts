import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Credential Adapter OAuth plan, Phase 7 (P7-01, P7-02): runs this adapter against
 * a local Wivity Link built from its own test harness (real PostgreSQL, the
 * synthetic provider, and a fake SignerSet). It needs a `mpas-api-proxy` checkout
 * with its dependencies installed and PostgreSQL's `initdb`/`pg_ctl` on PATH (or
 * PG_BINDIR, or TEST_DATABASE_URL). It is not part of `npm test`.
 *
 *   WIVITY_LINK_DIR=../../mpas-api-proxy npm run test:interop:wivity-link
 */
const wivityLinkDir = process.env.WIVITY_LINK_DIR;
if (!wivityLinkDir) throw new Error("Set WIVITY_LINK_DIR to a mpas-api-proxy checkout.");

export default defineConfig({
  test: {
    include: ["tests/interop/**/*.test.ts"],
    globalSetup: [join(wivityLinkDir, "tests", "support", "postgres-global.ts")],
    env: { WIVITY_LINK_INTEROP: "1" },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
  },
});
