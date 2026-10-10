import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactVerify, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it } from "vitest";
import type { ActionPackage, Approval, CanonicalApprovalPayload, Hash } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL(".", import.meta.url));
const validFixtureFiles = [
  "valid-no-approval-required.json",
  "valid-two-approvals.json",
  "valid-delete-branch.json",
];

interface SigningKeyFixture {
  label: string;
  did: string;
  publicJwk: JWK;
}

function hashJson(value: unknown): Hash {
  return {
    alg: "sha-256",
    value: createHash("sha256").update(canonicalize(value)).digest("base64url"),
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readSigningKeys(): Promise<Map<string, SigningKeyFixture>> {
  const keyFiles = ["proposer.json", "maintainer-a.json", "maintainer-b.json"];
  const entries = await Promise.all(
    keyFiles.map(async (file) => {
      const key = await readJson<SigningKeyFixture>(join(fixturesDir, "test-keys", file));
      return [key.did, key] as const;
    }),
  );

  return new Map(entries);
}

async function verifyApproval(approval: Approval, keysByDid: Map<string, SigningKeyFixture>): Promise<void> {
  expect(approval.signature.format).toBe("jws");

  const [encodedHeader] = approval.signature.value.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { alg?: string };
  expect(header.alg).toBe("EdDSA");
  expect(header.alg).not.toBe("none");

  const untrustedPayload = JSON.parse(
    Buffer.from(approval.signature.value.split(".")[1], "base64url").toString("utf8"),
  ) as CanonicalApprovalPayload;
  const key = keysByDid.get(untrustedPayload.signerDid ?? "");
  expect(key, `missing key for ${untrustedPayload.signerDid}`).toBeDefined();

  const cryptoKey = await importJWK(key!.publicJwk, "EdDSA");
  const { payload } = await compactVerify(approval.signature.value, cryptoKey);
  const verifiedPayload = JSON.parse(Buffer.from(payload).toString("utf8")) as CanonicalApprovalPayload;

  expect(verifiedPayload.type).toBe("ApprovalPayload");
  expect(verifiedPayload.actionEnvelopeHash).toEqual(approval.actionEnvelopeHash);
  expect(verifiedPayload.decision).toBe(approval.decision);
  expect(verifiedPayload.createdAt).toBe(approval.createdAt);
}

describe("valid Action Package fixtures", () => {
  it.each(validFixtureFiles)("%s has consistent hashes and verifiable approvals", async (fixtureFile) => {
    const keysByDid = await readSigningKeys();
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", fixtureFile));

    expect(actionPackage.type).toBe("ActionPackage");
    expect(actionPackage.actionEnvelope.executionPayloadHash).toEqual(hashJson(actionPackage.executionPayload));

    const actionEnvelopeHash = hashJson(actionPackage.actionEnvelope);
    expect(actionPackage.approvalBundle.actionEnvelopeHash).toEqual(actionEnvelopeHash);
    expect(actionPackage.approvalBundle.approvals.length).toBeGreaterThanOrEqual(1);

    for (const approval of actionPackage.approvalBundle.approvals) {
      expect(approval.actionEnvelopeHash).toEqual(actionEnvelopeHash);
      await verifyApproval(approval, keysByDid);
    }
  });
});
