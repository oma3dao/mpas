import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeJsonHash, verifyApprovalBundle, type TrustedSigner } from "../../src/core/verification.js";
import type { ActionPackage, Did } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: TrustedSigner["publicJwk"];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readActionPackage(file: string): Promise<ActionPackage> {
  return readJson<ActionPackage>(join(fixturesDir, "core", file));
}

async function trustedSigners(): Promise<TrustedSigner[]> {
  const proposer = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "proposer.json"));
  const maintainerA = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "maintainer-a.json"));
  const maintainerB = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "maintainer-b.json"));

  return [
    { did: proposer.did, publicJwk: proposer.publicJwk },
    { did: maintainerA.did, publicJwk: maintainerA.publicJwk },
    { did: maintainerB.did, publicJwk: maintainerB.publicJwk },
  ];
}

describe("verifyApprovalBundle", () => {
  it.each([
    ["valid-no-approval-required.json", 1],
    ["valid-two-approvals.json", 3],
    ["valid-delete-branch.json", 2],
  ])("verifies %s", async (fixtureFile, expectedCount) => {
    const actionPackage = await readActionPackage(fixtureFile);
    const result = await verifyApprovalBundle(
      actionPackage.approvalBundle,
      computeJsonHash(actionPackage.actionEnvelope),
      await trustedSigners(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verifiedApprovals.approvals).toHaveLength(expectedCount);
    }
  });

  it("rejects invalid-bad-signature.json", async () => {
    const actionPackage = await readActionPackage("invalid-bad-signature.json");
    const result = await verifyApprovalBundle(
      actionPackage.approvalBundle,
      computeJsonHash(actionPackage.actionEnvelope),
      await trustedSigners(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_SIGNATURE",
      },
    });
  });

  it("rejects bundle actionEnvelopeHash mismatch", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const tampered = {
      ...actionPackage.approvalBundle,
      actionEnvelopeHash: { alg: "sha-256" as const, value: "tampered" },
    };
    const result = await verifyApprovalBundle(tampered, computeJsonHash(actionPackage.actionEnvelope), await trustedSigners());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_ENVELOPE_HASH_MISMATCH",
      },
    });
  });

  it("rejects approval actionEnvelopeHash mismatch", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const tampered = {
      ...actionPackage.approvalBundle,
      approvals: [
        {
          ...actionPackage.approvalBundle.approvals[0],
          actionEnvelopeHash: { alg: "sha-256" as const, value: "tampered" },
        },
      ],
    };
    const result = await verifyApprovalBundle(tampered, computeJsonHash(actionPackage.actionEnvelope), await trustedSigners());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "APPROVAL_HASH_MISMATCH",
      },
    });
  });

  it("rejects an approval from an untrusted signer", async () => {
    const actionPackage = await readActionPackage("valid-two-approvals.json");
    const allSigners = await trustedSigners();
    // Only keep the proposer key — maintainers are untrusted
    const onlyProposer = allSigners.slice(0, 1);
    const result = await verifyApprovalBundle(actionPackage.approvalBundle, computeJsonHash(actionPackage.actionEnvelope), onlyProposer);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNTRUSTED_SIGNER",
      },
    });
  });
});
