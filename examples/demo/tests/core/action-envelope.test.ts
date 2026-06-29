import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateActionEnvelope } from "../../src/core/verification.js";
import type { ActionEnvelope, ActionPackage } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/core/", import.meta.url));

async function readActionPackage(file: string): Promise<ActionPackage> {
  return JSON.parse(await readFile(join(fixturesDir, file), "utf8")) as ActionPackage;
}

describe("validateActionEnvelope", () => {
  it.each(["valid-no-approval-required.json", "valid-two-approvals.json", "valid-delete-branch.json"])(
    "accepts valid envelope from %s",
    async (fixtureFile) => {
      const actionPackage = await readActionPackage(fixtureFile);

      expect(validateActionEnvelope(actionPackage.actionEnvelope)).toEqual({ ok: true });
    },
  );

  it("rejects an expired envelope", async () => {
    const actionPackage = await readActionPackage("invalid-expired-envelope.json");
    const result = validateActionEnvelope(actionPackage.actionEnvelope);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "ValidationError",
        code: "EXPIRED_ACTION_ENVELOPE",
        message: "Action Envelope is expired.",
        path: "$.expiresAt",
      },
    });
  });

  it("rejects a missing executionPayloadHash", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const malformed = { ...actionPackage.actionEnvelope } as Partial<ActionEnvelope>;
    delete malformed.executionPayloadHash;

    const result = validateActionEnvelope(malformed as ActionEnvelope);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "ValidationError",
        code: "INVALID_ACTION_ENVELOPE",
        message: "Action Envelope missing required field: executionPayloadHash",
        path: "$.executionPayloadHash",
      },
    });
  });

  it("rejects a non-DID execution profile id", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const malformed = {
      ...actionPackage.actionEnvelope,
      executionProfile: {
        ...actionPackage.actionEnvelope.executionProfile,
        id: "not-a-did",
      },
    } as unknown as ActionEnvelope;

    const result = validateActionEnvelope(malformed);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "ValidationError",
        code: "INVALID_ACTION_ENVELOPE",
        message: "Action Envelope executionProfile.id must be a DID.",
        path: "$.executionProfile.id",
      },
    });
  });

  it("rejects timestamps without exactly 3 fractional digits", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");

    expect(
      validateActionEnvelope({
        ...actionPackage.actionEnvelope,
        createdAt: "2026-06-05T18:00:00Z",
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "ValidationError",
        code: "INVALID_ACTION_ENVELOPE",
        message: "Action Envelope createdAt must be an MPAS timestamp with millisecond precision.",
        path: "$.createdAt",
      },
    });

    expect(
      validateActionEnvelope({
        ...actionPackage.actionEnvelope,
        expiresAt: "2030-01-01T00:00:00.00Z",
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "ValidationError",
        code: "INVALID_ACTION_ENVELOPE",
        message: "Action Envelope expiresAt must be an MPAS timestamp with millisecond precision.",
        path: "$.expiresAt",
      },
    });
  });
});
