import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { afterEach, describe, expect, it } from "vitest";
import { createCoordinationApiServer } from "../../src/coordination/coordination-api-server.js";
import type { CoordinationActionRequest } from "../../src/coordination/types.js";
import type { ActionPackage, Approval, Decision, Did, Hash } from "../../src/core/types.js";
import { computeJsonHash } from "../../src/core/verification.js";

interface FixtureKey {
  did: Did;
  kid: string;
  privateJwk: JWK;
}

const apps = new Set<ReturnType<typeof createCoordinationApiServer>>();

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

describe("coordination HTTP endpoint", () => {
  it("returns health status", async () => {
    const app = createApp();

    const response = await app.inject({ method: "GET", url: "/mpas/v1/coordination/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "mpas-local-coordination",
    });
  });

  it("submits an action and returns pending work through poll", async () => {
    const app = createApp();
    const request = await coordinationActionRequest();
    const maintainerA = await fixtureKey("maintainer-a");

    const submit = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/action",
      payload: request,
    });
    const duplicateSubmit = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/action",
      payload: request,
    });
    const poll = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/poll",
      payload: { version: "1", type: "CoordinationPollRequest", did: maintainerA.did },
    });

    expect(submit.statusCode).toBe(201);
    expect(duplicateSubmit.statusCode).toBe(200);
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toMatchObject({
      version: "1",
      type: "CoordinationPollResponse",
      approvalRequests: [expect.objectContaining({ type: "ApprovalRequest" })],
    });
  });

  it("accepts approvals and returns a completed package in proposer poll", async () => {
    const app = createApp();
    const request = await coordinationActionRequest();
    const maintainerA = await fixtureKey("maintainer-a");
    const maintainerB = await fixtureKey("maintainer-b");

    await app.inject({ method: "POST", url: "/mpas/v1/coordination/action", payload: request });
    for (const signer of [maintainerA, maintainerB]) {
      const approval = await signApproval(request.authorizationRequirements.actionEnvelopeHash, signer, "approve");
      const response = await app.inject({
        method: "POST",
        url: "/mpas/v1/coordination/approval",
        payload: {
          version: "1",
          type: "CoordinationApprovalSubmission",
          actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
          approval,
        },
      });
      expect(response.statusCode).toBe(200);
    }

    const poll = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/poll",
      payload: {
        version: "1",
        type: "CoordinationPollRequest",
        did: request.actionPackage.actionEnvelope.proposer.did,
      },
    });

    expect(poll.json().actionUpdates[0]).toMatchObject({
      state: "readyForResubmission",
      actionPackage: {
        type: "ActionPackage",
      },
    });
  });

  it("maps conflicts and cancellation errors to HTTP statuses", async () => {
    const app = createApp();
    const request = await coordinationActionRequest();
    const conflictingPackage = structuredClone(request.actionPackage);
    conflictingPackage.actionEnvelope.expiresAt = "2030-01-02T00:00:00.000Z";

    await app.inject({ method: "POST", url: "/mpas/v1/coordination/action", payload: request });
    const conflict = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/action",
      payload: {
        ...request,
        actionPackage: conflictingPackage,
      },
    });
    const missingCancel = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/action-cancel",
      payload: {
        version: "1",
        type: "CoordinationActionCancelRequest",
        actionId: { value: "urn:uuid:missing" },
        proposerDid: request.actionPackage.actionEnvelope.proposer.did,
      },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("ACTION_ID_CONFLICT");
    expect(missingCancel.statusCode).toBe(404);
  });

  it("does not import adapter internals", async () => {
    const source = await readFile(join(process.cwd(), "src", "coordination", "coordination-api-server.ts"), "utf8");

    expect(source).not.toContain("../adapter/");
  });
});

function createApp() {
  const app = createCoordinationApiServer();
  apps.add(app);
  return app;
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
