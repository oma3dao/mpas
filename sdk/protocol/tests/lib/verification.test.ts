import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseActionPackage,
  verifyActionPackage,
  type TrustedSigner,
  type VerificationConfig,
} from "../../src/lib/verification.js";
import type { ActionPackage, Did } from "../../src/types/mpas.js";

/** Shared monorepo fixtures — demo owns the signed Action Package corpus. */
const fixturesDir = fileURLToPath(new URL("../../../../examples/demo/tests/fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: TrustedSigner["publicJwk"];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readFixture(file: string): Promise<unknown> {
  return readJson<unknown>(join(fixturesDir, "core", file));
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

describe("verifyActionPackage (sdk)", () => {
  it.each([
    ["valid-no-approval-required.json", "create_issue_mirror"],
    ["valid-two-approvals.json", "merge_pull_request_mirror"],
    ["valid-delete-branch.json", "delete_branch_mirror"],
    ["insufficient-approvals.json", "merge_pull_request_mirror"],
    ["invalid-disabled-operation.json", "delete_branch_mirror"],
    ["invalid-resource-restricted.json", "create_issue_mirror"],
  ])("verifies core-valid fixture %s", async (fixtureFile, operationName) => {
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

  it("rejects a bundle whose propose approval is missing", async () => {
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

  it("rejects a package whose envelope declares a proposer that did not sign", async () => {
    const pkg = await parseFixture("valid-two-approvals.json");
    const maintainerA = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "maintainer-a.json"));
    const impersonated = {
      ...pkg,
      actionEnvelope: { ...pkg.actionEnvelope, proposer: { did: maintainerA.did } },
    };

    const result = await verifyActionPackage(impersonated, await verificationConfig());

    expect(result.status).toBe("rejected");
  });

  it("rejects structurally malformed approvals in the bundle", async () => {
    const pkg = await parseFixture("valid-no-approval-required.json");
    const cases = [
      { approvals: ["not-an-object"] },
      { approvals: [{ ...pkg.approvalBundle.approvals[0], decision: 1 }] },
      { approvals: [{ ...pkg.approvalBundle.approvals[0], createdAt: 1 }] },
      { approvals: [{ ...pkg.approvalBundle.approvals[0], signature: "bad" }] },
      { approvals: [{ ...pkg.approvalBundle.approvals[0], actionEnvelopeHash: "bad" }] },
      { actionEnvelopeHash: "bad", approvals: pkg.approvalBundle.approvals },
    ];

    for (const patch of cases) {
      const result = await verifyActionPackage(
        { ...pkg, approvalBundle: { ...pkg.approvalBundle, ...patch } as ActionPackage["approvalBundle"] },
        await verificationConfig(),
      );
      expect(result).toMatchObject({ status: "rejected", code: "MALFORMED_APPROVAL_BUNDLE" });
    }
  });

  it("rejects a non-object approval bundle", async () => {
    const pkg = await parseFixture("valid-no-approval-required.json");
    const result = await verifyActionPackage(
      { ...pkg, approvalBundle: null as unknown as ActionPackage["approvalBundle"] },
      await verificationConfig(),
    );
    expect(result).toMatchObject({ status: "rejected", code: "MALFORMED_APPROVAL_BUNDLE" });
  });

  it("verifies without an explicit trustedApplicationDids allow-list", async () => {
    const result = await verifyActionPackage(await parseFixture("valid-no-approval-required.json"), {
      trustedSigners: await trustedSigners(),
    });
    expect(result).toMatchObject({
      status: "verified",
      operationName: "create_issue_mirror",
    });
  });

  it("reports UNKNOWN_APPLICATION through onStep when the target DID is not trusted", async () => {
    const steps: Array<{ step: string; passed: boolean }> = [];
    const result = await verifyActionPackage(await parseFixture("valid-no-approval-required.json"), {
      trustedSigners: await trustedSigners(),
      trustedApplicationDids: ["did:web:other.example"],
      onStep: (step, passed) => {
        steps.push({ step, passed });
      },
    });
    expect(result).toMatchObject({ status: "rejected", code: "UNKNOWN_APPLICATION" });
    expect(steps.some((entry) => entry.step.includes("application") && entry.passed === false)).toBe(true);
  });

  it("rejects envelopes missing createdAt during structural validation", async () => {
    const pkg = await parseFixture("valid-no-approval-required.json");
    delete (pkg.actionEnvelope as { createdAt?: string }).createdAt;
    const { validateActionEnvelope } = await import("../../src/lib/verification.js");
    expect(validateActionEnvelope(pkg.actionEnvelope, { checkExpiry: false })).toMatchObject({
      ok: false,
      error: { code: "INVALID_ACTION_ENVELOPE", path: expect.stringContaining("createdAt") },
    });
  });

  it("omits operationName when the execution payload has no string name", async () => {
    const { ActionPackageBuilder, KeyManager } = await import("../../src/index.js");
    const keyManager = await KeyManager.fromFile(join(fixturesDir, "test-keys", "proposer.json"));
    const builder = new ActionPackageBuilder({
      keyManager,
      applicationDid: "did:web:github-mirror.example",
      executionProfile: { id: "did:web:profiles.oma3.org:mcp", format: "mcp.toolsCall" },
    });
    const payload = { notName: true } as never;
    const envelope = builder.buildEnvelope(payload);
    const approval = await builder.signProposerApproval(envelope);
    const pkg = builder.assemblePackage(payload, envelope, approval);

    const result = await verifyActionPackage(pkg, {
      trustedSigners: await trustedSigners(),
      trustedApplicationDids: ["did:web:github-mirror.example"],
    });
    expect(result).toMatchObject({ status: "verified", operationName: undefined });
  });
});
