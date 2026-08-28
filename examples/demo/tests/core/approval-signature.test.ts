import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyApprovalSignature } from "../../src/core/verification.js";
import type { ActionPackage, Approval, CanonicalApprovalPayload } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface SigningKeyFixture {
  did: string;
  publicJwk: Record<string, unknown>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readActionPackage(file: string): Promise<ActionPackage> {
  return readJson<ActionPackage>(join(fixturesDir, "core", file));
}

async function readSigningKeys(): Promise<Map<string, SigningKeyFixture>> {
  const entries = await Promise.all(
    ["proposer.json", "maintainer-a.json", "maintainer-b.json"].map(async (file) => {
      const key = await readJson<SigningKeyFixture>(join(fixturesDir, "test-keys", file));
      return [key.did, key] as const;
    }),
  );

  return new Map(entries);
}

function decodeApprovalPayload(approval: Approval): CanonicalApprovalPayload {
  return JSON.parse(Buffer.from(approval.signature.value.split(".")[1], "base64url").toString("utf8"));
}

describe("verifyApprovalSignature", () => {
  it.each(["valid-no-approval-required.json", "valid-two-approvals.json", "valid-delete-branch.json"])(
    "verifies all approvals in %s",
    async (fixtureFile) => {
      const keysByDid = await readSigningKeys();
      const actionPackage = await readActionPackage(fixtureFile);

      for (const approval of actionPackage.approvalBundle.approvals) {
        const payload = decodeApprovalPayload(approval);
        const key = keysByDid.get(payload.signerDid ?? "");

        expect(key, `missing key for ${payload.signerDid}`).toBeDefined();
        await expect(verifyApprovalSignature(approval, key!.publicJwk)).resolves.toBe(true);
      }
    },
  );

  it("rejects invalid-bad-signature.json", async () => {
    const keysByDid = await readSigningKeys();
    const actionPackage = await readActionPackage("invalid-bad-signature.json");
    const approval = actionPackage.approvalBundle.approvals[0];
    const payload = decodeApprovalPayload(approval);
    const key = keysByDid.get(payload.signerDid ?? "");

    expect(key).toBeDefined();
    await expect(verifyApprovalSignature(approval, key!.publicJwk)).resolves.toBe(false);
  });

  it("rejects alg none", async () => {
    const key = await readJson<SigningKeyFixture>(join(fixturesDir, "test-keys", "proposer.json"));
    const approval: Approval = {
      version: "1",
      type: "Approval",
      actionEnvelopeHash: { alg: "sha-256", value: "test" },
      decision: "approve",
      signature: {
        format: "jws",
        value: "eyJhbGciOiJub25lIn0.eyJ0eXBlIjoiQXBwcm92YWxQYXlsb2FkIn0.",
      },
      createdAt: "2026-06-05T18:00:00.000Z",
    };

    await expect(verifyApprovalSignature(approval, key.publicJwk)).resolves.toBe(false);
  });

  it("rejects non-EdDSA algorithms such as HS256", async () => {
    const key = await readJson<SigningKeyFixture>(join(fixturesDir, "test-keys", "proposer.json"));
    const approval: Approval = {
      version: "1",
      type: "Approval",
      actionEnvelopeHash: { alg: "sha-256", value: "test" },
      decision: "approve",
      signature: {
        format: "jws",
        value: "eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiQXBwcm92YWxQYXlsb2FkIn0.sig",
      },
      createdAt: "2026-06-05T18:02:00.000Z",
    };

    await expect(verifyApprovalSignature(approval, key.publicJwk)).resolves.toBe(false);
  });
});
