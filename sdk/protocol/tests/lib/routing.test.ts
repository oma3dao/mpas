import { describe, expect, it } from "vitest";
import {
  buildDeliveryEnvelope,
  computeIdempotencyFingerprint,
  parseActionRequestEnvelope,
  parseActionResponseEnvelope,
  parseActionResponse,
  parseCoordinationDeliveryResponse,
  parseCoordinationPollResponse,
  parseCoordinationSessionResponse,
  parseDeliveryEnvelope,
  resolveIdempotencyKey,
  RoutingValidationError,
  type ActionRequest,
  type ActionResponse,
  type Did,
} from "../../src/index.js";

const proposer = "did:jwk:proposer" as Did;
const verifier = "did:jwk:verifier" as Did;
const observer = "did:jwk:observer" as Did;

function actionRequest(idempotencyKey = "request-1"): ActionRequest {
  return {
    version: "1",
    type: "ActionRequest",
    idempotencyKey,
    actionPackage: {
      version: "1",
      type: "ActionPackage",
      executionPayload: {},
      actionEnvelope: {
        version: "1",
        type: "ActionEnvelope",
        proposer: { did: proposer },
        target: { applicationDid: verifier },
        executionProfile: { id: "did:web:profiles.example" },
        executionPayloadHash: { alg: "sha-256", value: "payload" },
        actionId: { value: "urn:uuid:11111111-1111-4111-8111-111111111111" },
        createdAt: "2026-08-25T12:00:00.000Z",
        expiresAt: "2026-08-25T13:00:00.000Z",
      },
      approvalBundle: {
        version: "1",
        type: "ApprovalBundle",
        actionEnvelopeHash: { alg: "sha-256", value: "envelope" },
        approvals: [],
      },
    },
  };
}

describe("routing helpers", () => {
  it("builds and parses a multi-recipient ActionRequest envelope without assigning roles", () => {
    const envelope = buildDeliveryEnvelope({
      sender: proposer,
      recipients: [verifier, observer],
      createdAt: "2026-08-25T12:00:00.000Z",
      expiresAt: "2026-08-25T12:05:00.000Z",
      audience: "https://coordination.example.com",
      payload: actionRequest(),
    });

    expect(parseActionRequestEnvelope(envelope)).toEqual(envelope);
    expect(envelope.recipients).toEqual([verifier, observer]);
  });

  it("rejects empty, duplicate, and inverted-time recipient envelopes", () => {
    const base = buildDeliveryEnvelope({ sender: proposer, recipients: [verifier], payload: actionRequest() });
    expect(() => parseDeliveryEnvelope({ ...base, recipients: [] })).toThrow(RoutingValidationError);
    expect(() => parseDeliveryEnvelope({ ...base, recipients: [verifier, verifier] })).toThrow("unique DIDs");
    expect(() => parseDeliveryEnvelope({
      ...base,
      createdAt: "2026-08-25T12:05:00.000Z",
      expiresAt: "2026-08-25T12:00:00.000Z",
    })).toThrow("later than createdAt");
    expect(() => parseDeliveryEnvelope({ ...base, createdAt: "2026-08-25T12:00:00Z" })).toThrow("RFC 3339");
  });

  it("parses only ActionResponse payloads for Verifier response delivery", () => {
    const response: ActionResponse = {
      version: "1",
      type: "ActionResponse",
      verifier: { did: verifier },
      actionEnvelopeHash: { alg: "sha-256", value: "envelope" },
      result: "executed",
    };
    const envelope = buildDeliveryEnvelope({ sender: verifier, recipients: [proposer], payload: response });
    expect(parseActionResponseEnvelope(envelope).payload).toBe(response);
    expect(parseActionResponse(response)).toBe(response);
    expect(() => parseActionResponse({ ...response, result: "invented" })).toThrow("result is invalid");
    expect(() => parseActionResponseEnvelope({ ...envelope, payload: actionRequest() })).toThrow();
  });

  it("resolves body/header idempotency and fingerprints independently of the key", () => {
    expect(resolveIdempotencyKey("same", "same")).toBe("same");
    expect(resolveIdempotencyKey(undefined, "header")).toBe("header");
    expect(() => resolveIdempotencyKey("body", "header")).toThrow("differ");

    const first = buildDeliveryEnvelope({
      sender: proposer,
      recipients: [verifier, observer],
      createdAt: "2026-08-25T12:00:00.000Z",
      expiresAt: "2026-08-25T12:05:00.000Z",
      audience: "https://coordination.example.com",
      payload: actionRequest("one"),
    });
    const retry = {
      ...first,
      recipients: [observer, verifier],
      createdAt: "2026-08-25T12:01:00.000Z",
      expiresAt: "2026-08-25T12:10:00.000Z",
      audience: "https://relay.example.com",
      payload: { ...actionRequest("two"), audience: "https://relay.example.com" },
    };
    expect(computeIdempotencyFingerprint(first)).toBe(computeIdempotencyFingerprint(retry));
    expect(computeIdempotencyFingerprint({ ...retry, recipients: [verifier] })).not.toBe(
      computeIdempotencyFingerprint(first),
    );
    expect(computeIdempotencyFingerprint({ ...retry, sender: observer })).not.toBe(
      computeIdempotencyFingerprint(first),
    );

    const changedAction = structuredClone(retry);
    changedAction.payload.actionPackage.actionEnvelope.actionId.value = "urn:uuid:22222222-2222-4222-8222-222222222222";
    expect(computeIdempotencyFingerprint(changedAction)).not.toBe(computeIdempotencyFingerprint(first));
    expect(() => computeIdempotencyFingerprint({ version: "1", type: "FutureMutation", idempotencyKey: "key" }))
      .toThrow("No idempotency equivalence scope");

    const approvalSubmission = {
      version: "1",
      type: "CoordinationApprovalSubmission",
      idempotencyKey: "first",
      audience: "https://coordination.example.com",
      actionEnvelopeHash: { alg: "sha-256", value: "action" },
      approval: { type: "Approval", decision: "approve" },
    };
    expect(computeIdempotencyFingerprint(approvalSubmission)).toBe(computeIdempotencyFingerprint({
      ...approvalSubmission,
      idempotencyKey: "second",
      audience: "https://relay.example.com",
    }));
    expect(computeIdempotencyFingerprint({
      ...approvalSubmission,
      approval: { type: "Approval", decision: "reject" },
    })).not.toBe(computeIdempotencyFingerprint(approvalSubmission));
  });

  it("parses the new delivery, poll, and session response messages", () => {
    expect(parseCoordinationDeliveryResponse({
      version: "1",
      type: "CoordinationDeliveryResponse",
      accepted: true,
    }).accepted).toBe(true);
    expect(parseCoordinationPollResponse({
      version: "1",
      type: "CoordinationPollResponse",
      approvalRequests: [],
      deliveries: [],
      nextCursor: "10",
    })).toMatchObject({ actionUpdates: [], nextCursor: "10" });
    expect(parseCoordinationSessionResponse({
      version: "1",
      type: "CoordinationSessionResponse",
      websocketUrl: "wss://coordination.example.com/mpas/v1/coordination/ws",
      ticket: "ticket",
      expiresAt: "2026-08-25T12:05:00.000Z",
    }).ticket).toBe("ticket");
  });
});
