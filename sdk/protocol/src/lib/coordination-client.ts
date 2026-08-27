import type {
  ActionResponse,
  ActionPackage,
  ActionId,
  Approval,
  AuthorizationRequirements,
  CoordinationActionRequest,
  CoordinationActionResponse,
  CoordinationApprovalResponse,
  CoordinationCancelResponse,
  CoordinationDeliveryResponse,
  CoordinationPollResponse,
  CoordinationSessionResponse,
  CoordinationWorkAvailable,
  DeliveryEnvelope,
  Did,
  HashObject,
  MpasHttpError,
} from "../types/mpas.js";
import { strictJsonParse } from "../utils/strict-json.js";
import {
  parseActionResponseEnvelope,
  parseCoordinationDeliveryResponse,
  parseCoordinationPollResponse,
  parseCoordinationSessionResponse,
  parseCoordinationWorkAvailable,
} from "./routing.js";
import {
  deriveMpasAudience,
  signMpasRfc9421,
  type MpasRfc9421Signer,
} from "./rfc9421.js";

/** Configuration for an MPAS Coordination Service client. */
export interface CoordinationServiceClientConfig {
  /** Base URL of the Coordination Service. */
  url: string;
  /** HTTP request timeout in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** RFC 9421 signer for the participant using this client. */
  signer?: MpasRfc9421Signer | PromiseLike<MpasRfc9421Signer>;
  /** Signature lifetime in seconds, subject to the MPAS HTTP profile maximum. */
  signatureLifetimeSeconds?: number;
  /** Native or server-side WebSocket adapter used for notification sessions. */
  webSocketFactory?: CoordinationWebSocketFactory;
  /** Participant DID used by participant-bound calls when no signer is configured. */
  participantDid?: Did;
}

/** @deprecated Use {@link CoordinationServiceClientConfig}. */
export type CoordinationClientConfig = CoordinationServiceClientConfig;

/** Minimal socket surface required by the notification client. */
export interface CoordinationWebSocket {
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: unknown) => void): void;
  removeEventListener?(type: "message" | "close" | "error", listener: (event: unknown) => void): void;
}

/**
 * Opens a WebSocket with the URL and authorization header returned by the session endpoint.
 *
 * Implementations must use `url` exactly and apply `headers.Authorization` to the
 * HTTP upgrade. The bearer ticket must not be placed in the URL. Browser WebSocket
 * APIs that cannot set an upgrade authorization header require a native or server adapter.
 */
export type CoordinationWebSocketFactory = (options: {
  /** WebSocket URL returned by the Coordination Service. */
  url: string;
  /** Opaque single-use ticket, exposed for adapters that accept it separately. */
  ticket: string;
  /** Required authorization header for the WebSocket upgrade. */
  headers: Readonly<Record<"Authorization", string>>;
}) => CoordinationWebSocket | PromiseLike<CoordinationWebSocket>;

/** Options for repeated, cursor-aware coordination polling. */
export interface CoordinationServicePollLoopOptions {
  /** Cursor from a previously accepted page. */
  cursor?: string;
  /** Delay between completed polls. Defaults to 30 seconds. */
  intervalMs?: number;
  /** Cancels the loop and any wait before its next poll. */
  signal?: AbortSignal;
  /** Called before the loop advances to `nextCursor`. */
  onPage: (page: CoordinationPollResponse) => void | Promise<void>;
  /** Optional recoverable-error handler. Without it, polling stops on the first error. */
  onError?: (error: unknown) => void | Promise<void>;
}

/** Options for polling whenever a WebSocket work notification arrives. */
export interface CoordinationServiceNotificationPollingOptions {
  /** Cursor from a previously accepted page. */
  cursor?: string;
  /** Called before the connection advances its cursor. */
  onPage: (page: CoordinationPollResponse) => void | Promise<void>;
  /** Optional handler for poll failures triggered by a notification. */
  onError?: (error: unknown) => void | Promise<void>;
}

/** Input for creating an approval workflow from an already evaluated Action. */
export interface CreateApprovalWorkflowInput {
  /** Action Package previously evaluated by a directly reachable Verifier. */
  actionPackage: ActionPackage;
  /** Authenticated requirements returned by that Verifier. */
  authorizationRequirements?: AuthorizationRequirements;
  /** Body-level mutation key reused across equivalent retries. */
  idempotencyKey?: string;
  /** Non-authoritative coordination metadata. */
  context?: CoordinationActionRequest["context"];
}

/** @deprecated Use {@link CreateApprovalWorkflowInput}. */
export type SubmitActionForCoordinationInput = CreateApprovalWorkflowInput;

/** Options for retrieving the next page of work for this client's participant. */
export interface PollCoordinationWorkOptions {
  /** Cursor from a previously accepted page. */
  cursor?: string;
}

/** Input for submitting a Signer Approval to an existing workflow. */
export interface SubmitCoordinationApprovalInput {
  /** Exact Action Envelope hash approved or rejected by the Signer. */
  actionEnvelopeHash: HashObject;
  /** Signed MPAS Approval. */
  approval: Approval;
  /** Body-level mutation key reused across equivalent retries. */
  idempotencyKey?: string;
}

/** Input for cancelling an approval-coordination workflow as its Proposer. */
export interface CancelCoordinationActionInput {
  /** Action identity of the workflow to cancel. */
  actionId: ActionId;
  /** Body-level mutation key reused across equivalent retries. */
  idempotencyKey?: string;
}

/** Input for opening a notification-only WebSocket for this client's participant. */
export interface ConnectCoordinationWorkNotificationsInput {
  /** Handler invoked for each valid payload-free availability notification. */
  onWorkAvailable: (notification: CoordinationWorkAvailable) => void | Promise<void>;
}

/** Context retained for an authenticated notification connection. */
export interface CoordinationNotificationConnection {
  /** Open notification-only socket. */
  socket: CoordinationWebSocket;
  /** Original HTTPS Coordination Service URL used for subsequent polls. */
  coordinationUrl: string;
  /** RFC 9421 audience derived from `coordinationUrl`. */
  audience: string;
  /** Participant DID bound to the session. */
  did: Did;
}

/** Notification connection that also exposes its last accepted poll cursor. */
export interface CoordinationNotificationPollConnection extends CoordinationNotificationConnection {
  /** Returns the cursor only after the corresponding page callback has completed. */
  getCursor(): string | undefined;
}

/** Authentication or endpoint-identity failure returned with HTTP 401 or 403. */
export class MpasAuthError extends Error {
  readonly code = "MPAS_AUTH_ERROR";

  constructor(
    readonly status: 401 | 403,
    readonly authCode: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MpasAuthError";
  }
}

/** Network, timeout, or Coordination Service 5xx failure that may be retried. */
export class CoordinationUnavailableError extends Error {
  readonly code = "COORDINATION_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoordinationUnavailable";
  }
}

/** Invalid response, invalid notification, or non-authentication 4xx rejection. */
export class CoordinationResponseError extends Error {
  readonly code = "COORDINATION_RESPONSE_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoordinationResponseInvalid";
  }
}

/**
 * RFC 9421-capable client for the MPAS Coordination Service HTTP and notification interfaces.
 *
 * Polling is authoritative. WebSocket methods only announce that pollable work may
 * exist and never deliver an Action, Approval Request, or other MPAS payload.
 */
export class CoordinationServiceClient {
  private readonly url: string;
  private readonly audience: string;
  private readonly timeoutMs: number;
  private readonly signer?: Promise<MpasRfc9421Signer>;
  private readonly signatureLifetimeSeconds?: number;
  private readonly webSocketFactory?: CoordinationWebSocketFactory;
  private readonly participantDid?: Did;

  /** Creates a client bound to one Coordination Service origin and participant signer. */
  constructor(config: CoordinationServiceClientConfig) {
    this.audience = deriveMpasAudience(config.url);
    this.url = config.url.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.signer = config.signer ? Promise.resolve(config.signer) : undefined;
    this.signatureLifetimeSeconds = config.signatureLifetimeSeconds;
    this.webSocketFactory = config.webSocketFactory;
    this.participantDid = config.participantDid;
  }

  /**
   * Creates an approval workflow from a Verifier-evaluated Action Package and its
   * Authorization Requirements at `/mpas/v1/coordination/workflow`.
   *
   * Use `ActionEndpointClient.submitActionRequest` when the Coordination Service
   * receives the initial enveloped Action through the common Action endpoint.
   */
  async createApprovalWorkflow(
    input: CreateApprovalWorkflowInput,
  ): Promise<CoordinationActionResponse> {
    return this.postApprovalWorkflow("/mpas/v1/coordination/workflow", input);
  }

  /** @deprecated Use {@link createApprovalWorkflow}. */
  async submitActionForCoordination(
    input: SubmitActionForCoordinationInput,
  ): Promise<CoordinationActionResponse> {
    return this.createApprovalWorkflow(input);
  }

  private async postApprovalWorkflow(
    path: "/mpas/v1/coordination/workflow" | "/mpas/v1/coordination/action",
    input: CreateApprovalWorkflowInput,
  ): Promise<CoordinationActionResponse> {
    const { actionPackage, authorizationRequirements, idempotencyKey, context } = input;
    return this.post<CoordinationActionResponse>(
      path,
      {
        version: "1",
        type: "CoordinationActionRequest",
        actionPackage,
        ...(authorizationRequirements !== undefined ? { authorizationRequirements } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(context !== undefined ? { context } : {}),
      },
      actionPackage.actionEnvelope.proposer.did,
    );
  }

  /**
   * @deprecated Use {@link createApprovalWorkflow}. This compatibility method
   * uses the temporary `/mpas/v1/coordination/action` migration alias.
   */
  async submitAction(
    actionPackage: ActionPackage,
    authorizationRequirements: AuthorizationRequirements,
    idempotencyKey?: string,
  ): Promise<CoordinationActionResponse> {
    return this.postApprovalWorkflow(
      "/mpas/v1/coordination/action",
      { actionPackage, authorizationRequirements, idempotencyKey },
    );
  }

  /**
   * Retrieves all work addressed to a participant through the existing coordination poll.
   *
   * The result may include Approval Requests, action updates, and Delivery Envelopes.
   * Reusing a cursor can return the same delivery page, so payload processing must be
   * idempotent under the enclosed MPAS object's identity rules.
   */
  async pollWork(options: PollCoordinationWorkOptions = {}): Promise<CoordinationPollResponse> {
    const did = await this.resolveParticipantDid();
    return this.pollWorkForDid(did, options.cursor);
  }

  /** @deprecated Use {@link pollWork} with a participant-bound client. */
  async poll(did: Did, cursor?: string): Promise<CoordinationPollResponse> {
    return this.pollWorkForDid(did, cursor);
  }

  private async pollWorkForDid(did: Did, cursor?: string): Promise<CoordinationPollResponse> {
    const response = parseCoordinationPollResponse(await this.post<unknown>(
      "/mpas/v1/coordination/poll",
      { version: "1", type: "CoordinationPollRequest", did, ...(cursor !== undefined ? { cursor } : {}) },
      did,
    ));
    return response;
  }

  /**
   * Sends a Verifier-authored Action response envelope to `/mpas/v1/coordination/delivery`.
   *
   * The returned value acknowledges Coordination Service acceptance only. It is not
   * the Action result.
   */
  async submitActionResponseDelivery(
    envelope: DeliveryEnvelope<ActionResponse>,
  ): Promise<CoordinationDeliveryResponse> {
    const parsed = parseActionResponseEnvelope(envelope);
    return parseCoordinationDeliveryResponse(
      await this.post<unknown>("/mpas/v1/coordination/delivery", parsed, parsed.sender),
    );
  }

  /**
   * Obtains a short-lived, one-use WebSocket upgrade ticket for this participant.
   *
   * This method does not open the socket. Prefer {@link connectWorkNotifications} unless
   * the caller needs to manage the upgrade directly.
   */
  async createNotificationSession(): Promise<CoordinationSessionResponse> {
    const did = await this.resolveParticipantDid();
    return parseCoordinationSessionResponse(await this.post<unknown>(
      "/mpas/v1/coordination/session",
      { version: "1", type: "CoordinationSessionRequest", did },
      did,
    ));
  }

  /**
   * Creates a session and opens a notification-only WebSocket for a participant.
   *
   * The supplied factory receives the exact URL and bearer authorization header for
   * the upgrade. Each valid frame is parsed as {@link CoordinationWorkAvailable}.
   * After disconnection, call this method again to obtain a new single-use ticket.
   *
   * @throws {@link CoordinationResponseError} If no factory is configured, the ticket
   * is already expired, or a notification frame is invalid.
   */
  async connectWorkNotifications(
    input: ConnectCoordinationWorkNotificationsInput,
  ): Promise<CoordinationNotificationConnection> {
    if (!this.webSocketFactory) {
      throw new CoordinationResponseError("A webSocketFactory is required for notification support.");
    }
    const did = await this.resolveParticipantDid();
    const session = await this.createNotificationSession();
    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new CoordinationResponseError("Coordination session ticket is already expired.");
    }
    const socket = await this.webSocketFactory({
      url: session.websocketUrl,
      ticket: session.ticket,
      headers: { Authorization: `Bearer ${session.ticket}` },
    });
    socket.addEventListener("message", (event) => {
      void Promise.resolve().then(async () => {
        const data = messageData(event);
        await input.onWorkAvailable(parseCoordinationWorkAvailable(JSON.parse(data)));
      }).catch(() => socket.close(1003, "invalid MPAS notification"));
    });
    return { socket, coordinationUrl: this.url, audience: this.audience, did };
  }

  /**
   * Opens a notification connection and performs a signed poll after each notification.
   *
   * Notifications are serialized. The cursor advances only after `onPage` resolves,
   * so a failed callback can safely retry the same page.
   */
  async connectNotificationsAndPoll(
    options: CoordinationServiceNotificationPollingOptions,
  ): Promise<CoordinationNotificationPollConnection> {
    let cursor = options.cursor;
    let pending = Promise.resolve();
    const did = await this.resolveParticipantDid();
    const context = await this.connectWorkNotifications({
      onWorkAvailable: () => {
        pending = pending.then(async () => {
          try {
            const page = await this.pollWorkForDid(did, cursor);
            await options.onPage(page);
            cursor = page.nextCursor ?? cursor;
          } catch (error) {
            if (!options.onError) throw error;
            await options.onError(error);
          }
        });
        return pending;
      },
    });
    return { ...context, getCursor: () => cursor };
  }

  /**
   * Runs cancellable short polling for participants that do not use WebSockets.
   *
   * The cursor advances only after `onPage` resolves. An `onError` handler makes poll
   * failures recoverable; without one, the loop rejects on the first failure.
   */
  async runPollLoop(options: CoordinationServicePollLoopOptions): Promise<void> {
    const did = await this.resolveParticipantDid();
    let cursor = options.cursor;
    const intervalMs = options.intervalMs ?? 30_000;
    while (!options.signal?.aborted) {
      try {
        const page = await this.pollWorkForDid(did, cursor);
        await options.onPage(page);
        cursor = page.nextCursor ?? cursor;
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!options.onError) throw error;
        await options.onError(error);
      }
      await waitForInterval(intervalMs, options.signal);
    }
  }

  /** Submits a Signer Approval to its existing coordination workflow. */
  async submitApproval(input: SubmitCoordinationApprovalInput): Promise<CoordinationApprovalResponse>;
  /** @deprecated Use the input-object overload. */
  async submitApproval(
    actionEnvelopeHash: HashObject,
    approval: Approval,
    idempotencyKey?: string,
  ): Promise<CoordinationApprovalResponse>;
  async submitApproval(
    inputOrHash: SubmitCoordinationApprovalInput | HashObject,
    legacyApproval?: Approval,
    legacyIdempotencyKey?: string,
  ): Promise<CoordinationApprovalResponse> {
    const { actionEnvelopeHash, approval, idempotencyKey } = "approval" in inputOrHash
      ? inputOrHash
      : {
          actionEnvelopeHash: inputOrHash,
          approval: legacyApproval as Approval,
          idempotencyKey: legacyIdempotencyKey,
        };
    return this.post<CoordinationApprovalResponse>(
      "/mpas/v1/coordination/approval",
      {
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash,
        approval,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      },
      approvalSignerDid(approval),
    );
  }

  /** Cancels a pending coordination workflow as its Proposer. */
  async cancelAction(input: CancelCoordinationActionInput): Promise<CoordinationCancelResponse>;
  /** @deprecated Use the input-object overload with a participant-bound client. */
  async cancelAction(actionId: ActionId, did: Did, idempotencyKey?: string): Promise<CoordinationCancelResponse>;
  async cancelAction(
    inputOrActionId: CancelCoordinationActionInput | ActionId,
    legacyDid?: Did,
    legacyIdempotencyKey?: string,
  ): Promise<CoordinationCancelResponse> {
    const canonical = "actionId" in inputOrActionId;
    const actionId = canonical ? inputOrActionId.actionId : inputOrActionId;
    const idempotencyKey = canonical ? inputOrActionId.idempotencyKey : legacyIdempotencyKey;
    const did = canonical ? await this.resolveParticipantDid() : legacyDid as Did;
    return this.post<CoordinationCancelResponse>(
      "/mpas/v1/coordination/action-cancel",
      {
        version: "1",
        type: "CoordinationActionCancelRequest",
        actionId,
        proposerDid: did,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      },
      did,
    );
  }

  private async resolveParticipantDid(): Promise<Did> {
    const signer = this.signer ? await this.signer : undefined;
    const did = this.participantDid ?? signer?.did;
    if (!did) {
      throw new CoordinationResponseError(
        "A signer or participantDid is required for participant-bound Coordination Service operations.",
      );
    }
    if (signer && signer.did !== did) {
      throw new CoordinationResponseError(
        `Coordination request identity ${did} does not match signer DID ${signer.did}.`,
      );
    }
    return did;
  }

  private async post<T>(path: string, payload: object, requiredDid: Did): Promise<T> {
    const signer = this.signer ? await this.signer : undefined;
    if (signer && signer.did !== requiredDid) {
      throw new CoordinationResponseError(
        `Coordination request identity ${requiredDid} does not match signer DID ${signer.did}.`,
      );
    }

    const bodyObject = signer ? { ...payload, audience: this.audience } : payload;
    const body = JSON.stringify(bodyObject);
    const requestUrl = `${this.url}${path}`;
    const requestPath = new URL(requestUrl).pathname;
    const headers: Record<string, string> = {
      "Content-Type": "application/mpas+json",
      Accept: "application/mpas+json",
    };

    if (signer) {
      Object.assign(
        headers,
        await signMpasRfc9421({
          method: "POST",
          path: requestPath,
          body: Buffer.from(body),
          signer,
          ...(this.signatureLifetimeSeconds !== undefined
            ? { lifetimeSeconds: this.signatureLifetimeSeconds }
            : {}),
        }),
      );
    }

    return this.request<T>(requestUrl, { method: "POST", headers, body });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          const errorBody = parseMpasHttpError(text);
          const authCode =
            errorBody?.error.code ?? (response.status === 401 ? "signature_invalid" : "permission_denied");
          const failure = response.status === 401 ? "authentication failed" : "authorization failed";
          throw new MpasAuthError(
            response.status,
            authCode,
            `Coordination request ${failure} with HTTP ${response.status} (${authCode}).`,
          );
        }
        if (
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          throw new CoordinationUnavailableError(`Coordination Service returned HTTP ${response.status}.`);
        }
        throw new CoordinationResponseError(`Coordination Service rejected the request with HTTP ${response.status}.`);
      }

      if (text.length === 0) {
        return undefined as T;
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new CoordinationResponseError("Coordination response was not valid JSON.", { cause: error });
      }

      if (
        error instanceof MpasAuthError ||
        error instanceof CoordinationUnavailableError ||
        error instanceof CoordinationResponseError
      ) {
        throw error;
      }

      throw new CoordinationUnavailableError(`Coordination Service is unavailable at ${this.url}.`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** @deprecated Use {@link CoordinationServiceClient}. */
export class CoordinationClient extends CoordinationServiceClient {}

function messageData(event: unknown): string {
  const data = typeof event === "object" && event !== null ? (event as { data?: unknown }).data : undefined;
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  throw new CoordinationResponseError("WebSocket message data was not UTF-8 text.");
}

async function waitForInterval(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (intervalMs < 0 || !Number.isFinite(intervalMs)) throw new Error("intervalMs must be a non-negative number.");
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, intervalMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function approvalSignerDid(approval: Approval): Did {
  const parts = approval.signature.value.split(".");
  if (approval.signature.format !== "jws" || parts.length !== 3) {
    throw new Error("Approval does not contain a decodable compact JWS signer DID.");
  }

  try {
    const payload = strictJsonParse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const signerDid =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).signerDid
        : undefined;
    if (typeof signerDid !== "string" || signerDid.length === 0) {
      throw new Error("missing signerDid");
    }
    return signerDid as Did;
  } catch (error) {
    throw new Error("Approval does not contain a decodable compact JWS signer DID.", { cause: error });
  }
}

function parseMpasHttpError(text: string): MpasHttpError | undefined {
  if (text.length === 0) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<MpasHttpError>;
    return parsed.type === "MpasHttpError" && typeof parsed.error?.code === "string"
      ? (parsed as MpasHttpError)
      : undefined;
  } catch {
    return undefined;
  }
}
