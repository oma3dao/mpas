import { Agent } from "undici";

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Connect and retry policy for every outbound HTTP request the adapter makes.
 *
 * This layer owns *how we reach a host* — address selection, connect budgets, and the
 * one retry that a degraded network path warrants. It deliberately knows nothing about
 * OAuth. Response rules (HTTPS-only, redirect handling, body caps) belong to the caller
 * that has the context to impose them; see `oauth-fetch-policy.ts`, which composes on
 * top of this.
 *
 * Keeping the two apart is what lets the MCP transport share the connect hardening
 * without inheriting OAuth's response restrictions.
 */

/**
 * Backstop for establishing a socket. Covers DNS, the TCP handshake and — because
 * undici clears this timer on `secureConnect` rather than `connect` — the TLS handshake
 * as well. undici defaults to 10s; a lower value surfaces a dead route well inside any
 * caller budget and leaves room for the retry below.
 */
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Happy Eyeballs (RFC 8305) per-address attempt window.
 *
 * This matches Node's own default, which has been enabled since v20, and is set here
 * only so behaviour cannot be altered by ambient configuration such as
 * `--no-network-family-autoselection`. It is *not* what recovers a blackholed route on a
 * supported runtime — that already worked before this module existed. The retry in
 * {@link createHardenedFetch} covers what address racing cannot: a path that completes
 * the handshake and only then goes silent, by which point Happy Eyeballs has committed.
 */
export const FAMILY_ATTEMPT_TIMEOUT_MS = 250;

/** Connect options applied to every request that uses the runtime's fetch. */
export const CONNECT_OPTIONS = Object.freeze({
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: FAMILY_ATTEMPT_TIMEOUT_MS,
  timeout: CONNECT_TIMEOUT_MS,
});

/**
 * Failures that prove no request bytes reached the server, which makes a retry safe
 * even for a non-idempotent request such as a token exchange.
 */
const CONNECT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
]);

type FetchDispatcher = NonNullable<RequestInit["dispatcher"]>;

export interface ConnectOverrides {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  family?: number;
  lookup?: unknown;
  timeout?: number;
}

export class HardenedFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HardenedFetchError";
  }
}

/** Builds a dispatcher with the shared connect policy, allowing per-test overrides. */
export function createDispatcher(connectOverrides: ConnectOverrides = {}): Agent {
  return new Agent({ connect: { ...CONNECT_OPTIONS, ...connectOverrides } });
}

let sharedDispatcher: Agent | undefined;
let ipv4OnlyDispatcher: Agent | undefined;

function defaultDispatcher(): Agent {
  sharedDispatcher ??= createDispatcher();
  return sharedDispatcher;
}

/**
 * Fallback for a path whose IPv6 route is degraded rather than absent. Happy Eyeballs
 * commits to a family once the handshake completes, so the retry has to pin the family
 * rather than race again.
 */
function ipv4Dispatcher(): Agent {
  ipv4OnlyDispatcher ??= createDispatcher({ family: 4, autoSelectFamily: false });
  return ipv4OnlyDispatcher;
}

/**
 * A budget shared across every request made through one fetch instance.
 *
 * Sequences such as the MCP SDK's `auth()` issue several requests back to back. Bounding
 * each one individually multiplies rather than caps the worst case, so callers that own
 * a whole sequence pass a single deadline covering all of it.
 */
export interface Deadline {
  readonly signal: AbortSignal;
  remainingMs(): number;
  expired(): boolean;
}

export function createDeadline(totalMs: number): Deadline {
  const expiresAt = Date.now() + totalMs;
  const signal = AbortSignal.timeout(totalMs);
  return {
    signal,
    remainingMs: () => Math.max(0, expiresAt - Date.now()),
    expired: () => signal.aborted,
  };
}

export interface HardenedFetchOptions {
  /**
   * Bound on a single attempt. Omit for requests whose duration is legitimately
   * open-ended — MCP tool calls, streamed responses — so the caller's own signal stays
   * the only response deadline. Setting it also makes a stalled attempt retryable, which
   * is the only way to recover a path that goes silent after the handshake.
   */
  attemptTimeoutMs?: number;
  /** Budget shared across every request made through this fetch instance. */
  deadline?: Deadline;
  /** Prefix for surfaced errors, e.g. "OAuth request". */
  label?: string;
  /** Test seam replacing the runtime fetch. Connect tuning does not apply to it. */
  fetch?: FetchLike;
  /**
   * Test seam for driving the real transport against synthetic address lists. Separate
   * dispatchers per attempt so a test can prove the retry left the failing path rather
   * than merely repeating the request.
   */
  testOnlyDispatchers?: { primary: Agent; retry: Agent };
}

interface Attempt {
  readonly signal: AbortSignal | undefined;
  timedOut(): boolean;
  dispose(): void;
}

export function createHardenedFetch(options: HardenedFetchOptions = {}): FetchLike {
  const injectedFetch = options.fetch;
  const fetchFn = injectedFetch ?? fetch;
  const label = options.label ?? "HTTP request";
  // Connect tuning only applies to the runtime's fetch. An injected fetch keeps whatever
  // transport the caller supplied, so a retry through it would repeat the first attempt
  // byte for byte and is suppressed below.
  const managesTransport = injectedFetch === undefined;

  return async (input, init) => {
    const url = new URL(String(input));
    const callerSignal = init?.signal;
    const deadline = options.deadline;

    const send = async (dispatcher: Agent | undefined, signal: AbortSignal | undefined): Promise<Response> =>
      fetchFn(input, {
        ...init,
        signal,
        // The global RequestInit types come from the undici-types copy bundled with
        // @types/node, while the dispatcher is a real undici Agent. The two declare
        // structurally identical but nominally distinct shapes, so the cast is confined
        // to this boundary rather than weakening the dispatcher type elsewhere.
        ...(dispatcher === undefined ? {} : { dispatcher: dispatcher as unknown as FetchDispatcher }),
      });

    const dispatcherFor = (seam: Agent | undefined, fallback: () => Agent): Agent | undefined =>
      managesTransport ? seam ?? fallback() : undefined;

    const first = beginAttempt(callerSignal, deadline, options.attemptTimeoutMs);
    try {
      return await send(dispatcherFor(options.testOnlyDispatchers?.primary, defaultDispatcher), first.signal);
    } catch (error) {
      // Cancellation by the caller is not a transport fault: never retry, never rewrite.
      if (callerSignal?.aborted) throw error;
      if (deadline?.expired()) throw budgetExhausted(label, url, error);

      const failureCode = connectFailureCode(error);
      if (!managesTransport || !isRetryable(failureCode, first.timedOut(), init?.body)) {
        throw transportFailure(label, error, failureCode, first.timedOut(), url);
      }

      const retry = beginAttempt(callerSignal, deadline, options.attemptTimeoutMs);
      try {
        return await send(dispatcherFor(options.testOnlyDispatchers?.retry, ipv4Dispatcher), retry.signal);
      } catch (retryError) {
        if (callerSignal?.aborted) throw retryError;
        if (deadline?.expired()) throw budgetExhausted(label, url, retryError);
        throw transportFailure(label, retryError, connectFailureCode(retryError), retry.timedOut(), url);
      } finally {
        retry.dispose();
      }
    } finally {
      first.dispose();
    }
  };
}

/**
 * A connect failure sends no bytes, so it is unconditionally safe to replay. An attempt
 * that stalled after the handshake is not provably safe — the server may have processed
 * a request whose response was lost. It is still replayed, because the alternative is
 * worse: on a degraded path the request is far more likely to have been dropped than
 * processed, and in the one case where a token grant did land, the locally stored
 * refresh token is already stale and needs operator attention either way.
 */
function isRetryable(failureCode: string | undefined, timedOut: boolean, body: unknown): boolean {
  if (failureCode === undefined && !timedOut) return false;
  return isReplayableBody(body);
}

function beginAttempt(
  callerSignal: AbortSignal | null | undefined,
  deadline: Deadline | undefined,
  attemptTimeoutMs: number | undefined,
): Attempt {
  const signals: AbortSignal[] = [];
  if (callerSignal) signals.push(callerSignal);
  if (deadline) signals.push(deadline.signal);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (attemptTimeoutMs !== undefined) {
    const controller = new AbortController();
    // Never let one attempt outlive the shared budget it is drawing from.
    const budget = deadline ? Math.min(attemptTimeoutMs, deadline.remainingMs()) : attemptTimeoutMs;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Attempt timed out", "TimeoutError"));
    }, budget);
    timer.unref?.();
    signals.push(controller.signal);
  }

  return {
    signal: signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Surfaces the transport's own diagnosis instead of collapsing every network failure
 * into a timeout. Only the host is included: OAuth URLs carry authorization codes and
 * state in the query string, and no header or body material is referenced.
 */
function transportFailure(
  label: string,
  error: unknown,
  failureCode: string | undefined,
  timedOut: boolean,
  url: URL,
): unknown {
  if (failureCode !== undefined) {
    return new HardenedFetchError(`${label} could not connect to ${url.host} (${failureCode})`, { cause: error });
  }
  if (timedOut) {
    return new HardenedFetchError(`${label} timed out`, { cause: error });
  }
  return error;
}

function budgetExhausted(label: string, url: URL, error: unknown): HardenedFetchError {
  return new HardenedFetchError(`${label} to ${url.host} exceeded its overall budget`, { cause: error });
}

export function connectFailureCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || error === null || typeof error !== "object") return undefined;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CONNECT_FAILURE_CODES.has(code)) return code;

  // Happy Eyeballs reports per-address failures through an AggregateError.
  const aggregated = (error as { errors?: unknown }).errors;
  if (Array.isArray(aggregated)) {
    for (const nested of aggregated) {
      const nestedCode = connectFailureCode(nested, depth + 1);
      if (nestedCode !== undefined) return nestedCode;
    }
  }
  return connectFailureCode((error as { cause?: unknown }).cause, depth + 1);
}

function isReplayableBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return true;
  if (body instanceof URLSearchParams) return true;
  if (body instanceof ArrayBuffer) return true;
  return ArrayBuffer.isView(body);
}
