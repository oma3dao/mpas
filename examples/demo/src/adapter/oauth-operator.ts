import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { assertExactAuthorizationServerIssuer } from "./oauth-discovery.js";
import { createOAuthFetchPolicy } from "./oauth-fetch-policy.js";

export interface OAuthOperatorRequest {
  applicationDid: string;
  resourceUrl: string;
  session: string;
  scopes?: string[];
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
  session: string;
  scopes?: string[];
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
    const oauth = isRecord(executionTarget.auth) ? executionTarget.auth : undefined;
    if (oauth?.type !== "oauth2" || typeof oauth.session !== "string" || !isSessionName(oauth.session)) {
      throw new Error(`OAuth application must configure a valid executionTarget.auth.session: ${applicationDid}`);
    }
    const scopes = Array.isArray(oauth?.scopes) && oauth.scopes.every((scope) => typeof scope === "string")
      ? oauth.scopes as string[]
      : undefined;
    matches.push({ applicationDid, resourceUrl: executionTarget.url, session: oauth.session, ...(scopes ? { scopes } : {}) });
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

interface StoredOAuthSession {
  version: 1;
  session: string;
  applicationDid: string;
  resourceUrl: string;
  state: string;
  redirectUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  tokensSavedAt?: string;
}

export interface FileOAuthOperatorServiceOptions {
  sessionDir?: string;
  callbackTimeoutMs?: number;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  openBrowser?: (url: URL) => void | Promise<void>;
  testOnlyAllowHttpLoopback?: boolean;
}

export function fileOAuthOperatorService(options: FileOAuthOperatorServiceOptions = {}): OAuthOperatorService {
  const sessionDir = options.sessionDir ?? join(homedir(), ".mpas", "oauth-sessions");
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 300_000;

  return {
    async login(request) {
      const callback = await startCallbackServer(callbackTimeoutMs);
      const path = sessionPath(sessionDir, request.session);
      const previous = await readSession(path);
      const session: StoredOAuthSession = {
        version: 1,
        session: request.session,
        applicationDid: request.applicationDid,
        resourceUrl: request.resourceUrl,
        state: randomBytes(32).toString("base64url"),
        redirectUrl: callback.redirectUrl,
        ...(previous?.clientInformation ? { clientInformation: previous.clientInformation } : {}),
        ...(previous?.discovery ? { discovery: previous.discovery } : {}),
      };
      const provider = new FileOAuthClientProvider(session, path, request.openBrowser, options);
      const fetchFn = createOAuthFetchPolicy({
        bearerTokenResourceUrl: request.resourceUrl,
        testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback,
      });
      try {
        const start = await auth(provider, {
          serverUrl: request.resourceUrl,
          ...(request.scopes?.length ? { scope: request.scopes.join(" ") } : {}),
          fetchFn,
        });
        if (start !== "REDIRECT") throw new Error("OAuth login did not require operator authorization");
        const code = await callback.waitForCode(session.state);
        const completed = await auth(provider, {
          serverUrl: request.resourceUrl,
          authorizationCode: code,
          ...(request.scopes?.length ? { scope: request.scopes.join(" ") } : {}),
          fetchFn,
        });
        if (completed !== "AUTHORIZED") throw new Error("OAuth authorization did not complete");
        return authorizedResult(session);
      } finally {
        await callback.close();
      }
    },
    async status(request) {
      const session = await readSession(sessionPath(sessionDir, request.session));
      if (!session?.tokens) {
        return {
          status: "oauth_login_required",
          applicationDid: request.applicationDid,
          resourceUrl: request.resourceUrl,
          operatorCommand: oauthLoginCommand(request),
        };
      }
      return authorizedResult(session);
    },
    async logout(request) {
      const path = sessionPath(sessionDir, request.session);
      await rm(path, { force: true });
      return {
        status: "logged_out",
        applicationDid: request.applicationDid,
        localCredentialsDeleted: true,
        remoteRevocation: "unavailable",
      };
    },
  };
}

class FileOAuthClientProvider implements OAuthClientProvider {
  constructor(
    private readonly session: StoredOAuthSession,
    private readonly path: string,
    private readonly shouldOpenBrowser: boolean,
    private readonly options: FileOAuthOperatorServiceOptions,
  ) {}

  get redirectUrl(): string { return this.session.redirectUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "MPAS Credential Adapter",
      redirect_uris: [this.session.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state(): string { return this.session.state; }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.session.clientInformation; }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.session.clientInformation = value;
    await writeSession(this.path, this.session);
  }
  tokens(): OAuthTokens | undefined { return this.session.tokens; }
  async saveTokens(value: OAuthTokens): Promise<void> {
    this.session.tokens = value;
    this.session.tokensSavedAt = new Date().toISOString();
    delete this.session.codeVerifier;
    await writeSession(this.path, this.session);
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    await this.options.onAuthorizationUrl?.(url);
    if (this.shouldOpenBrowser) {
      if (this.options.openBrowser) await this.options.openBrowser(url);
      else await openUrl(url);
    }
  }
  async saveCodeVerifier(value: string): Promise<void> {
    this.session.codeVerifier = value;
    await writeSession(this.path, this.session);
  }
  codeVerifier(): string {
    if (!this.session.codeVerifier) throw new Error("OAuth PKCE verifier is unavailable");
    return this.session.codeVerifier;
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    assertExactAuthorizationServerIssuer(value);
    this.session.discovery = value;
    await writeSession(this.path, this.session);
  }
  discoveryState(): OAuthDiscoveryState | undefined { return this.session.discovery; }
}

export async function loadFileOAuthClientProvider(
  sessionName: string,
  applicationDid: string,
  resourceUrl: string,
  sessionDir = join(homedir(), ".mpas", "oauth-sessions"),
): Promise<OAuthClientProvider | undefined> {
  const path = sessionPath(sessionDir, sessionName);
  const session = await readSession(path);
  if (!session?.tokens || session.session !== sessionName || session.applicationDid !== applicationDid || session.resourceUrl !== resourceUrl) return undefined;
  return new FileOAuthClientProvider(session, path, false, {});
}

function authorizedResult(session: StoredOAuthSession): OAuthOperatorResult {
  const expiresIn = typeof session.tokens?.expires_in === "number" ? session.tokens.expires_in : undefined;
  const savedAt = session.tokensSavedAt ? Date.parse(session.tokensSavedAt) : NaN;
  const clientInformationRecord: Record<string, unknown> | undefined = isRecord(session.clientInformation)
    ? session.clientInformation as Record<string, unknown>
    : undefined;
  const clientScope = typeof clientInformationRecord?.scope === "string"
    ? clientInformationRecord.scope
    : "";
  const scope = typeof session.tokens?.scope === "string"
    ? session.tokens.scope
    : clientScope;
  return {
    status: "authorized",
    applicationDid: session.applicationDid,
    issuer: session.discovery?.authorizationServerUrl ?? "unknown",
    resource: session.resourceUrl,
    clientMode: session.clientInformation ? "dynamic" : "static",
    scopes: scope.split(/\s+/).filter(Boolean),
    ...(expiresIn && Number.isFinite(savedAt) ? { expiresAt: new Date(savedAt + expiresIn * 1000).toISOString() } : {}),
    refreshable: typeof session.tokens?.refresh_token === "string",
    reauthorizationRequired: false,
  };
}

async function startCallbackServer(timeoutMs: number): Promise<{
  redirectUrl: string;
  waitForCode(expectedState: string): Promise<string>;
  close(): Promise<void>;
}> {
  let settle: ((value: string) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const code = new Promise<string>((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") { response.writeHead(404).end(); return; }
    const callbackState = url.searchParams.get("state");
    const authorizationCode = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) { response.writeHead(400).end("OAuth authorization failed. You may close this window."); reject?.(new Error("OAuth authorization failed")); return; }
    if (!authorizationCode || !callbackState) { response.writeHead(400).end("Invalid OAuth callback."); reject?.(new Error("OAuth callback is missing code or state")); return; }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("OAuth authorization complete. You may close this window.");
    settle?.(`${callbackState}\n${authorizationCode}`);
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth callback server failed to bind");
  const timer = setTimeout(() => reject?.(new Error("OAuth callback timed out")), timeoutMs);
  return {
    redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
    async waitForCode(expectedState) {
      const [actualState, authorizationCode] = (await code).split("\n", 2);
      if (actualState !== expectedState) throw new Error("OAuth callback state mismatch");
      return authorizationCode;
    },
    close: () => new Promise<void>((resolve) => {
      clearTimeout(timer);
      server.close(() => resolve());
    }),
  };
}

function sessionPath(dir: string, session: string): string {
  if (!isSessionName(session)) throw new Error("OAuth session name must contain only letters, digits, dots, underscores, or hyphens");
  return join(dir, `${session}.json`);
}

function isSessionName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

async function readSession(path: string): Promise<StoredOAuthSession | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as StoredOAuthSession; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function writeSession(path: string, session: StoredOAuthSession): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(session)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function openUrl(url: URL): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url.toString()], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Unable to open OAuth authorization URL")));
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
