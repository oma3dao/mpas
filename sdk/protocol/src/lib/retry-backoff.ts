/** Exponential backoff with full jitter for retried remote work. */
export interface BackoffPolicy {
  /** Delay ceiling before jitter for the first failure. */
  baseMs: number;
  /** Largest delay before jitter. */
  capMs: number;
}

/** Coordination polls and failed submissions (feature reduce-polling §4.4). */
export const FAILURE_BACKOFF: BackoffPolicy = { baseMs: 5_000, capMs: 300_000 };
/** Verifier `pending` re-checks (feature reduce-polling §5.1). */
export const PENDING_BACKOFF: BackoffPolicy = { baseMs: 2_000, capMs: 60_000 };
/** Largest `Retry-After` the bridge honors. */
export const MAX_RETRY_AFTER_MS = 900_000;

/**
 * Delay before the next attempt after `failures` consecutive failures (at
 * least 1). A server-supplied `Retry-After` replaces the computed delay.
 */
export function backoffDelayMs(
  failures: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(0, retryAfterMs), MAX_RETRY_AFTER_MS);
  }
  const exponent = Math.max(0, Math.min(failures, 31) - 1);
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

/** Parse an HTTP `Retry-After` value (delay-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/** A `retryAfterMs` carried by an SDK client error, when the server sent one. */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
