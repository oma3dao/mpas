import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it, vi } from "vitest";
import { buildDeliveryEnvelope, parseCoordinationPollResponse } from "@oma3/mpas";
import { CoordinationStore, MpasServiceError } from "../../src/coordination/store.js";
import type { CoordinationActionRequest } from "../../src/coordination/types.js";
import type { ActionPackage, Approval, Decision, Did, Hash } from "../../src/core/types.js";
import { computeJsonHash } from "../../src/core/verification.js";

interface FixtureKey {
  did: Did;
  kid: string;
  privateJwk: JWK;
}

/** Deterministic clock pinned inside the fixture validity window. */
const FIXTURE_NOW = Date.parse("2026-06-05T19:00:00.000Z");

const adapterDid = "did:web:adapter.local" as Did;

describe("CoordinationStore", () => {
  it("stores pending actions and returns signer-specific approval requests", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore({ now: FIXTURE_NOW });

    const result = store.createWorkflow(request);
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
    expect(parseCoordinationPollResponse(proposerPoll)).toEqual(proposerPoll);
    expect(outsiderPoll.approvalRequests).toHaveLength(0);
  });

  it("pins Action IDs independently within relay and coordination state", async () => {
    const request = await coordinationActionRequest();
    const conflictingPackage = structuredClone(request.actionPackage);
    conflictingPackage.actionEnvelope.expiresAt = "2026-06-06T18:00:00.000Z";
    conflictingPackage.approvalBundle.actionEnvelopeHash = computeJsonHash(conflictingPackage.actionEnvelope);
    const store = new CoordinationStore({ now: FIXTURE_NOW });

    store.createWorkflow(request);

    expect(() =>
      store.createWorkflow({
        ...request,
        actionPackage: conflictingPackage,
      }),
    ).toThrowError(MpasServiceError);
    expect(store.beginRelayedAction(buildDeliveryEnvelope({
      sender: conflictingPackage.actionEnvelope.proposer.did,
      recipients: [adapterDid],
      payload: { version: "1", type: "ActionRequest", actionPackage: conflictingPackage },
    }), adapterDid).created).toBe(true);
    expect(() => store.beginRelayedAction(buildDeliveryEnvelope({
      sender: request.actionPackage.actionEnvelope.proposer.did,
      recipients: [adapterDid],
      payload: { version: "1", type: "ActionRequest", actionPackage: request.actionPackage },
    }), adapterDid)).toThrowError(MpasServiceError);
  });

  it("tracks approvals, ignores duplicate signer counts, and assembles a completed action package", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore({ now: FIXTURE_NOW });
    const maintainerA = await fixtureKey("maintainer-a");
    const maintainerB = await fixtureKey("maintainer-b");

    store.createWorkflow(request);
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
    const readyPoll = store.poll(request.actionPackage.actionEnvelope.proposer.did);
    const readyUpdate = readyPoll.actionUpdates[0];
    expect(parseCoordinationPollResponse(readyPoll)).toEqual(readyPoll);

    expect(ready.state).toBe("readyForSubmission");
    expect(readyUpdate.state).toBe("readyForSubmission");
    expect(readyUpdate.expiresAt).toBe(request.actionPackage.actionEnvelope.expiresAt);
    expect(readyUpdate.actionPackage?.approvalBundle.approvals).toHaveLength(3);
    expect(store.poll(maintainerB.did).approvalRequests).toHaveLength(0);
  });

  it("makes each Signer's first decision final for an Action Envelope", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore({ now: FIXTURE_NOW });
    const maintainerA = await fixtureKey("maintainer-a");
    store.createWorkflow(request);

    const approve = await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerA, "approve");
    const first = store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: approve,
    });
    const duplicate = store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: approve,
    });
    const changedDecision = await signApproval(
      request.authorizationRequirements.actionEnvelopeHash,
      maintainerA,
      "reject",
    );

    expect(first.state).toBe("awaitingApprovals");
    expect(duplicate.state).toBe("awaitingApprovals");
    try {
      store.submitApproval({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
        approval: changedDecision,
      });
      throw new Error("changed decision unexpectedly accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(MpasServiceError);
      expect(error).toMatchObject({ statusCode: 409, code: "SIGNER_DECISION_CONFLICT" });
    }
  });

  it("rejects a workflow as soon as immutable decisions make its threshold unreachable", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore({ now: FIXTURE_NOW });
    const maintainerA = await fixtureKey("maintainer-a");
    store.createWorkflow(request);

    const response = store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerA, "reject"),
    });
    const poll = store.poll(request.actionPackage.actionEnvelope.proposer.did);
    const update = poll.actionUpdates[0];

    expect(response.state).toBe("rejected");
    expect(update).toMatchObject({ state: "rejected" });
    expect(update.rejectedAt).toBeDefined();
    expect(update.expiresAt).toBe(request.actionPackage.actionEnvelope.expiresAt);
    expect(update.progress).toEqual({ required: 2, collected: 0, pending: [(await fixtureKey("maintainer-b")).did] });
    expect(parseCoordinationPollResponse(poll)).toEqual(poll);
    expect(store.poll((await fixtureKey("maintainer-b")).did).approvalRequests).toHaveLength(0);
  });

  it("preserves expiry and progress in an expired response accepted by the public parser", async () => {
    const request = await coordinationActionRequest();
    const currentTime = new Date();
    try {
      // Pin the clock inside the fixture validity window for workflow creation.
      vi.setSystemTime(new Date(FIXTURE_NOW));
      const store = new CoordinationStore();
      store.createWorkflow(request);
      // Advance past expiry.
      vi.setSystemTime(new Date(Date.parse(request.actionPackage.actionEnvelope.expiresAt) + 1));
      const poll = store.poll(request.actionPackage.actionEnvelope.proposer.did);
      expect(poll.actionUpdates[0]).toMatchObject({ state: "expired", expiresAt: request.actionPackage.actionEnvelope.expiresAt,
        progress: { required: 2, collected: 0, pending: [(await fixtureKey("maintainer-a")).did, (await fixtureKey("maintainer-b")).did] } });
      expect(parseCoordinationPollResponse(poll)).toEqual(poll);
    } finally {
      vi.setSystemTime(currentTime);
    }
  });

  it("rejects invalid requirements and Action Package bindings before workflow creation", async () => {
    const request = await coordinationActionRequest();
    const cases: CoordinationActionRequest[] = [];

    const unachievable = structuredClone(request);
    unachievable.authorizationRequirements.approvalRequirements.anyOf![0].threshold = 3;
    cases.push(unachievable);

    const duplicate = structuredClone(request);
    duplicate.authorizationRequirements.approvalRequirements.anyOf![0].eligibleSigners = [
      duplicate.authorizationRequirements.approvalRequirements.anyOf![0].eligibleSigners[0],
      duplicate.authorizationRequirements.approvalRequirements.anyOf![0].eligibleSigners[0],
    ];
    cases.push(duplicate);

    const wrongRequirementsHash = structuredClone(request);
    wrongRequirementsHash.authorizationRequirements.actionEnvelopeHash.value = "wrong";
    cases.push(wrongRequirementsHash);

    const expiredRequirements = structuredClone(request);
    expiredRequirements.authorizationRequirements.expiresAt = "2020-01-01T00:00:00.000Z";
    cases.push(expiredRequirements);

    const payloadMismatch = structuredClone(request);
    payloadMismatch.actionPackage.executionPayload = { changed: true };
    cases.push(payloadMismatch);

    const envelopeMismatch = structuredClone(request);
    envelopeMismatch.actionPackage.approvalBundle.actionEnvelopeHash.value = "wrong";
    cases.push(envelopeMismatch);

    for (const invalid of cases) {
      const store = new CoordinationStore({ now: FIXTURE_NOW });
      expect(() => store.createWorkflow(invalid)).toThrowError(MpasServiceError);
      expect(store.poll(invalid.actionPackage.actionEnvelope.proposer.did).actionUpdates).toHaveLength(0);
    }
  });

  it("preserves unenforcing behavior by storing but not counting an ineligible Approval", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore({ now: FIXTURE_NOW });
    const adapter = await fixtureKey("adapter");
    store.createWorkflow(request);

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

  it("accepts a proposer Approval only when the settled policy makes that decision eligible", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore({ now: FIXTURE_NOW });
    const proposer = await fixtureKey("proposer");

    request.authorizationRequirements.approvalRequirements.anyOf![0].threshold = 1;
    request.authorizationRequirements.approvalRequirements.anyOf![0].eligibleSigners.push(proposer.did);
    store.createWorkflow(request);

    const selfApproval = await signApproval(request.authorizationRequirements.actionEnvelopeHash, proposer, "approve");
    const response = store.submitApproval({
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: selfApproval,
    });

    expect(response).toMatchObject({ accepted: true, state: "readyForSubmission" });
  });

  it("denies a proposer decision that the settled policy does not authorize", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore({ now: FIXTURE_NOW });
    const proposer = await fixtureKey("proposer");
    store.createWorkflow(request);

    const selfApproval = await signApproval(request.authorizationRequirements.actionEnvelopeHash, proposer, "approve");
    expect(() =>
      store.submitApproval({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
        approval: selfApproval,
      }),
    ).toThrowError(expect.objectContaining({ code: "SELF_APPROVAL_DENIED", statusCode: 403 }));
  });

  it("cancels awaiting actions, hides them from signers, and rejects later approvals", async () => {
    const request = await coordinationActionRequest();
    const store = new CoordinationStore({ now: FIXTURE_NOW });
    const maintainerA = await fixtureKey("maintainer-a");

    store.createWorkflow(request);
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
    const cancelledPoll = store.poll(request.actionPackage.actionEnvelope.proposer.did);
    expect(cancelledPoll.actionUpdates[0].progress).toBeUndefined();
    expect(cancelledPoll.actionUpdates[0].actionPackage).toBeUndefined();
    expect(parseCoordinationPollResponse(cancelledPoll)).toEqual(cancelledPoll);
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
    ).toThrowError(MpasServiceError);
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
