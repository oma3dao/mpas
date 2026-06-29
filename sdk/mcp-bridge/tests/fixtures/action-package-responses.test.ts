import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactVerify, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it } from "vitest";
import type {
  ActionPackage,
  AdapterResponse,
  CanonicalApprovalPayload,
  CoordinationPollResponse,
  Did,
  HashObject,
  ReceiptPayload,
  SignerReviewSet,
} from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL(".", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: JWK;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function computeHash(value: unknown): HashObject {
  return {
    alg: "sha-256",
    value: createHash("sha256").update(canonicalize(value)).digest("base64url"),
  };
}

function expectHashEqual(actual: HashObject, expected: HashObject): void {
  expect(actual).toEqual(expected);
}

describe("Action Package and response fixtures", () => {
  it("Action Package fixtures have correct hash bindings and verifiable approval signatures", async () => {
    const keyFiles = ["proposer.json", "maintainer-a.json", "maintainer-b.json"];
    const keys = await Promise.all(keyFiles.map((file) => readJson<KeyFixture>(join(fixturesDir, "keys", file))));

    for (const file of [
      "valid-create-issue-package.json",
      "valid-merge-pr-package.json",
      "valid-delete-branch-package.json",
    ]) {
      const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "action-packages", file));
      const actionEnvelopeHash = computeHash(actionPackage.actionEnvelope);

      expectHashEqual(actionPackage.actionEnvelope.executionPayloadHash, computeHash(actionPackage.executionPayload));
      expectHashEqual(actionPackage.approvalBundle.actionEnvelopeHash, actionEnvelopeHash);

      for (const approval of actionPackage.approvalBundle.approvals) {
        expectHashEqual(approval.actionEnvelopeHash, actionEnvelopeHash);

        let approvalPayload: CanonicalApprovalPayload | undefined;
        for (const key of keys) {
          try {
            const publicKey = await importJWK(key.publicJwk, "EdDSA");
            const verified = await compactVerify(approval.signature.value, publicKey);
            approvalPayload = JSON.parse(Buffer.from(verified.payload).toString("utf8")) as CanonicalApprovalPayload;
            break;
          } catch {
            continue;
          }
        }

        expect(approvalPayload, `no trusted key verified approval in ${file}`).toBeDefined();
        expect(approvalPayload).toMatchObject({
          type: "ApprovalPayload",
          actionEnvelopeHash,
          decision: approval.decision,
        });
      }
    }
  });

  it("adapter response fixtures are valid JSON and receipts verify against the adapter key", async () => {
    const createIssuePackage = await readJson<ActionPackage>(
      join(fixturesDir, "action-packages", "valid-create-issue-package.json"),
    );
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "keys", "adapter.json"));
    const adapterPublicKey = await importJWK(adapter.publicJwk, "EdDSA");

    const executed = await readJson<AdapterResponse>(join(fixturesDir, "responses", "adapter-response-executed.json"));
    const needsApprovals = await readJson<AdapterResponse>(
      join(fixturesDir, "responses", "adapter-response-needs-approvals.json"),
    );
    const rejected = await readJson<AdapterResponse>(join(fixturesDir, "responses", "adapter-response-rejected.json"));

    expect(executed.result).toBe("executed");
    if (executed.result === "executed" && executed.executionReceipt) {
      const verified = await compactVerify(executed.executionReceipt.signature, adapterPublicKey);
      const receiptPayload = JSON.parse(Buffer.from(verified.payload).toString("utf8")) as ReceiptPayload;

      expect(receiptPayload).toMatchObject({
        issuerDid: adapter.did,
        actionEnvelopeHash: computeHash(createIssuePackage.actionEnvelope),
        executionPayloadHash: computeHash(createIssuePackage.executionPayload),
        result: "executed",
      });
    }

    expect(needsApprovals.result).toBe("additionalApprovalsRequired");
    if (needsApprovals.result === "additionalApprovalsRequired") {
      expect(needsApprovals.authorizationRequirements.result).toBe("additionalApprovalsRequired");
      expectHashEqual(needsApprovals.authorizationRequirements.actionEnvelopeHash, computeHash(createIssuePackage.actionEnvelope));
    }

    expect(rejected.result).toBe("rejected");
    if (rejected.result === "rejected" && rejected.executionReceipt) {
      const verified = await compactVerify(rejected.executionReceipt.signature, adapterPublicKey);
      const receiptPayload = JSON.parse(Buffer.from(verified.payload).toString("utf8")) as ReceiptPayload;

      expect(receiptPayload.result).toBe("rejected");
    }
  });

  it("coordination fixtures reference the same reviewable action", async () => {
    const pending = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const reviewSet = await readJson<SignerReviewSet>(join(fixturesDir, "responses", "coordination-review-set.json"));
    const approvalRequest = pending.approvalRequests[0];

    expect(pending.approvalRequests).toHaveLength(1);
    expect(approvalRequest.actionRef).toMatchObject({
      actionId: reviewSet.actionEnvelope.actionId,
      actionEnvelopeHash: computeHash(reviewSet.actionEnvelope),
    });
    expect(approvalRequest.signerReviewSet).toEqual(reviewSet);
    expectHashEqual(reviewSet.actionEnvelope.executionPayloadHash, computeHash(reviewSet.executionPayload));
  });
});
