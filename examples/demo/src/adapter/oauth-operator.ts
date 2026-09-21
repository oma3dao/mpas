import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadPlugin } from "@oma3/mpas/plugin-loader";
import { assertExactAuthorizationServerIssuer } from "./oauth-discovery.js";
import { createDeadline } from "./hardened-fetch.js";
import { createOAuthFetchPolicy, DEFAULT_OAUTH_CALL_BUDGET_MS } from "./oauth-fetch-policy.js";

export const DEFAULT_OAUTH_REFRESH_SCOPE = "offline_access";
export const DEFAULT_OAUTH_REFRESH_SAFETY_WINDOW_MS = 60_000;
export const DEFAULT_OAUTH_REFRESH_JITTER_MAX_MS = 30_000;
const MAX_OAUTH_REFRESH_SAFETY_WINDOW_MS = 300_000;
const MAX_OAUTH_REFRESH_JITTER_MS = 60_000;

export type OAuthClientMode = "static" | "cimd" | "dynamic";

export type OAuthClientConfiguration =
  | {
      type: "auto";
      clientId?: string;
      clientSecret?: string;
      clientIdMetadataDocument?: string;
    }
  | {
      type: "static";
      clientId: string;
      clientSecret?: string;
    }
  | {
      type: "cimd";
      clientIdMetadataDocument: string;
    }
  | {
      type: "dynamic";
    };

export interface OAuthSharingPolicy {
  applicationDids: string[];
  operatorPrincipals: string[];
}

export interface OAuthRefreshPolicy {
  safetyWindowMs: number;
  jitterMaxMs: number;
}

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
  issuer?: string;
  client?: OAuthClientConfiguration;
  owner?: string;
  sharing?: Partial<OAuthSharingPolicy>;
  refresh?: Partial<OAuthRefreshPolicy>;
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
  issuer?: string;
  client: OAuthClientConfiguration;
  owner?: string;
  sharing?: Partial<OAuthSharingPolicy>;
  refresh: OAuthRefreshPolicy;
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
    const client = parseOAuthClientConfiguration(oauth?.client);
    const sharing = parseSharingPolicy(oauth?.sharing);
    const refresh = parseRefreshPolicy(oauth?.refresh);
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
      client,
      refresh,
      ...(typeof oauth.issuer === "string" ? { issuer: oauth.issuer } : {}),
      ...(typeof oauth.owner === "string" ? { owner: oauth.owner } : {}),
      ...(sharing ? { sharing } : {}),
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

interface OAuthAuthorizationBinding {
  applicationDid: string;
  resourceUrl: string;
  issuer: string;
  authorizationResponseIssuerRequired: boolean;
  clientMode: OAuthClientMode;
  clientId: string;
  clientConfiguration: string;
  scopeConfiguration: string;
  requestedScopes: string[];
  redirectUrl: string;
}

interface OAuthAuthorizationAttempt {
  state: string;
  redirectUrl: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

interface StoredOAuthSession {
  version: 1 | 2;
  session: string;
  credentialHandle: string;
  applicationDid: string;
  resourceUrl: string;
  state?: string;
  redirectUrl?: string;
  owner?: string;
  sharing?: OAuthSharingPolicy;
  binding?: OAuthAuthorizationBinding;
  authorization?: OAuthAuthorizationAttempt;
  reauthorizationRequired?: boolean;
  reauthorizationReason?: "binding_mismatch" | "invalid_grant" | "grant_unusable";
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  tokensSavedAt?: string;
  refreshJitterMs?: number;
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
  operatorPrincipal?: string;
  auditPath?: string;
  fetch?: FetchLike;
  resolveStaticClientSecret?: (credentialHandle: string) => Promise<string>;
}

export function fileOAuthOperatorService(options: FileOAuthOperatorServiceOptions = {}): OAuthOperatorService {
  const credentialDir = options.credentialDir ?? join(homedir(), ".mpas", "credentials");
  const callbackTimeoutMs = Math.min(options.callbackTimeoutMs ?? 300_000, 600_000);
  const operatorPrincipal = options.operatorPrincipal ?? localOperatorPrincipal();
  const auditPath = options.auditPath ?? join(credentialDir, "oauth-audit.jsonl");

  return {
    async login(request) {
      const callback = await startCallbackServer(callbackTimeoutMs);
      let session: StoredOAuthSession | undefined;
      try {
        const path = credentialPath(credentialDir, request.credentialHandle);
        const previous = await readSession(path);
        const owner = request.owner ?? operatorPrincipal;
        if (owner !== operatorPrincipal) {
          throw new Error("OAuth login is restricted to the configured session owner");
        }
        const sharing = normalizeSharingPolicy(request, owner);
        assertOperatorAccess(operatorPrincipal, request.applicationDid, owner, sharing);
        const client = request.client ?? { type: "auto" };
        const clientConfiguration = canonicalClientConfiguration(client);
        const state = randomBytes(32).toString("base64url");
        const createdAt = new Date();
        session = {
          version: 2,
          session: request.session,
          credentialHandle: request.credentialHandle,
          applicationDid: request.applicationDid,
          resourceUrl: request.resourceUrl,
          state,
          redirectUrl: callback.redirectUrl,
          owner,
          sharing,
          authorization: {
            state,
            redirectUrl: callback.redirectUrl,
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + callbackTimeoutMs).toISOString(),
          },
          ...(canReuseClientRegistration(previous, request, clientConfiguration)
            ? { clientInformation: previous?.clientInformation }
            : {}),
        };
        let authorizationResponseIssuerRequired = false;
        const policyFetch = createOAuthFetchPolicy({
          bearerTokenResourceUrl: request.resourceUrl,
          testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback,
          fetch: options.fetch,
        });
        const fetchFn = observeAuthorizationMetadata(policyFetch, (required) => {
          authorizationResponseIssuerRequired ||= required;
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
        const staticClientInformation = await resolveStaticClientInformation(client, options.resolveStaticClientSecret);
        if (staticClientInformation) session.clientInformation = staticClientInformation;
        await writeSession(path, session);
        const provider = new FileOAuthClientProvider(session, path, request.openBrowser, {
          ...options,
          stripInventedAdvertisedScope: resolved.scopes.length === 0,
          operatorCommand: oauthLoginCommand(request),
        }, {
          client,
          clientConfiguration,
          requestedScopes: canonicalScopes(resolved.scopes),
          scopeConfiguration: canonicalScopeConfiguration(request.scopes, request.refreshScope),
          authorizationResponseIssuerRequired: () => authorizationResponseIssuerRequired,
          expectedIssuer: request.issuer,
          refreshPolicy: normalizeRefreshPolicy(request.refresh),
          callback,
          fetchFn,
        });
        const scopeOption = resolved.scopes.length > 0 ? { scope: resolved.scopes.join(" ") } : {};
        const start = await auth(provider, {
          serverUrl: request.resourceUrl,
          ...scopeOption,
          fetchFn,
        });
        if (start !== "REDIRECT") throw new Error("OAuth login did not require operator authorization");
        const code = await callback.waitForCode();
        const completed = await auth(provider, {
          serverUrl: request.resourceUrl,
          authorizationCode: code,
          ...scopeOption,
          fetchFn,
        });
        if (completed !== "AUTHORIZED") throw new Error("OAuth authorization did not complete");
        session.reauthorizationRequired = false;
        delete session.reauthorizationReason;
        await writeSession(path, session);
        await appendOAuthAudit(auditPath, session, operatorPrincipal, "login", "succeeded");
        return authorizedResult(session, resolved.warnings);
      } catch (error) {
        if (session) await appendOAuthAudit(auditPath, session, operatorPrincipal, "login", "failed");
        throw error;
      } finally {
        await callback.close();
      }
    },
    async status(request) {
      const path = credentialPath(credentialDir, request.credentialHandle);
      const session = await readSecureSession(path);
      if (!session?.tokens) {
        return {
          status: "oauth_login_required",
          applicationDid: request.applicationDid,
          resourceUrl: request.resourceUrl,
          operatorCommand: oauthLoginCommand(request),
        };
      }
      if (!session.owner || !session.sharing) throw new Error("OAuth session owner policy is missing");
      const owner = session.owner;
      const sharing = session.sharing;
      assertOperatorAccess(operatorPrincipal, request.applicationDid, owner, sharing);
      if (!sessionMatchesRequest(session, request)) {
        await markReauthorizationRequired(session, path, auditPath, "binding_mismatch");
      }
      return authorizedResult(session);
    },
    async logout(request) {
      const path = credentialPath(credentialDir, request.credentialHandle);
      const session = await readSecureSession(path);
      let remoteRevocation: "succeeded" | "unavailable" | "failed" = "unavailable";
      if (session) {
        if (!session.owner || !session.sharing) throw new Error("OAuth session owner policy is missing");
        const owner = session.owner;
        const sharing = session.sharing;
        assertOperatorAccess(operatorPrincipal, request.applicationDid, owner, sharing);
        if (!sessionMatchesRequest(session, request)) {
          const operatorCommand = oauthLoginCommand(request);
          throw new OAuthReauthorizationRequiredError(
            operatorCommand,
            `OAuth session binding changed. Run ${operatorCommand}.`,
          );
        }
        remoteRevocation = await revokeAdvertisedTokens(session, {
          fetch: options.fetch,
          testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback,
        });
        await appendOAuthAudit(auditPath, session, operatorPrincipal, "revocation", remoteRevocation);
      }
      await rm(path, { force: true });
      if (session) await appendOAuthAudit(auditPath, session, operatorPrincipal, "logout", "succeeded");
      return {
        status: "logged_out",
        applicationDid: request.applicationDid,
        localCredentialsDeleted: true,
        remoteRevocation,
      };
    },
  };
}

interface FileOAuthClientRuntime {
  client: OAuthClientConfiguration;
  clientConfiguration: string;
  requestedScopes: string[];
  scopeConfiguration: string;
  authorizationResponseIssuerRequired?: () => boolean;
  expectedIssuer?: string;
  refreshPolicy: OAuthRefreshPolicy;
  callback?: OAuthCallbackServer;
  fetchFn?: FetchLike;
}

class FileOAuthClientProvider implements OAuthClientProvider {
  constructor(
    private readonly session: StoredOAuthSession,
    private readonly path: string,
    private readonly shouldOpenBrowser: boolean,
    private readonly options: FileOAuthOperatorServiceOptions,
    private readonly runtime?: FileOAuthClientRuntime,
  ) {}

  get redirectUrl(): string | undefined {
    return this.session.authorization?.redirectUrl ?? this.session.redirectUrl ?? this.session.binding?.redirectUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    const redirectUrl = this.redirectUrl;
    return {
      client_name: "MPAS Credential Adapter",
      redirect_uris: redirectUrl ? [redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: redirectUrl && isLoopbackUrl(redirectUrl) ? "native" : "web",
    } as OAuthClientMetadata;
  }
  state(): string {
    const state = this.session.authorization?.state ?? this.session.state;
    if (!state) throw new Error("OAuth authorization state is unavailable");
    return state;
  }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.session.clientInformation; }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    const pendingDynamic = this.session.binding?.clientMode === "dynamic" &&
      this.session.binding.clientId === "dynamic-registration-pending";
    if (this.session.binding && !pendingDynamic && value.client_id !== this.session.binding.clientId) {
      throw new Error("OAuth client registration changed after the authorization tuple was selected");
    }
    this.session.clientInformation = value;
    if (this.session.binding) this.session.binding.clientId = value.client_id;
    await writeSession(this.path, this.session);
  }
  tokens(): OAuthTokens | undefined { return this.session.tokens; }
  async saveTokens(value: OAuthTokens): Promise<void> {
    const previousRefreshToken = this.session.tokens?.refresh_token;
    this.session.tokens = previousRefreshToken && typeof value.refresh_token !== "string"
      ? { ...value, refresh_token: previousRefreshToken }
      : value;
    this.session.tokensSavedAt = new Date().toISOString();
    this.session.refreshJitterMs = boundedJitter(this.runtime?.refreshPolicy.jitterMaxMs ?? 0);
    this.session.reauthorizationRequired = false;
    delete this.session.reauthorizationReason;
    delete this.session.codeVerifier;
    delete this.session.authorization;
    delete this.session.state;
    delete this.session.redirectUrl;
    await writeSession(this.path, this.session);
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    const authorizationUrl = this.options.stripInventedAdvertisedScope
      ? stripInventedAdvertisedScope(url, this.session.discovery)
      : url;
    const authorization = this.session.authorization;
    const binding = this.session.binding;
    if (!authorization || !binding) {
      throw new Error("OAuth authorization tuple is incomplete");
    }
    this.runtime?.callback?.bind({
      state: authorization.state,
      redirectUrl: authorization.redirectUrl,
      issuer: binding.issuer,
      issuerRequired: binding.authorizationResponseIssuerRequired,
      expiresAt: authorization.expiresAt,
      onConsume: async () => {
        if (!this.session.authorization || this.session.authorization.consumedAt) {
          throw new Error("OAuth authorization session is no longer outstanding");
        }
        this.session.authorization.consumedAt = new Date().toISOString();
        await writeSession(this.path, this.session);
      },
    });
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
    if (this.runtime?.expectedIssuer && value.authorizationServerUrl !== this.runtime.expectedIssuer) {
      throw new Error("OAuth discovered issuer does not match the operator-pinned issuer");
    }
    this.session.discovery = value;
    if (this.runtime) {
      const selected = selectClientMode(this.runtime.client, value, this.session.clientInformation);
      if (selected.mode === "cimd") {
        await validateClientMetadataDocument(
          selected.clientId,
          this.redirectUrl,
          true,
          this.runtime.fetchFn,
        );
        this.session.clientInformation = { client_id: selected.clientId };
      }
      this.session.binding = {
        applicationDid: this.session.applicationDid,
        resourceUrl: canonicalResourceUrl(this.session.resourceUrl),
        issuer: value.authorizationServerUrl,
        authorizationResponseIssuerRequired: this.runtime.authorizationResponseIssuerRequired?.() ?? false,
        clientMode: selected.mode,
        clientId: selected.clientId,
        clientConfiguration: this.runtime.clientConfiguration,
        scopeConfiguration: this.runtime.scopeConfiguration,
        requestedScopes: this.runtime.requestedScopes,
        redirectUrl: this.redirectUrl ?? "",
      };
    }
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

export interface OAuthPrepareOptions {
  scopes?: string[];
  refreshScope?: string;
  issuer?: string;
  client?: OAuthClientConfiguration;
  owner?: string;
  sharing?: Partial<OAuthSharingPolicy>;
  refresh?: Partial<OAuthRefreshPolicy>;
  auditPath?: string;
}

const refreshTransactions = new Map<string, Promise<void>>();

export async function prepareOAuthForDispatch(
  sessionName: string,
  credentialHandle: string,
  applicationDid: string,
  resourceUrl: string,
  credentialDir = join(homedir(), ".mpas", "credentials"),
  expected: OAuthPrepareOptions = {},
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
  if (loaded.session.reauthorizationRequired) {
    return {
      ok: false,
      error: {
        code: "OAUTH_REAUTHORIZATION_REQUIRED",
        message: `OAuth reauthorization required. Run ${operatorCommand}.`,
      },
    };
  }
  if (!sessionMatchesExpectation(loaded.session, expected)) {
    await markReauthorizationRequired(
      loaded.session,
      loaded.path,
      expected.auditPath ?? join(credentialDir, "oauth-audit.jsonl"),
      "binding_mismatch",
    );
    return {
      ok: false,
      error: {
        code: "OAUTH_REAUTHORIZATION_REQUIRED",
        message: `OAuth session binding changed. Run ${operatorCommand}.`,
      },
    };
  }
  const refreshPolicy = normalizeRefreshPolicy(expected.refresh);
  if (shouldRefreshAccessToken(loaded.session, refreshPolicy)) {
    if (typeof loaded.session.tokens?.refresh_token !== "string") {
      await markReauthorizationRequired(
        loaded.session,
        loaded.path,
        expected.auditPath ?? join(credentialDir, "oauth-audit.jsonl"),
        "grant_unusable",
      );
      return {
        ok: false,
        error: {
          code: "OAUTH_REAUTHORIZATION_REQUIRED",
          message: `OAuth access token is expired or near expiry and no refresh_token is stored. Run ${operatorCommand}.`,
        },
      };
    }
    let transaction = refreshTransactions.get(loaded.path);
    if (!transaction) {
      transaction = refreshOAuthSession(
        loaded.path,
        sessionName,
        credentialHandle,
        applicationDid,
        resourceUrl,
        credentialDir,
        expected,
        operatorCommand,
      );
      refreshTransactions.set(loaded.path, transaction);
      void transaction.finally(() => {
        if (refreshTransactions.get(loaded.path) === transaction) refreshTransactions.delete(loaded.path);
      }).catch(() => {});
    }
    try {
      await transaction;
    } catch (error) {
      return { ok: false, error: classifyOAuthPrepareError(error, operatorCommand) };
    }
  }
  const refreshed = await readBoundOAuthSession(sessionName, credentialHandle, applicationDid, resourceUrl, credentialDir);
  if (!refreshed || refreshed.session.reauthorizationRequired) {
    return {
      ok: false,
      error: {
        code: "OAUTH_REAUTHORIZATION_REQUIRED",
        message: `OAuth reauthorization required. Run ${operatorCommand}.`,
      },
    };
  }
  const provider = new FileOAuthClientProvider(refreshed.session, refreshed.path, false, {
    persistAuthorizationArtifacts: false,
    operatorCommand,
    testOnlyAllowHttpLoopback: isLoopbackUrl(resourceUrl),
  });
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

export function isAccessTokenRefreshDue(
  tokens: OAuthTokens | undefined,
  tokensSavedAt: string | undefined,
  now = Date.now(),
  safetyWindowMs = DEFAULT_OAUTH_REFRESH_SAFETY_WINDOW_MS,
  jitterMs = 0,
): boolean {
  const expiresIn = typeof tokens?.expires_in === "number" ? tokens.expires_in : undefined;
  const savedAt = tokensSavedAt ? Date.parse(tokensSavedAt) : NaN;
  if (expiresIn === undefined || !Number.isFinite(savedAt)) return false;
  const boundedSafety = Math.min(Math.max(safetyWindowMs, 0), MAX_OAUTH_REFRESH_SAFETY_WINDOW_MS);
  const boundedJitterMs = Math.min(Math.max(jitterMs, 0), MAX_OAUTH_REFRESH_JITTER_MS);
  return savedAt + expiresIn * 1000 - boundedSafety - boundedJitterMs <= now;
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
    issuer: session.binding?.issuer ?? session.discovery?.authorizationServerUrl ?? "unknown",
    resource: session.resourceUrl,
    clientMode: session.binding?.clientMode ?? (session.clientInformation ? "dynamic" : "static"),
    scopes: uniqueScopes(session.binding?.requestedScopes, scope.split(/\s+/).filter(Boolean)),
    ...(expiresIn && Number.isFinite(savedAt) ? { expiresAt: new Date(savedAt + expiresIn * 1000).toISOString() } : {}),
    refreshable: typeof session.tokens?.refresh_token === "string",
    reauthorizationRequired: session.reauthorizationRequired === true || (
      isAccessTokenExpired(session.tokens, session.tokensSavedAt)
        && typeof session.tokens?.refresh_token !== "string"
    ),
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

interface OAuthCallbackExpectation {
  state: string;
  redirectUrl: string;
  issuer: string;
  issuerRequired: boolean;
  expiresAt: string;
  onConsume(): Promise<void>;
}

interface OAuthCallbackServer {
  redirectUrl: string;
  bind(expectation: OAuthCallbackExpectation): void;
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export function validateOAuthCallbackParameters(
  callbackUrl: URL,
  expected: Pick<OAuthCallbackExpectation, "state" | "redirectUrl" | "issuer" | "issuerRequired" | "expiresAt">,
  now = Date.now(),
): void {
  const redirect = new URL(expected.redirectUrl);
  if (callbackUrl.origin !== redirect.origin || callbackUrl.pathname !== redirect.pathname) {
    throw new Error("OAuth callback redirect URI mismatch");
  }
  if (callbackUrl.searchParams.get("state") !== expected.state) {
    throw new Error("OAuth callback state mismatch");
  }
  if (Date.parse(expected.expiresAt) <= now) {
    throw new Error("OAuth authorization session expired");
  }
  const issuer = callbackUrl.searchParams.get("iss");
  if ((expected.issuerRequired && !issuer) || (issuer !== null && issuer !== expected.issuer)) {
    throw new Error("OAuth callback issuer mismatch");
  }
}

async function startCallbackServer(timeoutMs: number): Promise<OAuthCallbackServer> {
  let settle: ((value: string) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let expectation: OAuthCallbackExpectation | undefined;
  let consuming = false;
  const code = new Promise<string>((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise; });
  // The callback may reject while redirectToAuthorization is still awaiting its
  // HTTP response. Attach a handler immediately so Node does not report a
  // transient unhandled rejection before login awaits waitForCode().
  void code.catch(() => {});
  const server = createServer(async (request, response) => {
    const host = request.headers.host ?? "invalid";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== "/oauth/callback") { response.writeHead(404).end(); return; }
    if (!expectation || consuming) {
      response.writeHead(409).end("OAuth authorization failed. You may close this window.");
      return;
    }
    try {
      validateOAuthCallbackParameters(url, expectation);
      consuming = true;
      await expectation.onConsume();
      if (url.searchParams.has("error")) throw new Error("OAuth authorization failed");
      const authorizationCode = url.searchParams.get("code");
      if (!authorizationCode) throw new Error("OAuth callback is missing an authorization code");
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end("OAuth authorization complete. You may close this window.");
      settle?.(authorizationCode);
    } catch (error) {
      consuming = true;
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        .end("OAuth authorization failed. You may close this window.");
      reject?.(error instanceof Error ? error : new Error("OAuth authorization failed"));
    }
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
    bind(value) {
      if (expectation) throw new Error("OAuth callback expectation is already bound");
      expectation = value;
    },
    waitForCode: () => code,
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

async function readSecureSession(path: string): Promise<StoredOAuthSession | undefined> {
  try {
    const metadata = await stat(path);
    if ((metadata.mode & 0o077) !== 0) throw new Error("OAuth session file must be chmod 600");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return readSession(path);
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
  const session = await readSecureSession(path);
  if (!session?.tokens || session.session !== sessionName || session.credentialHandle !== credentialHandle || session.applicationDid !== applicationDid || session.resourceUrl !== resourceUrl) {
    return undefined;
  }
  return { session, path };
}

async function refreshOAuthSession(
  path: string,
  sessionName: string,
  credentialHandle: string,
  applicationDid: string,
  resourceUrl: string,
  credentialDir: string,
  expected: OAuthPrepareOptions,
  operatorCommand: string,
): Promise<void> {
  const loaded = await readBoundOAuthSession(sessionName, credentialHandle, applicationDid, resourceUrl, credentialDir);
  if (!loaded || loaded.session.reauthorizationRequired) {
    throw new OAuthReauthorizationRequiredError(operatorCommand);
  }
  const refreshPolicy = normalizeRefreshPolicy(expected.refresh);
  if (!shouldRefreshAccessToken(loaded.session, refreshPolicy)) return;
  if (typeof loaded.session.tokens?.refresh_token !== "string") {
    await markReauthorizationRequired(
      loaded.session,
      path,
      expected.auditPath ?? join(credentialDir, "oauth-audit.jsonl"),
      "grant_unusable",
    );
    throw new OAuthReauthorizationRequiredError(operatorCommand);
  }

  const fetchFn = createOAuthFetchPolicy({
    bearerTokenResourceUrl: resourceUrl,
    testOnlyAllowHttpLoopback: isLoopbackUrl(resourceUrl),
  });
  const binding = loaded.session.binding;
  const discovery = loaded.session.discovery;
  const clientInformation = loaded.session.clientInformation;
  if (!discovery || !clientInformation) {
    await markReauthorizationRequired(
      loaded.session,
      path,
      expected.auditPath ?? join(credentialDir, "oauth-audit.jsonl"),
      "grant_unusable",
    );
    throw new OAuthReauthorizationRequiredError(operatorCommand);
  }
  const provider = new FileOAuthClientProvider(loaded.session, loaded.path, false, {
    persistAuthorizationArtifacts: false,
    operatorCommand,
    testOnlyAllowHttpLoopback: isLoopbackUrl(resourceUrl),
  }, binding ? {
    client: clientConfigurationForBinding(binding),
    clientConfiguration: binding.clientConfiguration,
    requestedScopes: binding.requestedScopes,
    scopeConfiguration: binding.scopeConfiguration ?? canonicalScopeConfiguration(binding.requestedScopes, undefined),
    authorizationResponseIssuerRequired: () => binding.authorizationResponseIssuerRequired,
    expectedIssuer: binding.issuer,
    refreshPolicy,
    fetchFn,
  } : undefined);
  try {
    const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation,
      refreshToken: loaded.session.tokens.refresh_token,
      resource: new URL(resourceUrl),
      fetchFn,
    });
    await provider.saveTokens(tokens);
    await appendOAuthAudit(
      expected.auditPath ?? join(credentialDir, "oauth-audit.jsonl"),
      loaded.session,
      "credential-adapter",
      "refresh",
      "succeeded",
    );
  } catch (error) {
    if (error instanceof InvalidGrantError || isInvalidGrantError(error)) {
      await markReauthorizationRequired(
        loaded.session,
        path,
        expected.auditPath ?? join(credentialDir, "oauth-audit.jsonl"),
        "invalid_grant",
      );
    } else {
      await appendOAuthAudit(
        expected.auditPath ?? join(credentialDir, "oauth-audit.jsonl"),
        loaded.session,
        "credential-adapter",
        "refresh",
        "failed",
      );
    }
    throw error;
  }
}

function shouldRefreshAccessToken(session: StoredOAuthSession, refresh: OAuthRefreshPolicy): boolean {
  return isAccessTokenRefreshDue(
    session.tokens,
    session.tokensSavedAt,
    Date.now(),
    refresh.safetyWindowMs,
    session.refreshJitterMs ?? 0,
  );
}

function clientConfigurationForBinding(binding: OAuthAuthorizationBinding): OAuthClientConfiguration {
  if (binding.clientMode === "cimd") {
    return { type: "cimd", clientIdMetadataDocument: binding.clientId };
  }
  if (binding.clientMode === "dynamic") return { type: "dynamic" };
  return { type: "static", clientId: binding.clientId };
}

function sessionMatchesRequest(session: StoredOAuthSession, request: OAuthOperatorRequest): boolean {
  return session.session === request.session &&
    session.credentialHandle === request.credentialHandle &&
    session.applicationDid === request.applicationDid &&
    canonicalResourceUrl(session.resourceUrl) === canonicalResourceUrl(request.resourceUrl) &&
    sessionMatchesExpectation(session, request);
}

function sessionMatchesExpectation(session: StoredOAuthSession, expected: OAuthPrepareOptions): boolean {
  const binding = session.binding;
  if (!binding) return Object.keys(expected).filter((key) => key !== "auditPath" && key !== "refresh").length === 0;
  const hasConfiguredExpectation = expected.issuer !== undefined || expected.client !== undefined ||
    expected.scopes !== undefined || expected.refreshScope !== undefined || expected.owner !== undefined ||
    expected.sharing !== undefined;
  if (hasConfiguredExpectation && (!session.owner || !session.sharing)) return false;
  if (expected.owner && session.owner !== expected.owner) return false;
  if (expected.sharing && session.owner && session.sharing) {
    const configured = normalizeSharingPolicy({
      applicationDid: session.applicationDid,
      resourceUrl: session.resourceUrl,
      session: session.session,
      credentialHandle: session.credentialHandle,
      sharing: expected.sharing,
    }, expected.owner ?? session.owner);
    if (!equalSharingPolicy(session.sharing, configured)) return false;
  }
  if (expected.issuer && binding.issuer !== expected.issuer) return false;
  if (expected.client && binding.clientConfiguration !== canonicalClientConfiguration(expected.client)) return false;
  if ((expected.scopes || expected.refreshScope) && binding.scopeConfiguration !==
      canonicalScopeConfiguration(expected.scopes, expected.refreshScope)) return false;
  return binding.applicationDid === session.applicationDid &&
    binding.resourceUrl === canonicalResourceUrl(session.resourceUrl);
}

async function markReauthorizationRequired(
  session: StoredOAuthSession,
  path: string,
  auditPath: string,
  reason: StoredOAuthSession["reauthorizationReason"],
): Promise<void> {
  session.reauthorizationRequired = true;
  session.reauthorizationReason = reason;
  await writeSession(path, session);
  await appendOAuthAudit(auditPath, session, "credential-adapter", "reauthorization_required", reason ?? "required");
}

function parseOAuthClientConfiguration(value: unknown): OAuthClientConfiguration {
  if (value === undefined) return { type: "auto" };
  if (!isRecord(value) || !["auto", "static", "cimd", "dynamic"].includes(String(value.type))) {
    throw new Error("OAuth client configuration must select auto, static, cimd, or dynamic mode");
  }
  if (value.type === "dynamic") return { type: "dynamic" };
  if (value.type === "cimd") {
    if (typeof value.clientIdMetadataDocument !== "string") {
      throw new Error("OAuth CIMD mode requires clientIdMetadataDocument");
    }
    assertCimdUrl(value.clientIdMetadataDocument);
    return { type: "cimd", clientIdMetadataDocument: value.clientIdMetadataDocument };
  }
  if (value.type === "static") {
    if (typeof value.clientId !== "string" || value.clientId.length === 0) {
      throw new Error("OAuth static client mode requires clientId");
    }
    if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
      throw new Error("OAuth static clientSecret must be a credential reference");
    }
    return {
      type: "static",
      clientId: value.clientId,
      ...(typeof value.clientSecret === "string" ? { clientSecret: value.clientSecret } : {}),
    };
  }
  if (value.clientIdMetadataDocument !== undefined && typeof value.clientIdMetadataDocument !== "string") {
    throw new Error("OAuth auto clientIdMetadataDocument must be a string");
  }
  if (typeof value.clientIdMetadataDocument === "string") assertCimdUrl(value.clientIdMetadataDocument);
  if (value.clientId !== undefined && (typeof value.clientId !== "string" || value.clientId.length === 0)) {
    throw new Error("OAuth auto clientId must be a non-empty string");
  }
  if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
    throw new Error("OAuth auto clientSecret must be a credential reference");
  }
  return {
    type: "auto",
    ...(typeof value.clientId === "string" ? { clientId: value.clientId } : {}),
    ...(typeof value.clientSecret === "string" ? { clientSecret: value.clientSecret } : {}),
    ...(typeof value.clientIdMetadataDocument === "string"
      ? { clientIdMetadataDocument: value.clientIdMetadataDocument }
      : {}),
  };
}

function parseSharingPolicy(value: unknown): Partial<OAuthSharingPolicy> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("OAuth sharing policy must be an object");
  const applicationDids = parseStringArray(value.applicationDids, "OAuth sharing applicationDids");
  const operatorPrincipals = parseStringArray(value.operatorPrincipals, "OAuth sharing operatorPrincipals");
  return { ...(applicationDids ? { applicationDids } : {}), ...(operatorPrincipals ? { operatorPrincipals } : {}) };
}

function parseRefreshPolicy(value: unknown): OAuthRefreshPolicy {
  if (value === undefined) return normalizeRefreshPolicy();
  if (!isRecord(value)) throw new Error("OAuth refresh policy must be an object");
  return normalizeRefreshPolicy({
    ...(typeof value.safetyWindowMs === "number" ? { safetyWindowMs: value.safetyWindowMs } : {}),
    ...(typeof value.jitterMaxMs === "number" ? { jitterMaxMs: value.jitterMaxMs } : {}),
  });
}

function normalizeRefreshPolicy(value: Partial<OAuthRefreshPolicy> = {}): OAuthRefreshPolicy {
  const safetyWindowMs = value.safetyWindowMs ?? DEFAULT_OAUTH_REFRESH_SAFETY_WINDOW_MS;
  const jitterMaxMs = value.jitterMaxMs ?? DEFAULT_OAUTH_REFRESH_JITTER_MAX_MS;
  if (!Number.isInteger(safetyWindowMs) || safetyWindowMs < 0 || safetyWindowMs > MAX_OAUTH_REFRESH_SAFETY_WINDOW_MS) {
    throw new Error(`OAuth refresh safetyWindowMs must be an integer from 0 to ${MAX_OAUTH_REFRESH_SAFETY_WINDOW_MS}`);
  }
  if (!Number.isInteger(jitterMaxMs) || jitterMaxMs < 0 || jitterMaxMs > MAX_OAUTH_REFRESH_JITTER_MS) {
    throw new Error(`OAuth refresh jitterMaxMs must be an integer from 0 to ${MAX_OAUTH_REFRESH_JITTER_MS}`);
  }
  return { safetyWindowMs, jitterMaxMs };
}

function normalizeSharingPolicy(request: OAuthOperatorRequest, owner: string): OAuthSharingPolicy {
  const applicationDids = request.sharing?.applicationDids ?? [request.applicationDid];
  const operatorPrincipals = request.sharing?.operatorPrincipals ?? [owner];
  if (!applicationDids.includes(request.applicationDid)) {
    throw new Error("OAuth sharing policy must authorize the selected Application DID");
  }
  if (!operatorPrincipals.includes(owner)) {
    throw new Error("OAuth sharing policy must authorize the session owner");
  }
  return { applicationDids: [...new Set(applicationDids)], operatorPrincipals: [...new Set(operatorPrincipals)] };
}

function assertOperatorAccess(
  principal: string,
  applicationDid: string,
  owner: string,
  sharing: OAuthSharingPolicy,
): void {
  if (!sharing.applicationDids.includes(applicationDid) ||
      (principal !== owner && !sharing.operatorPrincipals.includes(principal))) {
    throw new Error("OAuth session access denied by owner sharing policy");
  }
}

function localOperatorPrincipal(): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : userInfo().username;
  return `local-os-user:${uid}`;
}

function canonicalClientConfiguration(client: OAuthClientConfiguration): string {
  return JSON.stringify(client);
}

function canonicalScopes(scopes: string[]): string[] {
  return [...new Set(scopes.filter((scope) => scope.length > 0))].sort();
}

function canonicalScopeConfiguration(scopes: string[] | undefined, refreshScope: string | undefined): string {
  return JSON.stringify({
    scopes: canonicalScopes(scopes ?? []),
    refreshScope: refreshScope?.trim() || DEFAULT_OAUTH_REFRESH_SCOPE,
  });
}

function canonicalResourceUrl(value: string): string {
  return new URL(value).toString();
}

function equalSharingPolicy(left: OAuthSharingPolicy, right: OAuthSharingPolicy): boolean {
  return equalSets(left.applicationDids, right.applicationDids) &&
    equalSets(left.operatorPrincipals, right.operatorPrincipals);
}

function equalSets(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function parseStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value;
}

function canReuseClientRegistration(
  previous: StoredOAuthSession | undefined,
  request: OAuthOperatorRequest,
  clientConfiguration: string,
): boolean {
  return previous?.binding?.clientMode !== "dynamic" &&
    previous?.binding?.clientConfiguration === clientConfiguration &&
    previous.applicationDid === request.applicationDid &&
    canonicalResourceUrl(previous.resourceUrl) === canonicalResourceUrl(request.resourceUrl) &&
    previous.clientInformation !== undefined;
}

async function resolveStaticClientInformation(
  client: OAuthClientConfiguration,
  resolveSecret: FileOAuthOperatorServiceOptions["resolveStaticClientSecret"],
): Promise<OAuthClientInformationMixed | undefined> {
  const clientId = client.type === "static" || (client.type === "auto" && client.clientId)
    ? client.clientId
    : undefined;
  if (!clientId) return undefined;
  const secretReference = client.type === "static" || client.type === "auto" ? client.clientSecret : undefined;
  if (!secretReference) return { client_id: clientId };
  const handle = credentialReference(secretReference);
  if (!resolveSecret) throw new Error("OAuth static client secret resolver is unavailable");
  return { client_id: clientId, client_secret: await resolveSecret(handle) };
}

function credentialReference(value: string): string {
  const match = /^\{\{credential:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\}\}$/.exec(value);
  if (!match) throw new Error("OAuth clientSecret must be an exact {{credential:handle}} reference");
  return match[1];
}

function selectClientMode(
  client: OAuthClientConfiguration,
  discovery: OAuthDiscoveryState,
  existing: OAuthClientInformationMixed | undefined,
): { mode: OAuthClientMode; clientId: string } {
  const metadata = discovery.authorizationServerMetadata;
  if (client.type === "static" || (client.type === "auto" && client.clientId)) {
    const configuredClientId = client.clientId;
    if (!configuredClientId || existing?.client_id !== configuredClientId) {
      throw new Error("OAuth static client information is unavailable or does not match configuration");
    }
    return { mode: "static", clientId: configuredClientId };
  }
  if (client.type === "cimd") {
    if (metadata?.client_id_metadata_document_supported !== true) {
      throw new Error("OAuth CIMD mode is configured but the authorization server does not advertise it");
    }
    return { mode: "cimd", clientId: client.clientIdMetadataDocument };
  }
  if (client.type === "dynamic") {
    if (!metadata?.registration_endpoint) {
      throw new Error("OAuth dynamic client registration is configured but not advertised");
    }
    return { mode: "dynamic", clientId: existing?.client_id ?? "dynamic-registration-pending" };
  }
  if (client.clientIdMetadataDocument && metadata?.client_id_metadata_document_supported === true) {
    return { mode: "cimd", clientId: client.clientIdMetadataDocument };
  }
  if (metadata?.registration_endpoint) {
    return { mode: "dynamic", clientId: existing?.client_id ?? "dynamic-registration-pending" };
  }
  throw new Error("OAuth auto client selection found no static client, advertised CIMD, or advertised dynamic registration");
}

function assertCimdUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname === "/") {
    throw new Error("OAuth Client ID Metadata Document URL must use HTTPS and contain a non-root path");
  }
}

async function validateClientMetadataDocument(
  clientId: string,
  redirectUrl: string | undefined,
  refreshRequested: boolean,
  fetchFn: FetchLike | undefined,
): Promise<void> {
  assertCimdUrl(clientId);
  if (!redirectUrl || !fetchFn) throw new Error("OAuth CIMD validation prerequisites are unavailable");
  const response = await fetchFn(clientId, { redirect: "manual" });
  if (!response.ok) throw new Error("OAuth Client ID Metadata Document could not be loaded");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("OAuth Client ID Metadata Document is not valid JSON");
  }
  if (!isRecord(value) || value.client_id !== clientId || typeof value.client_name !== "string" ||
      !Array.isArray(value.redirect_uris) || value.redirect_uris.length !== 1 || value.redirect_uris[0] !== redirectUrl) {
    throw new Error("OAuth Client ID Metadata Document does not match the configured client and redirect URI");
  }
  if (refreshRequested && (!Array.isArray(value.grant_types) || !value.grant_types.includes("refresh_token"))) {
    throw new Error("OAuth Client ID Metadata Document does not advertise refresh_token");
  }
  if (Object.keys(value).some((key) => /secret|token|credential/i.test(key))) {
    throw new Error("OAuth Client ID Metadata Document must not contain credentials");
  }
}

function boundedJitter(maximum: number): number {
  const bounded = Math.min(Math.max(maximum, 0), MAX_OAUTH_REFRESH_JITTER_MS);
  if (bounded === 0) return 0;
  return randomBytes(4).readUInt32BE(0) % (bounded + 1);
}

async function revokeAdvertisedTokens(
  session: StoredOAuthSession,
  options: Pick<FileOAuthOperatorServiceOptions, "fetch" | "testOnlyAllowHttpLoopback">,
): Promise<"succeeded" | "unavailable" | "failed"> {
  const metadata = session.discovery?.authorizationServerMetadata;
  const rawMetadata = metadata as unknown as Record<string, unknown> | undefined;
  const endpoint = typeof rawMetadata?.revocation_endpoint === "string"
    ? rawMetadata.revocation_endpoint
    : undefined;
  const accessToken = session.tokens?.access_token;
  const refreshToken = session.tokens?.refresh_token;
  if (!endpoint || (!accessToken && !refreshToken)) return "unavailable";
  const fetchFn = createOAuthFetchPolicy({
    fetch: options.fetch,
    testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback,
  });
  const tokens = [
    ...(refreshToken ? [{ value: refreshToken, hint: "refresh_token" }] : []),
    ...(accessToken ? [{ value: accessToken, hint: "access_token" }] : []),
  ];
  let succeeded = true;
  for (const token of tokens) {
    const body = new URLSearchParams({ token: token.value, token_type_hint: token.hint });
    if (session.clientInformation?.client_id) body.set("client_id", session.clientInformation.client_id);
    if (session.clientInformation?.client_secret) body.set("client_secret", session.clientInformation.client_secret);
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) succeeded = false;
    } catch {
      succeeded = false;
    }
  }
  return succeeded ? "succeeded" : "failed";
}

async function appendOAuthAudit(
  path: string,
  session: StoredOAuthSession,
  operatorPrincipal: string,
  action: "login" | "refresh" | "reauthorization_required" | "revocation" | "logout" | "binding_change",
  outcome: string,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const event = {
    timestamp: new Date().toISOString(),
    session: session.session,
    applicationDid: session.applicationDid,
    issuer: session.binding?.issuer ?? session.discovery?.authorizationServerUrl ?? "unknown",
    resourceUrl: session.resourceUrl,
    clientMode: session.binding?.clientMode ?? "unknown",
    scopes: session.binding?.requestedScopes ?? [],
    operatorPrincipal,
    action,
    outcome,
  };
  await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export interface ManagedOAuthSessionValidation {
  ok: boolean;
  state: "authorized" | "refresh_due" | "reauthorization_required" | "missing" | "malformed" | "misbound" | "insecure_permissions" | "access_denied";
  error?: "OAUTH_REAUTHORIZATION_REQUIRED" | "OAUTH_SESSION_NOT_FOUND" | "OAUTH_SESSION_MALFORMED" | "OAUTH_SESSION_BINDING_MISMATCH" | "OAUTH_SESSION_INSECURE_PERMISSIONS" | "OAUTH_SESSION_ACCESS_DENIED";
}

export async function validateManagedOAuthSession(
  request: OAuthOperatorRequest,
  credentialDir = join(homedir(), ".mpas", "credentials"),
  operatorPrincipal = localOperatorPrincipal(),
): Promise<ManagedOAuthSessionValidation> {
  const path = credentialPath(credentialDir, request.credentialHandle);
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch {
    return { ok: false, state: "missing", error: "OAUTH_SESSION_NOT_FOUND" };
  }
  if ((mode & 0o077) !== 0) {
    return { ok: false, state: "insecure_permissions", error: "OAUTH_SESSION_INSECURE_PERMISSIONS" };
  }
  let session: StoredOAuthSession;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isStoredOAuthSession(parsed)) throw new Error("invalid session shape");
    session = parsed;
  } catch {
    return { ok: false, state: "malformed", error: "OAUTH_SESSION_MALFORMED" };
  }
  try {
    if (!session.owner || !session.sharing) throw new Error("OAuth session owner policy is missing");
    const owner = session.owner;
    const sharing = session.sharing;
    assertOperatorAccess(operatorPrincipal, request.applicationDid, owner, sharing);
  } catch {
    return { ok: false, state: "access_denied", error: "OAUTH_SESSION_ACCESS_DENIED" };
  }
  if (!sessionMatchesRequest(session, request)) {
    return { ok: false, state: "misbound", error: "OAUTH_SESSION_BINDING_MISMATCH" };
  }
  if (session.reauthorizationRequired || !session.tokens) {
    return { ok: false, state: "reauthorization_required", error: "OAUTH_REAUTHORIZATION_REQUIRED" };
  }
  if (shouldRefreshAccessToken(session, normalizeRefreshPolicy(request.refresh))) {
    return typeof session.tokens.refresh_token === "string"
      ? { ok: true, state: "refresh_due" }
      : { ok: false, state: "reauthorization_required", error: "OAUTH_REAUTHORIZATION_REQUIRED" };
  }
  return { ok: true, state: "authorized" };
}

function isStoredOAuthSession(value: unknown): value is StoredOAuthSession {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return false;
  return typeof value.session === "string" && typeof value.credentialHandle === "string" &&
    typeof value.applicationDid === "string" && typeof value.resourceUrl === "string" &&
    (value.tokens === undefined || isRecord(value.tokens));
}

async function refreshScopeFromPlugin(configDir: string, pluginPath: string | undefined): Promise<string> {
  if (!pluginPath) return DEFAULT_OAUTH_REFRESH_SCOPE;
  const loaded = await loadPlugin(resolve(configDir, pluginPath));
  if (!loaded.ok) return DEFAULT_OAUTH_REFRESH_SCOPE;
  const declared = loaded.plugin.credentialRequirements
    ?.map((requirement: { refreshScope?: string }) => requirement.refreshScope)
    .find((scope: string | undefined) => typeof scope === "string" && scope.trim().length > 0);
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

function observeAuthorizationMetadata(fetchFn: FetchLike, observe: (issuerRequired: boolean) => void): FetchLike {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("json")) {
      try {
        const value = await response.clone().json() as unknown;
        if (isRecord(value) && typeof value.issuer === "string" &&
            typeof value.authorization_endpoint === "string") {
          observe(value.authorization_response_iss_parameter_supported === true);
        }
      } catch {
        // The SDK owns syntax validation. This observer only preserves RFC 9207 metadata
        // that the SDK's current typed schema does not expose.
      }
    }
    return response;
  };
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
