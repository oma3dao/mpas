import type { Did, MpasHttpError } from "../types/mpas.js";
import { strictJsonParse } from "../utils/strict-json.js";
import {
  deriveMpasAudience,
  signMpasRfc9421,
  type MpasRfc9421Signer,
} from "./rfc9421.js";

/** Minimal socket surface shared by the independent MPAS notification clients. */
export interface MpasWebSocket {
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: unknown) => void): void;
  removeEventListener?(type: "message" | "close" | "error", listener: (event: unknown) => void): void;
}

/** Adapter for a WebSocket upgrade carrying a returned single-use bearer ticket.
 * Async factories must guard the socket before yielding or resolving it.
 */
export type MpasWebSocketFactory = (options: {
  url: string;
  ticket: string;
  headers: Readonly<Record<"Authorization", string>>;
}) => MpasWebSocket | PromiseLike<MpasWebSocket>;

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

interface TransportFailure {
  status?: number;
  cause?: unknown;
}

interface MpasHttpTransportErrors {
  identityMismatch(requiredDid: Did, signerDid: Did): Error;
  authentication(status: 401 | 403, code: string): Error;
  unavailable(failure: TransportFailure): Error;
  rejected(status: number): Error;
  invalidJson(cause: unknown): Error;
}

export interface MpasHttpTransportConfig {
  url: string;
  timeoutMs?: number;
  signer?: MpasRfc9421Signer | PromiseLike<MpasRfc9421Signer>;
  signatureLifetimeSeconds?: number;
  errors: MpasHttpTransportErrors;
}

/** Shared signed-JSON HTTP plumbing; service paths, schemas, and errors remain client-owned. */
export class MpasHttpTransport {
  readonly url: string;
  readonly audience: string;
  private readonly timeoutMs: number;
  private readonly signerPromise?: Promise<MpasRfc9421Signer>;
  private readonly signatureLifetimeSeconds?: number;
  private readonly errors: MpasHttpTransportErrors;

  constructor(config: MpasHttpTransportConfig) {
    this.url = config.url.replace(/\/+$/, "");
    this.audience = deriveMpasAudience(config.url);
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.signerPromise = config.signer ? Promise.resolve(config.signer) : undefined;
    this.signatureLifetimeSeconds = config.signatureLifetimeSeconds;
    this.errors = config.errors;
  }

  resolveSigner(): Promise<MpasRfc9421Signer | undefined> {
    return this.signerPromise ?? Promise.resolve(undefined);
  }

  async post<T>(path: string, payload: object, requiredDid: Did): Promise<T> {
    const signer = await this.resolveSigner();
    if (signer && signer.did !== requiredDid) {
      throw this.errors.identityMismatch(requiredDid, signer.did);
    }

    const body = JSON.stringify(signer ? { ...payload, audience: this.audience } : payload);
    const requestUrl = `${this.url}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/mpas+json",
      Accept: "application/mpas+json",
    };
    if (signer) {
      Object.assign(headers, await signMpasRfc9421({
        method: "POST",
        path: new URL(requestUrl).pathname,
        body: Buffer.from(body),
        signer,
        ...(this.signatureLifetimeSeconds !== undefined
          ? { lifetimeSeconds: this.signatureLifetimeSeconds }
          : {}),
      }));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(requestUrl, { method: "POST", headers, body, signal: controller.signal });
    } catch (cause) {
      clearTimeout(timeout);
      throw this.errors.unavailable({ cause });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw this.errors.unavailable({ cause });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const bodyError = parseMpasHttpError(text);
        const code = bodyError?.error.code ?? (response.status === 401 ? "signature_invalid" : "permission_denied");
        throw this.errors.authentication(response.status, code);
      }
      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        throw this.errors.unavailable({ status: response.status });
      }
      throw this.errors.rejected(response.status);
    }
    if (text.length === 0) return undefined as T;
    try {
      return strictJsonParse(text) as T;
    } catch (cause) {
      throw this.errors.invalidJson(cause);
    }
  }
}

export function websocketMessageData(event: unknown, invalid: () => Error): string {
  const data = typeof event === "object" && event !== null ? (event as { data?: unknown }).data : undefined;
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  throw invalid();
}

export async function waitForPollInterval(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (intervalMs < 0 || !Number.isFinite(intervalMs)) {
    throw new Error("intervalMs must be a non-negative number.");
  }
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, intervalMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function parseMpasHttpError(text: string): MpasHttpError | undefined {
  if (text.length === 0) return undefined;
  try {
    const parsed = strictJsonParse(text) as Partial<MpasHttpError>;
    return parsed.type === "MpasHttpError" && typeof parsed.error?.code === "string"
      ? (parsed as MpasHttpError)
      : undefined;
  } catch {
    return undefined;
  }
}

// Retain failures that occur before a consumer subscribes to socket termination.
const notificationFailures = new WeakMap<MpasWebSocket, Error>();
const guardedSockets = new WeakSet<MpasWebSocket>();

/** Install immediately after construction, before yielding a server-side socket. */
export function guardNotificationSocket<T extends MpasWebSocket>(socket: T): T {
  if (guardedSockets.has(socket)) return socket;
  guardedSockets.add(socket);
  socket.addEventListener("error", (event) => {
    const value = event as { message?: unknown; error?: { message?: unknown } } | null;
    const message = value?.message ?? value?.error?.message;
    const status = typeof message === "string"
      ? /Unexpected server response: (\d{3})\b/.exec(message)?.[1]
      : undefined;
    // Never copy URLs, tickets, headers, or arbitrary server text into logs.
    notificationFailures.set(socket, new Error(status
      ? `WebSocket upgrade failed: Unexpected server response: ${status}`
      : "WebSocket notification connection failed."));
  });
  return socket;
}

/** Sanitized failure retained by the synchronous notification guard. */
export function notificationSocketError(socket: MpasWebSocket): Error | undefined {
  return notificationFailures.get(socket);
}

/** Guard synchronous factories without introducing an await/listener race. */
export function openNotificationSocket(
  factory: MpasWebSocketFactory,
  options: Parameters<MpasWebSocketFactory>[0],
): MpasWebSocket | PromiseLike<MpasWebSocket> {
  const socket = factory(options);
  if ("addEventListener" in socket) return guardNotificationSocket(socket);
  return Promise.resolve(socket).then(guardNotificationSocket);
}
