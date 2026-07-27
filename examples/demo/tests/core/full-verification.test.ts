import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseActionPackage,
  verifyActionPackage,
  type TrustedSigner,
  type VerificationConfig,
} from "../../src/core/verification.js";
import type { ActionPackage, Did } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

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
    trustedApplicationDids: ["did:web:github.example"],
  };
}

async function parseFixture(file: string): Promise<ActionPackage> {
  const result = parseActionPackage(await readFixture(file));
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.actionPackage;
}

describe("verifyActionPackage", () => {
  it.each([
    ["valid-no-approval-required.json", "create_issue_demo"],
    ["valid-two-approvals.json", "merge_pull_request_demo"],
    ["valid-delete-branch.json", "delete_branch_demo"],
    ["insufficient-approvals.json", "merge_pull_request_demo"],
    ["invalid-disabled-operation.json", "delete_branch_demo"],
    ["invalid-resource-restricted.json", "create_issue_demo"],
  ])("verifies core-valid fixture %s", async (fixtureFile, operationName) => {
    const result = await verifyActionPackage(await parseFixture(fixtureFile), await verificationConfig());

    expect(result).toMatchObject({
      status: "verified",
      applicationDid: "did:web:github.example",
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
    const maintainerA = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "maintainer-a.json"));
    // Claim a different (trusted) DID as proposer without re-signing anything.
    const impersonated = {
      ...pkg,
      actionEnvelope: { ...pkg.actionEnvelope, proposer: { did: maintainerA.did } },
    };

    const result = await verifyActionPackage(impersonated, await verificationConfig());

    // Mutating the envelope breaks the envelope-hash binding first; either way
    // the impersonation must be rejected, never verified.
    expect(result.status).toBe("rejected");
  });
});
