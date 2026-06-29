import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseActionPackage } from "../../src/core/verification.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/core/", import.meta.url));

async function readFixture(file: string): Promise<unknown> {
  return JSON.parse(await readFile(join(fixturesDir, file), "utf8")) as unknown;
}

describe("parseActionPackage", () => {
  it.each([
    "valid-no-approval-required.json",
    "valid-two-approvals.json",
    "valid-delete-branch.json",
    "invalid-payload-hash-mismatch.json",
    "invalid-expired-envelope.json",
    "invalid-bad-signature.json",
    "insufficient-approvals.json",
    "invalid-unknown-application.json",
    "invalid-disabled-operation.json",
    "invalid-resource-restricted.json",
  ])("parses structurally complete fixture %s", async (fixtureFile) => {
    const result = parseActionPackage(await readFixture(fixtureFile));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actionPackage.executionPayload).toBeDefined();
      expect(result.actionPackage.actionEnvelope).toBeDefined();
      expect(result.actionPackage.approvalBundle).toBeDefined();
    }
  });

  it("returns a structured error for malformed-missing-envelope.json", async () => {
    const result = parseActionPackage(await readFixture("malformed-missing-envelope.json"));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "ParseError",
        code: "INVALID_ACTION_PACKAGE",
        message: "Action Package missing required field: actionEnvelope",
        path: "$.actionEnvelope",
      },
    });
  });

  it("rejects non-object values as malformed", () => {
    const result = parseActionPackage(null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe("$");
    }
  });
});
