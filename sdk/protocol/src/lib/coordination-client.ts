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
  MpasHttpError,
} from "../types/mpas.js";
import {
  deriveMpasAudience,
  signMpasRfc9421,
  type MpasRfc9421Signer,
} from "./rfc9421.js";

export interface CoordinationClientConfig {
  url: string;
  timeoutMs?: number;
  signer?: MpasRfc9421Signer | PromiseLike<MpasRfc9421Signer>;
  signatureLifetimeSeconds?: number;
}

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
  private readonly audience: string;
  private readonly timeoutMs: number;
  private readonly signer?: Promise<MpasRfc9421Signer>;
  private readonly signatureLifetimeSeconds?: number;

  constructor(config: CoordinationClientConfig) {
    this.audience = deriveMpasAudience(config.url);
    this.url = config.url.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.signer = config.signer ? Promise.resolve(config.signer) : undefined;
    this.signatureLifetimeSeconds = config.signatureLifetimeSeconds;
  }

  async submitAction(pkg: ActionPackage, authReqs: AuthorizationRequirements): Promise<CoordinationActionResponse> {
    return this.post<CoordinationActionResponse>(
      "/mpas/v1/coordination/action",
      {
        version: "1",
        type: "CoordinationActionRequest",
        actionPackage: pkg,
        authorizationRequirements: authReqs,
      },
      pkg.actionEnvelope.proposer.did,
    );
  }

  async poll(did: Did): Promise<CoordinationPollResponse> {
    return this.post<CoordinationPollResponse>(
      "/mpas/v1/coordination/poll",
      { version: "1", type: "CoordinationPollRequest", did },
      did,
    );
  }

  async submitApproval(actionEnvelopeHash: HashObject, approval: Approval): Promise<CoordinationApprovalResponse> {
    return this.post<CoordinationApprovalResponse>(
      "/mpas/v1/coordination/approval",
      { version: "1", type: "CoordinationApprovalSubmission", actionEnvelopeHash, approval },
      approvalSignerDid(approval),
    );
  }

  async cancelAction(actionId: ActionId, did: Did): Promise<CoordinationCancelResponse> {
    return this.post<CoordinationCancelResponse>(
      "/mpas/v1/coordination/action-cancel",
      { version: "1", type: "CoordinationActionCancelRequest", actionId, proposerDid: did },
      did,
    );
  }

  private async post<T>(path: string, payload: Record<string, unknown>, requiredDid: Did): Promise<T> {
    const signer = this.signer ? await this.signer : undefined;
    if (signer && signer.did !== requiredDid) {
      throw new Error(`Coordination request identity ${requiredDid} does not match signer DID ${signer.did}.`);
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
          throw new MpasAuthError(
            response.status,
            errorBody?.error.code ?? (response.status === 401 ? "signature_invalid" : "permission_denied"),
            `Coordination authentication failed with HTTP ${response.status}.`,
          );
        }
        if (response.status >= 500) {
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

function approvalSignerDid(approval: Approval): Did {
  const parts = approval.signature.value.split(".");
  if (approval.signature.format !== "jws" || parts.length !== 3) {
    throw new Error("Approval does not contain a decodable compact JWS signer DID.");
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
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
