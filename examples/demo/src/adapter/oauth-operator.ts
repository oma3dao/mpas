import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  auth,
  discoverOAuthServerInfo,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { loadPlugin } from "@oma3/mpas/plugin-loader";
import { assertExactAuthorizationServerIssuer } from "./oauth-discovery.js";
import { createOAuthFetchPolicy } from "./oauth-fetch-policy.js";

export const DEFAULT_OAUTH_REFRESH_SCOPE = "offline_access";

export class OAuthReauthorizationRequiredError extends Error {
  readonly code = "OAUTH_REAUTHORIZATION_REQUIRED";
  readonly operatorCommand: string;

  constructor(operatorCommand: string, message?: string) {
    super(message ?? `OAuth reauthorization required. Run ${operatorCommand}.`);
    this.name = "OAuthReauthorizationRequiredError";
    this.operatorCommand = operatorCommand;
  }
}

export class OAuthScopeNotSupportedError extends Error {
  readonly code = "OAUTH_SCOPE_NOT_SUPPORTED";
  readonly requestedScope: string;
  readonly supportedScopes: string[];

  constructor(requestedScope: string, supportedScopes: string[]) {
    super(
      `Requested scope "${requestedScope}" is not supported; supported: ${formatSupportedScopes(supportedScopes)}.`,
    );
    this.name = "OAuthScopeNotSupportedError";
    this.requestedScope = requestedScope;
    this.supportedScopes = supportedScopes;
  }
}

export interface OAuthOperatorWarning {
  code: "OAUTH_REFRESH_TOKEN_NOT_ISSUED" | "OAUTH_REFRESH_SCOPE_NOT_ADVERTISED";
  message: string;
}

export interface OAuthOperatorRequest {
  applicationDid: string;
  resourceUrl: string;
  session: string;
  credentialHandle: string;
  scopes?: string[];
  refreshScope?: string;
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
      warnings?: OAuthOperatorWarning[];
    }
  | {
      status: "oauth_scope_not_supported";
      applicationDid: string;
      resourceUrl: string;
      requestedScope: string;
      supportedScopes: string[];
      message: string;
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
  credentialHandle: string;
  scopes?: string[];
  refreshScope: string;
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
    const bindings = Array.isArray(value.credentialBindings) ? value.credentialBindings : [];
    const binding = bindings.length === 1 && isRecord(bindings[0]) ? bindings[0] : undefined;
    if (typeof binding?.credentialHandle !== "string" || binding.provider !== "file") {
      throw new Error(`OAuth application must configure one file credential binding: ${applicationDid}`);
    }
    const pluginPath = isRecord(value.plugin) && typeof value.plugin.path === "string"
      ? value.plugin.path
      : undefined;
    matches.push({
      applicationDid,
      resourceUrl: executionTarget.url,
      session: oauth.session,
      credentialHandle: binding.credentialHandle,
      refreshScope: await refreshScopeFromPlugin(configDir, pluginPath),
      ...(scopes ? { scopes } : {}),
    });
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
  credentialHandle: string;
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
  credentialDir?: string;
  callbackTimeoutMs?: number;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  openBrowser?: (url: URL) => void | Promise<void>;
  testOnlyAllowHttpLoopback?: boolean;
  persistAuthorizationArtifacts?: boolean;
  stripInventedAdvertisedScope?: boolean;
  operatorCommand?: string;
}

export function fileOAuthOperatorService(options: FileOAuthOperatorServiceOptions = {}): OAuthOperatorService {
  const credentialDir = options.credentialDir ?? join(homedir(), ".mpas", "credentials");
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 300_000;

  return {
    async login(request) {
      const callback = await startCallbackServer(callbackTimeoutMs);
      try {
        const path = credentialPath(credentialDir, request.credentialHandle);
        const previous = await readSession(path);
        const session: StoredOAuthSession = {
          version: 1,
          session: request.session,
          credentialHandle: request.credentialHandle,
          applicationDid: request.applicationDid,
          resourceUrl: request.resourceUrl,
          state: randomBytes(32).toString("base64url"),
          redirectUrl: callback.redirectUrl,
          ...(previous?.clientInformation ? { clientInformation: previous.clientInformation } : {}),
          ...(previous?.discovery ? { discovery: previous.discovery } : {}),
        };
        const fetchFn = createOAuthFetchPolicy({
          bearerTokenResourceUrl: request.resourceUrl,
          testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback,
        });
        const supportedScopes = await discoverSupportedScopes(request.resourceUrl, fetchFn);
        const resolved = resolveRequestedOAuthScopes({
          configuredScopes: request.scopes,
          refreshScope: request.refreshScope,
          supportedScopes,
        });
        if (!resolved.ok) {
          return {
            status: "oauth_scope_not_supported",
            applicationDid: request.applicationDid,
            resourceUrl: request.resourceUrl,
            requestedScope: resolved.requestedScope,
            supportedScopes: resolved.supportedScopes,
            message: resolved.message,
          };
        }
        const provider = new FileOAuthClientProvider(session, path, request.openBrowser, {
          ...options,
          stripInventedAdvertisedScope: resolved.scopes.length === 0,
          operatorCommand: oauthLoginCommand(request),
        });
        const scopeOption = resolved.scopes.length > 0 ? { scope: resolved.scopes.join(" ") } : {};
        const start = await auth(provider, {
          serverUrl: request.resourceUrl,
          ...scopeOption,
          fetchFn,
        });
        if (start !== "REDIRECT") throw new Error("OAuth login did not require operator authorization");
        const code = await callback.waitForCode(session.state);
        const completed = await auth(provider, {
          serverUrl: request.resourceUrl,
          authorizationCode: code,
          ...scopeOption,
          fetchFn,
        });
        if (completed !== "AUTHORIZED") throw new Error("OAuth authorization did not complete");
        return authorizedResult(session, resolved.warnings);
      } finally {
        await callback.close();
      }
    },
    async status(request) {
      const session = await readSession(credentialPath(credentialDir, request.credentialHandle));
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
      const path = credentialPath(credentialDir, request.credentialHandle);
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
    const authorizationUrl = this.options.stripInventedAdvertisedScope
      ? stripInventedAdvertisedScope(url, this.session.discovery)
      : url;
    if (!this.shouldOpenBrowser && !this.options.onAuthorizationUrl) {
      throw new OAuthReauthorizationRequiredError(
        this.options.operatorCommand ?? "mpas oauth login",
        `OAuth reauthorization required. The Credential Adapter cannot start a browser during dispatch. Run ${this.options.operatorCommand ?? "mpas oauth login"}.`,
      );
    }
    await this.options.onAuthorizationUrl?.(authorizationUrl);
    if (this.shouldOpenBrowser) {
      if (this.options.openBrowser) await this.options.openBrowser(authorizationUrl);
      else await openUrl(authorizationUrl);
    }
  }
  async saveCodeVerifier(value: string): Promise<void> {
    this.session.codeVerifier = value;
    if (this.options.persistAuthorizationArtifacts === false) return;
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
  credentialHandle: string,
  applicationDid: string,
  resourceUrl: string,
  credentialDir = join(homedir(), ".mpas", "credentials"),
): Promise<OAuthClientProvider | undefined> {
  const loaded = await readBoundOAuthSession(sessionName, credentialHandle, applicationDid, resourceUrl, credentialDir);
  if (!loaded) return undefined;
  return new FileOAuthClientProvider(loaded.session, loaded.path, false, {
    persistAuthorizationArtifacts: false,
    operatorCommand: oauthLoginCommand({ applicationDid, resourceUrl, session: sessionName, credentialHandle }),
  });
}

export async function prepareOAuthForDispatch(
  sessionName: string,
  credentialHandle: string,
  applicationDid: string,
  resourceUrl: string,
  credentialDir = join(homedir(), ".mpas", "credentials"),
): Promise<
  | { ok: true; provider: OAuthClientProvider }
  | { ok: false; error: { code: "OAUTH_REAUTHORIZATION_REQUIRED" | "OAUTH_AUTHENTICATION_FAILED" | "OAUTH_INVALID_GRANT" | "TARGET_UNAVAILABLE"; message: string } }
> {
  const operatorCommand = oauthLoginCommand({ applicationDid, resourceUrl, session: sessionName, credentialHandle });
  const loaded = await readBoundOAuthSession(sessionName, credentialHandle, applicationDid, resourceUrl, credentialDir);
  if (!loaded) {
    return {
      ok: false,
      error: {
        code: "OAUTH_REAUTHORIZATION_REQUIRED",
        message: `OAuth login required. Run ${operatorCommand}.`,
      },
    };
  }
  const provider = new FileOAuthClientProvider(loaded.session, loaded.path, false, {
    persistAuthorizationArtifacts: false,
    operatorCommand,
    testOnlyAllowHttpLoopback: isLoopbackUrl(resourceUrl),
  });
  if (isAccessTokenExpired(loaded.session.tokens, loaded.session.tokensSavedAt)) {
    if (typeof loaded.session.tokens?.refresh_token !== "string") {
      return {
        ok: false,
        error: {
          code: "OAUTH_REAUTHORIZATION_REQUIRED",
          message: `OAuth access token is expired and no refresh_token is stored. Run ${operatorCommand}.`,
        },
      };
    }
    try {
      const fetchFn = createOAuthFetchPolicy({
        bearerTokenResourceUrl: resourceUrl,
        testOnlyAllowHttpLoopback: isLoopbackUrl(resourceUrl),
      });
      const result = await auth(provider, { serverUrl: resourceUrl, fetchFn });
      if (result !== "AUTHORIZED") {
        return {
          ok: false,
          error: {
            code: "OAUTH_REAUTHORIZATION_REQUIRED",
            message: `OAuth reauthorization required. Run ${operatorCommand}.`,
          },
        };
      }
    } catch (error) {
      return { ok: false, error: classifyOAuthPrepareError(error, operatorCommand) };
    }
  }
  return { ok: true, provider };
}

export function classifyOAuthPrepareError(
  error: unknown,
  operatorCommand: string,
): { code: "OAUTH_REAUTHORIZATION_REQUIRED" | "OAUTH_AUTHENTICATION_FAILED" | "OAUTH_INVALID_GRANT" | "TARGET_UNAVAILABLE"; message: string } {
  if (error instanceof OAuthReauthorizationRequiredError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof InvalidGrantError || isInvalidGrantError(error)) {
    return {
      code: "OAUTH_INVALID_GRANT",
      message: `OAuth refresh grant is invalid or revoked. Run ${operatorCommand}.`,
    };
  }
  if (error instanceof UnauthorizedError || isUnauthorizedError(error) || isPostRefreshAuthenticationFailure(error)) {
    return {
      code: "OAUTH_AUTHENTICATION_FAILED",
      message: `OAuth authentication failed after a reachable target rejected the credentials. Run ${operatorCommand}.`,
    };
  }
  return {
    code: "TARGET_UNAVAILABLE",
    message: `MCP HTTP target could not be connected and initialized: ${error instanceof Error ? error.message : String(error)}`,
  };
}

export function resolveRequestedOAuthScopes(input: {
  configuredScopes?: string[];
  refreshScope?: string;
  supportedScopes: string[];
}):
  | { ok: true; scopes: string[]; warnings: OAuthOperatorWarning[] }
  | { ok: false; requestedScope: string; supportedScopes: string[]; message: string } {
  const refreshScope = input.refreshScope?.trim() || DEFAULT_OAUTH_REFRESH_SCOPE;
  const supported = input.supportedScopes;
  const configured = input.configuredScopes ?? [];
  for (const scope of configured) {
    if (!supported.includes(scope)) {
      const error = new OAuthScopeNotSupportedError(scope, supported);
      return {
        ok: false,
        requestedScope: error.requestedScope,
        supportedScopes: error.supportedScopes,
        message: error.message,
      };
    }
  }
  const warnings: OAuthOperatorWarning[] = [];
  const scopes = [...configured];
  const selectedRefreshScope = selectRefreshScope(refreshScope, supported);
  if (!selectedRefreshScope.ok) {
    return {
      ok: false,
      requestedScope: selectedRefreshScope.requestedScope,
      supportedScopes: selectedRefreshScope.supportedScopes,
      message: selectedRefreshScope.message,
    };
  }
  if (selectedRefreshScope.warning) warnings.push(selectedRefreshScope.warning);
  if (!scopes.includes(selectedRefreshScope.scope)) scopes.push(selectedRefreshScope.scope);
  return { ok: true, scopes, warnings };
}

function selectRefreshScope(
  preferred: string,
  supported: string[],
):
  | { ok: true; scope: string; warning?: OAuthOperatorWarning }
  | { ok: false; requestedScope: string; supportedScopes: string[]; message: string } {
  if (supported.includes(preferred)) return { ok: true, scope: preferred };
  if (preferred !== DEFAULT_OAUTH_REFRESH_SCOPE && supported.includes(DEFAULT_OAUTH_REFRESH_SCOPE)) {
    return {
      ok: true,
      scope: DEFAULT_OAUTH_REFRESH_SCOPE,
      warning: {
        code: "OAUTH_REFRESH_SCOPE_NOT_ADVERTISED",
        message: `Plugin refresh scope "${preferred}" is not advertised; using ${DEFAULT_OAUTH_REFRESH_SCOPE}. Supported: ${formatSupportedScopes(supported)}.`,
      },
    };
  }
  const error = new OAuthScopeNotSupportedError(preferred, supported);
  return {
    ok: false,
    requestedScope: error.requestedScope,
    supportedScopes: error.supportedScopes,
    message: `Refresh scope "${preferred}" is not advertised by the authorization server and ${DEFAULT_OAUTH_REFRESH_SCOPE} is not available. Supported: ${formatSupportedScopes(supported)}.`,
  };
}

export function isAccessTokenExpired(
  tokens: OAuthTokens | undefined,
  tokensSavedAt: string | undefined,
  now = Date.now(),
): boolean {
  const expiresIn = typeof tokens?.expires_in === "number" ? tokens.expires_in : undefined;
  const savedAt = tokensSavedAt ? Date.parse(tokensSavedAt) : NaN;
  if (expiresIn === undefined || !Number.isFinite(savedAt)) return false;
  return savedAt + expiresIn * 1000 <= now;
}

function authorizedResult(session: StoredOAuthSession, extraWarnings: OAuthOperatorWarning[] = []): OAuthOperatorResult {
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
  const warnings = [...extraWarnings, ...postLoginWarnings(session)];
  return {
    status: "authorized",
    applicationDid: session.applicationDid,
    issuer: session.discovery?.authorizationServerUrl ?? "unknown",
    resource: session.resourceUrl,
    clientMode: session.clientInformation ? "dynamic" : "static",
    scopes: scope.split(/\s+/).filter(Boolean),
    ...(expiresIn && Number.isFinite(savedAt) ? { expiresAt: new Date(savedAt + expiresIn * 1000).toISOString() } : {}),
    refreshable: typeof session.tokens?.refresh_token === "string",
    reauthorizationRequired: isAccessTokenExpired(session.tokens, session.tokensSavedAt)
      && typeof session.tokens?.refresh_token !== "string",
    ...(warnings.length ? { warnings } : {}),
  };
}

function postLoginWarnings(session: StoredOAuthSession): OAuthOperatorWarning[] {
  if (typeof session.tokens?.refresh_token === "string") return [];
  return [{
    code: "OAUTH_REFRESH_TOKEN_NOT_ISSUED",
    message: "OAuth login succeeded but the authorization server did not issue a refresh_token. Unattended refresh is unavailable; deploys will fail when the access token expires. Re-run mpas oauth login after confirming the refresh scope is granted.",
  }];
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

function credentialPath(dir: string, credentialHandle: string): string {
  if (!isSessionName(credentialHandle)) throw new Error("OAuth credential handle must contain only letters, digits, dots, underscores, or hyphens");
  return join(dir, `${credentialHandle}.json`);
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
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(session)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
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

async function readBoundOAuthSession(
  sessionName: string,
  credentialHandle: string,
  applicationDid: string,
  resourceUrl: string,
  credentialDir: string,
): Promise<{ session: StoredOAuthSession; path: string } | undefined> {
  const path = credentialPath(credentialDir, credentialHandle);
  const session = await readSession(path);
  if (!session?.tokens || session.session !== sessionName || session.credentialHandle !== credentialHandle || session.applicationDid !== applicationDid || session.resourceUrl !== resourceUrl) {
    return undefined;
  }
  return { session, path };
}

async function refreshScopeFromPlugin(configDir: string, pluginPath: string | undefined): Promise<string> {
  if (!pluginPath) return DEFAULT_OAUTH_REFRESH_SCOPE;
  const loaded = await loadPlugin(resolve(configDir, pluginPath));
  if (!loaded.ok) return DEFAULT_OAUTH_REFRESH_SCOPE;
  const declared = loaded.plugin.credentialRequirements
    ?.map((requirement) => requirement.refreshScope)
    .find((scope) => typeof scope === "string" && scope.trim().length > 0);
  return declared?.trim() || DEFAULT_OAUTH_REFRESH_SCOPE;
}

async function discoverSupportedScopes(
  resourceUrl: string,
  fetchFn: ReturnType<typeof createOAuthFetchPolicy>,
): Promise<string[]> {
  const info = await discoverOAuthServerInfo(resourceUrl, { fetchFn });
  return uniqueScopes(
    info.resourceMetadata?.scopes_supported,
    info.authorizationServerMetadata?.scopes_supported,
  );
}

function uniqueScopes(...lists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const scope of list ?? []) {
      if (typeof scope === "string" && scope.length > 0) seen.add(scope);
    }
  }
  return [...seen];
}

function stripInventedAdvertisedScope(url: URL, discovery: OAuthDiscoveryState | undefined): URL {
  const advertised = discovery?.resourceMetadata?.scopes_supported;
  if (!Array.isArray(advertised) || url.searchParams.get("scope") !== advertised.join(" ")) return url;
  const stripped = new URL(url);
  stripped.searchParams.delete("scope");
  return stripped;
}

function formatSupportedScopes(supportedScopes: string[]): string {
  return supportedScopes.length > 0 ? supportedScopes.join(", ") : "(none advertised)";
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function isInvalidGrantError(error: unknown): boolean {
  return error instanceof Error && (error.name === "InvalidGrantError" || /invalid_grant/i.test(error.message));
}

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && (error.name === "UnauthorizedError" || /unauthorized/i.test(error.message));
}

function isPostRefreshAuthenticationFailure(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) return error.code === 401 || error.code === 403;
  if (!isRecord(error)) return false;
  return (error.name === "StreamableHTTPError" || error.name === "Error")
    && (error.code === 401 || error.code === 403);
}
