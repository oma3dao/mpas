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
    const missingHash = { alg: "sha-256", value: "missing-action" } as Hash;
    const missingApproval = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/approval",
      payload: {
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: missingHash,
        approval: {
          version: "1",
          type: "Approval",
          actionEnvelopeHash: missingHash,
          decision: "approve",
          signature: { format: "jws", value: "invalid.invalid.invalid" },
          createdAt: "2026-06-05T18:03:00.000Z",
        },
      },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("ACTION_ID_CONFLICT");
    expect(missingCancel.statusCode).toBe(404);
    expect(missingApproval.statusCode).toBe(404);
  });

  it("does not import adapter internals", async () => {
    const source = await readFile(join(process.cwd(), "src", "coordination", "coordination-api-server.ts"), "utf8");

    expect(source).not.toContain("../adapter/");
  });

  it("rejects empty and duplicate-member JSON bodies", async () => {
    const app = createApp();
    // Empty / incomplete payloads yield handler TypeErrors before schema validation (500).
    const empty = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/action",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    expect(empty.statusCode).toBe(500);

    const missingPackage = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/action",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(missingPackage.statusCode).toBe(500);

    const dup = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/action",
      headers: { "content-type": "application/json" },
      payload: '{"version":"1","version":"2"}',
    });
    expect(dup.statusCode).toBe(400);

    const truncated = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/action",
      headers: { "content-type": "application/json" },
      payload: '{"a":1',
    });
    expect(truncated.statusCode).toBe(400);
  });

  it("accepts application/mpas+json action submissions", async () => {
    const app = createApp();
    const request = await coordinationActionRequest();
    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/action",
      headers: { "content-type": "application/mpas+json" },
      payload: JSON.stringify(request),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ type: "CoordinationActionResponse", state: "awaitingApprovals" });
  });

  it("maps CoordinationStoreError from poll and approval handlers", async () => {
    const { CoordinationStoreError } = await import("../../src/coordination/store.js");
    const store = {
      poll() {
        throw new CoordinationStoreError(400, "POLL_FAILED", "poll failed");
      },
      validateSubmitApproval() {
        // Auth-disabled path still preflights before submitApproval.
      },
      submitApproval() {
        throw new CoordinationStoreError(404, "ACTION_NOT_FOUND", "missing");
      },
    };
    const app = createCoordinationApiServer({ store: store as never });
    apps.add(app);

    const poll = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/poll",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ version: "1", type: "CoordinationPollRequest", did: "did:web:x" }),
    });
    expect(poll.statusCode).toBe(400);
    expect(poll.json()).toMatchObject({ error: { code: "POLL_FAILED" } });

    const approval = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/approval",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: { alg: "sha-256", value: "x" },
        approval: {
          version: "1",
          type: "Approval",
          actionEnvelopeHash: { alg: "sha-256", value: "x" },
          decision: "approve",
          signature: { format: "jws", value: "a.b.c" },
          createdAt: "2026-06-05T18:03:00.000Z",
        },
      }),
    });
    expect(approval.statusCode).toBe(404);
    expect(approval.json()).toMatchObject({ error: { code: "ACTION_NOT_FOUND" } });
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
