import type { ActionPackage, AdapterResponse, MpasHttpError } from "../types/mpas.js";

export interface AdapterClientConfig {
  url: string;
  timeoutMs?: number;
}

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
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdapterRequestError";
  }
}

export class AdapterClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(config: AdapterClientConfig) {
    this.url = config.url.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async submit(pkg: ActionPackage): Promise<AdapterResponse> {
    return this.request<AdapterResponse>("/mpas/v1/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/mpas+json",
        Accept: "application/mpas+json",
      },
      body: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage: pkg }),
    });
  }

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
        if (httpError?.type === "MpasHttpError" && httpError.error) {
          throw new AdapterRequestError(httpError.error.code, httpError.error.message, response.status);
        }
        throw new AdapterRequestError("server_error", `Adapter returned HTTP ${response.status}.`, response.status);
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
