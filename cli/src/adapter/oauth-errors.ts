/**
 * Typed OAuth failures raised inside the Credential Adapter.
 *
 * Each failure carries an uppercase adapter constant. The spec's lowercase reason
 * codes (§11) are derived from that constant by the single table
 * `OAUTH_REASON_BY_CODE` in `oauth-operator.ts`; nothing here chooses a reason.
 * Messages are written by the adapter and never echo a server response.
 */

export type OAuthFailureCode =
  | "OAUTH_LOGIN_REQUIRED"
  | "OAUTH_INVALID_GRANT"
  | "OAUTH_INSUFFICIENT_SCOPE"
  | "OAUTH_ACCESS_DENIED"
  | "OAUTH_AUTHORIZATION_DENIED"
  | "OAUTH_DISCOVERY_FAILED"
  | "OAUTH_CLIENT_REGISTRATION_FAILED"
  | "OAUTH_CLIENT_AUTHENTICATION_FAILED"
  | "OAUTH_TEMPORARILY_UNAVAILABLE"
  | "OAUTH_RATE_LIMITED"
  | "OAUTH_TOKEN_REFRESH_FAILED"
  | "OAUTH_RESOURCE_FORBIDDEN"
  | "OAUTH_UNKNOWN_ERROR";

export interface OAuthFailureDetails {
  cause?: unknown;
  /** Present only when the operator can act by running it; never for an entitlement denial. */
  operatorCommand?: string;
  retryAfterSeconds?: number;
  /** True when a token request may have been processed without a usable response (OAUTH-30). */
  ambiguous?: boolean;
  /** Bounded, non-secret diagnostics such as an HTTP status or a sanitized error code. */
  diagnostic?: { status?: number; error?: string; phase?: string };
}

export class OAuthOperatorError extends Error {
  readonly operatorCommand?: string;
  readonly retryAfterSeconds?: number;
  readonly ambiguous: boolean;
  readonly diagnostic?: OAuthFailureDetails["diagnostic"];

  constructor(readonly code: OAuthFailureCode, message: string, details: OAuthFailureDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "OAuthOperatorError";
    this.ambiguous = details.ambiguous === true;
    if (details.operatorCommand) this.operatorCommand = details.operatorCommand;
    if (details.retryAfterSeconds !== undefined) this.retryAfterSeconds = details.retryAfterSeconds;
    if (details.diagnostic) this.diagnostic = details.diagnostic;
  }
}

/** Accepts only a short token-like OAuth error code; anything else is reported as unparseable. */
export function sanitizeOAuthErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

/** Bounded `Retry-After` in seconds (delta-seconds or HTTP-date), clamped to one hour. */
export function parseRetryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d{1,10}$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const date = Date.parse(trimmed);
    if (!Number.isFinite(date)) return undefined;
    seconds = Math.ceil((date - now) / 1000);
  }
  return Math.min(Math.max(seconds, 1), 3600);
}
