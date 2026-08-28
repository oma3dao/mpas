/**
 * Approval counting — mpas-profile-policy-json.md §6.5.
 *
 * §6.5 states five counting rules for threshold requirements. This file has one
 * describe block per rule. Every approval is really signed by a fixture key and
 * really passed through verifyApprovalBundle, so the VerifiedApprovals handed to
 * evaluatePolicy are the ones the Verifier itself would produce.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "json-canonicalize";
import { beforeAll, describe, expect, it } from "vitest";
import { KeyManager, computeHash } from "../../src/index.js";
import type { ActionEnvelope, ActionPackage, Approval, Did } from "../../src/types/mpas.js";
import { evaluatePolicy, type PolicyConfig } from "../../src/lib/policy-engine.js";
import {
  verifyApprovalBundle,
  type TrustedSigner,
  type VerifiedApprovals,
} from "../../src/lib/verification.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

let mergePackage: ActionPackage;
let otherPackage: ActionPackage;
let proposerKeys: KeyManager;
let maintainerAKeys: KeyManager;
let maintainerBKeys: KeyManager;
let strangerKeys: KeyManager;

let proposerDid: Did;
let maintainerA: Did;
let maintainerB: Did;
let stranger: Did;

let trustedSigners: TrustedSigner[];

async function readJson<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await readFile(join(fixturesDir, ...segments), "utf8")) as T;
}

beforeAll(async () => {
  mergePackage = await readJson<ActionPackage>("action-packages", "valid-merge-pr-package.json");
  otherPackage = await readJson<ActionPackage>("action-packages", "valid-delete-branch-package.json");

  [proposerKeys, maintainerAKeys, maintainerBKeys, strangerKeys] = await Promise.all([
    KeyManager.fromFile(join(fixturesDir, "keys", "proposer.json")),
    KeyManager.fromFile(join(fixturesDir, "keys", "maintainer-a.json")),
    KeyManager.fromFile(join(fixturesDir, "keys", "maintainer-b.json")),
    KeyManager.fromFile(join(fixturesDir, "keys", "adapter.json")),
  ]);

  proposerDid = proposerKeys.did;
  maintainerA = maintainerAKeys.did;
  maintainerB = maintainerBKeys.did;
  stranger = strangerKeys.did;

  trustedSigners = [proposerDid, maintainerA, maintainerB, stranger].map((did) => ({ did }));
});

/**
 * Signs one Approval with an explicit createdAt. ApprovalBuilder stamps
 * createdAt from the clock, and two of these tests need two Approvals from one
 * key that differ only in that field. The payload shape is ApprovalBuilder's.
 */
async function approvalAt(
  keys: KeyManager,
  envelope: ActionEnvelope,
  decision: "approve" | "reject",
  createdAt: string,
): Promise<Approval> {
  const actionEnvelopeHash = computeHash(envelope);
  const payload = {
    type: "ApprovalPayload" as const,
    actionEnvelopeHash,
    decision,
    signerDid: keys.did,
    createdAt,
  };
  const signature = await keys.sign(Buffer.from(canonicalize(payload)));
  return {
    version: "1",
    type: "Approval",
    actionEnvelopeHash,
    decision,
    signature: { format: "jws", value: signature },
    createdAt,
  };
}

/** Runs the real bundle verifier and returns what it produces. Fails the test if it rejects. */
async function verified(approvals: Approval[]): Promise<VerifiedApprovals> {
  const envelopeHash = computeHash(mergePackage.actionEnvelope);
  const result = await verifyApprovalBundle(
    { ...mergePackage.approvalBundle, actionEnvelopeHash: envelopeHash, approvals },
    envelopeHash,
    trustedSigners,
  );
  if (!result.ok) {
    throw new Error(`bundle verification rejected: ${result.error.code}`);
  }
  return result.verifiedApprovals;
}

function policyFor(threshold: number, maintainers: Did[]): PolicyConfig {
  return {
    defaultRequirement: { type: "proposerOnly" },
    signerGroups: { all: [proposerDid, maintainerA, maintainerB, stranger], maintainers },
    policies: {
      merge_pull_request: [
        {
          requirements: {
            type: "threshold",
            threshold,
            eligibleSignerGroup: "maintainers",
            decision: "approve",
          },
        },
      ],
    },
  };
}

describe("§6.5 approval counting — control", () => {
  it("counts two Approvals from two distinct Signers as satisfying threshold 2", async () => {
    const approvals = await verified([
      await approvalAt(maintainerAKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:01:00.000Z"),
      await approvalAt(maintainerBKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:02:00.000Z"),
    ]);

    expect(evaluatePolicy(mergePackage, approvals, policyFor(2, [maintainerA, maintainerB])).status).toBe(
      "satisfied",
    );
  });

  it("leaves threshold 2 unsatisfied on a single Approval", async () => {
    const approvals = await verified([
      await approvalAt(maintainerAKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:01:00.000Z"),
    ]);

    expect(evaluatePolicy(mergePackage, approvals, policyFor(2, [maintainerA, maintainerB])).status).toBe(
      "additionalApprovalsRequired",
    );
  });
});

describe("§6.5 rule 4 — duplicate Approvals from the same Signer MUST NOT be counted twice", () => {
  it("does not let one Signer satisfy threshold 2 with two distinct valid Approvals", async () => {
    const approvals = await verified([
      await approvalAt(maintainerAKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:01:00.000Z"),
      await approvalAt(maintainerAKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:02:00.000Z"),
    ]);

    expect(approvals.approvals).toHaveLength(2);
    expect(evaluatePolicy(mergePackage, approvals, policyFor(2, [maintainerA, maintainerB])).status).toBe(
      "additionalApprovalsRequired",
    );
  });

  it("does not let one Signer satisfy threshold 2 with the same Approval replayed", async () => {
    const once = await approvalAt(
      maintainerAKeys,
      mergePackage.actionEnvelope,
      "approve",
      "2026-06-05T18:01:00.000Z",
    );
    const approvals = await verified([once, once]);

    expect(evaluatePolicy(mergePackage, approvals, policyFor(2, [maintainerA, maintainerB])).status).toBe(
      "additionalApprovalsRequired",
    );
  });

  it("reports distinct Signers, not Approvals, in the unsatisfied count", async () => {
    const approvals = await verified([
      await approvalAt(maintainerAKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:01:00.000Z"),
      await approvalAt(maintainerAKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:02:00.000Z"),
    ]);

    const result = evaluatePolicy(mergePackage, approvals, policyFor(3, [maintainerA, maintainerB]));
    expect(result.status).toBe("additionalApprovalsRequired");
    if (result.status !== "additionalApprovalsRequired") return;
    expect(result.unsatisfiedRules[0].found).toBe(1);
  });
});

describe("§6.5 rule 1 — only Approvals binding to the computed Action Envelope hash may be counted", () => {
  it("rejects the bundle when an Approval binds to a different Action Envelope", async () => {
    const envelopeHash = computeHash(mergePackage.actionEnvelope);
    const foreign = await approvalAt(
      maintainerAKeys,
      otherPackage.actionEnvelope,
      "approve",
      "2026-06-05T18:01:00.000Z",
    );

    const result = await verifyApprovalBundle(
      { ...mergePackage.approvalBundle, actionEnvelopeHash: envelopeHash, approvals: [foreign] },
      envelopeHash,
      trustedSigners,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("APPROVAL_HASH_MISMATCH");
  });
});

describe("§6.5 rule 2 — only Approvals with the required decision may be counted", () => {
  it("does not count a reject Approval toward an approve threshold", async () => {
    const approvals = await verified([
      await approvalAt(maintainerAKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:01:00.000Z"),
      await approvalAt(maintainerBKeys, mergePackage.actionEnvelope, "reject", "2026-06-05T18:02:00.000Z"),
    ]);

    expect(evaluatePolicy(mergePackage, approvals, policyFor(2, [maintainerA, maintainerB])).status).toBe(
      "additionalApprovalsRequired",
    );
  });
});

describe("§6.5 rule 3 — only Approvals from eligible Signers may be counted", () => {
  it("does not count an Approval from a Signer outside the eligible group", async () => {
    const approvals = await verified([
      await approvalAt(maintainerAKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:01:00.000Z"),
      await approvalAt(strangerKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:02:00.000Z"),
    ]);

    expect(evaluatePolicy(mergePackage, approvals, policyFor(2, [maintainerA, maintainerB])).status).toBe(
      "additionalApprovalsRequired",
    );
  });
});

describe("§6.5 rule 5 — an Approval from the Proposer MUST NOT count toward a threshold", () => {
  it("does not count the Proposer's own approve Approval even inside the eligible group", async () => {
    const approvals = await verified([
      await approvalAt(maintainerAKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:01:00.000Z"),
      await approvalAt(proposerKeys, mergePackage.actionEnvelope, "approve", "2026-06-05T18:02:00.000Z"),
    ]);

    expect(evaluatePolicy(mergePackage, approvals, policyFor(2, [proposerDid, maintainerA])).status).toBe(
      "additionalApprovalsRequired",
    );
  });
});
