import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ActionRelayResponseError,
  ActionRelayUnavailableError,
  MpasAuthError,
  buildDeliveryEnvelope,
  computeIdempotencyFingerprint,
  isDeliveryEnvelopeExpired,
  parseActionRequestEnvelope,
  parseActionResponseEnvelope,
  type ActionRequest,
  type ActionResponse,
  type RelayDeliveryResponse,
  type RelayNotificationConnection,
  type RelayPollResponse,
  type ActionRelayWebSocket,
  type DeliveryEnvelope,
  type Did,
} from "@oma3/mpas";
import { computeJsonHash } from "../core/verification.js";

const DEFAULT_FALLBACK_POLL_INTERVAL_MS = 30_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

export interface VerifierRelayClient {
  pollDeliveries(options?: { cursor?: string }): Promise<RelayPollResponse>;
  submitActionResponse(
    envelope: DeliveryEnvelope<ActionResponse>,
  ): Promise<RelayDeliveryResponse>;
  connectWorkNotifications(input: {
    onWorkAvailable: () => void | Promise<void>;
  }): Promise<RelayNotificationConnection>;
}

export interface VerifierRelayState {
  version: "1";
  type: "MpasVerifierRelayState";
  relayUrl: string;
  verifierDid: Did;
  cursor?: string;
  responses: Record<string, {
    envelope: DeliveryEnvelope<ActionResponse>;
    delivered: boolean;
  }>;
}

export interface VerifierRelayStateStore {
  load(identity: { relayUrl: string; verifierDid: Did }): Promise<VerifierRelayState>;
  save(state: VerifierRelayState): Promise<void>;
}

export interface VerifierRelayWorkerEvent {
  level: "info" | "warn" | "error";
  event:
    | "connected"
    | "disconnected"
    | "page_processed"
    | "retry_scheduled"
    | "fatal_error"
    | "stopped";
  relayUrl: string;
  verifierDid: Did;
  deliveryCount?: number;
  retryAfterMs?: number;
  errorCode?: string;
  message?: string;
}

export interface VerifierRelayWorkerOptions {
  relayUrl: string;
  verifierDid: Did;
  client: VerifierRelayClient;
  stateStore: VerifierRelayStateStore;
  processAction: (envelope: DeliveryEnvelope<ActionRequest>) => Promise<ActionResponse>;
  fallbackPollIntervalMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  onEvent?: (event: VerifierRelayWorkerEvent) => void;
  now?: () => number;
}

export type VerifierRelayWorkerStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "retrying"
  | "fatal"
  | "stopped";

/**
 * Outbound Verifier worker for Action Relay delivery.
 *
 * WebSockets announce availability only. The worker performs an authenticated
 * cursor-based poll on connection, after every notification, and periodically
 * as recovery for a lost notification. The worker cache preserves the exact
 * response bytes across submission retries; the Verifier dispatch ledger
 * independently enforces at-most-once execution and crash recovery.
 */
export class VerifierRelayWorker {
  private readonly relayUrl: string;
  private readonly verifierDid: Did;
  private readonly client: VerifierRelayClient;
  private readonly stateStore: VerifierRelayStateStore;
  private readonly processAction: VerifierRelayWorkerOptions["processAction"];
  private readonly fallbackPollIntervalMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly onEvent?: VerifierRelayWorkerOptions["onEvent"];
  private readonly now: () => number;
  private readonly abortController = new AbortController();
  private state: VerifierRelayState;
  private status: VerifierRelayWorkerStatus = "idle";
  private socket?: ActionRelayWebSocket;
  private runPromise?: Promise<void>;
  private pollChain: Promise<void> = Promise.resolve();
  private fallbackTimer?: ReturnType<typeof setInterval>;
  private fatalError?: unknown;

  private constructor(options: VerifierRelayWorkerOptions, state: VerifierRelayState) {
    this.relayUrl = normalizeUrl(options.relayUrl);
    this.verifierDid = options.verifierDid;
    this.client = options.client;
    this.stateStore = options.stateStore;
    this.processAction = options.processAction;
    this.fallbackPollIntervalMs = positiveInterval(
      options.fallbackPollIntervalMs ?? DEFAULT_FALLBACK_POLL_INTERVAL_MS,
      "fallbackPollIntervalMs",
    );
    this.reconnectInitialMs = positiveInterval(
      options.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS,
      "reconnectInitialMs",
    );
    this.reconnectMaxMs = positiveInterval(
      options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      "reconnectMaxMs",
    );
    if (this.reconnectMaxMs < this.reconnectInitialMs) {
      throw new Error("reconnectMaxMs must be greater than or equal to reconnectInitialMs.");
    }
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
    this.state = state;
  }

  static async create(options: VerifierRelayWorkerOptions): Promise<VerifierRelayWorker> {
    const identity = {
      relayUrl: normalizeUrl(options.relayUrl),
      verifierDid: options.verifierDid,
    };
    const state = await options.stateStore.load(identity);
    return new VerifierRelayWorker(options, state);
  }

  getStatus(): VerifierRelayWorkerStatus {
    return this.status;
  }

  getCursor(): string | undefined {
    return this.state.cursor;
  }

  start(): void {
    if (this.runPromise) return;
    this.status = "connecting";
    this.fallbackTimer = setInterval(() => {
      if (this.status === "fatal" || this.status === "stopped") return;
      void this.pollNow().catch((error) => this.handleBackgroundPollError(error));
    }, this.fallbackPollIntervalMs);
    this.fallbackTimer.unref?.();
    this.runPromise = this.runConnectionLoop();
  }

  async stop(): Promise<void> {
    if (this.status === "stopped") return;
    this.abortController.abort();
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.socket?.close(1001, "Verifier shutdown");
    await this.runPromise;
    await this.pollChain;
    this.status = "stopped";
    this.emit({ level: "info", event: "stopped" });
  }

  /** Performs one serialized poll-and-drain cycle, primarily for startup and tests. */
  pollNow(): Promise<void> {
    const operation = this.pollChain.then(() => this.drainAvailableWork());
    this.pollChain = operation.catch(() => undefined);
    return operation;
  }

  private async runConnectionLoop(): Promise<void> {
    let reconnectMs = this.reconnectInitialMs;
    while (!this.abortController.signal.aborted && !this.fatalError) {
      let retryError: unknown;
      try {
        this.status = "connecting";
        const connection = await this.client.connectWorkNotifications({
          onWorkAvailable: async () => {
            try {
              await this.pollNow();
            } catch (error) {
              this.recordPollError(error);
              throw error;
            }
          },
        });
        this.socket = connection.socket;
        this.status = "connected";
        reconnectMs = this.reconnectInitialMs;
        this.emit({ level: "info", event: "connected" });

        try {
          await this.pollNow();
        } catch (error) {
          this.recordPollError(error);
          throw error;
        }

        await waitForSocketEnd(connection.socket, this.abortController.signal);
        this.socket = undefined;
        if (this.abortController.signal.aborted) break;
        if (this.fatalError) throw this.fatalError;
        this.emit({ level: "warn", event: "disconnected" });
      } catch (error) {
        retryError = error;
        this.socket?.close(1011, "Verifier relay retry");
        this.socket = undefined;
        if (this.abortController.signal.aborted) break;
        if (isPermanentError(error)) this.enterFatal(error);
        if (this.fatalError) {
          break;
        }
      }

      if (this.abortController.signal.aborted || this.fatalError) break;
      this.status = "retrying";
      this.emit({
        level: "warn",
        event: "retry_scheduled",
        retryAfterMs: reconnectMs,
        ...(retryError
          ? { errorCode: errorCode(retryError), message: safeMessage(retryError) }
          : {}),
      });
      await abortableDelay(reconnectMs, this.abortController.signal);
      reconnectMs = Math.min(reconnectMs * 2, this.reconnectMaxMs);
    }
  }

  private async drainAvailableWork(): Promise<void> {
    let cursor = this.state.cursor;
    while (!this.abortController.signal.aborted) {
      const page = await this.client.pollDeliveries(cursor === undefined ? {} : { cursor });
      const deliveries = page.deliveries;
      for (const delivery of deliveries) {
        await this.processDelivery(delivery);
      }

      const previousCursor = cursor;
      if (deliveries.length > 0) {
        if (!page.nextCursor || page.nextCursor === previousCursor) {
          throw new ActionRelayResponseError(
            "Action Relay returned deliveries without an advancing cursor.",
          );
        }
        cursor = page.nextCursor;
        this.state.cursor = cursor;
        for (const [fingerprint, response] of Object.entries(this.state.responses)) {
          if (response.delivered) delete this.state.responses[fingerprint];
        }
        await this.saveState();
      }

      this.emit({
        level: "info",
        event: "page_processed",
        deliveryCount: deliveries.length,
      });
      if (deliveries.length === 0) return;
    }
  }

  private async processDelivery(delivery: DeliveryEnvelope): Promise<void> {
    if (!isActionRequestPayload(delivery.payload)) {
      throw new ActionRelayResponseError(
        `Verifier received unsupported delivery payload type ${payloadType(delivery.payload)}.`,
      );
    }

    let envelope: DeliveryEnvelope<ActionRequest>;
    try {
      envelope = parseActionRequestEnvelope(delivery);
    } catch (error) {
      throw new ActionRelayResponseError("Action Relay returned an invalid Action request envelope.", {
        cause: error,
      });
    }
    if (!envelope.recipients.includes(this.verifierDid)) {
      throw new ActionRelayResponseError("Polled Action request does not address this Verifier DID.");
    }
    if (isDeliveryEnvelopeExpired(envelope, this.now())) return;

    const fingerprint = computeIdempotencyFingerprint(envelope);
    let cached = this.state.responses[fingerprint];
    if (!cached) {
      const response = await this.processAction(envelope);
      if (response.result === "pending") {
        throw new ActionRelayUnavailableError(
          "Verifier is still processing the delivered Action; retrying without advancing the cursor.",
        );
      }
      const expectedHash = computeJsonHash(envelope.payload.actionPackage.actionEnvelope);
      if (response.verifier?.did !== this.verifierDid) {
        throw new ActionRelayResponseError("Verifier response DID does not match the configured Verifier DID.");
      }
      if (
        response.actionEnvelopeHash?.alg !== expectedHash.alg ||
        response.actionEnvelopeHash.value !== expectedHash.value
      ) {
        throw new ActionRelayResponseError("Verifier response does not match the delivered Action Envelope hash.");
      }
      const responseEnvelope = buildDeliveryEnvelope({
        sender: this.verifierDid,
        recipients: responseRecipients(envelope.sender, response),
        payload: response,
      });
      cached = { envelope: responseEnvelope, delivered: false };
      this.state.responses[fingerprint] = cached;
      await this.saveState();
    }

    if (!cached.delivered) {
      const result = await this.client.submitActionResponse(cached.envelope);
      if (result.accepted !== true) {
        throw new ActionRelayResponseError("Action Relay did not accept the Verifier response delivery.");
      }
      cached.delivered = true;
      await this.saveState();
    }
  }

  private handleBackgroundPollError(error: unknown): void {
    this.recordPollError(error);
  }

  private recordPollError(error: unknown): void {
    if (isPermanentError(error)) this.enterFatal(error);
  }

  private enterFatal(error: unknown): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.status = "fatal";
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
    this.socket?.close(1008, "Verifier relay failure");
    this.emit({
      level: "error",
      event: "fatal_error",
      errorCode: errorCode(error),
      message: safeMessage(error),
    });
  }

  private async saveState(): Promise<void> {
    try {
      await this.stateStore.save(this.state);
    } catch (error) {
      throw new ActionRelayResponseError("Unable to persist Verifier relay state.", { cause: error });
    }
  }

  private emit(event: Omit<VerifierRelayWorkerEvent, "relayUrl" | "verifierDid">): void {
    this.onEvent?.({
      ...event,
      relayUrl: this.relayUrl,
      verifierDid: this.verifierDid,
    });
  }
}

/** Durable JSON state for a single Action Relay origin and Verifier DID. */
export class FileVerifierRelayStateStore implements VerifierRelayStateStore {
  constructor(private readonly path: string) {}

  async load(identity: { relayUrl: string; verifierDid: Did }): Promise<VerifierRelayState> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return newState(identity);
      throw new Error(`Unable to read Verifier relay state: ${this.path}`, { cause: error });
    }
    return parseState(parsed, identity, this.path);
  }

  async save(state: VerifierRelayState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

function newState(identity: { relayUrl: string; verifierDid: Did }): VerifierRelayState {
  return {
    version: "1",
    type: "MpasVerifierRelayState",
    relayUrl: normalizeUrl(identity.relayUrl),
    verifierDid: identity.verifierDid,
    responses: {},
  };
}

function parseState(
  value: unknown,
  identity: { relayUrl: string; verifierDid: Did },
  path: string,
): VerifierRelayState {
  if (!isRecord(value) || value.version !== "1" ||
      (value.type !== "MpasVerifierRelayState" && value.type !== "MpasVerifierCoordinationState")) {
    throw new Error(`Verifier relay state is invalid: ${path}`);
  }
  const relayUrl = normalizeUrl(identity.relayUrl);
  const storedRelayUrl = value.type === "MpasVerifierCoordinationState" ? value.coordinationUrl : value.relayUrl;
  if (storedRelayUrl !== relayUrl || value.verifierDid !== identity.verifierDid) {
    throw new Error(
      `Verifier relay state identity does not match ${relayUrl} and ${identity.verifierDid}: ${path}`,
    );
  }
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw new Error(`Verifier relay cursor is invalid: ${path}`);
  }
  if (!isRecord(value.responses)) {
    throw new Error(`Verifier relay response cache is invalid: ${path}`);
  }
  const responses: VerifierRelayState["responses"] = {};
  for (const [fingerprint, entry] of Object.entries(value.responses)) {
    if (!fingerprint || !isRecord(entry) || typeof entry.delivered !== "boolean") {
      throw new Error(`Verifier relay response cache entry is invalid: ${path}`);
    }
    const envelope = parseActionResponseEnvelope(entry.envelope);
    if (envelope.sender !== identity.verifierDid) {
      throw new Error(`Cached Verifier response sender is invalid: ${path}`);
    }
    responses[fingerprint] = { envelope, delivered: entry.delivered };
  }
  return {
    version: "1",
    type: "MpasVerifierRelayState",
    relayUrl,
    verifierDid: identity.verifierDid,
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    responses,
  };
}

function isActionRequestPayload(value: unknown): value is ActionRequest {
  return isRecord(value) && value.type === "ActionRequest";
}

function payloadType(value: unknown): string {
  return isRecord(value) && typeof value.type === "string"
    ? JSON.stringify(value.type)
    : "(missing)";
}

function responseRecipients(proposer: Did, response: ActionResponse): Did[] {
  void response;
  return [proposer];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function positiveInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function isPermanentError(error: unknown): boolean {
  return error instanceof MpasAuthError || error instanceof ActionRelayResponseError;
}

function errorCode(error: unknown): string {
  if (error instanceof MpasAuthError) return error.authCode;
  if (error instanceof ActionRelayUnavailableError) return error.code;
  if (error instanceof ActionRelayResponseError) return error.code;
  return "VERIFIER_RELAY_ERROR";
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Verifier relay failed.";
}

/** @deprecated Use VerifierRelayClient. */
export type VerifierCoordinationClient = VerifierRelayClient;
/** @deprecated Use VerifierRelayState. Persisted legacy state is migrated when loaded. */
export type VerifierCoordinationState = VerifierRelayState;
/** @deprecated Use VerifierRelayStateStore. */
export type VerifierCoordinationStateStore = VerifierRelayStateStore;
/** @deprecated Use VerifierRelayWorkerEvent. */
export type VerifierCoordinationWorkerEvent = VerifierRelayWorkerEvent;
/** @deprecated Use VerifierRelayWorkerStatus. */
export type VerifierCoordinationWorkerStatus = VerifierRelayWorkerStatus;
/** @deprecated Use VerifierRelayWorkerOptions. */
export type VerifierCoordinationWorkerOptions = VerifierRelayWorkerOptions;
/** @deprecated Use FileVerifierRelayStateStore. */
export { FileVerifierRelayStateStore as FileVerifierCoordinationStateStore };
/** @deprecated Use VerifierRelayWorker. */
export { VerifierRelayWorker as VerifierCoordinationWorker };

function waitForSocketEnd(socket: ActionRelayWebSocket, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      socket.removeEventListener?.("close", done);
      socket.removeEventListener?.("error", done);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      socket.close(1001, "Verifier shutdown");
      done();
    };
    socket.addEventListener("close", done);
    socket.addEventListener("error", done);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
