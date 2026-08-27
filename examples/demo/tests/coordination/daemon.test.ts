import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { afterEach, describe, expect, it } from "vitest";
import { startCoordinationDaemon, type StartedCoordinationDaemon } from "../../src/coordination/daemon.js";
import type { CoordinationActionRequest } from "../../src/coordination/types.js";
import type { ActionPackage, Approval, Decision, Did, Hash } from "../../src/core/types.js";
import { computeJsonHash } from "../../src/core/verification.js";

interface FixtureKey {
  did: Did;
  kid: string;
  privateJwk: JWK;
}

const daemons: StartedCoordinationDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.app.close()));
});

describe("coordination daemon", () => {
  it("starts on a standalone port and responds to health checks", async () => {
    const daemon = await startCoordinationDaemon({ port: 0 });
    daemons.push(daemon);

    const health = await fetch(`${daemon.address}/mpas/v1/coordination/health`);

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("supports a full local approval collection flow over HTTP", async () => {
    const daemon = await startCoordinationDaemon({ port: 0 });
    daemons.push(daemon);
    const request = await coordinationActionRequest();
    const maintainerA = await fixtureKey("maintainer-a");
    const maintainerB = await fixtureKey("maintainer-b");

    const submit = await post(daemon.address, "/mpas/v1/coordination/workflow", request);
    const signerPoll = await post(daemon.address, "/mpas/v1/coordination/poll", {
      version: "1",
      type: "CoordinationPollRequest",
      did: maintainerA.did,
    });
    await post(daemon.address, "/mpas/v1/coordination/approval", {
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerA, "approve"),
    });
    await post(daemon.address, "/mpas/v1/coordination/approval", {
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerB, "approve"),
    });
    const proposerPoll = await post(daemon.address, "/mpas/v1/coordination/poll", {
      version: "1",
      type: "CoordinationPollRequest",
      did: request.actionPackage.actionEnvelope.proposer.did,
    });

    expect(submit).toMatchObject({ state: "awaitingApprovals" });
    expect(signerPoll).toMatchObject({
      approvalRequests: [expect.objectContaining({ requestedDecision: "approve" })],
    });
    expect(proposerPoll).toMatchObject({
      actionUpdates: [
        expect.objectContaining({
          state: "readyForResubmission",
          actionPackage: expect.objectContaining({
            type: "ActionPackage",
          }),
        }),
      ],
    });
  });
});

async function post(address: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${address}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBeLessThan(400);
  return response.json();
}

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
        did: "did:web:adapter.local",
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
    },
  };
}

async function signApproval(actionEnvelopeHash: Hash, signer: FixtureKey, decision: Decision): Promise<Approval> {
  const createdAt = "2026-06-05T18:03:00.000Z";
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

async function fixtureKey(label: "maintainer-a" | "maintainer-b"): Promise<FixtureKey> {
  return readJson<FixtureKey>(`test-keys/${label}.json`);
}

async function readJson<T>(fixture: string): Promise<T> {
  return JSON.parse(await readFile(join(process.cwd(), "tests", "fixtures", fixture), "utf8")) as T;
}
