import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseActionReference } from "../../src/lib/routing.js";
import {
  buildDeliveryEnvelope,
  computeIdempotencyFingerprint,
  computeJsonHash,
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
  type CoordinationActionUpdate,
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

function actionUpdate(state: CoordinationActionUpdate["state"] = "awaitingApprovals"): CoordinationActionUpdate {
  const actionPackage = actionRequest().actionPackage;
  actionPackage.actionEnvelope.executionPayloadHash = computeJsonHash(actionPackage.executionPayload);
  const actionEnvelopeHash = computeJsonHash(actionPackage.actionEnvelope);
  actionPackage.approvalBundle.actionEnvelopeHash = actionEnvelopeHash;
  // Structural parsing does not establish signature validity or execution authority.
  actionPackage.approvalBundle.approvals = [{ version: "1", type: "Approval", actionEnvelopeHash,
    decision: "approve", createdAt: actionPackage.actionEnvelope.createdAt, signature: { format: "jws", value: "e30.e30.c2ln" } }];
  return {
    version: "1", type: "CoordinationActionUpdate", state,
    actionRef: { version: "1", type: "ActionRef", actionId: actionPackage.actionEnvelope.actionId, actionEnvelopeHash },
    expiresAt: actionPackage.actionEnvelope.expiresAt,
    ...(state === "cancelled" ? { cancelledAt: "2026-08-25T12:30:00.000Z" } : { progress: { required: 1, collected: 0, pending: [observer] } }),
    ...(state === "rejected" ? { rejectedAt: "2026-08-25T12:30:00.000Z" } : {}),
    ...(state === "readyForResubmission" ? { actionPackage } : {}),
  };
}

describe("routing helpers", () => {
  it.each(["awaitingApprovals", "readyForResubmission", "executed", "rejected", "cancelled", "expired"] as const)
    ("preserves a valid populated action update in state %s", state => {
      const poll = { version: "1", type: "CoordinationPollResponse", approvalRequests: [], actionUpdates: [actionUpdate(state)] };
      expect(parseCoordinationPollResponse(poll)).toEqual(poll);
    });

  it.each([
    ["", null], ["", {}], ["version", "2"], ["type", "other"], ["extra", true], ["expiredAt", "2026-08-25T12:00:00.000Z"],
    ["expiresAt", undefined], ["expiresAt", "2030"], ["expiresAt", "2030-02-30T00:00:00.000Z"],
    ["actionRef", null], ["actionRef.actionId.scope", 42], ["actionRef.actionEnvelopeHash.value", "bad="],
    ["state", "other"], ["progress", undefined], ["progress", null], ["progress.extra", 0],
    ["progress.required", -1], ["progress.collected", 0.5], ["progress.pending", {}], ["progress.pending", ["not-a-did"]],
    ["cancelledAt", "2030"], ["rejectedAt", null], ["actionPackage", {}],
  ])("rejects malformed action update field %s", (field, value) => {
    let update: unknown = actionUpdate();
    if (field === "") update = value;
    else {
      const parts = (field as string).split(".");
      let object = update as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) object = object[part] as Record<string, unknown>;
      if (value === undefined) delete object[parts.at(-1)!];
      else object[parts.at(-1)!] = value;
    }
    expect(() => parseCoordinationPollResponse({ version: "1", type: "CoordinationPollResponse", approvalRequests: [], actionUpdates: [update] }))
      .toThrow(RoutingValidationError);
  });

  it.each(["missing ready package", "missing cancelled time", "cancelled progress", "cancelled package", "missing rejected time",
    "package action ID", "package scope", "package hash", "bundle hash", "approval hash", "package expiry"])
    ("rejects invalid action update condition: %s", fault => {
      const update = actionUpdate(fault.startsWith("cancelled") || fault === "missing cancelled time" ? "cancelled"
        : fault === "missing rejected time" ? "rejected" : "readyForResubmission");
      if (fault === "missing ready package") delete update.actionPackage;
      if (fault === "missing cancelled time") delete update.cancelledAt;
      if (fault === "cancelled progress") update.progress = { required: 0, collected: 0, pending: [] };
      if (fault === "cancelled package") update.actionPackage = actionUpdate("readyForResubmission").actionPackage;
      if (fault === "missing rejected time") delete update.rejectedAt;
      if (fault === "package action ID") update.actionRef.actionId = { value: "other" };
      if (fault === "package scope") update.actionRef.actionId = { ...update.actionRef.actionId, scope: "other" };
      if (fault === "package hash") update.actionRef.actionEnvelopeHash = { alg: "sha-256", value: "wrong" };
      if (fault === "bundle hash") update.actionPackage!.approvalBundle.actionEnvelopeHash = { alg: "sha-256", value: "wrong" };
      if (fault === "approval hash") update.actionPackage!.approvalBundle.approvals[0].actionEnvelopeHash = { alg: "sha-256", value: "wrong" };
      if (fault === "package expiry") update.expiresAt = "2026-08-25T14:00:00.000Z";
      expect(() => parseCoordinationPollResponse({ version: "1", type: "CoordinationPollResponse", approvalRequests: [], actionUpdates: [update] }))
        .toThrow(RoutingValidationError);
    });

  it("rejects undeclared Coordination poll wrapper members", () => {
    const poll = { version: "1", type: "CoordinationPollResponse", approvalRequests: [], actionUpdates: [], extra: true };
    expect(() => parseCoordinationPollResponse(poll)).toThrow(RoutingValidationError);
    expect(() => parseCoordinationPollResponse(poll)).toThrowError(expect.objectContaining({
      code: "ROUTING_VALIDATION_ERROR", path: "$.extra", message: "Object contains an undeclared member.",
    }));
  });

  it("accepts an empty Coordination poll with omitted action updates", () => {
    expect(parseCoordinationPollResponse({ version: "1", type: "CoordinationPollResponse", approvalRequests: [] }))
      .toEqual({ version: "1", type: "CoordinationPollResponse", approvalRequests: [], actionUpdates: [] });
  });

  it("preserves complete pending objects, valid scoped IDs, and HTTP optional metadata", () => {
    const poll = JSON.parse(readFileSync(new URL("../fixtures/responses/coordination-pending-actions.json", import.meta.url), "utf8"));
    const request = poll.approvalRequests[0];
    request.actionRef.actionId = { value: "42", scope: "eip155:1:0x1234567890abcdef1234567890abcdef12345678" };
    request.signerReviewSet.actionEnvelope.actionId = { ...request.actionRef.actionId };
    request.returnMode = "async";
    request.context = { message: "Review this complete action", data: [null, true, 2] };
    request.signerReviewSet.actionEnvelope.target.region = "test-region";
    expect(parseCoordinationPollResponse(poll)).toEqual(poll);
    expect(parseActionReference(request.actionRef)).toEqual(request.actionRef);
    delete request.signerReviewSet.authorizationRequirements;
    delete request.requestedDecision;
    expect(parseCoordinationPollResponse(poll)).toEqual(poll);
  });

  it.each([
    ["", null], ["", {}], ["version", "2"], ["extra", true],
    ["actionRef.extra", true], ["actionRef.actionId.extra", true],
    ["actionRef.actionId.value", ""], ["actionRef.actionId.scope", 42],
    ["actionRef.actionEnvelopeHash.extra", true], ["actionRef.actionEnvelopeHash.value", "bad="],
    ["signerReviewSet", null], ["signerReviewSet.extra", true],
    ["signerReviewSet.actionEnvelope.proposer", {}],
    ["signerReviewSet.actionEnvelope.executionProfile.extra", true],
    ["signerReviewSet.actionEnvelope.target.resource", 42],
    ["signerReviewSet.actionEnvelope.expiresAt", "2030-02-30T00:00:00.000Z"],
    ["signerReviewSet.authorizationRequirements.verifier", {}],
    ["signerReviewSet.authorizationRequirements.approvalRequirements", {}],
    ["signerReviewSet.authorizationRequirements.approvalRequirements.anyOf", [null]],
    ["signerReviewSet.authorizationRequirements.approvalRequirements.anyOf", [{ type: "threshold", threshold: 1 }]],
    ["signerReviewSet.authorizationRequirements.approvalRequirements.overrideSigners", [{ signer: "did:web:a", permissions: [] }]],
    ["returnMode", "other"], ["context", []],
  ])("rejects malformed pending field %s", (field, invalid) => {
    const poll = JSON.parse(readFileSync(new URL("../fixtures/responses/coordination-pending-actions.json", import.meta.url), "utf8"));
    if (field === "") poll.approvalRequests[0] = invalid;
    else {
      const parts = field.split(".");
      let object = poll.approvalRequests[0];
      for (const part of parts.slice(0, -1)) object = object[part];
      object[parts.at(-1)!] = invalid;
    }
    expect(() => parseCoordinationPollResponse(poll)).toThrow(RoutingValidationError);
  });

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

  it("requires response and authorization-requirements Verifier DIDs to match", () => {
    const response: ActionResponse = {
      version: "1",
      type: "ActionResponse",
      verifier: { did: verifier },
      actionEnvelopeHash: { alg: "sha-256", value: "envelope" },
      result: "additionalApprovalsRequired",
      authorizationRequirements: {
        version: "1",
        type: "AuthorizationRequirements",
        actionEnvelopeHash: { alg: "sha-256", value: "envelope" },
        result: "additionalApprovalsRequired",
        verifier: { did: verifier },
        approvalRequirements: {
          anyOf: [{ type: "threshold", eligibleSigners: [observer], threshold: 1 }],
        },
      },
    };

    expect(parseActionResponse(response)).toBe(response);
    expect(() => parseActionResponse({
      ...response,
      authorizationRequirements: {
        ...response.authorizationRequirements!,
        verifier: { did: observer },
      },
    })).toThrow("must equal ActionResponse.verifier.did");
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
      actionUpdates: [],
    })).toEqual({
      version: "1",
      type: "CoordinationPollResponse",
      approvalRequests: [],
      actionUpdates: [],
    });
    expect(() => parseCoordinationPollResponse({
      version: "1",
      type: "CoordinationPollResponse",
      approvalRequests: [],
      actionUpdates: [],
      deliveries: [],
    })).toThrowError(expect.objectContaining({
      code: "ROUTING_VALIDATION_ERROR", path: "$.deliveries", message: "Object contains an undeclared member.",
    }));
    expect(parseCoordinationSessionResponse({
      version: "1",
      type: "CoordinationSessionResponse",
      websocketUrl: "wss://coordination.example.com/mpas/v1/coordination/ws",
      ticket: "ticket",
      expiresAt: "2026-08-25T12:05:00.000Z",
    }).ticket).toBe("ticket");
  });
});
