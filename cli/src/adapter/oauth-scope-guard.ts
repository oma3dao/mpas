import { extractWWWAuthenticateParams, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { OAuthOperatorError, sanitizeOAuthErrorCode } from "./oauth-errors.js";

export interface OAuthScopeChallenge {
  requestedScopes: string[];
  grantedScopes: string[];
  configuredScopes: string[];
}

export class OAuthScopeChangeRequiredError extends Error {
  readonly code = "OAUTH_SCOPE_CHANGE_REQUIRED";
  constructor(readonly challenge: OAuthScopeChallenge, operatorCommand: string) {
    super(`OAuth scope review required: server requested ${JSON.stringify(challenge.requestedScopes)}; granted ${JSON.stringify(challenge.grantedScopes)}; configured ${JSON.stringify(challenge.configuredScopes)}. Review the trusted deployment scopes before running ${operatorCommand}. No automatic reauthorization was attempted.`);
    this.name = "OAuthScopeChangeRequiredError";
  }
}

/** Stop challenges before the MCP SDK can request wider authority or persist PKCE state. */
export function guardOAuthScopes(
  fetchFn: FetchLike,
  provider: OAuthClientProvider,
  configuredScopes: string[],
  operatorCommand: string,
  onChallenge?: (challenge: OAuthScopeChallenge) => void,
  onAccessDenied?: () => void | Promise<void>,
): FetchLike {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (response.status !== 401 && response.status !== 403) return response;
    if (response.status === 403 && !hasBearerChallenge(response)) {
      // §11, §11.1: a 403 without a Bearer challenge is an application denial, not an
      // OAuth challenge. Neither login nor more scopes is suggested.
      throw await resourceDenial(response, onAccessDenied);
    }
    const { error, scope } = extractWWWAuthenticateParams(response);
    const requestedScopes = scope?.split(/ +/).filter(Boolean) ?? [];
    const tokens = await provider.tokens();
    const grantedScopes = tokens?.scope?.split(/ +/).filter(Boolean) ?? [];
    // OAUTH-05A, §4.2: without explicit configuration the allowed set is the baseline
    // recorded before consent. Extra granted scopes never widen it.
    const baseline = (provider as { scopeBaseline?: () => string[] | undefined }).scopeBaseline?.();
    const allowed = new Set(configuredScopes.length ? configuredScopes : baseline ?? grantedScopes);
    if (error !== "insufficient_scope" && requestedScopes.every((value) => allowed.has(value))) return response;
    // Bound untrusted diagnostic data, never include the raw header or bearer token.
    const bounded = (values: string[]) => values.slice(0, 64).map((value) => value.slice(0, 128));
    const challenge = { requestedScopes: bounded(requestedScopes), grantedScopes: bounded(grantedScopes), configuredScopes: bounded(configuredScopes) };
    await response.body?.cancel().catch(() => {});
    onChallenge?.(challenge);
    throw new OAuthScopeChangeRequiredError(challenge, operatorCommand);
  };
}

function hasBearerChallenge(response: Response): boolean {
  return /^\s*bearer\b/i.test(response.headers.get("www-authenticate") ?? "");
}

/**
 * Only the bounded JSON `error` member is read. `account_not_allowed` is the
 * compatibility case that maps to `oauth_access_denied`; any other body keeps the
 * denial without a guessed cause, and no text, URL or command in it is used.
 */
async function resourceDenial(response: Response, onAccessDenied?: () => void | Promise<void>): Promise<OAuthOperatorError> {
  let error: string | undefined;
  try {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const text = contentType.includes("json") ? await response.text() : "";
    if (text.length > 0 && text.length <= 16_384) {
      const parsed = JSON.parse(text) as { error?: unknown };
      error = sanitizeOAuthErrorCode(parsed?.error);
    }
  } catch {
    // Unknown bodies stay unknown.
  } finally {
    await response.body?.cancel().catch(() => {});
  }
  if (error === "account_not_allowed") {
    await onAccessDenied?.();
    return new OAuthOperatorError(
      "OAUTH_ACCESS_DENIED",
      "The MCP server denied access for this account, organization or adapter. Restore service access through an owner or admin; logging in again will not help.",
      { diagnostic: { status: 403, error } },
    );
  }
  return new OAuthOperatorError(
    "OAUTH_RESOURCE_FORBIDDEN",
    "The MCP server refused the request (HTTP 403). No login or scope change was attempted.",
    { diagnostic: { status: 403 } },
  );
}
