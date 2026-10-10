import type { Agent } from "undici";

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  createHardenedFetch,
  type Deadline,
  HardenedFetchError,
} from "./hardened-fetch.js";

/**
 * OAuth-specific request rules, layered on the shared connect policy in
 * `hardened-fetch.ts`. Everything here is about *what an OAuth exchange is allowed to
 * do* — the transport concerns it sits on top of are deliberately not repeated.
 */

/**
 * Bound on one attempt at a single OAuth request. Two attempts are possible, so a
 * request costs at most twice this before it gives up.
 */
export const DEFAULT_OAUTH_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Budget for an entire `auth()` sequence, which issues several requests back to back
 * (protected-resource metadata, one or more authorization-server discovery URLs, then
 * the token call). Bounding each request individually multiplies the worst case instead
 * of capping it, so callers that own a whole sequence pass this as a shared deadline.
 */
export const DEFAULT_OAUTH_CALL_BUDGET_MS = 30_000;

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  // Only reachable while testOnlyAllowHttpLoopback is set. Fixtures need a *name* to
  // exercise multi-address resolution, because numeric hosts bypass DNS entirely.
  "localhost",
]);

export interface OAuthFetchPolicyOptions {
  testOnlyAllowHttpLoopback?: boolean;
  bearerTokenResourceUrl?: string;
  fetch?: FetchLike;
  maxJsonResponseBytes?: number;
  /** Per-attempt bound. Defaults to {@link DEFAULT_OAUTH_ATTEMPT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Budget shared across every request this policy makes. Pass one when a single
   * `auth()` call is being bounded; leave it unset when the policy spans an operator
   * authorization that waits on a human, where wall-clock time is not a fault signal.
   */
  deadline?: Deadline;
  /** Test seam for driving the real transport against synthetic address lists. */
  testOnlyDispatchers?: { primary: Agent; retry: Agent };
}

export class OAuthFetchPolicyError extends Error {
  readonly code = "oauth_discovery_failed";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OAuthFetchPolicyError";
  }
}

export function createOAuthFetchPolicy(options: OAuthFetchPolicyOptions = {}): FetchLike {
  const send = createHardenedFetch({
    label: "OAuth request",
    attemptTimeoutMs: options.timeoutMs ?? DEFAULT_OAUTH_ATTEMPT_TIMEOUT_MS,
    ...(options.deadline ? { deadline: options.deadline } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.testOnlyDispatchers ? { testOnlyDispatchers: options.testOnlyDispatchers } : {}),
  });
  const maxJsonResponseBytes = options.maxJsonResponseBytes ?? 1_048_576;

  return async (input, init) => {
    const url = new URL(String(input));
    if (!isAllowedUrl(url, options.testOnlyAllowHttpLoopback === true)) {
      throw new OAuthFetchPolicyError("OAuth requests require HTTPS");
    }
    assertBearerTarget(init, url, options.bearerTokenResourceUrl);

    let response: Response;
    try {
      response = await send(input, { ...init, redirect: "manual" });
    } catch (error) {
      // Keep the transport's diagnosis, but present it as this policy's error type so
      // callers classifying OAuth failures only have to know about one.
      if (error instanceof HardenedFetchError) {
        throw new OAuthFetchPolicyError(error.message, { cause: error });
      }
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new OAuthFetchPolicyError("OAuth requests must not follow redirects");
    }
    await assertBoundedJsonResponse(response, maxJsonResponseBytes);
    return response;
  };
}

function assertBearerTarget(
  init: RequestInit | undefined,
  requestUrl: URL,
  resourceUrl: string | undefined,
): void {
  const headers = new Headers(init?.headers);
  const authorization = headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) return;

  if (resourceUrl === undefined || requestUrl.toString() !== new URL(resourceUrl).toString()) {
    throw new OAuthFetchPolicyError("Bearer authorization is restricted to the exact MCP resource URL");
  }
}

async function assertBoundedJsonResponse(response: Response, maxBytes: number): Promise<void> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) return;

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new OAuthFetchPolicyError("OAuth JSON response exceeds the size limit");
  }

  const body = await response.clone().arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw new OAuthFetchPolicyError("OAuth JSON response exceeds the size limit");
  }
}

function isAllowedUrl(url: URL, allowHttpLoopback: boolean): boolean {
  if (url.protocol === "https:") return true;
  return allowHttpLoopback && url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
}
