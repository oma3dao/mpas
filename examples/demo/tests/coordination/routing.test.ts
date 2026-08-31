import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildDeliveryEnvelope, type ActionPackage, type ActionRequest, type ActionResponse, type Did } from "@oma3/mpas";
import { createCoordinationApiServer } from "../../src/coordination/coordination-api-server.js";
import { CoordinationStore } from "../../src/coordination/store.js";
import { computeJsonHash } from "../../src/core/verification.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const verifier = "did:jwk:verifier" as Did;
const observer = "did:jwk:observer" as Did;
const maintainer = "did:jwk:maintainer" as Did;
const unknown = "did:jwk:unknown" as Did;
const apps = new Set<ReturnType<typeof createCoordinationApiServer>>();

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

describe("co-located Action Relay and Coordination Service", () => {
  it("relays a multi-recipient Action to the configured Verifier and returns its unchanged response", async () => {
    const pkg = await actionPackage();
    const proposer = pkg.actionEnvelope.proposer.did;
    const request = actionRequest(pkg);
    const envelope = buildDeliveryEnvelope({
      sender: proposer,
      recipients: [verifier, observer],
      payload: request,
    });
    const store = new CoordinationStore();
    const app = createApp(store);

    const pending = app.inject({ method: "POST", url: "/mpas/v1/verifier/action", payload: envelope });
    await new Promise((resolve) => setImmediate(resolve));
    const verifierPoll = await relayPoll(app, verifier);
    const observerPoll = await relayPoll(app, observer);
    expect(verifierPoll.json().deliveries).toEqual([envelope]);
    expect(observerPoll.json().deliveries).toEqual([envelope]);

    const response: ActionResponse = {
      version: "1",
      type: "ActionResponse",
      verifier: { did: verifier },
      actionEnvelopeHash: computeJsonHash(pkg.actionEnvelope),
      result: "executed",
      createdAt: "2026-08-26T12:00:00.000Z",
    };
    const responseEnvelope = buildDeliveryEnvelope({ sender: verifier, recipients: [proposer], payload: response });
    const wrongAlgorithm = await app.inject({
      method: "POST",
      url: "/mpas/v1/relay/delivery",
      payload: {
        ...responseEnvelope,
        payload: { ...response, actionEnvelopeHash: { ...response.actionEnvelopeHash!, alg: "sha-512" } },
      },
    });
    expect(wrongAlgorithm.statusCode).toBe(400);
    expect(wrongAlgorithm.json().error.code).toBe("ACTION_HASH_MISMATCH");
    const delivered = await app.inject({
      method: "POST",
      url: "/mpas/v1/relay/delivery",
      payload: responseEnvelope,
    });

    expect(delivered.statusCode).toBe(200);
    expect(delivered.json()).toMatchObject({ type: "RelayDeliveryResponse", accepted: true });
    const actionResult = await pending;
    expect(actionResult.statusCode).toBe(200);
    expect(actionResult.json()).toEqual(response);
    expect((await relayPoll(app, proposer)).json().deliveries).toContainEqual(responseEnvelope);
    expect((await poll(app, proposer)).json().deliveries).toBeUndefined();
    expect(store.routingAudit()).toMatchObject([
      { purpose: "initialAction", recipients: [verifier, observer], designatedVerifierDid: verifier },
      { purpose: "actionResponse", recipients: [proposer], designatedVerifierDid: verifier },
    ]);
  });

  it("keeps a requirements response relay-only until the client explicitly creates a workflow", async () => {
    const pkg = await actionPackage();
    const proposer = pkg.actionEnvelope.proposer.did;
    const app = createApp();
    const pending = app.inject({
      method: "POST",
      url: "/mpas/v1/verifier/action",
      payload: buildDeliveryEnvelope({
        sender: proposer,
        recipients: [verifier],
        payload: actionRequest(pkg),
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const response: ActionResponse = {
      version: "1",
      type: "ActionResponse",
      verifier: { did: verifier },
      actionEnvelopeHash: computeJsonHash(pkg.actionEnvelope),
      result: "additionalApprovalsRequired",
      authorizationRequirements: {
        version: "1",
        type: "AuthorizationRequirements",
        actionEnvelopeHash: computeJsonHash(pkg.actionEnvelope),
        result: "additionalApprovalsRequired",
        verifier: { did: verifier },
        approvalRequirements: {
          anyOf: [{ type: "threshold", threshold: 1, eligibleSigners: [maintainer] }],
        },
      },
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/mpas/v1/relay/delivery",
      payload: buildDeliveryEnvelope({ sender: verifier, recipients: [proposer, unknown], payload: response }),
    });
    expect(unauthorized.statusCode).toBe(403);
    expect(unauthorized.json().error.code).toBe("permission_denied");

    const signerCopy = await app.inject({
      method: "POST",
      url: "/mpas/v1/relay/delivery",
      payload: buildDeliveryEnvelope({ sender: verifier, recipients: [proposer, maintainer], payload: response }),
    });
    expect(signerCopy.statusCode).toBe(403);

    const responseEnvelope = buildDeliveryEnvelope({ sender: verifier, recipients: [proposer], payload: response });
    const delivered = await app.inject({
      method: "POST",
      url: "/mpas/v1/relay/delivery",
      payload: responseEnvelope,
    });

    expect(delivered.statusCode).toBe(200);
    expect((await pending).json()).toEqual(response);
    expect((await relayPoll(app, maintainer)).json().deliveries).toEqual([]);
    expect((await poll(app, maintainer)).json().approvalRequests).toHaveLength(0);

    const workflow = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/workflow",
      payload: {
        version: "1",
        type: "CoordinationActionRequest",
        actionPackage: pkg,
        authorizationRequirements: response.authorizationRequirements,
      },
    });
    expect(workflow.statusCode).toBe(201);
    expect((await poll(app, maintainer)).json().approvalRequests).toHaveLength(1);
    expect((await relayPoll(app, maintainer)).json().deliveries).toEqual([]);
  });

  it("rejects bare relay submission, unauthorized recipients, and non-ActionResponse delivery", async () => {
    const pkg = await actionPackage();
    const proposer = pkg.actionEnvelope.proposer.did;
    const app = createApp();

    const bare = await app.inject({ method: "POST", url: "/mpas/v1/action", payload: actionRequest(pkg) });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/mpas/v1/verifier/action",
      payload: buildDeliveryEnvelope({ sender: proposer, recipients: [verifier, unknown], payload: actionRequest(pkg) }),
    });
    const wrongPayload = await app.inject({
      method: "POST",
      url: "/mpas/v1/relay/delivery",
      payload: buildDeliveryEnvelope({ sender: verifier, recipients: [proposer], payload: actionRequest(pkg) }),
    });

    expect(bare.statusCode).toBe(400);
    expect(unauthorized.statusCode).toBe(403);
    expect(wrongPayload.statusCode).toBe(400);
  });

  it("rejects body/header idempotency mismatch before creating a delivery", async () => {
    const pkg = await actionPackage();
    const envelope = buildDeliveryEnvelope({
      sender: pkg.actionEnvelope.proposer.did,
      recipients: [verifier],
      payload: actionRequest(pkg),
    });
    const app = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/verifier/action",
      headers: { "idempotency-key": "different" },
      payload: envelope,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("idempotency_mismatch");
    expect((await relayPoll(app, verifier)).json().deliveries).toEqual([]);
  });

  it("rejects an already expired envelope without creating a delivery", async () => {
    const pkg = await actionPackage();
    const app = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      payload: buildDeliveryEnvelope({
        sender: pkg.actionEnvelope.proposer.did,
        recipients: [verifier],
        createdAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:01:00.000Z",
        payload: actionRequest(pkg),
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    expect((await relayPoll(app, verifier)).json().deliveries).toEqual([]);

    const expiredResponse = await app.inject({
      method: "POST",
      url: "/mpas/v1/relay/delivery",
      payload: buildDeliveryEnvelope({
        sender: verifier,
        recipients: [pkg.actionEnvelope.proposer.did],
        createdAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:01:00.000Z",
        payload: {
          version: "1",
          type: "ActionResponse",
          verifier: { did: verifier },
          actionEnvelopeHash: computeJsonHash(pkg.actionEnvelope),
          result: "executed",
        },
      }),
    });
    expect(expiredResponse.statusCode).toBe(400);
    expect(expiredResponse.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects unusable Verifier requirements without storing the response or creating a workflow", async () => {
    const pkg = await actionPackage();
    const proposer = pkg.actionEnvelope.proposer.did;
    const app = createApp(undefined, 25);
    const pending = app.inject({
      method: "POST",
      url: "/mpas/v1/action",
      payload: buildDeliveryEnvelope({ sender: proposer, recipients: [verifier], payload: actionRequest(pkg) }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const baseRequirements = {
      version: "1" as const,
      type: "AuthorizationRequirements" as const,
      actionEnvelopeHash: computeJsonHash(pkg.actionEnvelope),
      result: "additionalApprovalsRequired" as const,
      verifier: { did: verifier },
    };
    const invalidRequirements = [
      {
        ...baseRequirements,
        approvalRequirements: {
          anyOf: [{ type: "threshold" as const, threshold: 2, eligibleSigners: [maintainer] }],
        },
      },
      {
        ...baseRequirements,
        approvalRequirements: {
          anyOf: [{ type: "threshold" as const, threshold: 1, eligibleSigners: [maintainer, maintainer] }],
        },
      },
    ];

    for (const authorizationRequirements of invalidRequirements) {
      const response: ActionResponse = {
        version: "1",
        type: "ActionResponse",
        verifier: { did: verifier },
        actionEnvelopeHash: computeJsonHash(pkg.actionEnvelope),
        result: "additionalApprovalsRequired",
        authorizationRequirements,
      };
      const rejected = await app.inject({
        method: "POST",
        url: "/mpas/v1/relay/delivery",
        payload: buildDeliveryEnvelope({ sender: verifier, recipients: [proposer], payload: response }),
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("INVALID_REQUEST");
    }

    expect((await poll(app, maintainer)).json().approvalRequests).toHaveLength(0);
    expect((await relayPoll(app, proposer)).json().deliveries).toEqual([]);
    expect((await pending).statusCode).toBe(503);
  });

  it("bounds the relay wait and lets an equivalent rebuilt retry receive the later response", async () => {
    const pkg = await actionPackage();
    const proposer = pkg.actionEnvelope.proposer.did;
    const store = new CoordinationStore();
    const app = createApp(store, 25);
    const firstEnvelope = buildDeliveryEnvelope({
      sender: proposer,
      recipients: [verifier],
      createdAt: "2026-08-20T12:00:00.000Z",
      audience: "https://first-relay.example.com",
      payload: actionRequest(pkg),
    });

    const timedOut = await app.inject({ method: "POST", url: "/mpas/v1/verifier/action", payload: firstEnvelope });
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.json().error).toMatchObject({ code: "timeout", retryable: true });
    expect((await relayPoll(app, verifier)).json().deliveries).toHaveLength(1);

    const retryEnvelope = {
      ...firstEnvelope,
      createdAt: "2026-08-21T12:00:00.000Z",
      audience: "https://second-relay.example.com",
    };
    const retry = app.inject({ method: "POST", url: "/mpas/v1/action", payload: retryEnvelope });
    await new Promise((resolve) => setImmediate(resolve));
    const response: ActionResponse = {
      version: "1",
      type: "ActionResponse",
      verifier: { did: verifier },
      actionEnvelopeHash: computeJsonHash(pkg.actionEnvelope),
      result: "executed",
    };
    await app.inject({
      method: "POST",
      url: "/mpas/v1/relay/delivery",
      payload: buildDeliveryEnvelope({ sender: verifier, recipients: [proposer], payload: response }),
    });

    expect((await retry).json()).toEqual(response);
    expect((await relayPoll(app, verifier)).json().deliveries).toHaveLength(1);
  });

  it("rejects Action Package hash-binding failures before creating deliveries", async () => {
    const valid = await actionPackage();
    const invalidPackages = [
      { ...structuredClone(valid), executionPayload: { changed: true } },
      {
        ...structuredClone(valid),
        approvalBundle: {
          ...structuredClone(valid.approvalBundle),
          actionEnvelopeHash: { alg: "sha-256" as const, value: "wrong" },
        },
      },
    ];

    for (const pkg of invalidPackages) {
      const app = createApp();
      const response = await app.inject({
        method: "POST",
        url: "/mpas/v1/verifier/action",
        payload: buildDeliveryEnvelope({
          sender: pkg.actionEnvelope.proposer.did,
          recipients: [verifier],
          payload: actionRequest(pkg),
        }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("artifact_hash_mismatch");
      expect((await relayPoll(app, verifier)).json().deliveries).toEqual([]);
    }
  });

  it("coalesces equivalent concurrent Action retries and rejects changed-body key reuse", async () => {
    const pkg = await actionPackage();
    const proposer = pkg.actionEnvelope.proposer.did;
    const envelope = buildDeliveryEnvelope({
      sender: proposer,
      recipients: [verifier],
      payload: actionRequest(pkg),
    });
    const app = createApp();
    const first = app.inject({ method: "POST", url: "/mpas/v1/verifier/action", payload: envelope });
    const retry = app.inject({ method: "POST", url: "/mpas/v1/action", payload: envelope });
    await new Promise((resolve) => setImmediate(resolve));

    const conflict = await app.inject({
      method: "POST",
      url: "/mpas/v1/verifier/action",
      payload: { ...envelope, recipients: [verifier, observer] },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");
    expect((await relayPoll(app, verifier)).json().deliveries).toHaveLength(1);

    const response: ActionResponse = {
      version: "1",
      type: "ActionResponse",
      verifier: { did: verifier },
      actionEnvelopeHash: computeJsonHash(pkg.actionEnvelope),
      result: "executed",
    };
    await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/delivery",
      payload: buildDeliveryEnvelope({ sender: verifier, recipients: [proposer], payload: response }),
    });
    expect((await Promise.all([first, retry])).map((result) => result.json())).toEqual([response, response]);
  });

  it("issues an opaque notification session ticket", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/session",
      payload: { version: "1", type: "CoordinationSessionRequest", did: verifier },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: "1",
      type: "CoordinationSessionResponse",
      websocketUrl: "wss://coordination.example.com/mpas/v1/coordination/ws",
    });
    expect(response.json().ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("caps delivery pages and returns a checkpoint cursor for every non-empty page", async () => {
    const base = await actionPackage();
    const store = new CoordinationStore();
    for (let index = 0; index < 101; index += 1) {
      const pkg = structuredClone(base);
      pkg.actionEnvelope.actionId.value = `urn:uuid:${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
      pkg.approvalBundle.actionEnvelopeHash = computeJsonHash(pkg.actionEnvelope);
      store.beginRelayedAction(buildDeliveryEnvelope({
        sender: pkg.actionEnvelope.proposer.did,
        recipients: [verifier],
        payload: { version: "1", type: "ActionRequest", actionPackage: pkg },
      }), verifier);
    }

    const first = store.pollDeliveries(verifier);
    expect(first.deliveries).toHaveLength(100);
    expect(first.nextCursor).toBeDefined();
    const second = store.pollDeliveries(verifier, first.nextCursor);
    expect(second.deliveries).toHaveLength(1);
    expect(second.nextCursor).toBeDefined();
    const caughtUp = store.pollDeliveries(verifier, second.nextCursor);
    expect(caughtUp.deliveries).toEqual([]);
    expect(caughtUp.nextCursor).toBeUndefined();
  });
});

function createApp(store?: CoordinationStore, relayResponseWaitMs?: number) {
  const app = createCoordinationApiServer({
    store,
    designatedVerifierDid: verifier,
    authorizedRecipientDids: [observer],
    notificationOrigin: "https://coordination.example.com",
    ...(relayResponseWaitMs !== undefined ? { relayResponseWaitMs } : {}),
  });
  apps.add(app);
  return app;
}

function poll(app: ReturnType<typeof createCoordinationApiServer>, did: Did) {
  return app.inject({ method: "POST", url: "/mpas/v1/coordination/poll", payload: { version: "1", type: "CoordinationPollRequest", did } });
}

function relayPoll(app: ReturnType<typeof createCoordinationApiServer>, did: Did, cursor?: string) {
  return app.inject({
    method: "POST",
    url: "/mpas/v1/relay/poll",
    payload: { version: "1", type: "RelayPollRequest", did, ...(cursor !== undefined ? { cursor } : {}) },
  });
}

function actionRequest(pkg: ActionPackage): ActionRequest {
  return { version: "1", type: "ActionRequest", idempotencyKey: "relay-action-1", actionPackage: pkg };
}

async function actionPackage(): Promise<ActionPackage> {
  return JSON.parse(await readFile(`${fixtures}/core/insufficient-approvals.json`, "utf8")) as ActionPackage;
}
