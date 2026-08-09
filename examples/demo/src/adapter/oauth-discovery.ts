import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export class OAuthIssuerMismatchError extends Error {
  readonly code = "oauth_discovery_failed";

  constructor() {
    super("OAuth authorization-server metadata issuer does not exactly match the discovered issuer");
    this.name = "OAuthIssuerMismatchError";
  }
}

/** Enforces OAUTH-11B at the SDK provider boundary before discovery is persisted or used. */
export function assertExactAuthorizationServerIssuer(state: OAuthDiscoveryState): void {
  const declaredIssuer = state.authorizationServerMetadata?.issuer;
  if (declaredIssuer !== undefined && declaredIssuer !== state.authorizationServerUrl) {
    throw new OAuthIssuerMismatchError();
  }
}
