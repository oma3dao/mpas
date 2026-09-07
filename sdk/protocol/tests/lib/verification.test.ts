import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeJsonHash,
  parseActionPackage,
  validateActionEnvelope,
  verifyActionPackage,
  verifyApprovalBundle,
  verifyPayloadBinding,
  type TrustedSigner,
  type VerificationConfig,
} from "../../src/lib/verification.js";
import type { ActionEnvelope, ActionPackage, Did } from "../../src/types/mpas.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: TrustedSigner["publicJwk"];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readFixture(file: string): Promise<unknown> {
  return readJson<unknown>(join(fixturesDir, "verification", file));
}

async function readActionPackage(file: string): Promise<ActionPackage> {
  return readJson<ActionPackage>(join(fixturesDir, "verification", file));
}

async function trustedSigners(): Promise<TrustedSigner[]> {
  const proposer = await readJson<KeyFixture>(join(fixturesDir, "keys", "proposer.json"));
  const maintainerA = await readJson<KeyFixture>(join(fixturesDir, "keys", "maintainer-a.json"));
  const maintainerB = await readJson<KeyFixture>(join(fixturesDir, "keys", "maintainer-b.json"));

  return [
    { did: proposer.did, publicJwk: proposer.publicJwk },
    { did: maintainerA.did, publicJwk: maintainerA.publicJwk },
    { did: maintainerB.did, publicJwk: maintainerB.publicJwk },
  ];
}

async function verificationConfig(): Promise<VerificationConfig> {
  return {
    trustedSigners: await trustedSigners(),
    trustedApplicationDids: ["did:web:github-mirror.example"],
  };
}

async function parseFixture(file: string): Promise<ActionPackage> {
  const result = parseActionPackage(await readFixture(file));
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.actionPackage;
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
    const onlyProposer = allSigners.slice(0, 1);
    const result = await verifyApprovalBundle(
      actionPackage.approvalBundle,
      computeJsonHash(actionPackage.actionEnvelope),
      onlyProposer,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNTRUSTED_SIGNER",
      },
    });
  });
});

describe("verifyActionPackage", () => {
  it.each([
    ["valid-no-approval-required.json", "create_issue_mirror"],
    ["valid-two-approvals.json", "merge_pull_request_mirror"],
    ["valid-delete-branch.json", "delete_branch_mirror"],
    ["insufficient-approvals.json", "merge_pull_request_mirror"],
    ["invalid-disabled-operation.json", "delete_branch_mirror"],
    ["invalid-resource-restricted.json", "create_issue_mirror"],
  ])("verifies structurally signed fixture %s", async (fixtureFile, operationName) => {
    const result = await verifyActionPackage(await parseFixture(fixtureFile), await verificationConfig());

    expect(result).toMatchObject({
      status: "verified",
      applicationDid: "did:web:github-mirror.example",
      operationName,
    });
  });

  it("treats malformed-missing-envelope.json as malformed at parse time", async () => {
    const result = parseActionPackage(await readFixture("malformed-missing-envelope.json"));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ACTION_PACKAGE",
        path: "$.actionEnvelope",
      },
    });
  });

  it.each([
    ["invalid-payload-hash-mismatch.json", "PAYLOAD_HASH_MISMATCH"],
    ["invalid-expired-envelope.json", "EXPIRED_ACTION_ENVELOPE"],
    ["invalid-bad-signature.json", "APPROVAL_BUNDLE_INVALID"],
    ["invalid-unknown-application.json", "UNKNOWN_APPLICATION"],
  ])("rejects %s with %s", async (fixtureFile, code) => {
    const result = await verifyActionPackage(await parseFixture(fixtureFile), await verificationConfig());

    expect(result).toMatchObject({
      status: "rejected",
      code,
    });
  });

  it("rejects an empty approvals array as MALFORMED_APPROVAL_BUNDLE", async () => {
    const pkg = await parseFixture("valid-two-approvals.json");
    const stripped = { ...pkg, approvalBundle: { ...pkg.approvalBundle, approvals: [] } };

    const result = await verifyActionPackage(stripped, await verificationConfig());

    expect(result).toMatchObject({ status: "rejected", code: "MALFORMED_APPROVAL_BUNDLE" });
  });

  it("rejects a missing approvals array as MALFORMED_APPROVAL_BUNDLE instead of throwing", async () => {
    const pkg = await parseFixture("valid-two-approvals.json");
    const bundle = { ...pkg.approvalBundle } as Record<string, unknown>;
    delete bundle.approvals;
    const stripped = { ...pkg, approvalBundle: bundle as unknown as ActionPackage["approvalBundle"] };

    const result = await verifyActionPackage(stripped, await verificationConfig());

    expect(result).toMatchObject({ status: "rejected", code: "MALFORMED_APPROVAL_BUNDLE" });
  });

  it("rejects a bundle whose propose approval is missing (only maintainer approvals present)", async () => {
    const pkg = await parseFixture("valid-two-approvals.json");
    const withoutPropose = {
      ...pkg,
      approvalBundle: {
        ...pkg.approvalBundle,
        approvals: pkg.approvalBundle.approvals.filter((approval) => approval.decision !== "propose"),
      },
    };

    const result = await verifyActionPackage(withoutPropose, await verificationConfig());

    expect(result).toMatchObject({ status: "rejected", code: "MISSING_PROPOSER_APPROVAL" });
  });

  it("rejects a package whose envelope declares a proposer that did not sign the propose approval", async () => {
    const pkg = await parseFixture("valid-two-approvals.json");
    const maintainerA = await readJson<KeyFixture>(join(fixturesDir, "keys", "maintainer-a.json"));
    const impersonated = {
      ...pkg,
      actionEnvelope: { ...pkg.actionEnvelope, proposer: { did: maintainerA.did } },
    };

    const result = await verifyActionPackage(impersonated, await verificationConfig());

    expect(result.status).toBe("rejected");
  });
});
