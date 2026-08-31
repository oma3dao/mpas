import {
  hasDeliveryEnvelopeRecipient,
  isDeliveryEnvelopeExpired,
  parseActionRequestEnvelope,
  parseActionResponseEnvelope,
  resolveIdempotencyKey,
  RoutingValidationError,
  type CoordinationSessionRequest,
  type RelayPollRequest,
  type RelaySessionRequest,
  type DeliveryEnvelope,
  type ActionRequest,
  type ActionResponse,
  type Did,
} from "@oma3/mpas";
import { MpasServiceError } from "./store.js";
import type {
  CoordinationActionCancelRequest,
  CoordinationActionRequest,
  CoordinationApprovalSubmission,
  CoordinationPollRequest,
} from "./types.js";

export function validateRelayedActionRequest(value: unknown, verifierDid: Did): DeliveryEnvelope<ActionRequest> {
  try {
    const envelope = parseActionRequestEnvelope(value);
    const proposerDid = envelope.payload.actionPackage.actionEnvelope?.proposer?.did;
    if (envelope.sender !== proposerDid) {
      throw new RoutingValidationError("DeliveryEnvelope.sender must equal ActionEnvelope.proposer.did.", "$.sender");
    }
    if (!hasDeliveryEnvelopeRecipient(envelope, verifierDid)) {
      throw new RoutingValidationError("Configured Verifier DID must occur in DeliveryEnvelope.recipients.", "$.recipients");
    }
    if (isDeliveryEnvelopeExpired(envelope)) {
      throw new RoutingValidationError("DeliveryEnvelope.expiresAt must be in the future at submission.", "$.expiresAt");
    }
    return envelope;
  } catch (error) {
    throw invalidRequest(error);
  }
}

export function validateResponseDelivery(value: unknown): DeliveryEnvelope<ActionResponse> {
  try {
    const envelope = parseActionResponseEnvelope(value);
    if (!envelope.payload.verifier?.did) {
      throw new RoutingValidationError("ActionResponse.verifier.did is required for coordinated delivery.", "$.payload.verifier.did");
    }
    if (!envelope.payload.actionEnvelopeHash?.value) {
      throw new RoutingValidationError("ActionResponse.actionEnvelopeHash is required for coordinated delivery.", "$.payload.actionEnvelopeHash");
    }
    if (isDeliveryEnvelopeExpired(envelope)) {
      throw new RoutingValidationError("DeliveryEnvelope.expiresAt must be in the future at submission.", "$.expiresAt");
    }
    return envelope;
  } catch (error) {
    throw invalidRequest(error);
  }
}

export function validateSessionRequest(value: unknown): CoordinationSessionRequest {
  const body = requireRecord(value);
  requireVersionType(body, "CoordinationSessionRequest");
  if (typeof body.did !== "string" || !body.did.startsWith("did:")) {
    throw new MpasServiceError(400, "INVALID_REQUEST", "CoordinationSessionRequest.did must be a DID.");
  }
  return body as unknown as CoordinationSessionRequest;
}

export function validateRelaySessionRequest(value: unknown): RelaySessionRequest {
  const body = requireRecord(value);
  requireVersionType(body, "RelaySessionRequest");
  if (typeof body.did !== "string" || !body.did.startsWith("did:")) {
    throw new MpasServiceError(400, "INVALID_REQUEST", "RelaySessionRequest.did must be a DID.");
  }
  return body as unknown as RelaySessionRequest;
}

export function validateRelayPollRequest(value: unknown): RelayPollRequest {
  const body = requireRecord(value);
  requireVersionType(body, "RelayPollRequest");
  if (typeof body.did !== "string" || !body.did.startsWith("did:")) {
    throw new MpasServiceError(400, "INVALID_REQUEST", "RelayPollRequest.did must be a DID.");
  }
  if (body.cursor !== undefined && typeof body.cursor !== "string") {
    throw new MpasServiceError(400, "INVALID_REQUEST", "RelayPollRequest.cursor must be a string.");
  }
  return body as unknown as RelayPollRequest;
}

export function validatePollRequest(value: unknown): CoordinationPollRequest {
  const body = requireRecord(value);
  requireVersionType(body, "CoordinationPollRequest");
  if (typeof body.did !== "string" || !body.did.startsWith("did:")) {
    throw new MpasServiceError(400, "INVALID_REQUEST", "CoordinationPollRequest.did must be a DID.");
  }
  return body as unknown as CoordinationPollRequest;
}

export function validateCoordinationActionRequest(value: unknown): CoordinationActionRequest {
  const body = requireRecord(value);
  requireVersionType(body, "CoordinationActionRequest");
  if (!isRecord(body.actionPackage) || body.actionPackage.type !== "ActionPackage") {
    throw new MpasServiceError(400, "INVALID_REQUEST", "CoordinationActionRequest.actionPackage is required.");
  }
  if (!isRecord(body.authorizationRequirements) || body.authorizationRequirements.type !== "AuthorizationRequirements") {
    throw new MpasServiceError(400, "INVALID_REQUEST", "CoordinationActionRequest.authorizationRequirements is required.");
  }
  validateBodyIdempotency(body.idempotencyKey);
  return body as unknown as CoordinationActionRequest;
}

export function validateApprovalSubmission(value: unknown): CoordinationApprovalSubmission {
  const body = requireRecord(value);
  requireVersionType(body, "CoordinationApprovalSubmission");
  if (!isRecord(body.actionEnvelopeHash) || typeof body.actionEnvelopeHash.value !== "string") {
    throw new MpasServiceError(400, "INVALID_REQUEST", "CoordinationApprovalSubmission.actionEnvelopeHash is required.");
  }
  if (!isRecord(body.approval) || body.approval.type !== "Approval") {
    throw new MpasServiceError(400, "INVALID_REQUEST", "CoordinationApprovalSubmission.approval is required.");
  }
  validateBodyIdempotency(body.idempotencyKey);
  return body as unknown as CoordinationApprovalSubmission;
}

export function validateCancelRequest(value: unknown): CoordinationActionCancelRequest {
  const body = requireRecord(value);
  requireVersionType(body, "CoordinationActionCancelRequest");
  if (!isRecord(body.actionId) || typeof body.actionId.value !== "string" || typeof body.proposerDid !== "string") {
    throw new MpasServiceError(400, "INVALID_REQUEST", "Cancellation actionId and proposerDid are required.");
  }
  validateBodyIdempotency(body.idempotencyKey);
  return body as unknown as CoordinationActionCancelRequest;
}

export function effectiveIdempotencyKey(bodyValue: unknown, headerValue: unknown): string | undefined {
  try {
    return resolveIdempotencyKey(bodyValue, typeof headerValue === "string" ? headerValue : undefined);
  } catch (error) {
    throw new MpasServiceError(400, "idempotency_mismatch", error instanceof Error ? error.message : String(error));
  }
}

function validateBodyIdempotency(value: unknown): void {
  if (value === undefined) return;
  try {
    resolveIdempotencyKey(value);
  } catch (error) {
    throw invalidRequest(error);
  }
}

function invalidRequest(error: unknown): MpasServiceError {
  return new MpasServiceError(400, "INVALID_REQUEST", error instanceof Error ? error.message : String(error));
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new MpasServiceError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  return value;
}

function requireVersionType(body: Record<string, unknown>, type: string): void {
  if (body.version !== "1" || body.type !== type) {
    throw new MpasServiceError(400, "INVALID_REQUEST", `Expected version 1 ${type}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
