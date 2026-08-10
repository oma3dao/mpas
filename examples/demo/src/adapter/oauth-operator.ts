export interface OAuthOperatorRequest {
  applicationDid: string;
  resourceUrl: string;
}

export interface OAuthLoginRequest extends OAuthOperatorRequest {
  openBrowser: boolean;
}

export type OAuthOperatorResult =
  | {
      status: "oauth_login_required" | "oauth_operator_service_unavailable";
      applicationDid: string;
      resourceUrl: string;
      operatorCommand: string;
    }
  | {
      status: "authorized";
      applicationDid: string;
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
      applicationDid: string;
      localCredentialsDeleted: boolean;
      remoteRevocation: "succeeded" | "unavailable" | "failed";
    };

export interface OAuthOperatorService {
  login(request: OAuthLoginRequest): Promise<OAuthOperatorResult>;
  status(request: OAuthOperatorRequest): Promise<OAuthOperatorResult>;
  logout(request: OAuthOperatorRequest): Promise<OAuthOperatorResult>;
}

export interface OAuthDeploymentSelection {
  applicationDid: string;
  resourceUrl: string;
}

export type ResolveOAuthDeployment = (
  configDir: string,
  applicationDid: string,
) => Promise<OAuthDeploymentSelection>;

export function oauthLoginCommand(request: OAuthOperatorRequest): string {
  return `mpas oauth login --application-did ${shellQuote(request.applicationDid)}`;
}

export function unavailableOAuthOperatorService(): OAuthOperatorService {
  const unavailable = async (request: OAuthOperatorRequest): Promise<OAuthOperatorResult> => ({
    status: "oauth_operator_service_unavailable",
    applicationDid: request.applicationDid,
    resourceUrl: request.resourceUrl,
    operatorCommand: oauthLoginCommand(request),
  });
  return { login: unavailable, status: unavailable, logout: unavailable };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
