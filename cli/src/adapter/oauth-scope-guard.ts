import { extractWWWAuthenticateParams, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

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
): FetchLike {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (response.status !== 401 && response.status !== 403) return response;
    const { error, scope } = extractWWWAuthenticateParams(response);
    const requestedScopes = scope?.split(/ +/).filter(Boolean) ?? [];
    const tokens = await provider.tokens();
    const grantedScopes = tokens?.scope?.split(/ +/).filter(Boolean) ?? [];
    const allowed = new Set(configuredScopes.length ? configuredScopes : grantedScopes);
    if (error !== "insufficient_scope" && requestedScopes.every((value) => allowed.has(value))) return response;
    // Bound untrusted diagnostic data, never include the raw header or bearer token.
    const bounded = (values: string[]) => values.slice(0, 64).map((value) => value.slice(0, 128));
    const challenge = { requestedScopes: bounded(requestedScopes), grantedScopes: bounded(grantedScopes), configuredScopes: bounded(configuredScopes) };
    await response.body?.cancel().catch(() => {});
    onChallenge?.(challenge);
    throw new OAuthScopeChangeRequiredError(challenge, operatorCommand);
  };
}
