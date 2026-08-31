import type {
  ActionRequest,
  ActionResponse,
  CoordinationDeliveryResponse,
  CoordinationPollResponse,
  CoordinationSessionResponse,
  CoordinationWorkAvailable,
  DeliveryEnvelope,
  Did,
  JsonValue,
  RelayDeliveryResponse,
  RelayPollResponse,
  RelaySessionResponse,
  RelayWorkAvailable,
  Timestamp,
} from "../types/mpas.js";
import { computeJsonHash } from "../utils/hash.js";

/** Maximum length, in characters, of an MPAS body-level idempotency key. */
export const MPAS_MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * Reports a structural or field-level error while parsing a routing message.
 *
 * The {@link path} property identifies the JSON location that failed validation.
 */
export class RoutingValidationError extends Error {
  readonly code = "ROUTING_VALIDATION_ERROR";

  constructor(message: string, readonly path = "$") {
    super(message);
    this.name = "RoutingValidationError";
  }
}

/** Input accepted by {@link buildDeliveryEnvelope}. */
export interface DeliveryEnvelopeInput<TPayload> {
  /** DID whose provenance is recorded by the envelope. */
  sender: Did;
  /** Non-empty set of DIDs that may independently retrieve the delivery. */
  recipients: readonly Did[];
  /** MPAS message or other JSON-compatible value carried by the routing layer. */
  payload: TPayload;
  /** MPAS Core §5 envelope creation time. Defaults to the current time. */
  createdAt?: Timestamp;
  /** Optional Core §5 retrieval deadline, which must be later than `createdAt`. */
  expiresAt?: Timestamp;
  /** Receiving HTTP service origin when the envelope is a signed request body. */
  audience?: string;
}

/**
 * Builds and validates a delivery envelope without inspecting the payload's protocol semantics.
 *
 * The recipient list is copied, `createdAt` defaults to the current time, and the
 * result is passed through {@link parseDeliveryEnvelope}. This helper does not sign,
 * encrypt, transmit, or assign roles to recipients.
 *
 * @throws {@link RoutingValidationError} If the envelope metadata is invalid.
 */
export function buildDeliveryEnvelope<TPayload>(input: DeliveryEnvelopeInput<TPayload>): DeliveryEnvelope<TPayload> {
  const envelope: DeliveryEnvelope<TPayload> = {
    version: "1",
    type: "DeliveryEnvelope",
    sender: input.sender,
    recipients: [...input.recipients],
    createdAt: input.createdAt ?? new Date().toISOString(),
    payload: input.payload,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.audience !== undefined ? { audience: input.audience } : {}),
  };
  return parseDeliveryEnvelope(envelope) as DeliveryEnvelope<TPayload>;
}

/**
 * Parses the outer delivery layer and leaves `payload` opaque.
 *
 * After this succeeds, dispatch the payload by its own `type` and use the
 * corresponding MPAS parser or verification pipeline.
 *
 * @throws {@link RoutingValidationError} If the envelope is malformed, has duplicate
 * recipients, invalid timestamps, an invalid audience, or a non-JSON payload.
 */
export function parseDeliveryEnvelope(value: unknown): DeliveryEnvelope {
  const object = requireRecord(value, "$", "DeliveryEnvelope must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "DeliveryEnvelope", "$.type");
  const sender = requireDid(object.sender, "$.sender");
  if (!Array.isArray(object.recipients) || object.recipients.length === 0) {
    throw new RoutingValidationError("DeliveryEnvelope.recipients must be a non-empty array.", "$.recipients");
  }
  const recipients = object.recipients.map((recipient, index) => requireDid(recipient, `$.recipients[${index}]`));
  if (new Set(recipients).size !== recipients.length) {
    throw new RoutingValidationError("DeliveryEnvelope.recipients must contain unique DIDs.", "$.recipients");
  }
  const createdAt = requireTimestamp(object.createdAt, "$.createdAt");
  const expiresAt = object.expiresAt === undefined ? undefined : requireTimestamp(object.expiresAt, "$.expiresAt");
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new RoutingValidationError("DeliveryEnvelope.expiresAt must be later than createdAt.", "$.expiresAt");
  }
  const audience = object.audience === undefined ? undefined : requireOrigin(object.audience, "$.audience");
  requireJsonValue(object.payload, "$.payload");

  return {
    version: "1",
    type: "DeliveryEnvelope",
    sender,
    recipients,
    createdAt,
    payload: object.payload as JsonValue,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(audience !== undefined ? { audience } : {}),
  };
}

/**
 * Parses the HTTP Action request wrapper and its body-level routing additions.
 *
 * This checks the `ActionRequest` and nested `ActionPackage` discriminants but does
 * not replace full Action Package verification.
 *
 * @throws {@link RoutingValidationError} If the request wrapper is malformed.
 */
export function parseActionRequest(value: unknown): ActionRequest {
  const object = requireRecord(value, "$", "ActionRequest must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "ActionRequest", "$.type");
  const actionPackage = requireRecord(object.actionPackage, "$.actionPackage", "ActionRequest.actionPackage is required.");
  requireLiteral(actionPackage.version, "1", "$.actionPackage.version");
  requireLiteral(actionPackage.type, "ActionPackage", "$.actionPackage.type");
  const idempotencyKey = validateOptionalIdempotencyKey(object.idempotencyKey, "$.idempotencyKey");
  const audience = object.audience === undefined ? undefined : requireOrigin(object.audience, "$.audience");
  if (object.context !== undefined) {
    requireRecord(object.context, "$.context", "ActionRequest.context must be a JSON object.");
    requireJsonValue(object.context, "$.context");
  }
  return {
    version: "1",
    type: "ActionRequest",
    actionPackage: actionPackage as unknown as ActionRequest["actionPackage"],
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...(object.context !== undefined ? { context: object.context as ActionRequest["context"] } : {}),
  };
}

/**
 * Parses a delivery envelope and then parses its payload as an {@link ActionRequest}.
 *
 * @throws {@link RoutingValidationError} If either layer is malformed.
 */
export function parseActionRequestEnvelope(value: unknown): DeliveryEnvelope<ActionRequest> {
  const envelope = parseDeliveryEnvelope(value);
  const payload = parseActionRequest(envelope.payload);
  return { ...envelope, payload };
}

/**
 * Parses the Action response discriminants used by the HTTP routing clients.
 *
 * This does not verify an Execution Receipt or the response's Action hash binding.
 *
 * @throws {@link RoutingValidationError} If the response type or result is invalid.
 */
export function parseActionResponse(value: unknown): ActionResponse {
  return parseActionResponseAt(value, "$");
}

function parseActionResponseAt(value: unknown, path: string): ActionResponse {
  const object = requireRecord(value, path, "ActionResponse must be a JSON object.");
  requireLiteral(object.version, "1", `${path}.version`);
  requireLiteral(object.type, "ActionResponse", `${path}.type`);
  if (typeof object.result !== "string" || !ACTION_RESPONSE_RESULTS.has(object.result)) {
    throw new RoutingValidationError("ActionResponse.result is invalid.", `${path}.result`);
  }
  return object as unknown as ActionResponse;
}

/**
 * Parses a delivery envelope and then parses its payload as an {@link ActionResponse}.
 *
 * @throws {@link RoutingValidationError} If either layer is malformed.
 */
export function parseActionResponseEnvelope(value: unknown): DeliveryEnvelope<ActionResponse> {
  const envelope = parseDeliveryEnvelope(value);
  return { ...envelope, payload: parseActionResponseAt(envelope.payload, "$.payload") };
}

/** Parses the durable acknowledgement returned by `/mpas/v1/relay/delivery`. */
export function parseRelayDeliveryResponse(value: unknown): RelayDeliveryResponse {
  const object = requireRecord(value, "$", "RelayDeliveryResponse must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "RelayDeliveryResponse", "$.type");
  if (object.accepted !== true) throw new RoutingValidationError("Relay delivery was not accepted.", "$.accepted");
  const createdAt = object.createdAt === undefined ? undefined : requireTimestamp(object.createdAt, "$.createdAt");
  return { version: "1", type: "RelayDeliveryResponse", accepted: true, ...(createdAt ? { createdAt } : {}) };
}

/**
 * Parses the acknowledgement returned after a Coordination Service durably accepts
 * a Verifier response delivery. The acknowledgement is not an Action result.
 *
 * @throws {@link RoutingValidationError} If the acknowledgement is malformed.
 */
export function parseCoordinationDeliveryResponse(value: unknown): CoordinationDeliveryResponse {
  const object = requireRecord(value, "$", "CoordinationDeliveryResponse must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "CoordinationDeliveryResponse", "$.type");
  if (object.accepted !== true) throw new RoutingValidationError("Coordination delivery was not accepted.", "$.accepted");
  const createdAt = object.createdAt === undefined ? undefined : requireTimestamp(object.createdAt, "$.createdAt");
  return { version: "1", type: "CoordinationDeliveryResponse", accepted: true, ...(createdAt ? { createdAt } : {}) };
}

/**
 * Parses a WebSocket session response, including its URL, ticket, and expiration.
 *
 * Both `ws:` and `wss:` are structurally accepted so local development remains
 * possible; production transport policy is enforced by the hosting application.
 *
 * @throws {@link RoutingValidationError} If the session response is malformed.
 */
export function parseCoordinationSessionResponse(value: unknown): CoordinationSessionResponse {
  const object = requireRecord(value, "$", "CoordinationSessionResponse must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "CoordinationSessionResponse", "$.type");
  if (typeof object.websocketUrl !== "string") throw new RoutingValidationError("websocketUrl is required.", "$.websocketUrl");
  const websocketUrl = new URL(object.websocketUrl);
  if (websocketUrl.protocol !== "wss:" && websocketUrl.protocol !== "ws:") {
    throw new RoutingValidationError("websocketUrl must use ws or wss.", "$.websocketUrl");
  }
  if (typeof object.ticket !== "string" || object.ticket.length === 0) {
    throw new RoutingValidationError("ticket is required.", "$.ticket");
  }
  return {
    version: "1",
    type: "CoordinationSessionResponse",
    websocketUrl: object.websocketUrl,
    ticket: object.ticket,
    expiresAt: requireTimestamp(object.expiresAt, "$.expiresAt"),
  };
}

/** Parses an Action Relay WebSocket session response. */
export function parseRelaySessionResponse(value: unknown): RelaySessionResponse {
  const object = requireRecord(value, "$", "RelaySessionResponse must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "RelaySessionResponse", "$.type");
  if (typeof object.websocketUrl !== "string") throw new RoutingValidationError("websocketUrl is required.", "$.websocketUrl");
  const websocketUrl = new URL(object.websocketUrl);
  if (websocketUrl.protocol !== "wss:" && websocketUrl.protocol !== "ws:") {
    throw new RoutingValidationError("websocketUrl must use ws or wss.", "$.websocketUrl");
  }
  if (typeof object.ticket !== "string" || object.ticket.length === 0) {
    throw new RoutingValidationError("ticket is required.", "$.ticket");
  }
  return {
    version: "1",
    type: "RelaySessionResponse",
    websocketUrl: object.websocketUrl,
    ticket: object.ticket,
    expiresAt: requireTimestamp(object.expiresAt, "$.expiresAt"),
  };
}

/**
 * Parses the payload-free notification that instructs a participant to poll.
 *
 * @throws {@link RoutingValidationError} If the notification discriminants are invalid.
 */
export function parseCoordinationWorkAvailable(value: unknown): CoordinationWorkAvailable {
  const object = requireRecord(value, "$", "CoordinationWorkAvailable must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "CoordinationWorkAvailable", "$.type");
  return { version: "1", type: "CoordinationWorkAvailable" };
}

/** Parses the payload-free notification that instructs a participant to poll its relay. */
export function parseRelayWorkAvailable(value: unknown): RelayWorkAvailable {
  const object = requireRecord(value, "$", "RelayWorkAvailable must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "RelayWorkAvailable", "$.type");
  return { version: "1", type: "RelayWorkAvailable" };
}

/** Parses a relay delivery page while leaving every enclosed payload opaque. */
export function parseRelayPollResponse(value: unknown): RelayPollResponse {
  const object = requireRecord(value, "$", "RelayPollResponse must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "RelayPollResponse", "$.type");
  if (!Array.isArray(object.deliveries)) {
    throw new RoutingValidationError("deliveries must be an array.", "$.deliveries");
  }
  if (object.nextCursor !== undefined && typeof object.nextCursor !== "string") {
    throw new RoutingValidationError("nextCursor must be a string.", "$.nextCursor");
  }
  return {
    version: "1",
    type: "RelayPollResponse",
    deliveries: object.deliveries.map(parseDeliveryEnvelope),
    ...(typeof object.nextCursor === "string" ? { nextCursor: object.nextCursor } : {}),
  };
}

/** Parses the workflow-only response returned by the Coordination Service poll. */
export function parseCoordinationPollResponse(value: unknown): CoordinationPollResponse {
  const object = requireRecord(value, "$", "CoordinationPollResponse must be a JSON object.");
  requireLiteral(object.version, "1", "$.version");
  requireLiteral(object.type, "CoordinationPollResponse", "$.type");
  if (!Array.isArray(object.approvalRequests)) {
    throw new RoutingValidationError("approvalRequests must be an array.", "$.approvalRequests");
  }
  if (object.actionUpdates !== undefined && !Array.isArray(object.actionUpdates)) {
    throw new RoutingValidationError("actionUpdates must be an array when present.", "$.actionUpdates");
  }
  if (object.deliveries !== undefined || object.nextCursor !== undefined) {
    throw new RoutingValidationError(
      "Coordination poll responses must not contain relay deliveries or relay cursors.",
      object.deliveries !== undefined ? "$.deliveries" : "$.nextCursor",
    );
  }
  return {
    version: "1",
    type: "CoordinationPollResponse",
    approvalRequests: object.approvalRequests as CoordinationPollResponse["approvalRequests"],
    actionUpdates: (object.actionUpdates ?? []) as CoordinationPollResponse["actionUpdates"],
  };
}

/** Returns whether `did` occurs in the envelope's explicit recipient list. */
export function hasDeliveryEnvelopeRecipient(envelope: DeliveryEnvelope<unknown>, did: Did): boolean {
  return envelope.recipients.includes(did);
}

/**
 * Returns whether the optional retrieval deadline has passed.
 *
 * An envelope without `expiresAt` is not considered expired by the routing layer.
 */
export function isDeliveryEnvelopeExpired(envelope: DeliveryEnvelope<unknown>, now = Date.now()): boolean {
  return envelope.expiresAt !== undefined && Date.parse(envelope.expiresAt) <= now;
}

/**
 * Validates and returns a body-level idempotency key.
 *
 * @throws {@link RoutingValidationError} If the key is empty or exceeds
 * {@link MPAS_MAX_IDEMPOTENCY_KEY_LENGTH}.
 */
export function validateIdempotencyKey(value: string): string {
  if (value.length === 0 || value.length > MPAS_MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new RoutingValidationError(
      `idempotencyKey must contain 1 to ${MPAS_MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      "$.idempotencyKey",
    );
  }
  return value;
}

/**
 * Resolves body-level idempotency with the compatibility `Idempotency-Key` header.
 *
 * The body value takes precedence when only it is present. When both values are
 * present they must be equal.
 *
 * @throws {@link RoutingValidationError} If either key is invalid or the values differ.
 */
export function resolveIdempotencyKey(bodyValue: unknown, headerValue?: string): string | undefined {
  const body = validateOptionalIdempotencyKey(bodyValue, "$.idempotencyKey");
  const header = headerValue === undefined ? undefined : validateIdempotencyKey(headerValue);
  if (body !== undefined && header !== undefined && body !== header) {
    throw new RoutingValidationError("Body and Idempotency-Key header values differ.", "$.idempotencyKey");
  }
  return body ?? header;
}

/**
 * Computes the request-equivalence fingerprint used for an idempotency record.
 *
 * Equivalence is composed one protocol layer at a time. A Delivery Envelope
 * contributes its sender, recipient set, and payload equivalence while ignoring
 * regenerated transport metadata. A supported request payload contributes all of
 * its fields except `idempotencyKey` and signed-request `audience`.
 *
 * @throws {@link RoutingValidationError} If a layer has no registered equivalence
 * scope. Failing closed prevents a new mutation type from silently acquiring
 * accidental whole-body retry semantics.
 */
export function computeIdempotencyFingerprint(request: unknown): string {
  return computeJsonHash(idempotencyProjection(request, "$")).value;
}

function idempotencyProjection(value: unknown, path: string): JsonValue {
  const object = requireRecord(value, path, "Idempotent request layer must be a JSON object.");
  switch (object.type) {
    case "DeliveryEnvelope": {
      const envelope = parseDeliveryEnvelope(object);
      return {
        version: envelope.version,
        type: envelope.type,
        sender: envelope.sender,
        recipients: [...envelope.recipients].sort(),
        payload: idempotencyProjection(envelope.payload, `${path}.payload`),
      };
    }
    case "ActionRequest":
    case "CoordinationActionRequest":
    case "CoordinationApprovalSubmission":
    case "CoordinationActionCancelRequest": {
      const projection = structuredClone(object);
      delete projection.idempotencyKey;
      delete projection.audience;
      requireJsonValue(projection, path);
      return projection as JsonValue;
    }
    default:
      throw new RoutingValidationError(
        `No idempotency equivalence scope is registered for object type ${JSON.stringify(object.type)}.`,
        `${path}.type`,
      );
  }
}

function validateOptionalIdempotencyKey(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new RoutingValidationError("idempotencyKey must be a string.", path);
  }
  return validateIdempotencyKey(value);
}

function requireRecord(value: unknown, path: string, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RoutingValidationError(message, path);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireLiteral<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new RoutingValidationError(`Expected ${JSON.stringify(expected)}.`, path);
  return expected;
}

function requireDid(value: unknown, path: string): Did {
  if (typeof value !== "string" || !/^did:[a-z0-9]+:\S+$/i.test(value)) {
    throw new RoutingValidationError("Expected a DID string.", path);
  }
  return value as Did;
}

function requireTimestamp(value: unknown, path: string): Timestamp {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) {
    throw new RoutingValidationError("Expected an RFC 3339 timestamp.", path);
  }
  return value;
}

function requireOrigin(value: unknown, path: string): string {
  if (typeof value !== "string") throw new RoutingValidationError("Expected an audience origin.", path);
  try {
    const url = new URL(value);
    if (url.origin !== value || (url.protocol !== "https:" && url.protocol !== "http:")) throw new Error("not origin");
    return value;
  } catch {
    throw new RoutingValidationError("Expected a canonical HTTP(S) origin.", path);
  }
}

function requireJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new RoutingValidationError("JSON numbers must be finite.", path);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => requireJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) throw new RoutingValidationError("undefined is not a JSON value.", `${path}.${key}`);
      requireJsonValue(entry, `${path}.${key}`);
    }
    return;
  }
  throw new RoutingValidationError("Expected a JSON value.", path);
}

const ACTION_RESPONSE_RESULTS: ReadonlySet<string> = new Set([
  "executed",
  "additionalApprovalsRequired",
  "rejected",
  "notSupported",
  "malformed",
  "policyUnavailable",
  "pending",
  "failed",
  "indeterminate",
  "expired",
  "cancelled",
]);
