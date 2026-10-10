import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyPayloadBinding } from "../../src/core/verification.js";
import type { ActionPackage } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/core/", import.meta.url));

async function readActionPackage(file: string): Promise<ActionPackage> {
  return JSON.parse(await readFile(join(fixturesDir, file), "utf8")) as ActionPackage;
}

describe("verifyPayloadBinding", () => {
  it.each([
    "valid-no-approval-required.json",
    "valid-two-approvals.json",
    "valid-delete-branch.json",
    "invalid-expired-envelope.json",
    "invalid-bad-signature.json",
    "insufficient-approvals.json",
    "invalid-unknown-application.json",
    "invalid-disabled-operation.json",
    "invalid-resource-restricted.json",
  ])("returns true when the payload hash matches for %s", async (fixtureFile) => {
    const actionPackage = await readActionPackage(fixtureFile);

    expect(verifyPayloadBinding(actionPackage.executionPayload, actionPackage.actionEnvelope)).toBe(true);
  });

  it("returns false for invalid-payload-hash-mismatch.json", async () => {
    const actionPackage = await readActionPackage("invalid-payload-hash-mismatch.json");

    expect(verifyPayloadBinding(actionPackage.executionPayload, actionPackage.actionEnvelope)).toBe(false);
  });
});
