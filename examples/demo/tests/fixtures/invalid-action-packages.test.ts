import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactVerify, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it } from "vitest";
import type { ActionPackage, CanonicalApprovalPayload, Hash } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL(".", import.meta.url));

interface SigningKeyFixture {
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

function decodeApprovalPayload(jws: string): CanonicalApprovalPayload {
  return JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString("utf8")) as CanonicalApprovalPayload;
}

describe("invalid Action Package fixtures", () => {
  it.each([
    "malformed-missing-envelope.json",
    "invalid-payload-hash-mismatch.json",
    "invalid-expired-envelope.json",
    "invalid-bad-signature.json",
    "insufficient-approvals.json",
    "invalid-unknown-application.json",
    "invalid-disabled-operation.json",
    "invalid-resource-restricted.json",
  ])("%s is valid JSON", async (fixtureFile) => {
    await expect(readJson<unknown>(join(fixturesDir, "core", fixtureFile))).resolves.toBeDefined();
  });

  it("malformed-missing-envelope.json omits the Action Envelope", async () => {
    const fixture = await readJson<Partial<ActionPackage>>(
      join(fixturesDir, "core", "malformed-missing-envelope.json"),
    );

    expect(fixture.executionPayload).toBeDefined();
    expect(fixture.actionEnvelope).toBeUndefined();
    expect(fixture.approvalBundle).toBeDefined();
  });

  it("invalid-payload-hash-mismatch.json has only a payload hash mismatch", async () => {
    const fixture = await readJson<ActionPackage>(join(fixturesDir, "core", "invalid-payload-hash-mismatch.json"));

    expect(fixture.actionEnvelope.executionPayloadHash).not.toEqual(hashJson(fixture.executionPayload));
    expect(fixture.approvalBundle.actionEnvelopeHash).toEqual(hashJson(fixture.actionEnvelope));
  });

  it("invalid-expired-envelope.json has an envelope expiry in the past", async () => {
    const fixture = await readJson<ActionPackage>(join(fixturesDir, "core", "invalid-expired-envelope.json"));

    expect(new Date(fixture.actionEnvelope.createdAt).getTime()).toBeLessThan(
      new Date(fixture.actionEnvelope.expiresAt).getTime(),
    );
    expect(new Date(fixture.actionEnvelope.expiresAt).getTime()).toBeLessThan(
      new Date("2026-06-05T00:00:00.000Z").getTime(),
    );
  });

  it("invalid-bad-signature.json has a signature that does not verify", async () => {
    const fixture = await readJson<ActionPackage>(join(fixturesDir, "core", "invalid-bad-signature.json"));
    const approval = fixture.approvalBundle.approvals[0];
    const payload = decodeApprovalPayload(approval.signature.value);
    const keysByDid = await readSigningKeys();
    const key = keysByDid.get(payload.signerDid ?? "");

    expect(key).toBeDefined();
    const cryptoKey = await importJWK(key!.publicJwk, "EdDSA");
    await expect(compactVerify(approval.signature.value, cryptoKey)).rejects.toThrow();
  });

  it("insufficient-approvals.json is a main-branch merge with only proposer approval", async () => {
    const fixture = await readJson<ActionPackage>(join(fixturesDir, "core", "insufficient-approvals.json"));

    expect(fixture.executionPayload).toMatchObject({
      name: "merge_pull_request_demo",
      arguments: { baseRef: "main" },
    });
    expect(fixture.approvalBundle.approvals).toHaveLength(1);
    expect(fixture.approvalBundle.approvals[0].decision).toBe("propose");
  });

  it("invalid-unknown-application.json targets an unconfigured application DID", async () => {
    const fixture = await readJson<ActionPackage>(join(fixturesDir, "core", "invalid-unknown-application.json"));

    expect(fixture.actionEnvelope.target.applicationDid).toBe("did:web:unknown-github.example");
    expect(fixture.actionEnvelope.executionPayloadHash).toEqual(hashJson(fixture.executionPayload));
  });

  it("invalid-disabled-operation.json requests the disabled delete branch operation", async () => {
    const fixture = await readJson<ActionPackage>(join(fixturesDir, "core", "invalid-disabled-operation.json"));

    expect(fixture.executionPayload).toMatchObject({
      name: "delete_branch_demo",
      arguments: { branch: "feature/disabled-operation" },
    });
    expect(fixture.actionEnvelope.executionPayloadHash).toEqual(hashJson(fixture.executionPayload));
  });

  it("invalid-resource-restricted.json names a repository outside allowed resources", async () => {
    const fixture = await readJson<ActionPackage>(join(fixturesDir, "core", "invalid-resource-restricted.json"));

    expect(fixture.actionEnvelope.target.resource).toBe("repo:outside-org/restricted-repo");
    expect(fixture.executionPayload).toMatchObject({
      arguments: {
        owner: "outside-org",
        repo: "restricted-repo",
      },
    });
    expect(fixture.actionEnvelope.executionPayloadHash).toEqual(hashJson(fixture.executionPayload));
  });
});
