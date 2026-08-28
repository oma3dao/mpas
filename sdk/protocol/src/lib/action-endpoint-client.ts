import type {
  ActionPackage,
  ActionRequest,
  ActionResponse,
  DeliveryEnvelope,
  Did,
  MpasHttpError,
} from "../types/mpas.js";
import {
  parseActionRequest,
  parseActionRequestEnvelope,
  parseActionResponse,
} from "./routing.js";
import { deriveMpasAudience, signMpasRfc9421, type MpasRfc9421Signer } from "./rfc9421.js";

/** Configuration for the common MPAS Action endpoint client. */
export interface ActionEndpointClientConfig {
  /** Base URL of a directly reachable Verifier or a Coordination Service relay. */
  url: string;
  /** Request timeout in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** RFC 9421 signer for the Action Proposer DID. Omit only at a trusted unenforcing endpoint. */
  signer?: MpasRfc9421Signer | PromiseLike<MpasRfc9421Signer>;
  /** Signature lifetime in seconds, subject to the MPAS HTTP profile maximum. */
  signatureLifetimeSeconds?: number;
}

/** Input for constructing an {@link ActionRequest} around an Action Package. */
export interface BuildActionRequestInput {
  /** Complete MPAS Action Package submitted for Verifier processing. */
  actionPackage: ActionPackage;
  /** Body-level key reused across equivalent Action-processing retries. */
  idempotencyKey?: string;
  /** Non-authoritative Action request metadata. */
  context?: ActionRequest["context"];
}

/** Optional details attached to an {@link ActionEndpointClientError}. */
export interface ActionEndpointClientErrorOptions extends ErrorOptions {
  /** HTTP status returned by the Action endpoint, when a response was received. */
  status?: number;
  /** MPAS error code returned inside an `MpasHttpError`, when available. */
  protocolCode?: string;
}

/** Error returned for Action endpoint transport, HTTP, identity, or response failures. */
export class ActionEndpointClientError extends Error {
  readonly code = "ACTION_ENDPOINT_CLIENT_ERROR";
  readonly status?: number;
  readonly protocolCode?: string;

  constructor(message: string, options: ActionEndpointClientErrorOptions = {}) {
    super(message, options);
    this.name = "ActionEndpointClientError";
    this.status = options.status;
    this.protocolCode = options.protocolCode;
  }
}

/**
 * Constructs and validates the inner Action HTTP message without routing or transmission.
 *
 * Use {@link buildDeliveryEnvelope} separately when the Action request needs an outer
 * routing layer. Keeping the two construction steps separate allows an exact envelope
 * to be retained for an idempotent retry.
 *
 * @throws `RoutingValidationError` If the constructed request is malformed.
 */
export function buildActionRequest(input: BuildActionRequestInput): ActionRequest {
  return parseActionRequest({
    version: "1",
    type: "ActionRequest",
    actionPackage: input.actionPackage,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
  });
}

/**
 * Client of the common MPAS `/mpas/v1/action` endpoint.
 *
 * The endpoint may be hosted by a directly reachable Verifier or by a Coordination
 * Service relay. Both topologies accept an Action request and return the existing
 * Verifier-authored {@link ActionResponse}; only the accepted outer request form differs.
 */
export class ActionEndpointClient {
  private readonly url: string;
  private readonly audience: string;
  private readonly timeoutMs: number;
  private readonly signer?: Promise<MpasRfc9421Signer>;
  private readonly signatureLifetimeSeconds?: number;

  /** Creates a client bound to one Action endpoint origin. */
  constructor(config: ActionEndpointClientConfig) {
    this.url = config.url.replace(/\/+$/, "");
    this.audience = deriveMpasAudience(config.url);
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.signer = config.signer ? Promise.resolve(config.signer) : undefined;
    this.signatureLifetimeSeconds = config.signatureLifetimeSeconds;
  }

  /**
   * Submits a pre-built bare or enveloped Action request to `/mpas/v1/action`.
   *
   * The outer body is parsed before transmission. When signing is enabled, the
   * signer DID must equal the bare request's Proposer DID or the envelope sender.
   * The client adds the endpoint audience and creates a fresh RFC 9421 nonce.
   *
   * @throws `RoutingValidationError` If the supplied request is malformed.
   * @throws {@link ActionEndpointClientError} For identity, transport, HTTP, or response errors.
   */
  async submitActionRequest(
    request: ActionRequest | DeliveryEnvelope<ActionRequest>,
  ): Promise<ActionResponse> {
    let canonical: ActionRequest | DeliveryEnvelope<ActionRequest>;
    let requiredDid: Did;
    if (request.type === "DeliveryEnvelope") {
      canonical = parseActionRequestEnvelope(request);
      requiredDid = canonical.sender;
    } else {
      canonical = parseActionRequest(request);
      requiredDid = canonical.actionPackage.actionEnvelope.proposer.did;
    }

    const signer = this.signer ? await this.signer : undefined;
    if (signer && signer.did !== requiredDid) {
      throw new ActionEndpointClientError(
        `Action request identity ${requiredDid} does not match signer DID ${signer.did}.`,
      );
    }

    const submitted = signer ? { ...canonical, audience: this.audience } : canonical;
    const requestUrl = `${this.url}/mpas/v1/action`;
    const text = JSON.stringify(submitted);
    const headers: Record<string, string> = {
      "Content-Type": "application/mpas+json",
      Accept: "application/mpas+json",
    };
    if (signer) {
      Object.assign(headers, await signMpasRfc9421({
        method: "POST",
        path: new URL(requestUrl).pathname,
        body: Buffer.from(text),
        signer,
        ...(this.signatureLifetimeSeconds !== undefined
          ? { lifetimeSeconds: this.signatureLifetimeSeconds }
          : {}),
      }));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers,
        body: text,
        signal: controller.signal,
      });
      const responseText = await response.text();
      let parsed: unknown;
      try {
        parsed = responseText.length === 0 ? undefined : JSON.parse(responseText) as unknown;
      } catch (error) {
        throw new ActionEndpointClientError(
          "Action endpoint response was not valid JSON.",
          { status: response.status, cause: error },
        );
      }
      if (!response.ok) {
        const error = parsed as Partial<MpasHttpError> | undefined;
        throw new ActionEndpointClientError(
          `Action endpoint returned HTTP ${response.status}.`,
          {
            status: response.status,
            protocolCode: error?.type === "MpasHttpError" ? error.error?.code : undefined,
          },
        );
      }
      try {
        return parseActionResponse(parsed);
      } catch (error) {
        throw new ActionEndpointClientError(
          "Action endpoint did not return a valid ActionResponse.",
          { cause: error },
        );
      }
    } catch (error) {
      if (error instanceof ActionEndpointClientError) throw error;
      throw new ActionEndpointClientError(
        `Action endpoint is unavailable at ${this.url}.`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
