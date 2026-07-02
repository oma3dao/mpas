import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JWK } from "jose";
import { describe, expect, it } from "vitest";
import { ApprovalBuilder, computeHash, KeyManager, type ActionPackage, type Did } from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: JWK;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("ApprovalBuilder", () => {
  it("builds a verifiable approval bound to a fixture Action Envelope", async () => {
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "action-packages", "valid-merge-pr-package.json"),
    );
    const signer = await readJson<KeyFixture>(join(fixturesDir, "keys", "maintainer-a.json"));
    const keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", "maintainer-a.json"));
    const builder = new ApprovalBuilder({ keyManager });
    const approval = await builder.buildApproval(actionPackage.actionEnvelope, "approve");

    expect(approval).toMatchObject({
      version: "1",
      type: "Approval",
      actionEnvelopeHash: computeHash(actionPackage.actionEnvelope),
      decision: "approve",
    });
    await expect(builder.verifyApproval(approval, signer.publicJwk)).resolves.toBe(true);
  });

  it("returns false for tampered approvals", async () => {
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "action-packages", "valid-delete-branch-package.json"),
    );
    const signer = await readJson<KeyFixture>(join(fixturesDir, "keys", "maintainer-a.json"));
    const keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", "maintainer-a.json"));
    const builder = new ApprovalBuilder({ keyManager });
    const approval = await builder.buildApproval(actionPackage.actionEnvelope, "approve");

    await expect(builder.verifyApproval({ ...approval, decision: "reject" }, signer.publicJwk)).resolves.toBe(false);
    await expect(
      builder.verifyApproval(
        {
          ...approval,
          signature: {
            format: "jws",
            value: `${approval.signature.value.split(".").slice(0, 2).join(".")}.invalid`,
          },
        },
        signer.publicJwk,
      ),
    ).resolves.toBe(false);
  });
});
