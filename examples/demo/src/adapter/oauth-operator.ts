export interface OAuthOperatorRequest {
  deployment: string;
  session: string;
}

export interface OAuthLoginRequest extends OAuthOperatorRequest {
  openBrowser: boolean;
}

export type OAuthOperatorResult =
  | {
      status: "oauth_login_required" | "oauth_operator_service_unavailable";
      deployment: string;
      session: string;
      operatorCommand: string;
    }
  | {
      status: "authorized";
      deployment: string;
      session: string;
      issuer: string;
      resource: string;
      clientMode: "static" | "cimd" | "dynamic";
      scopes: string[];
      expiresAt?: string;
      refreshable: boolean;
      reauthorizationRequired: boolean;
    }
  | {
      status: "logged_out";
      deployment: string;
      session: string;
      localCredentialsDeleted: boolean;
      remoteRevocation: "succeeded" | "unavailable" | "failed";
    };

export interface OAuthOperatorService {
  login(request: OAuthLoginRequest): Promise<OAuthOperatorResult>;
  status(request: OAuthOperatorRequest): Promise<OAuthOperatorResult>;
  logout(request: OAuthOperatorRequest): Promise<OAuthOperatorResult>;
}

export function oauthLoginCommand(request: OAuthOperatorRequest): string {
  return `mpas oauth login --deployment ${shellQuote(request.deployment)} --session ${shellQuote(request.session)}`;
}

export function unavailableOAuthOperatorService(): OAuthOperatorService {
  const unavailable = async (request: OAuthOperatorRequest): Promise<OAuthOperatorResult> => ({
    status: "oauth_operator_service_unavailable",
    deployment: request.deployment,
    session: request.session,
    operatorCommand: oauthLoginCommand(request),
  });
  return { login: unavailable, status: unavailable, logout: unavailable };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
