import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export class OAuthIssuerMismatchError extends Error {
  readonly code = "oauth_discovery_failed";

  constructor() {
    super("OAuth authorization-server metadata issuer does not exactly match the discovered issuer");
    this.name = "OAuthIssuerMismatchError";
  }
}

export class OAuthPkceMetadataError extends Error {
  readonly code = "oauth_discovery_failed";

  constructor() {
    super("OAuth authorization-server metadata must explicitly advertise PKCE S256");
    this.name = "OAuthPkceMetadataError";
  }
}

/** Enforces OAUTH-11B at the SDK provider boundary before discovery is persisted or used. */
export function assertExactAuthorizationServerIssuer(state: OAuthDiscoveryState): void {
  const declaredIssuer = state.authorizationServerMetadata?.issuer;
  if (state.resourceMetadata === undefined || declaredIssuer === undefined ||
      declaredIssuer !== state.authorizationServerUrl) {
    throw new OAuthIssuerMismatchError();
  }
  if (!state.authorizationServerMetadata?.code_challenge_methods_supported?.includes("S256")) {
    throw new OAuthPkceMetadataError();
  }
}
