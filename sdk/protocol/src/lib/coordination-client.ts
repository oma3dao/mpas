import type {
  ActionPackage,
  ActionId,
  Approval,
  AuthorizationRequirements,
  CoordinationActionResponse,
  CoordinationApprovalResponse,
  CoordinationCancelResponse,
  CoordinationPollResponse,
  Did,
  HashObject,
} from "../types/mpas.js";

export interface CoordinationClientConfig {
  url: string;
  timeoutMs?: number;
}

export class CoordinationUnavailableError extends Error {
  readonly code = "COORDINATION_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoordinationUnavailable";
  }
}

export class CoordinationResponseError extends Error {
  readonly code = "COORDINATION_RESPONSE_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoordinationResponseInvalid";
  }
}

export class CoordinationClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(config: CoordinationClientConfig) {
    this.url = config.url.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async submitAction(pkg: ActionPackage, authReqs: AuthorizationRequirements): Promise<CoordinationActionResponse> {
    return this.request<CoordinationActionResponse>("/mpas/v1/coordination/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "1",
        type: "CoordinationActionRequest",
        actionPackage: pkg,
        authorizationRequirements: authReqs,
      }),
    });
  }

  async poll(did: Did): Promise<CoordinationPollResponse> {
    return this.request<CoordinationPollResponse>("/mpas/v1/coordination/poll", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "1",
        type: "CoordinationPollRequest",
        did,
      }),
    });
  }

  async submitApproval(actionEnvelopeHash: HashObject, approval: Approval): Promise<CoordinationApprovalResponse> {
    return this.request<CoordinationApprovalResponse>("/mpas/v1/coordination/approval", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "1",
        type: "CoordinationApprovalSubmission",
        actionEnvelopeHash,
        approval,
      }),
    });
  }

  async cancelAction(actionId: ActionId, did: Did): Promise<CoordinationCancelResponse> {
    return this.request<CoordinationCancelResponse>("/mpas/v1/coordination/action-cancel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "1",
        type: "CoordinationActionCancelRequest",
        actionId,
        proposerDid: did,
      }),
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
      const text = await response.text();

      if (!response.ok) {
        throw new CoordinationUnavailableError(`Coordination Service returned HTTP ${response.status}.`);
      }

      if (text.length === 0) {
        return undefined as T;
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new CoordinationResponseError("Coordination response was not valid JSON.", { cause: error });
      }

      throw new CoordinationUnavailableError(`Coordination Service is unavailable at ${this.url}.`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
