import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface OAuthFetchPolicyOptions {
  allowHttpLoopback?: boolean;
  bearerTokenResourceUrl?: string;
  fetch?: FetchLike;
  maxJsonResponseBytes?: number;
  timeoutMs?: number;
}

export class OAuthFetchPolicyError extends Error {
  readonly code = "oauth_discovery_failed";

  constructor(message: string) {
    super(message);
    this.name = "OAuthFetchPolicyError";
  }
}

export function createOAuthFetchPolicy(options: OAuthFetchPolicyOptions = {}): FetchLike {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxJsonResponseBytes = options.maxJsonResponseBytes ?? 1_048_576;

  return async (input, init) => {
    const url = new URL(String(input));
    if (!isAllowedUrl(url, options.allowHttpLoopback === true)) {
      throw new OAuthFetchPolicyError("OAuth requests require HTTPS");
    }
    assertBearerTarget(init, url, options.bearerTokenResourceUrl);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await fetchFn(input, { ...init, redirect: "manual", signal });
    } catch (error) {
      if (timeoutSignal.aborted) {
        throw new OAuthFetchPolicyError("OAuth request timed out");
      }
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new OAuthFetchPolicyError("OAuth requests must not follow redirects");
    }
    return boundJsonResponse(response, maxJsonResponseBytes);
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

async function boundJsonResponse(response: Response, maxBytes: number): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) return response;

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new OAuthFetchPolicyError("OAuth JSON response exceeds the size limit");
  }

  const body = await response.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw new OAuthFetchPolicyError("OAuth JSON response exceeds the size limit");
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isAllowedUrl(url: URL, allowHttpLoopback: boolean): boolean {
  if (url.protocol === "https:") return true;
  return allowHttpLoopback && url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
}
