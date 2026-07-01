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
    { did: proposer.did, roles: ["proposer"], publicJwk: proposer.publicJwk },
    { did: maintainerA.did, roles: ["maintainer"], publicJwk: maintainerA.publicJwk },
    { did: maintainerB.did, roles: ["maintainer"], publicJwk: maintainerB.publicJwk },
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
    ["valid-no-approval-required.json", "create_issue"],
    ["valid-two-approvals.json", "merge_pull_request"],
    ["valid-delete-branch.json", "delete_branch"],
    ["insufficient-approvals.json", "merge_pull_request"],
    ["invalid-disabled-operation.json", "delete_branch"],
    ["invalid-resource-restricted.json", "create_issue"],
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
});
