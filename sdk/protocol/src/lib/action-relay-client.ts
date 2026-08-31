import type {
  ActionRequest,
  ActionResponse,
  DeliveryEnvelope,
  Did,
  RelayDeliveryResponse,
  RelayPollResponse,
  RelaySessionResponse,
  RelayWorkAvailable,
} from "../types/mpas.js";
import {
  parseActionRequestEnvelope,
  parseActionResponse,
  parseActionResponseEnvelope,
  parseRelayDeliveryResponse,
  parseRelayPollResponse,
  parseRelaySessionResponse,
  parseRelayWorkAvailable,
} from "./routing.js";
import {
  MpasAuthError,
  MpasHttpTransport,
  waitForPollInterval,
  websocketMessageData,
  type MpasWebSocket,
  type MpasWebSocketFactory,
} from "./client-transport.js";
import type { MpasRfc9421Signer } from "./rfc9421.js";

/** Socket shape used by Action Relay notification connections. */
export type ActionRelayWebSocket = MpasWebSocket;

/** Adapter for opening an Action Relay notification WebSocket. */
export type ActionRelayWebSocketFactory = MpasWebSocketFactory;

/** Configuration for a participant-facing Action Relay client. */
export interface ActionRelayClientConfig {
  /** Base URL of the Action Relay. */
  url: string;
  /** Participant signer used for RFC 9421-authenticated relay calls. */
  signer?: MpasRfc9421Signer | PromiseLike<MpasRfc9421Signer>;
  /** Participant DID for an unenforcing relay when no signer is configured. */
  participantDid?: Did;
  /** HTTP request timeout in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Signature lifetime in seconds, subject to the MPAS HTTP profile maximum. */
  signatureLifetimeSeconds?: number;
  /** Native or server-side WebSocket adapter used for relay notifications. */
  webSocketFactory?: ActionRelayWebSocketFactory;
}

/** Options for retrieving one page of addressed Delivery Envelopes. */
export interface PollRelayDeliveriesOptions {
  /** Cursor from a previously and durably accepted relay page. */
  cursor?: string;
}

/** Options for repeated, cursor-aware relay polling. */
export interface ActionRelayPollLoopOptions extends PollRelayDeliveriesOptions {
  /** Delay between completed polls. Defaults to 30 seconds. */
  intervalMs?: number;
  /** Cancels the loop and any wait before its next poll. */
  signal?: AbortSignal;
  /** Called before the loop advances to `nextCursor`. */
  onPage: (page: RelayPollResponse) => void | Promise<void>;
  /** Optional recoverable-error handler. Without it, polling stops on the first error. */
  onError?: (error: unknown) => void | Promise<void>;
}

/** Options for polling the relay whenever a notification arrives. */
export interface ActionRelayNotificationPollingOptions extends PollRelayDeliveriesOptions {
  /** Called before the connection advances its relay cursor. */
  onPage: (page: RelayPollResponse) => void | Promise<void>;
  /** Optional handler for poll failures triggered by a notification. */
  onError?: (error: unknown) => void | Promise<void>;
}

/** Input for opening an Action Relay notification-only WebSocket. */
export interface ConnectRelayWorkNotificationsInput {
  onWorkAvailable: (notification: RelayWorkAvailable) => void | Promise<void>;
}

/** Context retained for an authenticated relay notification connection. */
export interface RelayNotificationConnection {
  socket: ActionRelayWebSocket;
  relayUrl: string;
  audience: string;
  did: Did;
}

/** Relay notification connection that exposes its last accepted delivery cursor. */
export interface RelayNotificationPollConnection extends RelayNotificationConnection {
  getCursor(): string | undefined;
}

/** Network, timeout, or Action Relay 5xx failure that may be retried. */
export class ActionRelayUnavailableError extends Error {
  readonly code = "ACTION_RELAY_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ActionRelayUnavailableError";
  }
}

/** Invalid response, notification, identity, or non-authentication 4xx rejection. */
export class ActionRelayResponseError extends Error {
  readonly code = "ACTION_RELAY_RESPONSE_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ActionRelayResponseError";
  }
}

/**
 * RFC 9421-capable client for the Action Relay delivery and notification APIs.
 *
 * This client does not create approval workflows. Submit initial Actions with
 * {@link submitAction}; use {@link CoordinationServiceClient} only after a caller
 * explicitly chooses to create or interact with a workflow.
 */
export class ActionRelayClient {
  private readonly url: string;
  private readonly audience: string;
  private readonly transport: MpasHttpTransport;
  private readonly participantDid?: Did;
  private readonly webSocketFactory?: ActionRelayWebSocketFactory;

  constructor(config: ActionRelayClientConfig) {
    this.url = config.url.replace(/\/+$/, "");
    this.transport = new MpasHttpTransport({
      ...config,
      errors: {
        identityMismatch: (requiredDid, signerDid) => new ActionRelayResponseError(
          `Relay request identity ${requiredDid} does not match signer DID ${signerDid}.`,
        ),
        authentication: (status, code) => new MpasAuthError(
          status,
          code,
          `Action Relay request failed with HTTP ${status} (${code}).`,
        ),
        unavailable: ({ status, cause }) => status === undefined
          ? new ActionRelayUnavailableError(`Action Relay is unavailable at ${this.url}.`, { cause })
          : new ActionRelayUnavailableError(`Action Relay returned HTTP ${status}.`),
        rejected: (status) => new ActionRelayResponseError(
          `Action Relay rejected the request with HTTP ${status}.`,
        ),
        invalidJson: (cause) => new ActionRelayResponseError(
          "Action Relay response was not valid JSON.",
          { cause },
        ),
      },
    });
    this.audience = this.transport.audience;
    this.participantDid = config.participantDid;
    this.webSocketFactory = config.webSocketFactory;
  }

  /**
   * Submits a canonical enveloped Action to `/mpas/v1/verifier/action`.
   *
   * Unlike a directly reachable Verifier, an Action Relay requires the outer
   * Delivery Envelope. The returned value is the designated Verifier's unchanged
   * `ActionResponse`; durable relay acceptance is not exposed as an Action result.
   */
  async submitAction(
    envelope: DeliveryEnvelope<ActionRequest>,
  ): Promise<ActionResponse> {
    const parsed = parseActionRequestEnvelope(envelope);
    const did = await this.resolveParticipantDid();
    if (parsed.sender !== did) {
      throw new ActionRelayResponseError(
        `Relay Action sender ${parsed.sender} does not match participant DID ${did}.`,
      );
    }
    return parseActionResponse(await this.post<unknown>(
      "/mpas/v1/verifier/action",
      parsed,
      parsed.sender,
    ));
  }

  /** Retrieves addressed Delivery Envelopes from `/mpas/v1/relay/poll`. */
  async pollDeliveries(options: PollRelayDeliveriesOptions = {}): Promise<RelayPollResponse> {
    const did = await this.resolveParticipantDid();
    return this.pollDeliveriesForDid(did, options.cursor);
  }

  /**
   * Delivers a Verifier-authored Action response through `/mpas/v1/relay/delivery`.
   *
   * The acknowledgement confirms durable relay acceptance; it is not an Action verdict.
   */
  async submitActionResponse(
    envelope: DeliveryEnvelope<ActionResponse>,
  ): Promise<RelayDeliveryResponse> {
    const parsed = parseActionResponseEnvelope(envelope);
    const did = await this.resolveParticipantDid();
    if (parsed.sender !== did) {
      throw new ActionRelayResponseError(
        `Relay response sender ${parsed.sender} does not match participant DID ${did}.`,
      );
    }
    return parseRelayDeliveryResponse(
      await this.post<unknown>("/mpas/v1/relay/delivery", parsed, parsed.sender),
    );
  }

  /** Obtains a short-lived, one-use ticket for `/mpas/v1/relay/ws`. */
  async createNotificationSession(): Promise<RelaySessionResponse> {
    const did = await this.resolveParticipantDid();
    return parseRelaySessionResponse(await this.post<unknown>(
      "/mpas/v1/relay/session",
      { version: "1", type: "RelaySessionRequest", did },
      did,
    ));
  }

  /** Opens a notification-only relay WebSocket using the exact returned URL and ticket. */
  async connectWorkNotifications(
    input: ConnectRelayWorkNotificationsInput,
  ): Promise<RelayNotificationConnection> {
    if (!this.webSocketFactory) {
      throw new ActionRelayResponseError("A webSocketFactory is required for relay notifications.");
    }
    const did = await this.resolveParticipantDid();
    const session = await this.createNotificationSession();
    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new ActionRelayResponseError("Action Relay session ticket is already expired.");
    }
    const socket = await this.webSocketFactory({
      url: session.websocketUrl,
      ticket: session.ticket,
      headers: { Authorization: `Bearer ${session.ticket}` },
    });
    socket.addEventListener("message", (event) => {
      void Promise.resolve().then(async () => {
        const data = websocketMessageData(
          event,
          () => new ActionRelayResponseError("WebSocket message data was not UTF-8 text."),
        );
        await input.onWorkAvailable(parseRelayWorkAvailable(JSON.parse(data)));
      }).catch(() => socket.close(1003, "invalid MPAS notification"));
    });
    return { socket, relayUrl: this.url, audience: this.audience, did };
  }

  /** Opens relay notifications and performs a signed relay poll after each signal. */
  async connectNotificationsAndPoll(
    options: ActionRelayNotificationPollingOptions,
  ): Promise<RelayNotificationPollConnection> {
    let cursor = options.cursor;
    let pending = Promise.resolve();
    const did = await this.resolveParticipantDid();
    const context = await this.connectWorkNotifications({
      onWorkAvailable: () => {
        pending = pending.then(async () => {
          try {
            const page = await this.pollDeliveriesForDid(did, cursor);
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

  /** Runs cancellable short polling with durable-callback-before-cursor semantics. */
  async runPollLoop(options: ActionRelayPollLoopOptions): Promise<void> {
    const did = await this.resolveParticipantDid();
    let cursor = options.cursor;
    const intervalMs = options.intervalMs ?? 30_000;
    while (!options.signal?.aborted) {
      try {
        const page = await this.pollDeliveriesForDid(did, cursor);
        await options.onPage(page);
        cursor = page.nextCursor ?? cursor;
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!options.onError) throw error;
        await options.onError(error);
      }
      await waitForPollInterval(intervalMs, options.signal);
    }
  }

  private async pollDeliveriesForDid(did: Did, cursor?: string): Promise<RelayPollResponse> {
    return parseRelayPollResponse(await this.post<unknown>(
      "/mpas/v1/relay/poll",
      { version: "1", type: "RelayPollRequest", did, ...(cursor !== undefined ? { cursor } : {}) },
      did,
    ));
  }

  private async resolveParticipantDid(): Promise<Did> {
    const signer = await this.transport.resolveSigner();
    const did = this.participantDid ?? signer?.did;
    if (!did) throw new ActionRelayResponseError("A signer or participantDid is required for relay operations.");
    if (signer && signer.did !== did) {
      throw new ActionRelayResponseError(`Relay request identity ${did} does not match signer DID ${signer.did}.`);
    }
    return did;
  }

  private async post<T>(path: string, payload: object, requiredDid: Did): Promise<T> {
    return this.transport.post<T>(path, payload, requiredDid);
  }
}
