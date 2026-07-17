import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it } from "vitest";
import { CoordinationStore, CoordinationStoreError } from "../../src/coordination/store.js";
import type { CoordinationActionRequest } from "../../src/coordination/types.js";
import type { ActionPackage, Approval, Decision, Did, Hash } from "../../src/core/types.js";
import { computeJsonHash } from "../../src/core/verification.js";

interface FixtureKey {
  did: Did;
  kid: string;
  privateJwk: JWK;
}

const adapterDid = "did:web:adapter.local" as Did;

describe("CoordinationStore", () => {
  it("stores pending actions and returns signer-specific approval requests", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore();

    const result = store.submitAction(request);
    const maintainerPoll = store.poll((await fixtureKey("maintainer-a")).did);
    const outsiderPoll = store.poll("did:web:agents.example:outsider" as Did);

    expect(result.created).toBe(true);
    expect(result.response.state).toBe("awaitingApprovals");
    expect(maintainerPoll.approvalRequests).toHaveLength(1);
    expect(maintainerPoll.approvalRequests[0].signerReviewSet.authorizationRequirements).toBe(
      request.authorizationRequirements,
    );
    expect(outsiderPoll.approvalRequests).toHaveLength(0);
  });

  it("rejects action ID conflicts with different envelope hashes", async () => {
    const request = await coordinationActionRequest();
    const conflictingPackage = structuredClone(request.actionPackage);
    conflictingPackage.actionEnvelope.expiresAt = "2030-01-02T00:00:00.000Z";
    conflictingPackage.approvalBundle.actionEnvelopeHash = computeJsonHash(conflictingPackage.actionEnvelope);
    const store = new CoordinationStore();

    store.submitAction(request);

    expect(() =>
      store.submitAction({
        ...request,
        actionPackage: conflictingPackage,
      }),
    ).toThrowError(CoordinationStoreError);
  });

  it("tracks approvals, ignores duplicate signer counts, and assembles a completed action package", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore();
    const maintainerA = await fixtureKey("maintainer-a");
    const maintainerB = await fixtureKey("maintainer-b");

    store.submitAction(request);
    store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerA, "approve"),
    });
    store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerA, "approve", "2026-06-05T18:04:00.000Z"),
    });

    const waitingUpdate = store.poll(request.actionPackage.actionEnvelope.proposer.did).actionUpdates[0];
    expect(waitingUpdate.state).toBe("awaitingApprovals");
    expect(waitingUpdate.progress).toMatchObject({ required: 2, collected: 1 });

    const ready = store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerB, "approve"),
    });
    const readyUpdate = store.poll(request.actionPackage.actionEnvelope.proposer.did).actionUpdates[0];

    expect(ready.state).toBe("readyForResubmission");
    expect(readyUpdate.state).toBe("readyForResubmission");
    expect(readyUpdate.actionPackage?.approvalBundle.approvals).toHaveLength(3);
    expect(store.poll(maintainerB.did).approvalRequests).toHaveLength(0);
  });

  it("rejects self-approval — proposer cannot approve their own action", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore();
    const proposer = await fixtureKey("proposer");

    // Make the proposer eligible as a signer for this test
    request.authorizationRequirements.approvalRequirements.anyOf![0].eligibleSigners.push(proposer.did);

    store.submitAction(request);

    // Proposer tries to approve their own action
    const selfApproval = await signApproval(request.authorizationRequirements.actionEnvelopeHash, proposer, "approve");
    expect(() =>
      store.submitApproval({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
        approval: selfApproval,
      }),
    ).toThrowError(CoordinationStoreError);
  });

  it("cancels awaiting actions, hides them from signers, and rejects later approvals", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore();
    const maintainerA = await fixtureKey("maintainer-a");

    store.submitAction(request);
    const cancelled = store.cancelAction({
      version: "1",
      type: "CoordinationActionCancelRequest",
      actionId: request.actionPackage.actionEnvelope.actionId,
      proposerDid: request.actionPackage.actionEnvelope.proposer.did,
    });

    expect(cancelled.state).toBe("cancelled");
    expect(store.poll(maintainerA.did).approvalRequests).toHaveLength(0);
    expect(store.poll(request.actionPackage.actionEnvelope.proposer.did).actionUpdates[0]).toMatchObject({
      state: "cancelled",
    });
    expect(() =>
      store.submitApproval({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
        approval: {
          version: "1",
          type: "Approval",
          actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
          decision: "approve",
          signature: { format: "jws", value: "invalid.invalid.invalid" },
          createdAt: "2026-06-05T18:02:00.000Z",
        },
      }),
    ).toThrowError(CoordinationStoreError);
  });
});

async function coordinationActionRequest(): Promise<CoordinationActionRequest> {
  const actionPackage = await readJson<ActionPackage>("core/insufficient-approvals.json");
  const actionEnvelopeHash = computeJsonHash(actionPackage.actionEnvelope);
  const maintainerA = await fixtureKey("maintainer-a");
  const maintainerB = await fixtureKey("maintainer-b");
  return {
    version: "1",
    type: "CoordinationActionRequest",
    actionPackage,
    authorizationRequirements: {
      version: "1",
      type: "AuthorizationRequirements",
      actionEnvelopeHash,
      result: "additionalApprovalsRequired",
      verifier: {
        did: adapterDid,
      },
      approvalRequirements: {
        anyOf: [
          {
            type: "threshold",
            threshold: 2,
            eligibleSigners: [maintainerA.did, maintainerB.did],
            decision: "approve",
          },
        ],
      },
      createdAt: "2026-06-05T18:01:00.000Z",
      expiresAt: actionPackage.actionEnvelope.expiresAt,
    },
  };
}

async function signApproval(
  actionEnvelopeHash: Hash,
  signer: FixtureKey,
  decision: Decision,
  createdAt = "2026-06-05T18:03:00.000Z",
): Promise<Approval> {
  const payload = {
    type: "ApprovalPayload",
    actionEnvelopeHash,
    decision,
    signerDid: signer.did,
    createdAt,
  };
  const key = await importJWK(signer.privateJwk, "EdDSA");
  const value = await new CompactSign(Buffer.from(canonicalize(payload)))
    .setProtectedHeader({ alg: "EdDSA", kid: signer.kid })
    .sign(key);

  return {
    version: "1",
    type: "Approval",
    actionEnvelopeHash,
    decision,
    signature: { format: "jws", value },
    createdAt,
  };
}

async function fixtureKey(label: "proposer" | "maintainer-a" | "maintainer-b"): Promise<FixtureKey> {
  return readJson<FixtureKey>(`test-keys/${label}.json`);
}

async function readJson<T>(fixture: string): Promise<T> {
  return JSON.parse(await readFile(join(process.cwd(), "tests", "fixtures", fixture), "utf8")) as T;
}
