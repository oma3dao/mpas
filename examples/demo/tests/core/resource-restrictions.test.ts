import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkResourceRestrictions } from "../../src/core/policy-engine.js";
import type { ActionPackage } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readActionPackage(file: string): Promise<ActionPackage> {
  return JSON.parse(await readFile(join(fixturesDir, "core", file), "utf8")) as ActionPackage;
}

const restrictions = {
  allowedRepositories: ["example-org/mpas-demo-repository"],
  allowedOrganizations: ["example-org"],
};

describe("checkResourceRestrictions", () => {
  it("allows payloads targeting configured repositories", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");

    expect(checkResourceRestrictions(actionPackage.executionPayload, restrictions)).toBe(true);
  });

  it("rejects payloads outside allowed repositories and organizations", async () => {
    const actionPackage = await readActionPackage("invalid-resource-restricted.json");

    expect(checkResourceRestrictions(actionPackage.executionPayload, restrictions)).toBe(false);
  });
});
