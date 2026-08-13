import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeJsonHash,
  verifyActionPackage,
  verifyApprovalBundle,
  verifyApprovalSignature,
  type TrustedSigner,
} from "../../src/lib/verification.js";
import type { ActionPackage, Approval, CanonicalApprovalPayload, Did } from "../../src/types/mpas.js";

const fixturesDir = fileURLToPath(new URL("../../../../examples/demo/tests/fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: TrustedSigner["publicJwk"];
}

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

describe("verifyApprovalSignature (sdk)", () => {
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
    // {"alg":"HS256"} base64url
    const approval: Approval = {
      version: "1",
      type: "Approval",
      actionEnvelopeHash: { alg: "sha-256", value: "test" },
      decision: "approve",
      signature: {
        format: "jws",
        value: "eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiQXBwcm92YWxQYXlsb2FkIn0.sig",
      },
      createdAt: "2026-06-05T18:00:00.000Z",
    };

    await expect(verifyApprovalSignature(approval, key.publicJwk)).resolves.toBe(false);
  });

  it("rejects non-jws signature formats", async () => {
    const key = await readJson<SigningKeyFixture>(join(fixturesDir, "test-keys", "proposer.json"));
    const approval: Approval = {
      version: "1",
      type: "Approval",
      actionEnvelopeHash: { alg: "sha-256", value: "test" },
      decision: "approve",
      signature: {
        format: "detached" as never,
        value: "unused",
      },
      createdAt: "2026-06-05T18:00:00.000Z",
    };

    await expect(verifyApprovalSignature(approval, key.publicJwk)).resolves.toBe(false);
  });
});

describe("verifyApprovalBundle (sdk)", () => {
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

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_SIGNATURE" } });
  });

  it("rejects bundle actionEnvelopeHash mismatch", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const tampered = {
      ...actionPackage.approvalBundle,
      actionEnvelopeHash: { alg: "sha-256" as const, value: "tampered" },
    };
    const result = await verifyApprovalBundle(
      tampered,
      computeJsonHash(actionPackage.actionEnvelope),
      await trustedSigners(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "ACTION_ENVELOPE_HASH_MISMATCH" } });
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
    const result = await verifyApprovalBundle(
      tampered,
      computeJsonHash(actionPackage.actionEnvelope),
      await trustedSigners(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "APPROVAL_HASH_MISMATCH" } });
  });

  it("rejects an approval from an untrusted signer", async () => {
    const actionPackage = await readActionPackage("valid-two-approvals.json");
    const onlyProposer = (await trustedSigners()).slice(0, 1);
    const result = await verifyApprovalBundle(
      actionPackage.approvalBundle,
      computeJsonHash(actionPackage.actionEnvelope),
      onlyProposer,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "UNTRUSTED_SIGNER" } });
  });

  it("rejects when top-level Approval fields disagree with the signed payload", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const tampered = {
      ...actionPackage.approvalBundle,
      approvals: [
        {
          ...actionPackage.approvalBundle.approvals[0],
          decision: "reject" as const,
        },
      ],
    };
    const result = await verifyApprovalBundle(
      tampered,
      computeJsonHash(actionPackage.actionEnvelope),
      await trustedSigners(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "APPROVAL_PAYLOAD_MISMATCH" } });
  });

  it("rejects when a trusted signer has no resolvable verification key", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const hash = computeJsonHash(actionPackage.actionEnvelope);
    const payload = Buffer.from(
      JSON.stringify({
        type: "ApprovalPayload",
        actionEnvelopeHash: hash,
        decision: "approve",
        signerDid: "did:web:unkeyed.example",
        createdAt: "2026-06-05T18:02:00.000Z",
      }),
    ).toString("base64url");
    const bundle = {
      ...actionPackage.approvalBundle,
      approvals: [
        {
          version: "1" as const,
          type: "Approval" as const,
          actionEnvelopeHash: hash,
          decision: "approve" as const,
          signature: { format: "jws" as const, value: `eyJhbGciOiJFZERTQSJ9.${payload}.sig` },
          createdAt: "2026-06-05T18:02:00.000Z",
        },
      ],
    };
    const result = await verifyApprovalBundle(bundle, hash, [{ did: "did:web:unkeyed.example" as Did }]);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNTRUSTED_SIGNER",
        message: expect.stringContaining("No verification key"),
      },
    });
  });

  it("rejects undecodable approval payloads as untrusted", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const garbage = {
      ...actionPackage.approvalBundle,
      approvals: [
        {
          ...actionPackage.approvalBundle.approvals[0],
          signature: { format: "jws" as const, value: "not-a-jws" },
        },
      ],
    };
    const result = await verifyApprovalBundle(
      garbage,
      computeJsonHash(actionPackage.actionEnvelope),
      await trustedSigners(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "UNTRUSTED_SIGNER" } });
  });

  it("rejects a non-jws approval signature as INVALID_SIGNATURE", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const approval = actionPackage.approvalBundle.approvals[0];
    const badFormat = {
      ...actionPackage.approvalBundle,
      approvals: [
        {
          ...approval,
          signature: { format: "raw" as const, value: approval.signature.value },
        },
      ],
    };
    const result = await verifyApprovalBundle(
      badFormat,
      computeJsonHash(actionPackage.actionEnvelope),
      await trustedSigners(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_SIGNATURE" } });
  });
});

describe("verifyActionPackage onStep (sdk)", () => {
  it("emits verification step callbacks", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const steps: Array<{ step: string; passed: boolean }> = [];

    const result = await verifyActionPackage(actionPackage, {
      trustedSigners: await trustedSigners(),
      trustedApplicationDids: ["did:web:github-mirror.example"],
      onStep: (step, passed) => {
        steps.push({ step, passed });
      },
    });

    expect(result.status).toBe("verified");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((entry) => typeof entry.step === "string")).toBe(true);
    expect(steps.some((entry) => entry.passed)).toBe(true);
  });

  it("emits a failing step for an expired envelope", async () => {
    const actionPackage = await readActionPackage("invalid-expired-envelope.json");
    const steps: Array<{ step: string; passed: boolean; code?: string }> = [];

    const result = await verifyActionPackage(actionPackage, {
      trustedSigners: await trustedSigners(),
      trustedApplicationDids: ["did:web:github-mirror.example"],
      onStep: (step, passed, details) => {
        steps.push({ step, passed, code: details?.code as string | undefined });
      },
    });

    expect(result.status).toBe("rejected");
    expect(steps.some((entry) => entry.passed === false)).toBe(true);
  });
});
