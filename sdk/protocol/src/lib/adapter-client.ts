import type {
  ActionPackage,
  ActionRequest,
  AdapterResponse,
  DeliveryEnvelope,
  MpasHttpError,
} from "../types/mpas.js";
import { isRetryableHttpFailure, isRetryableHttpStatus } from "./client-transport.js";
import { parseRetryAfterMs } from "./retry-backoff.js";
import {
  ActionEndpointClient,
  ActionEndpointClientError,
  buildActionRequest,
  type ActionEndpointClientConfig,
} from "./action-endpoint-client.js";

/** Configuration for a Credential Adapter client. */
export type CredentialAdapterClientConfig = ActionEndpointClientConfig;

/** @deprecated Use {@link CredentialAdapterClientConfig}. */
export type AdapterClientConfig = CredentialAdapterClientConfig;

export class AdapterUnavailableError extends Error {
  readonly code = "ADAPTER_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdapterUnavailable";
  }
}

export class AdapterResponseError extends Error {
  readonly code = "ADAPTER_RESPONSE_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdapterResponseInvalid";
  }
}

/** Raised when the adapter returns a non-2xx MpasHttpError (e.g. 400 unparseable request). */
export class AdapterRequestError extends Error {
  /**
   * Whether an identical retry may succeed, by the shared MPAS HTTP rule
   * ({@link isRetryableHttpFailure}).
   */
  readonly retryable: boolean;
  /** Server-requested delay from `Retry-After`, when present. */
  readonly retryAfterMs?: number;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    retryable: boolean = isRetryableHttpStatus(status),
    options: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "AdapterRequestError";
    this.retryable = retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Client of a Credential Adapter endpoint.
 *
 * Common Action submission delegates to {@link ActionEndpointClient}; this class
 * additionally exposes adapter-specific operations such as the optional health check.
 */
export class CredentialAdapterClient {
  private readonly url: string;
  readonly timeoutMs: number;
  private readonly actionEndpoint: ActionEndpointClient;

  constructor(config: CredentialAdapterClientConfig) {
    this.url = config.url.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.actionEndpoint = new ActionEndpointClient(config);
  }

  /** Submits a bare or enveloped Action request through the common Action endpoint. */
  async submitActionRequest(
    request: ActionRequest | DeliveryEnvelope<ActionRequest>,
  ): Promise<AdapterResponse> {
    return this.actionEndpoint.submitActionRequest(request);
  }

  /**
   * @deprecated Build an Action request with {@link buildActionRequest} and call
   * {@link submitActionRequest}.
   */
  async submit(pkg: ActionPackage): Promise<AdapterResponse> {
    try {
      return await this.submitActionRequest(buildActionRequest({ actionPackage: pkg }));
    } catch (error) {
      // Keep the endpoint client's classification: a malformed success
      // response is permanent, an HTTP failure carries its retryability, and
      // anything else is an outage.
      if (
        error instanceof ActionEndpointClientError &&
        error.retryable === false &&
        (error.message.includes("valid ActionResponse") || error.message.includes("valid JSON"))
      ) {
        throw new AdapterResponseError(error.message, { cause: error });
      }
      if (error instanceof ActionEndpointClientError && error.status !== undefined) {
        throw new AdapterRequestError(
          error.protocolCode ?? "server_error",
          error.message,
          error.status,
          error.retryable ?? isRetryableHttpStatus(error.status),
          error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {},
        );
      }
      throw new AdapterUnavailableError(`Credential Adapter is unavailable at ${this.url}.`, { cause: error });
    }
  }

  /** Checks the adapter-specific, non-protocol health endpoint. */
  async healthCheck(): Promise<{ status: string }> {
    return this.request<{ status: string }>("/mpas/v1/health", {
      method: "GET",
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}${path}`, {
        ...init,
        signal: controller.signal,
      });

      const body = (await response.json()) as unknown;

      if (!response.ok) {
        const httpError = body as Partial<MpasHttpError>;
        const retryable = isRetryableHttpFailure(response.status, body);
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const options = retryAfterMs !== undefined ? { retryAfterMs } : {};
        if (httpError?.type === "MpasHttpError" && httpError.error) {
          throw new AdapterRequestError(httpError.error.code, httpError.error.message, response.status, retryable, options);
        }
        throw new AdapterRequestError("server_error", `Adapter returned HTTP ${response.status}.`, response.status, retryable, options);
      }

      return body as T;
    } catch (error) {
      if (error instanceof AdapterRequestError) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        throw new AdapterResponseError("Adapter response was not valid JSON.", { cause: error });
      }

      throw new AdapterUnavailableError(`Credential Adapter is unavailable at ${this.url}.`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** @deprecated Use {@link CredentialAdapterClient}. */
export class AdapterClient extends CredentialAdapterClient {}
