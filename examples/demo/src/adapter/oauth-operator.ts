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

export async function resolveOAuthApplication(
  configDir: string,
  applicationDid: string,
): Promise<OAuthDeploymentSelection> {
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch {
    throw new Error(`Unable to read OAuth deployment config directory: ${configDir}`);
  }

  const matches: OAuthDeploymentSelection[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const path = join(configDir, entry);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error(`OAuth deployment config is not valid JSON: ${path}`);
    }
    if (!isRecord(value) || value.type !== "MpasAdapterDeploymentConfig") continue;
    const target = isRecord(value.target) ? value.target : undefined;
    if (target?.applicationDid !== applicationDid) continue;
    const executionTarget = isRecord(value.executionTarget) ? value.executionTarget : undefined;
    if (executionTarget?.type !== "mcp.http" || typeof executionTarget.url !== "string") {
      throw new Error(`OAuth application must use an mcp.http execution target: ${applicationDid}`);
    }
    matches.push({ applicationDid, resourceUrl: executionTarget.url });
  }

  if (matches.length === 0) throw new Error(`Unknown OAuth application DID: ${applicationDid}`);
  if (matches.length > 1) throw new Error(`Multiple deployment configs target OAuth application DID: ${applicationDid}`);
  return matches[0];
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
