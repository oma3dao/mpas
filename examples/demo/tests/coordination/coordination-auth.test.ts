import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeyManager,
  generateEd25519Key,
  signMpasRfc9421,
  type MpasRfc9421Signer,
} from "@oma3/mpas";
import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCoordinationApiServer,
  type CoordinationAuthOptions,
} from "../../src/coordination/coordination-api-server.js";
import type {
  CoordinationActionCancelRequest,
  CoordinationActionRequest,
  CoordinationApprovalSubmission,
  CoordinationPollRequest,
} from "../../src/coordination/types.js";
import { TraceLogger, TraceWriter } from "../../src/core/trace.js";
import type { ActionPackage, Approval, Decision, Did, Hash } from "../../src/core/types.js";
import { computeJsonHash } from "../../src/core/verification.js";

interface FixtureKey {
  did: Did;
  kid: string;
  privateJwk: JWK;
}

interface FixtureSigner {
  fixture: FixtureKey;
  signer: KeyManager;
}

const AUDIENCE = "https://coordination.example.com";
const NOW = new Date("2026-06-05T18:03:30.000Z");
const CREATED = new Date("2026-06-05T18:03:00.000Z");
const EXPIRES = new Date("2026-06-05T18:04:00.000Z");
const apps = new Set<ReturnType<typeof createCoordinationApiServer>>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  await Promise.all([...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true })));
  apps.clear();
  temporaryDirectories.clear();
});

describe("coordination RFC 9421 authentication", () => {
  it("fails closed for missing or invalid enforcing configuration", () => {
    expect(() => createCoordinationApiServer({ auth: { enforcement: true } })).toThrow(/non-empty/);
    expect(() =>
      createCoordinationApiServer({ auth: { enforcement: true, audiences: [`${AUDIENCE}/`] } }),
    ).toThrow(/canonical audience origins/);
    expect(() =>
      createCoordinationApiServer({ auth: { enforcement: true, audiences: [AUDIENCE], signatureLifetimeSeconds: 61 } }),
    ).toThrow(/1 to 60/);
  });

  it("leaves health open but requires authentication on every protocol endpoint", async () => {
    const app = createApp();
    const health = await app.inject({ method: "GET", url: "/mpas/v1/coordination/health" });
    expect(health.statusCode).toBe(200);

    for (const path of [
      "/mpas/v1/action",
      "/mpas/v1/coordination/workflow",
      "/mpas/v1/coordination/action",
      "/mpas/v1/coordination/poll",
      "/mpas/v1/coordination/approval",
      "/mpas/v1/coordination/action-cancel",
      "/mpas/v1/coordination/delivery",
      "/mpas/v1/coordination/session",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: path,
        payload: {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(mpasError("authentication_required", "Authentication is required."));
    }

    const bodyless = await app.inject({ method: "POST", url: "/mpas/v1/coordination/poll" });
    expect(bodyless.statusCode).toBe(401);
    expect(bodyless.json()).toEqual(mpasError("authentication_required", "Authentication is required."));
  });

  it("authenticates a complete workflow and never counts transport authentication as an Approval", async () => {
    const app = createApp();
    const request = await coordinationActionRequest();
    const proposer = await fixtureSigner("proposer");
    const maintainerA = await fixtureSigner("maintainer-a");
    const maintainerB = await fixtureSigner("maintainer-b");

    const submit = await signedInject(app, "/mpas/v1/coordination/workflow", request, proposer.signer);
    expect(submit.statusCode).toBe(201);

    const pollA = await signedInject(
      app,
      "/mpas/v1/coordination/poll",
      pollRequest(maintainerA.fixture.did),
      maintainerA.signer,
    );
    expect(pollA.statusCode).toBe(200);
    expect(pollA.json().approvalRequests).toHaveLength(1);
    expect(pollA.json().actionUpdates).toHaveLength(0);

    for (const maintainer of [maintainerA, maintainerB]) {
      const approvalRequest: CoordinationApprovalSubmission = {
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
        approval: await signApproval(
          request.authorizationRequirements.actionEnvelopeHash,
          maintainer.fixture,
          "approve",
        ),
      };
      const response = await signedInject(
        app,
        "/mpas/v1/coordination/approval",
        approvalRequest,
        maintainer.signer,
      );
      expect(response.statusCode).toBe(200);
    }

    const proposerPoll = await signedInject(
      app,
      "/mpas/v1/coordination/poll",
      pollRequest(proposer.fixture.did),
      proposer.signer,
    );
    expect(proposerPoll.json().actionUpdates[0]).toMatchObject({ state: "readyForResubmission" });
    expect(proposerPoll.json().actionUpdates[0].actionPackage.approvalBundle.approvals).toHaveLength(3);
  });

  it("accepts a correctly authenticated cancellation", async () => {
    const app = createApp();
    const request = await coordinationActionRequest();
    const proposer = await fixtureSigner("proposer");
    await signedInject(app, "/mpas/v1/coordination/workflow", request, proposer.signer);

    const cancel: CoordinationActionCancelRequest = {
      version: "1",
      type: "CoordinationActionCancelRequest",
      actionId: request.actionPackage.actionEnvelope.actionId,
      proposerDid: proposer.fixture.did,
    };
    const response = await signedInject(app, "/mpas/v1/coordination/workflow-cancel", cancel, proposer.signer);

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("cancelled");
  });

  it("rejects every endpoint identity mismatch and ineligible Approval signer with 403", async () => {
    const actionApp = createApp();
    const request = await coordinationActionRequest();
    const proposer = await fixtureSigner("proposer");
    const maintainerA = await fixtureSigner("maintainer-a");
    const adapter = await fixtureSigner("adapter");

    const mismatchedAction = await signedInject(
      actionApp,
      "/mpas/v1/coordination/workflow",
      request,
      maintainerA.signer,
    );
    expectPermissionDenied(mismatchedAction);

    const app = createApp();
    await signedInject(app, "/mpas/v1/coordination/workflow", request, proposer.signer);

    const mismatchedPoll = await signedInject(
      app,
      "/mpas/v1/coordination/poll",
      pollRequest(maintainerA.fixture.did),
      proposer.signer,
    );
    expectPermissionDenied(mismatchedPoll);

    const maintainerApproval: CoordinationApprovalSubmission = {
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, maintainerA.fixture, "approve"),
    };
    const mismatchedApproval = await signedInject(
      app,
      "/mpas/v1/coordination/approval",
      maintainerApproval,
      proposer.signer,
    );
    expectPermissionDenied(mismatchedApproval);

    const adapterApproval: CoordinationApprovalSubmission = {
      ...maintainerApproval,
      approval: await signApproval(request.authorizationRequirements.actionEnvelopeHash, adapter.fixture, "approve"),
    };
    const ineligibleApproval = await signedInject(
      app,
      "/mpas/v1/coordination/approval",
      adapterApproval,
      adapter.signer,
    );
    expectPermissionDenied(ineligibleApproval);

    const cancel: CoordinationActionCancelRequest = {
      version: "1",
      type: "CoordinationActionCancelRequest",
      actionId: request.actionPackage.actionEnvelope.actionId,
      proposerDid: proposer.fixture.did,
    };
    const mismatchedCancel = await signedInject(
      app,
      "/mpas/v1/coordination/workflow-cancel",
      cancel,
      maintainerA.signer,
    );
    expectPermissionDenied(mismatchedCancel);

    const missingCancel = await signedInject(
      app,
      "/mpas/v1/coordination/workflow-cancel",
      { ...cancel, actionId: { value: "urn:uuid:missing" } },
      proposer.signer,
    );
    expectPermissionDenied(missingCancel);

    const missingHash = { alg: "sha-256", value: "missing-action" } as Hash;
    const missingApproval = await signedInject(
      app,
      "/mpas/v1/coordination/approval",
      {
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash: missingHash,
        approval: await signApproval(missingHash, maintainerA.fixture, "approve"),
      },
      maintainerA.signer,
    );
    expectPermissionDenied(missingApproval);
  });

  it("allows exactly one concurrent mutation for a repeated nonce", async () => {
    const app = createApp();
    const request = await coordinationActionRequest();
    const proposer = await fixtureSigner("proposer");
    const signed = await buildSignedRequest(
      "/mpas/v1/coordination/workflow",
      request,
      proposer.signer,
      "concurrent-nonce",
    );

    const responses = await Promise.all([app.inject(signed), app.inject(signed)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 401]);
    expect(responses.find((response) => response.statusCode === 401)?.json()).toEqual(
      mpasError("signature_invalid", "Signature verification failed."),
    );
  });

  it("does not consume a nonce for identity or business-preflight failures", async () => {
    const request = await coordinationActionRequest();
    const proposer = await fixtureSigner("proposer");
    const maintainerA = await fixtureSigner("maintainer-a");

    const identityApp = createApp();
    const wrongIdentity = structuredClone(request);
    wrongIdentity.actionPackage.actionEnvelope.proposer.did = maintainerA.fixture.did;
    const identityFailure = await signedInject(
      identityApp,
      "/mpas/v1/coordination/workflow",
      wrongIdentity,
      proposer.signer,
      "reusable-identity-nonce",
    );
    expectPermissionDenied(identityFailure);
    const correctedIdentity = await signedInject(
      identityApp,
      "/mpas/v1/coordination/workflow",
      request,
      proposer.signer,
      "reusable-identity-nonce",
    );
    expect(correctedIdentity.statusCode).toBe(201);

    const preflightApp = createApp();
    await signedInject(preflightApp, "/mpas/v1/coordination/workflow", request, proposer.signer);
    const missingHash = { alg: "sha-256", value: "missing-action" } as Hash;
    const invalidApproval: CoordinationApprovalSubmission = {
      version: "1",
      type: "CoordinationApprovalSubmission",
      actionEnvelopeHash: request.authorizationRequirements.actionEnvelopeHash,
      approval: await signApproval(missingHash, maintainerA.fixture, "approve"),
    };
    const preflightFailure = await signedInject(
      preflightApp,
      "/mpas/v1/coordination/approval",
      invalidApproval,
      maintainerA.signer,
      "reusable-preflight-nonce",
    );
    expect(preflightFailure.statusCode).toBe(400);
    const correctedApproval: CoordinationApprovalSubmission = {
      ...invalidApproval,
      approval: await signApproval(
        request.authorizationRequirements.actionEnvelopeHash,
        maintainerA.fixture,
        "approve",
      ),
    };
    const correctedPreflight = await signedInject(
      preflightApp,
      "/mpas/v1/coordination/approval",
      correctedApproval,
      maintainerA.signer,
      "reusable-preflight-nonce",
    );
    expect(correctedPreflight.statusCode).toBe(200);
  });

  it("maps body digest mismatches to 400 and all other presented-signature failures to one generic response", async () => {
    const app = createApp();
    const maintainerA = await fixtureSigner("maintainer-a");
    const signed = await buildSignedRequest(
      "/mpas/v1/coordination/poll",
      pollRequest(maintainerA.fixture.did),
      maintainerA.signer,
    );
    const changedBody = signed.payload.replace("CoordinationPollRequest", "CoordinationPollRequesu");

    const digestMismatch = await app.inject({ ...signed, payload: changedBody });
    expect(digestMismatch.statusCode).toBe(400);
    expect(digestMismatch.json()).toEqual(mpasError("artifact_hash_mismatch", "Request body digest does not match."));

    const wrongAudience = await signedInject(
      app,
      "/mpas/v1/coordination/poll",
      pollRequest(maintainerA.fixture.did),
      maintainerA.signer,
      undefined,
      "https://other.example.com",
    );
    expect(wrongAudience.statusCode).toBe(401);
    expect(wrongAudience.json()).toEqual(mpasError("signature_invalid", "Signature verification failed."));
  });

  it("does not reveal whether a DID is known or has pending work on authentication failure", async () => {
    const app = createApp();
    const request = await coordinationActionRequest();
    const proposer = await fixtureSigner("proposer");
    const maintainerA = await fixtureSigner("maintainer-a");
    const adapter = await fixtureSigner("adapter");
    const unknownKey = await generateEd25519Key();
    const unknown: FixtureSigner = {
      fixture: unknownKey as FixtureKey,
      signer: KeyManager.fromJwk(unknownKey.privateJwk),
    };
    await signedInject(app, "/mpas/v1/coordination/workflow", request, proposer.signer);

    const identities = [maintainerA, adapter, unknown];
    const successful = await Promise.all(
      identities.map((identity) =>
        signedInject(
          app,
          "/mpas/v1/coordination/poll",
          pollRequest(identity.fixture.did),
          identity.signer,
        ),
      ),
    );
    expect(successful.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(successful[0].json().approvalRequests).toHaveLength(1);
    expect(successful[1].json().approvalRequests).toHaveLength(0);
    expect(successful[2].json().approvalRequests).toHaveLength(0);

    const responses = await Promise.all(
      identities.map((identity) =>
        signedInject(
          app,
          "/mpas/v1/coordination/poll",
          pollRequest(identity.fixture.did),
          identity.signer,
          undefined,
          "https://other.example.com",
        ),
      ),
    );

    expect(new Set(responses.map((response) => response.body))).toEqual(
      new Set([JSON.stringify(mpasError("signature_invalid", "Signature verification failed."))]),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401]);
  });

  it("does not write signature metadata, identities, nonces, or request bodies to traces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mpas-auth-trace-"));
    temporaryDirectories.add(directory);
    const tracePath = join(directory, "trace.jsonl");
    const traceLogger = new TraceLogger("coordination", new TraceWriter(tracePath));
    const app = createApp({}, traceLogger);
    const request = await coordinationActionRequest();
    const proposer = await fixtureSigner("proposer");
    const signed = await buildSignedRequest(
      "/mpas/v1/coordination/workflow",
      request,
      proposer.signer,
      "secret-nonce-value",
    );

    const response = await app.inject(signed);
    expect(response.statusCode).toBe(201);
    const trace = await readFile(tracePath, "utf8");
    expect(trace).toContain("coordination_workflow_create");
    expect(trace).not.toContain("Signature-Input");
    expect(trace).not.toContain("secret-nonce-value");
    expect(trace).not.toContain(proposer.fixture.did);
    expect(trace).not.toContain(request.actionPackage.actionEnvelope.actionId.value);
    expect(trace).not.toContain(signed.payload);
    expect(trace).not.toContain(signed.headers["Signature"]);
  });
});

function createApp(auth: Partial<CoordinationAuthOptions> = {}, traceLogger?: TraceLogger) {
  const app = createCoordinationApiServer({
    traceLogger,
    designatedVerifierDid: "did:web:adapter.local" as Did,
    auth: {
      enforcement: true,
      audiences: [AUDIENCE],
      now: () => NOW,
      ...auth,
    },
  });
  apps.add(app);
  return app;
}

function pollRequest(did: Did): CoordinationPollRequest {
  return { version: "1", type: "CoordinationPollRequest", did };
}

async function signedInject(
  app: ReturnType<typeof createCoordinationApiServer>,
  path: string,
  payload: object,
  signer: MpasRfc9421Signer,
  nonce?: string,
  audience = AUDIENCE,
  created = CREATED,
  expires = EXPIRES,
) {
  return app.inject(await buildSignedRequest(path, payload, signer, nonce, audience, created, expires));
}

async function buildSignedRequest(
  path: string,
  payload: object,
  signer: MpasRfc9421Signer,
  nonce?: string,
  audience = AUDIENCE,
  created = CREATED,
  expires = EXPIRES,
) {
  const body = JSON.stringify({ ...payload, audience });
  const headers = await signMpasRfc9421({
    method: "POST",
    path,
    body: Buffer.from(body),
    signer,
    nonce,
    created,
    expires,
  });
  return {
    method: "POST" as const,
    url: path,
    headers: { ...headers, "content-type": "application/mpas+json" } as Record<string, string>,
    payload: body,
  };
}

function expectPermissionDenied(response: { statusCode: number; json(): unknown }): void {
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual(
    mpasError("permission_denied", "The authenticated identity is not permitted for this request."),
  );
}

function mpasError(code: string, message: string) {
  return { version: "1", type: "MpasHttpError", error: { code, message } };
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
      verifier: { did: "did:web:adapter.local" },
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

async function fixtureSigner(label: "proposer" | "maintainer-a" | "maintainer-b" | "adapter"): Promise<FixtureSigner> {
  const fixture = await fixtureKey(label);
  return { fixture, signer: KeyManager.fromJwk(fixture.privateJwk) };
}

async function fixtureKey(label: "proposer" | "maintainer-a" | "maintainer-b" | "adapter"): Promise<FixtureKey> {
  return readJson<FixtureKey>(`test-keys/${label}.json`);
}

async function readJson<T>(fixture: string): Promise<T> {
  return JSON.parse(await readFile(join(process.cwd(), "tests", "fixtures", fixture), "utf8")) as T;
}
