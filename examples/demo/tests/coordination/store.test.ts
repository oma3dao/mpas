import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it } from "vitest";
import { CoordinationStore, CoordinationStoreError, decodeApprovalSignerDid } from "../../src/coordination/store.js";
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
    const proposerPoll = store.poll(request.actionPackage.actionEnvelope.proposer.did);
    const outsiderPoll = store.poll("did:web:agents.example:outsider" as Did);

    expect(result.created).toBe(true);
    expect(result.response.state).toBe("awaitingApprovals");
    expect(maintainerPoll.approvalRequests).toHaveLength(1);
    expect(maintainerPoll.approvalRequests[0].signerReviewSet.authorizationRequirements).toBe(
      request.authorizationRequirements,
    );
    expect(proposerPoll.actionUpdates[0]).toMatchObject({
      state: "awaitingApprovals",
      expiresAt: request.actionPackage.actionEnvelope.expiresAt,
    });
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
    expect(readyUpdate.expiresAt).toBe(request.actionPackage.actionEnvelope.expiresAt);
    expect(readyUpdate.actionPackage?.approvalBundle.approvals).toHaveLength(3);
    expect(store.poll(maintainerB.did).approvalRequests).toHaveLength(0);
  });

  it("preserves unenforcing behavior by storing but not counting an ineligible Approval", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore();
    const adapter = await fixtureKey("adapter");
    store.submitAction(request);

    const response = store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, adapter, "approve"),
    });
    const update = store.poll(request.actionPackage.actionEnvelope.proposer.did).actionUpdates[0];

    expect(response).toMatchObject({ accepted: true, state: "awaitingApprovals" });
    expect(update.progress).toMatchObject({ required: 2, collected: 0 });
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
      expiresAt: request.actionPackage.actionEnvelope.expiresAt,
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

  it("rejects cancel from a non-proposer and after expiry or readiness", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore();
    const maintainerA = await fixtureKey("maintainer-a");
    const maintainerB = await fixtureKey("maintainer-b");

    store.submitAction(request);
    try {
      store.cancelAction({
        version: "1",
        type: "CoordinationActionCancelRequest",
        actionId: request.actionPackage.actionEnvelope.actionId,
        proposerDid: maintainerA.did,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CoordinationStoreError);
      expect((error as CoordinationStoreError).code).toBe("NOT_PROPOSER");
    }

    const expiredRequest = await coordinationActionRequest();
    expiredRequest.actionPackage.actionEnvelope.expiresAt = "2000-01-01T00:00:00.000Z";
    expiredRequest.authorizationRequirements.expiresAt = "2000-01-01T00:00:00.000Z";
    const expiredStore = new CoordinationStore();
    expiredStore.submitAction(expiredRequest);
    try {
      expiredStore.cancelAction({
        version: "1",
        type: "CoordinationActionCancelRequest",
        actionId: expiredRequest.actionPackage.actionEnvelope.actionId,
        proposerDid: expiredRequest.actionPackage.actionEnvelope.proposer.did,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as CoordinationStoreError).code).toBe("ACTION_EXPIRED");
    }

    const readyStore = new CoordinationStore();
    const readyRequest = await coordinationActionRequest();
    readyStore.submitAction(readyRequest);
    readyStore.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: readyRequest.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(readyRequest.authorizationRequirements.actionEnvelopeHash, maintainerA, "approve"),
    });
    readyStore.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: readyRequest.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(readyRequest.authorizationRequirements.actionEnvelopeHash, maintainerB, "approve"),
    });
    try {
      readyStore.cancelAction({
        version: "1",
        type: "CoordinationActionCancelRequest",
        actionId: readyRequest.actionPackage.actionEnvelope.actionId,
        proposerDid: readyRequest.actionPackage.actionEnvelope.proposer.did,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as CoordinationStoreError).code).toBe("ACTION_READY");
    }
  });

  it("returns created:false for an identical action resubmission", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore();
    const first = store.submitAction(request);
    const second = store.submitAction(request);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.response.actionRef).toEqual(first.response.actionRef);
    expect(second.response.state).toBe("awaitingApprovals");
  });

  it("rejects approvals whose envelope hash or signed payload does not match", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore();
    const maintainerA = await fixtureKey("maintainer-a");
    store.submitAction(request);

    const wrongHashApproval = await signApproval(
      { alg: "sha-256", value: "different-envelope-hash" },
      maintainerA,
      "approve",
    );
    try {
      store.submitApproval({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
        approval: {
          ...wrongHashApproval,
          actionEnvelopeHash: { alg: "sha-256", value: "different-envelope-hash" },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as CoordinationStoreError).code).toBe("APPROVAL_HASH_MISMATCH");
    }

    try {
      store.submitApproval({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
        approval: {
          version: "1",
          type: "Approval",
          actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
          decision: "approve",
          signature: { format: "jws", value: "only.two" },
          createdAt: "2026-06-05T18:03:00.000Z",
        },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as CoordinationStoreError).code).toBe("APPROVAL_HASH_MISMATCH");
    }

    const payloadWithoutSigner = {
      type: "ApprovalPayload",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      decision: "approve",
      createdAt: "2026-06-05T18:03:00.000Z",
    };
    const key = await importJWK(maintainerA.privateJwk, "EdDSA");
    const value = await new CompactSign(Buffer.from(canonicalize(payloadWithoutSigner)))
      .setProtectedHeader({ alg: "EdDSA", kid: maintainerA.kid })
      .sign(key);
    try {
      store.submitApproval({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
        approval: {
          version: "1",
          type: "Approval",
          actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
          decision: "approve",
          signature: { format: "jws", value },
          createdAt: "2026-06-05T18:03:00.000Z",
        },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as CoordinationStoreError).code).toBe("APPROVAL_SIGNER_MISSING");
    }
  });

  it("reports expired state on proposer poll and rejects unknown cancels", async () => {
    const expiredRequest = await coordinationActionRequest();
    expiredRequest.actionPackage.actionEnvelope.expiresAt = "2000-01-01T00:00:00.000Z";
    expiredRequest.authorizationRequirements.expiresAt = "2000-01-01T00:00:00.000Z";
    const store = new CoordinationStore();
    store.submitAction(expiredRequest);

    const update = store.poll(expiredRequest.actionPackage.actionEnvelope.proposer.did).actionUpdates[0];
    expect(update).toMatchObject({
      state: "expired",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    try {
      store.cancelAction({
        version: "1",
        type: "CoordinationActionCancelRequest",
        actionId: { value: "urn:uuid:does-not-exist" },
        proposerDid: expiredRequest.actionPackage.actionEnvelope.proposer.did,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as CoordinationStoreError).code).toBe("ACTION_NOT_FOUND");
    }
  });

  it("marks an allOf threshold ready after a single matching approval", async () => {
    const request = await coordinationActionRequest();
    const maintainerA = await fixtureKey("maintainer-a");
    request.authorizationRequirements.approvalRequirements = {
      allOf: [
        {
          type: "threshold",
          threshold: 1,
          eligibleSigners: [maintainerA.did],
          decision: "approve",
        },
      ],
    };
    const store = new CoordinationStore();
    store.submitAction(request);
    const ready = store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerA, "approve"),
    });
    expect(ready.state).toBe("readyForResubmission");
  });

  it("rejects corrupt JWS payloads and reports empty progress for empty requirements", async () => {
    const request = await coordinationActionRequest();
    request.authorizationRequirements.approvalRequirements = {};
    const store = new CoordinationStore();
    store.submitAction(request);

    const progress = store.poll(request.actionPackage.actionEnvelope.proposer.did).actionUpdates[0];
    expect(progress).toMatchObject({
      progress: { required: 0, collected: 0, pending: [] },
    });

    try {
      store.submitApproval({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
        approval: {
          version: "1",
          type: "Approval",
          actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
          decision: "approve",
          signature: { format: "jws", value: "hdr.!!!not-base64!!!.sig" },
          createdAt: "2026-06-05T18:03:00.000Z",
        },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as CoordinationStoreError).code).toBe("APPROVAL_HASH_MISMATCH");
    }
  });

  it("rejects approvals for unknown envelope hashes as ACTION_NOT_FOUND", async () => {
    const store = new CoordinationStore();
    const maintainerA = await fixtureKey("maintainer-a");
    try {
      store.submitApproval({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: { alg: "sha-256", value: "missing-envelope-hash" },
        approval: await signApproval({ alg: "sha-256", value: "missing-envelope-hash" }, maintainerA, "approve"),
      });
      expect.unreachable();
    } catch (error) {
      expect((error as CoordinationStoreError).code).toBe("ACTION_NOT_FOUND");
    }
  });

  it("hides approval requests from signers who already responded", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore();
    const maintainerA = await fixtureKey("maintainer-a");
    store.submitAction(request);

    expect(store.poll(maintainerA.did).approvalRequests).toHaveLength(1);
    store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerA, "approve"),
    });
    expect(store.poll(maintainerA.did).approvalRequests).toEqual([]);
  });

  it("treats missing envelope hashes and malformed approvals as having no signer DID", async () => {
    const store = new CoordinationStore();
    expect(store.isEligibleSigner("missing-hash", "did:web:agents.example:x" as Did)).toBe(false);
    expect(decodeApprovalSignerDid(undefined)).toBeUndefined();
    expect(decodeApprovalSignerDid({
      version: "1",
      type: "Approval",
      actionEnvelopeHash: { alg: "sha-256", value: "x" },
      decision: "approve",
      signature: { format: "jws", value: 12 as unknown as string },
      createdAt: "2026-06-05T18:03:00.000Z",
    })).toBeUndefined();
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

async function fixtureKey(label: "proposer" | "maintainer-a" | "maintainer-b" | "adapter"): Promise<FixtureKey> {
  return readJson<FixtureKey>(`test-keys/${label}.json`);
}

async function readJson<T>(fixture: string): Promise<T> {
  return JSON.parse(await readFile(join(process.cwd(), "tests", "fixtures", fixture), "utf8")) as T;
}
