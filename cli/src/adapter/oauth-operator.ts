import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  auth,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
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
import { assertExactAuthorizationServerIssuer, OAuthIssuerMismatchError, OAuthPkceMetadataError } from "./oauth-discovery.js";
import { connectFailureCode, HardenedFetchError } from "./hardened-fetch.js";
import { createOAuthFetchPolicy, OAuthFetchPolicyError } from "./oauth-fetch-policy.js";
import { defaultAdapterKeyPath, loadAdapterKey } from "./adapter-key.js";
import {
  applyClientAssertion,
  assertRevocationAuthentication,
  selectClientAuthentication,
  type LoadClientSigningKey,
  type OAuthClientAuthenticationBinding,
} from "./oauth-client-auth.js";
import {
  OAuthOperatorError,
  parseRetryAfterSeconds,
  sanitizeOAuthErrorCode,
  type OAuthFailureCode,
} from "./oauth-errors.js";

import { OAuthScopeChangeRequiredError } from "./oauth-scope-guard.js";

export { OAuthOperatorError } from "./oauth-errors.js";

/** Adapter-local reason codes (spec §11). */
export type OAuthReasonCode =
  | "oauth_login_required"
  | "oauth_reauthorization_required"
  | "oauth_insufficient_scope"
  | "oauth_access_denied"
  | "oauth_authorization_denied"
  | "oauth_discovery_failed"
  | "oauth_client_registration_failed"
  | "oauth_client_authentication_failed"
  | "oauth_temporarily_unavailable"
  | "oauth_rate_limited"
  | "oauth_token_refresh_failed";

/**
 * The one mapping from the adapter's uppercase constants to the §11 reason codes
 * (plan Phase 0). Status output, operator errors and agent-facing rejections all
 * read their reason from here. A constant absent from this table has no §11 code:
 * `OAUTH_RESOURCE_FORBIDDEN` preserves an unexplained denial without guessing a
 * cause, and `OAUTH_UNKNOWN_ERROR` stays unknown (§11.1).
 */
export const OAUTH_REASON_BY_CODE: Readonly<Record<string, OAuthReasonCode>> = Object.freeze({
  OAUTH_LOGIN_REQUIRED: "oauth_login_required",
  OAUTH_SESSION_NOT_FOUND: "oauth_login_required",
  OAUTH_REAUTHORIZATION_REQUIRED: "oauth_reauthorization_required",
  OAUTH_INVALID_GRANT: "oauth_reauthorization_required",
  OAUTH_AUTHENTICATION_FAILED: "oauth_reauthorization_required",
  OAUTH_SESSION_BINDING_MISMATCH: "oauth_reauthorization_required",
  OAUTH_INSUFFICIENT_SCOPE: "oauth_insufficient_scope",
  OAUTH_SCOPE_CHANGE_REQUIRED: "oauth_insufficient_scope",
  OAUTH_ACCESS_DENIED: "oauth_access_denied",
  OAUTH_AUTHORIZATION_DENIED: "oauth_authorization_denied",
  OAUTH_DISCOVERY_FAILED: "oauth_discovery_failed",
  OAUTH_SCOPE_NOT_SUPPORTED: "oauth_discovery_failed",
  OAUTH_CLIENT_REGISTRATION_FAILED: "oauth_client_registration_failed",
  OAUTH_CLIENT_AUTHENTICATION_FAILED: "oauth_client_authentication_failed",
  OAUTH_TEMPORARILY_UNAVAILABLE: "oauth_temporarily_unavailable",
  OAUTH_RATE_LIMITED: "oauth_rate_limited",
  OAUTH_TOKEN_REFRESH_FAILED: "oauth_token_refresh_failed",
});

const OAUTH_REASON_CODES: ReadonlySet<string> = new Set(Object.values(OAUTH_REASON_BY_CODE));

/** The §11 reason for an adapter constant, or for an error already carrying a reason code. */
export function oauthReasonForCode(code: string | undefined): OAuthReasonCode | undefined {
  if (!code) return undefined;
  return OAUTH_REASON_BY_CODE[code] ?? (OAUTH_REASON_CODES.has(code) ? code as OAuthReasonCode : undefined);
}

/** Reason codes that must not be answered with login advice (§11). */
const NO_LOGIN_ADVICE: ReadonlySet<OAuthReasonCode> = new Set([
  "oauth_access_denied",
  "oauth_authorization_denied",
  "oauth_temporarily_unavailable",
  "oauth_rate_limited",
  "oauth_client_authentication_failed",
  "oauth_client_registration_failed",
  "oauth_discovery_failed",
]);

export type OAuthPrepareErrorCode =
  | "OAUTH_SCOPE_CHANGE_REQUIRED"
  | "OAUTH_REAUTHORIZATION_REQUIRED"
  | "OAUTH_AUTHENTICATION_FAILED"
  | "OAUTH_INVALID_GRANT"
  | "TARGET_UNAVAILABLE"
  | OAuthFailureCode;

export interface OAuthPrepareError {
  code: OAuthPrepareErrorCode;
  message: string;
  retryAfterSeconds?: number;
  /** §11 reason, when the code has one. */
  reason?: OAuthReasonCode;
  /** Only when the operator can act by running it (OAUTH-33A); never executed here. */
  operatorCommand?: string;
}

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

export type OAuthSessionState =
  | "authorized"
  | "refresh_due"
  | "login_required"
  | "reauthorization_required"
  | "refresh_uncertain"
  | "rate_limited"
  | "access_denied";

export type OAuthOperatorResult =
  | {
      status: "oauth_login_required" | "oauth_operator_service_unavailable";
      applicationDid: string;
      resourceUrl: string;
      operatorCommand: string;
      reason?: OAuthReasonCode;
    }
  | {
      status: "authorized";
      applicationDid: string;
      issuer: string;
      resource: string;
      clientMode: "static" | "cimd" | "dynamic";
      clientAuthentication?: "none" | "private_key_jwt";
      /** Union of requested and granted names, kept for compatibility. */
      scopes: string[];
      requestedScopes?: string[];
      grantedScopes?: string[];
      expiresAt?: string;
      refreshable: boolean;
      reauthorizationRequired: boolean;
      state?: OAuthSessionState;
      reason?: OAuthReasonCode;
      operatorCommand?: string;
      retryAfter?: string;
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
      revocationReason?: OAuthReasonCode;
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
  /** OAUTH-15D: absent means a public client. Part of the binding for the session's life. */
  clientAuthentication?: OAuthClientAuthenticationBinding;
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
  /**
   * OAUTH-30 refresh evidence. `uncertain` means a refresh request may have rotated
   * the grant without a usable response: the stored tokens are kept, the old refresh
   * token is never resent, and dispatch is refused until the operator logs in again
   * (plan Phase 0). `deferred` honors a bounded Retry-After.
   */
  refreshState?: { status: "uncertain" | "deferred"; at: string; retryAfter?: string };
  /** A supported explicit entitlement denial observed at the resource (§11). */
  accessDenied?: { at: string; error: "account_not_allowed" };
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
  /** The daemon's adapter key file (OAUTH-15E). Defaults to the daemon's own path. */
  adapterKeyPath?: string;
  /** Test seam replacing the key file load. */
  loadSigningKey?: LoadClientSigningKey;
  /** Per-attempt bound for OAuth requests. Defaults to the fetch policy's bound. */
  requestTimeoutMs?: number;
}

export function fileOAuthOperatorService(options: FileOAuthOperatorServiceOptions = {}): OAuthOperatorService {
  const credentialDir = options.credentialDir ?? join(homedir(), ".mpas", "credentials");
  const callbackTimeoutMs = Math.min(options.callbackTimeoutMs ?? 300_000, 600_000);
  const operatorPrincipal = options.operatorPrincipal ?? localOperatorPrincipal();
  const auditPath = options.auditPath ?? join(credentialDir, "oauth-audit.jsonl");
  // OAUTH-15E, plan Phase 0: the daemon's own key file, loaded only when a client
  // document declares private_key_jwt.
  const loadSigningKey: LoadClientSigningKey = options.loadSigningKey ??
    (() => loadAdapterKey(options.adapterKeyPath ?? defaultAdapterKeyPath()));

  return {
    async login(request) {
      const callback = await startCallbackServer(callbackTimeoutMs);
      const path = credentialPath(credentialDir, request.credentialHandle);
      const operatorCommand = oauthLoginCommand(request);
      const evidence = new OAuthRequestEvidence();
      let previousRaw: Buffer | undefined;
      let session: StoredOAuthSession | undefined;
      let committed = false;
      try {
        previousRaw = await readRawSession(path);
        const previous = previousRaw ? JSON.parse(previousRaw.toString("utf8")) as StoredOAuthSession : undefined;
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
        let authorizationResponseIssuerRequired = false;
        const policyFetch = createOAuthFetchPolicy({
          bearerTokenResourceUrl: request.resourceUrl,
          testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback,
          fetch: options.fetch,
          ...(options.requestTimeoutMs ? { timeoutMs: options.requestTimeoutMs } : {}),
        });
        const fetchFn = observeAuthorizationMetadata(
          observeTokenRequests(evidence.observe(policyFetch)),
          (required) => { authorizationResponseIssuerRequired ||= required; },
        );
        evidence.begin("discovery");
        const discovered = await discoverLoginScopes(request.resourceUrl, fetchFn);
        const resolved = resolveRequestedOAuthScopes({
          configuredScopes: request.scopes,
          refreshScope: request.refreshScope,
          supportedScopes: uniqueScopes(discovered.resourceScopes, discovered.authorizationServerScopes),
          resourceScopes: discovered.resourceScopes,
          authorizationServerScopes: discovered.authorizationServerScopes,
          challengeScopes: discovered.challengeScopes,
          previousGrantedScopes: reauthorizationScopes(previous, request),
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
        const staticClientInformation = await resolveStaticClientInformation(client, options.resolveStaticClientSecret);
        if (staticClientInformation) session.clientInformation = staticClientInformation;
        await writeSession(path, session);
        const provider = new FileOAuthClientProvider(session, path, request.openBrowser, {
          ...options,
          operatorCommand,
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
          loadSigningKey,
        });
        // §4.2: the selected set is passed explicitly, so the SDK never substitutes its own.
        const scopeOption = resolved.scopes.length > 0 ? { scope: resolved.scopes.join(" ") } : {};
        const metadataOption = discovered.resourceMetadataUrl
          ? { resourceMetadataUrl: new URL(discovered.resourceMetadataUrl) }
          : {};
        evidence.begin("authorization");
        const start = await auth(provider, {
          serverUrl: request.resourceUrl,
          ...scopeOption,
          ...metadataOption,
          fetchFn,
        });
        if (start !== "REDIRECT") throw new Error("OAuth login did not require operator authorization");
        const code = await callback.waitForCode();
        evidence.begin("token");
        const completed = await auth(provider, {
          serverUrl: request.resourceUrl,
          authorizationCode: code,
          ...scopeOption,
          ...metadataOption,
          fetchFn,
        });
        if (completed !== "AUTHORIZED") throw new Error("OAuth authorization did not complete");
        session.reauthorizationRequired = false;
        delete session.reauthorizationReason;
        await writeSession(path, session);
        committed = true;
        await appendOAuthAudit(auditPath, session, operatorPrincipal, "login", "succeeded");
        return authorizedResult(session, resolved.warnings, operatorCommand);
      } catch (error) {
        const failure = classifyLoginFailure(error, evidence);
        if (session) await appendOAuthAudit(auditPath, session, operatorPrincipal, "login", "failed");
        // §6, P2-09, P5-07: a failed or declined login never erases the configured
        // identity or the previously stored grant.
        if (session && !committed) await restoreSession(path, previousRaw);
        throw failure;
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
          reason: "oauth_login_required",
        };
      }
      if (!session.owner || !session.sharing) throw new Error("OAuth session owner policy is missing");
      const owner = session.owner;
      const sharing = session.sharing;
      assertOperatorAccess(operatorPrincipal, request.applicationDid, owner, sharing);
      if (!sessionMatchesRequest(session, request)) {
        await markReauthorizationRequired(session, path, auditPath, "binding_mismatch");
      }
      return authorizedResult(session, [], oauthLoginCommand(request));
    },
    async logout(request) {
      const path = credentialPath(credentialDir, request.credentialHandle);
      const session = await readSecureSession(path);
      let remoteRevocation: "succeeded" | "unavailable" | "failed" = "unavailable";
      let revocationReason: OAuthReasonCode | undefined;
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
        const revoked = await revokeAdvertisedTokens(session, {
          fetch: options.fetch,
          testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback,
          loadSigningKey,
        });
        remoteRevocation = revoked.outcome;
        revocationReason = revoked.reason;
        await appendOAuthAudit(auditPath, session, operatorPrincipal, "revocation", remoteRevocation);
      }
      // OAUTH-31: local deletion succeeds whatever happened remotely.
      await rm(path, { force: true });
      if (session) await appendOAuthAudit(auditPath, session, operatorPrincipal, "logout", "succeeded");
      return {
        status: "logged_out",
        applicationDid: request.applicationDid,
        localCredentialsDeleted: true,
        remoteRevocation,
        ...(revocationReason ? { revocationReason } : {}),
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
  loadSigningKey?: LoadClientSigningKey;
}

class FileOAuthClientProvider implements OAuthClientProvider {
  /** The last token-endpoint failure seen through {@link wrapFetch}, for dispatch-time 401 recovery. */
  private lastTokenFailure?: OAuthOperatorError;
  /**
   * Set when a refresh got a successful response and cleared by {@link saveTokens}.
   * If the SDK drops that refresh for any reason in between, the server may already
   * have rotated the grant (OAUTH-30).
   */
  private refreshAwaitingSave = false;

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
  /**
   * OAUTH-15D: present only for a session bound to `private_key_jwt`. The SDK then
   * calls it for the code exchange and every refresh instead of its public-client
   * handling; a signing failure throws before anything is sent.
   */
  get addClientAuthentication(): OAuthClientProvider["addClientAuthentication"] {
    const binding = this.session.binding;
    const clientAuthentication = binding?.clientAuthentication;
    if (!binding || !clientAuthentication) return undefined;
    const loadSigningKey = this.runtime?.loadSigningKey ?? this.options.loadSigningKey;
    return async (_headers, params) => {
      await applyClientAssertion(params, {
        clientId: binding.clientId,
        audience: binding.issuer,
        binding: clientAuthentication,
        loadSigningKey,
      });
    };
  }
  /** The fixed scope baseline recorded before consent (§4.2, OAUTH-05A). */
  scopeBaseline(): string[] | undefined {
    return this.session.binding?.requestedScopes;
  }
  /** Classifies token-endpoint responses on the dispatch transport's own fetch. */
  wrapFetch(fetchFn: FetchLike): FetchLike {
    return observeTokenRequests(fetchFn, {
      onFailure: (failure) => { this.lastTokenFailure = failure; },
      onResponse: (status, grantType) => {
        if (grantType === "refresh_token" && status >= 200 && status < 300) this.refreshAwaitingSave = true;
      },
    });
  }
  /** Records a supported explicit entitlement denial for `status` (§11, P5-05). */
  async recordAccessDenied(): Promise<void> {
    this.session.accessDenied = { at: new Date().toISOString(), error: "account_not_allowed" };
    await writeSession(this.path, this.session);
  }
  async state(): Promise<string> {
    // The SDK asks for state before redirecting; during dispatch there is no
    // authorization attempt to give it (OAUTH-33A).
    if (this.isDispatch()) throw await this.dispatchCannotAuthorize();
    const state = this.session.authorization?.state ?? this.session.state;
    if (!state) throw new Error("OAuth authorization state is unavailable");
    return state;
  }
  private isDispatch(): boolean {
    return !this.shouldOpenBrowser && !this.options.onAuthorizationUrl;
  }
  /** What dispatch reports when the SDK would start consent: the real cause, never a browser. */
  private async dispatchCannotAuthorize(): Promise<Error> {
    const operatorCommand = this.options.operatorCommand ?? "mpas oauth login";
    // The SDK swallows a refresh failure that is not one of its own OAuth errors and
    // falls through to consent, so this is where a dispatch-time refresh is settled.
    const tokenFailure = this.lastTokenFailure ?? (this.refreshAwaitingSave
      ? new OAuthOperatorError("OAUTH_TOKEN_REFRESH_FAILED", "The refresh response could not be used", { ambiguous: true })
      : undefined);
    if (tokenFailure) {
      await persistTokenFailure(this.session, this.path, tokenFailure);
      return withOperatorCommand(tokenFailure, operatorCommand);
    }
    return new OAuthReauthorizationRequiredError(
      operatorCommand,
      `OAuth reauthorization required. The Credential Adapter cannot start a browser during dispatch. Run ${operatorCommand}.`,
    );
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
    const previous = this.session.tokens;
    let next = previous?.refresh_token && typeof value.refresh_token !== "string"
      ? { ...value, refresh_token: previous.refresh_token }
      : value;
    // §4.2, RFC 6749 §6: a refresh response that omits `scope` keeps the granted set;
    // a returned `scope` replaces it.
    if (typeof next.scope !== "string" && typeof previous?.scope === "string") next = { ...next, scope: previous.scope };
    this.session.tokens = next;
    this.refreshAwaitingSave = false;
    this.session.tokensSavedAt = new Date().toISOString();
    this.session.refreshJitterMs = boundedJitter(this.runtime?.refreshPolicy.jitterMaxMs ?? 0);
    this.session.reauthorizationRequired = false;
    delete this.session.reauthorizationReason;
    delete this.session.refreshState;
    delete this.session.codeVerifier;
    delete this.session.authorization;
    delete this.session.state;
    delete this.session.redirectUrl;
    await writeSession(this.path, this.session);
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    // OAUTH-33A: dispatch never starts consent. Report what actually happened.
    if (this.isDispatch()) throw await this.dispatchCannotAuthorize();
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
    await this.options.onAuthorizationUrl?.(url);
    if (this.shouldOpenBrowser) {
      if (this.options.openBrowser) await this.options.openBrowser(url);
      else await openUrl(url);
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
      let clientAuthentication: OAuthClientAuthenticationBinding | undefined;
      if (selected.mode === "cimd") {
        const document = await validateClientMetadataDocument(
          selected.clientId,
          this.redirectUrl,
          true,
          this.runtime.fetchFn,
        );
        clientAuthentication = await selectClientAuthentication({
          document,
          metadata: value.authorizationServerMetadata as Record<string, unknown> | undefined,
          loadSigningKey: this.runtime.loadSigningKey,
        });
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
        ...(clientAuthentication ? { clientAuthentication } : {}),
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
  /** The adapter's DID key for `private_key_jwt` sessions (OAUTH-15E). Not a binding member. */
  signingKey?: LoadClientSigningKey;
  /** Test seam for OAuth requests made during preparation. Not a binding member. */
  fetch?: FetchLike;
}

/** Expectation members that select behavior but are not part of the session binding. */
const NON_BINDING_EXPECTATIONS: ReadonlySet<string> = new Set(["auditPath", "refresh", "signingKey", "fetch"]);

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
  | { ok: false; error: OAuthPrepareError }
> {
  const operatorCommand = oauthLoginCommand({ applicationDid, resourceUrl, session: sessionName, credentialHandle });
  const auditPath = expected.auditPath ?? join(credentialDir, "oauth-audit.jsonl");
  const refuse = (code: OAuthPrepareErrorCode, message: string, retryAfterSeconds?: number) => ({
    ok: false as const,
    error: prepareError(code, message, operatorCommand, retryAfterSeconds),
  });
  const loaded = await readBoundOAuthSession(sessionName, credentialHandle, applicationDid, resourceUrl, credentialDir);
  if (!loaded) {
    return refuse("OAUTH_LOGIN_REQUIRED", `OAuth login required. Run ${operatorCommand}.`);
  }
  if (loaded.session.reauthorizationRequired) {
    return refuse("OAUTH_REAUTHORIZATION_REQUIRED", `OAuth reauthorization required. Run ${operatorCommand}.`);
  }
  if (loaded.session.refreshState?.status === "uncertain") {
    // OAUTH-30, plan Phase 0: refused before the ledger's executing write; the old
    // refresh token is never resent.
    return refuse("OAUTH_TOKEN_REFRESH_FAILED", refreshUncertainMessage(operatorCommand));
  }
  if (!sessionMatchesExpectation(loaded.session, expected)) {
    await markReauthorizationRequired(loaded.session, loaded.path, auditPath, "binding_mismatch");
    return refuse("OAUTH_REAUTHORIZATION_REQUIRED", `OAuth session binding changed. Run ${operatorCommand}.`);
  }
  const refreshPolicy = normalizeRefreshPolicy(expected.refresh);
  if (shouldRefreshAccessToken(loaded.session, refreshPolicy)) {
    if (typeof loaded.session.tokens?.refresh_token !== "string") {
      // §4.2, P4-03: a server need not issue refresh tokens. The session simply ends
      // at expiry; until then the access token remains usable.
      if (isAccessTokenExpired(loaded.session.tokens, loaded.session.tokensSavedAt)) {
        return refuse(
          "OAUTH_LOGIN_REQUIRED",
          `OAuth access token expired and the server issued no refresh token. Run ${operatorCommand}.`,
        );
      }
    } else {
      const deferredUntil = Date.parse(loaded.session.refreshState?.retryAfter ?? "");
      if (Number.isFinite(deferredUntil) && deferredUntil > Date.now()) {
        return refuse(
          "OAUTH_RATE_LIMITED",
          "OAuth token refresh is rate limited; the adapter will retry after the server's Retry-After.",
          Math.ceil((deferredUntil - Date.now()) / 1000),
        );
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
  }
  const refreshed = await readBoundOAuthSession(sessionName, credentialHandle, applicationDid, resourceUrl, credentialDir);
  if (!refreshed || refreshed.session.reauthorizationRequired) {
    return refuse("OAUTH_REAUTHORIZATION_REQUIRED", `OAuth reauthorization required. Run ${operatorCommand}.`);
  }
  const provider = new FileOAuthClientProvider(refreshed.session, refreshed.path, false, {
    persistAuthorizationArtifacts: false,
    operatorCommand,
    testOnlyAllowHttpLoopback: isLoopbackUrl(resourceUrl),
    ...(expected.signingKey ? { loadSigningKey: expected.signingKey } : {}),
  });
  return { ok: true, provider };
}

export function classifyOAuthPrepareError(error: unknown, operatorCommand: string): OAuthPrepareError {
  if (error instanceof OAuthOperatorError) {
    return prepareError(error.code, error.message, error.operatorCommand ?? operatorCommand, error.retryAfterSeconds);
  }
  if (error instanceof OAuthScopeChangeRequiredError) {
    return { code: error.code, message: error.message, reason: "oauth_insufficient_scope", operatorCommand };
  }
  if (error instanceof OAuthReauthorizationRequiredError) {
    return prepareError(error.code, error.message, error.operatorCommand);
  }
  if (error instanceof InvalidGrantError || isInvalidGrantError(error)) {
    return prepareError("OAUTH_INVALID_GRANT", `OAuth refresh grant is invalid or revoked. Run ${operatorCommand}.`, operatorCommand);
  }
  if (error instanceof UnauthorizedError || isUnauthorizedError(error) || isPostRefreshAuthenticationFailure(error)) {
    return prepareError(
      "OAUTH_AUTHENTICATION_FAILED",
      `OAuth authentication failed after a reachable target rejected the credentials. Run ${operatorCommand}.`,
      operatorCommand,
    );
  }
  return {
    code: "TARGET_UNAVAILABLE",
    message: `MCP HTTP target could not be connected and initialized: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * Builds an agent-facing rejection. Login advice is included only where running login
 * can help; an entitlement denial, a declined consent, a temporary outage or a client
 * configuration fault never suggests it (§11).
 */
function prepareError(
  code: OAuthPrepareErrorCode,
  message: string,
  operatorCommand: string | undefined,
  retryAfterSeconds?: number,
): OAuthPrepareError {
  const reason = oauthReasonForCode(code);
  const advise = operatorCommand !== undefined && reason !== undefined && !NO_LOGIN_ADVICE.has(reason);
  return {
    code,
    message: advise && !message.includes(operatorCommand) ? `${message} Run ${operatorCommand}.` : message,
    ...(reason ? { reason } : {}),
    ...(advise ? { operatorCommand } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function refreshUncertainMessage(operatorCommand: string): string {
  return "OAuth token refresh may have rotated the grant without a usable response. " +
    `The adapter will not resend the previous refresh token. Run ${operatorCommand}.`;
}

/**
 * Selects the scopes for an operator login.
 *
 * Explicit configuration keeps the shipped behavior (OAUTH-05A, P4-06): every
 * configured scope must be advertised. Without configuration, §4.2 applies: the
 * resource's challenge scope, otherwise its protected-resource `scopes_supported`,
 * otherwise no `scope`; authorization-server `scopes_supported` is never merged into
 * that baseline. A refresh scope is added only when the authorization server
 * advertises it, and its absence is a warning, never a failure (§4.2).
 */
export function resolveRequestedOAuthScopes(input: {
  configuredScopes?: string[];
  refreshScope?: string;
  /** Every advertised scope; used to validate explicit configuration. */
  supportedScopes: string[];
  /** Protected-resource `scopes_supported`, when published. */
  resourceScopes?: string[];
  /** Authorization-server `scopes_supported`; defaults to `supportedScopes`. */
  authorizationServerScopes?: string[];
  /** The scope in the resource's unauthenticated Bearer challenge, when present. */
  challengeScopes?: string[];
  /** Previously granted scopes that current policy still permits (P4-05). */
  previousGrantedScopes?: string[];
}):
  | { ok: true; scopes: string[]; warnings: OAuthOperatorWarning[] }
  | { ok: false; requestedScope: string; supportedScopes: string[]; message: string } {
  const refreshScope = input.refreshScope?.trim() || DEFAULT_OAUTH_REFRESH_SCOPE;
  const supported = input.supportedScopes;
  const configured = input.configuredScopes;
  for (const scope of configured ?? []) {
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
  const baseline = configured ?? (
    input.challengeScopes?.length ? input.challengeScopes : input.resourceScopes ?? []
  );
  const scopes = [...baseline];
  for (const scope of input.previousGrantedScopes ?? []) {
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  const selectedRefreshScope = selectRefreshScope(refreshScope, input.authorizationServerScopes ?? supported);
  if (selectedRefreshScope.warning) warnings.push(selectedRefreshScope.warning);
  if (selectedRefreshScope.scope && !scopes.includes(selectedRefreshScope.scope)) scopes.push(selectedRefreshScope.scope);
  return { ok: true, scopes, warnings };
}

function selectRefreshScope(
  preferred: string,
  supported: string[],
): { scope?: string; warning?: OAuthOperatorWarning } {
  if (supported.includes(preferred)) return { scope: preferred };
  if (preferred !== DEFAULT_OAUTH_REFRESH_SCOPE && supported.includes(DEFAULT_OAUTH_REFRESH_SCOPE)) {
    return {
      scope: DEFAULT_OAUTH_REFRESH_SCOPE,
      warning: {
        code: "OAUTH_REFRESH_SCOPE_NOT_ADVERTISED",
        message: `Plugin refresh scope "${preferred}" is not advertised; using ${DEFAULT_OAUTH_REFRESH_SCOPE}. Supported: ${formatSupportedScopes(supported)}.`,
      },
    };
  }
  return {
    warning: {
      code: "OAUTH_REFRESH_SCOPE_NOT_ADVERTISED",
      message: `Refresh scope "${preferred}" is not advertised by the authorization server and ${DEFAULT_OAUTH_REFRESH_SCOPE} is not available; no refresh scope is requested. The server may still issue a refresh token. Supported: ${formatSupportedScopes(supported)}.`,
    },
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

function authorizedResult(
  session: StoredOAuthSession,
  extraWarnings: OAuthOperatorWarning[] = [],
  operatorCommand?: string,
): OAuthOperatorResult {
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
  const requestedScopes = session.binding?.requestedScopes ?? [];
  // §4.2: requested and granted stay distinct. An omitted initial `scope` means the
  // requested set was granted (RFC 6749 §5.1).
  const grantedScopes = typeof session.tokens?.scope === "string"
    ? session.tokens.scope.split(/\s+/).filter(Boolean)
    : requestedScopes;
  const warnings = [...extraWarnings, ...postLoginWarnings(session)];
  const expiredWithoutRefresh = isAccessTokenExpired(session.tokens, session.tokensSavedAt)
    && typeof session.tokens?.refresh_token !== "string";
  const condition = sessionCondition(session, expiredWithoutRefresh);
  const advise = operatorCommand !== undefined && condition.reason !== undefined && !NO_LOGIN_ADVICE.has(condition.reason);
  return {
    status: "authorized",
    applicationDid: session.applicationDid,
    issuer: session.binding?.issuer ?? session.discovery?.authorizationServerUrl ?? "unknown",
    resource: session.resourceUrl,
    clientMode: session.binding?.clientMode ?? (session.clientInformation ? "dynamic" : "static"),
    clientAuthentication: session.binding?.clientAuthentication?.method ?? "none",
    scopes: uniqueScopes(session.binding?.requestedScopes, scope.split(/\s+/).filter(Boolean)),
    requestedScopes,
    grantedScopes,
    ...(expiresIn && Number.isFinite(savedAt) ? { expiresAt: new Date(savedAt + expiresIn * 1000).toISOString() } : {}),
    refreshable: typeof session.tokens?.refresh_token === "string",
    reauthorizationRequired: session.reauthorizationRequired === true || expiredWithoutRefresh,
    state: condition.state,
    ...(condition.reason ? { reason: condition.reason } : {}),
    ...(advise ? { operatorCommand } : {}),
    ...(condition.retryAfter ? { retryAfter: condition.retryAfter } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** The status state and §11 reason for a stored session, most specific first. */
function sessionCondition(
  session: StoredOAuthSession,
  expiredWithoutRefresh: boolean,
): { state: OAuthSessionState; reason?: OAuthReasonCode; retryAfter?: string } {
  if (session.accessDenied) return { state: "access_denied", reason: "oauth_access_denied" };
  if (session.reauthorizationRequired) return { state: "reauthorization_required", reason: "oauth_reauthorization_required" };
  if (session.refreshState?.status === "uncertain") return { state: "refresh_uncertain", reason: "oauth_token_refresh_failed" };
  if (expiredWithoutRefresh) return { state: "login_required", reason: "oauth_login_required" };
  const retryAfter = session.refreshState?.retryAfter;
  if (session.refreshState?.status === "deferred" && retryAfter && Date.parse(retryAfter) > Date.now()) {
    return { state: "rate_limited", reason: "oauth_rate_limited", retryAfter };
  }
  return { state: "authorized" };
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
      // §11.1: state and issuer are verified above before the error is interpreted.
      if (url.searchParams.has("error")) throw callbackError(url.searchParams.get("error"));
      const authorizationCode = url.searchParams.get("code");
      if (!authorizationCode) throw new Error("OAuth callback is missing an authorization code");
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end("OAuth authorization complete. You may close this window.");
      settle?.(authorizationCode);
    } catch (error) {
      consuming = true;
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        .end("OAuth authorization was not completed. You may close this window.");
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

/**
 * Maps a validated authorization callback error. `error_description` and `error_uri`
 * are never read: no recovery is chosen from free text and no URL is followed (§11.1).
 */
function callbackError(value: string | null): OAuthOperatorError {
  const error = sanitizeOAuthErrorCode(value);
  const diagnostic = { phase: "authorization", ...(error ? { error } : {}) };
  switch (error) {
    case "access_denied":
      return new OAuthOperatorError(
        "OAUTH_AUTHORIZATION_DENIED",
        "Authorization was denied at the authorization server. The connection was not completed and login was not restarted.",
        { diagnostic },
      );
    case "invalid_scope":
      return new OAuthOperatorError(
        "OAUTH_INSUFFICIENT_SCOPE",
        "The authorization server rejected the requested scopes (invalid_scope). Review the configured scopes; login was not retried.",
        { diagnostic },
      );
    case "temporarily_unavailable":
    case "server_error":
      return new OAuthOperatorError(
        "OAUTH_TEMPORARILY_UNAVAILABLE",
        "The authorization server is temporarily unavailable. Run login again later.",
        { diagnostic },
      );
    default:
      return new OAuthOperatorError(
        "OAUTH_UNKNOWN_ERROR",
        "The authorization server returned an unrecognized authorization error. No recovery was attempted.",
        { diagnostic },
      );
  }
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
  const auditPath = expected.auditPath ?? join(credentialDir, "oauth-audit.jsonl");
  const loaded = await readBoundOAuthSession(sessionName, credentialHandle, applicationDid, resourceUrl, credentialDir);
  if (!loaded || loaded.session.reauthorizationRequired) {
    throw new OAuthReauthorizationRequiredError(operatorCommand);
  }
  if (loaded.session.refreshState?.status === "uncertain") {
    throw new OAuthOperatorError("OAUTH_TOKEN_REFRESH_FAILED", refreshUncertainMessage(operatorCommand), { operatorCommand });
  }
  const refreshPolicy = normalizeRefreshPolicy(expected.refresh);
  if (!shouldRefreshAccessToken(loaded.session, refreshPolicy)) return;
  if (typeof loaded.session.tokens?.refresh_token !== "string") {
    throw new OAuthOperatorError(
      "OAUTH_LOGIN_REQUIRED",
      `OAuth access token expired and the server issued no refresh token. Run ${operatorCommand}.`,
      { operatorCommand },
    );
  }

  let responded = false;
  const fetchFn = observeTokenRequests(createOAuthFetchPolicy({
    bearerTokenResourceUrl: resourceUrl,
    testOnlyAllowHttpLoopback: isLoopbackUrl(resourceUrl),
    ...(expected.fetch ? { fetch: expected.fetch } : {}),
  }), { onResponse: () => { responded = true; } });
  const binding = loaded.session.binding;
  const discovery = loaded.session.discovery;
  const clientInformation = loaded.session.clientInformation;
  if (!discovery || !clientInformation) {
    await markReauthorizationRequired(loaded.session, path, auditPath, "grant_unusable");
    throw new OAuthReauthorizationRequiredError(operatorCommand);
  }
  if (binding?.clientMode === "cimd") {
    // OAUTH-15D, P3-08: the client authentication method is part of the binding. A
    // document whose method changed since login makes the session unusable.
    await assertClientDocumentUnchanged(loaded.session, path, auditPath, binding, discovery, fetchFn, expected.signingKey, operatorCommand);
  }
  const provider = new FileOAuthClientProvider(loaded.session, loaded.path, false, {
    persistAuthorizationArtifacts: false,
    operatorCommand,
    testOnlyAllowHttpLoopback: isLoopbackUrl(resourceUrl),
    ...(expected.signingKey ? { loadSigningKey: expected.signingKey } : {}),
  }, binding ? {
    client: clientConfigurationForBinding(binding),
    clientConfiguration: binding.clientConfiguration,
    requestedScopes: binding.requestedScopes,
    scopeConfiguration: binding.scopeConfiguration ?? canonicalScopeConfiguration(binding.requestedScopes, undefined),
    authorizationResponseIssuerRequired: () => binding.authorizationResponseIssuerRequired,
    expectedIssuer: binding.issuer,
    refreshPolicy,
    fetchFn,
    ...(expected.signingKey ? { loadSigningKey: expected.signingKey } : {}),
  } : undefined);
  const addClientAuthentication = provider.addClientAuthentication;
  try {
    const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation,
      refreshToken: loaded.session.tokens.refresh_token,
      resource: new URL(resourceUrl),
      fetchFn,
      ...(addClientAuthentication ? { addClientAuthentication } : {}),
    });
    await provider.saveTokens(tokens);
    await appendOAuthAudit(auditPath, loaded.session, "credential-adapter", "refresh", "succeeded");
  } catch (error) {
    const failure = error instanceof OAuthOperatorError
      ? error
      : responded
        // A 2xx whose body could not be used: the grant may already have rotated.
        ? new OAuthOperatorError("OAUTH_TOKEN_REFRESH_FAILED", "The refresh response could not be used", { cause: error, ambiguous: true })
        : new OAuthOperatorError("OAUTH_UNKNOWN_ERROR", "OAuth token refresh failed before a response was received", { cause: error });
    await persistTokenFailure(loaded.session, path, failure, auditPath);
    throw withOperatorCommand(failure, operatorCommand);
  }
}

/**
 * Persists what a token-endpoint failure proves about the stored grant (OAUTH-29,
 * OAUTH-30). Nothing here erases the stored tokens.
 */
async function persistTokenFailure(
  session: StoredOAuthSession,
  path: string,
  failure: OAuthOperatorError,
  auditPath?: string,
): Promise<void> {
  if (failure.code === "OAUTH_INVALID_GRANT") {
    if (auditPath) await markReauthorizationRequired(session, path, auditPath, "invalid_grant");
    else {
      session.reauthorizationRequired = true;
      session.reauthorizationReason = "invalid_grant";
      await writeSession(path, session);
    }
    return;
  }
  if (failure.ambiguous) {
    session.refreshState = { status: "uncertain", at: new Date().toISOString() };
    await writeSession(path, session);
    if (auditPath) await appendOAuthAudit(auditPath, session, "credential-adapter", "refresh", "uncertain");
    return;
  }
  if (failure.code === "OAUTH_RATE_LIMITED") {
    const seconds = failure.retryAfterSeconds ?? 60;
    session.refreshState = {
      status: "deferred",
      at: new Date().toISOString(),
      retryAfter: new Date(Date.now() + seconds * 1000).toISOString(),
    };
    await writeSession(path, session);
  }
  if (auditPath) await appendOAuthAudit(auditPath, session, "credential-adapter", "refresh", "failed");
}

function withOperatorCommand(failure: OAuthOperatorError, operatorCommand: string): OAuthOperatorError {
  if (failure.operatorCommand) return failure;
  const reason = oauthReasonForCode(failure.code);
  if (!reason || NO_LOGIN_ADVICE.has(reason)) return failure;
  const message = failure.code === "OAUTH_INVALID_GRANT"
    ? `OAuth refresh grant is invalid or revoked. Run ${operatorCommand}.`
    : failure.ambiguous ? refreshUncertainMessage(operatorCommand) : failure.message;
  return new OAuthOperatorError(failure.code, message, {
    cause: failure,
    operatorCommand,
    ambiguous: failure.ambiguous,
    ...(failure.retryAfterSeconds !== undefined ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
    ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
  });
}

async function assertClientDocumentUnchanged(
  session: StoredOAuthSession,
  path: string,
  auditPath: string,
  binding: OAuthAuthorizationBinding,
  discovery: OAuthDiscoveryState,
  fetchFn: FetchLike,
  loadSigningKey: LoadClientSigningKey | undefined,
  operatorCommand: string,
): Promise<void> {
  let document: Record<string, unknown>;
  try {
    document = await validateClientMetadataDocument(binding.clientId, binding.redirectUrl, true, fetchFn);
  } catch (error) {
    if (error instanceof OAuthOperatorError &&
        (error.code === "OAUTH_TEMPORARILY_UNAVAILABLE" || error.code === "OAUTH_RATE_LIMITED")) {
      throw error;
    }
    await markReauthorizationRequired(session, path, auditPath, "binding_mismatch");
    throw new OAuthReauthorizationRequiredError(
      operatorCommand,
      `The OAuth client document no longer matches this session. Run ${operatorCommand}.`,
    );
  }
  const declared = document.token_endpoint_auth_method ?? "none";
  const bound = binding.clientAuthentication?.method ?? "none";
  if (declared !== bound) {
    await markReauthorizationRequired(session, path, auditPath, "binding_mismatch");
    throw new OAuthReauthorizationRequiredError(
      operatorCommand,
      `The OAuth client document's authentication method changed since login. Run ${operatorCommand}.`,
    );
  }
  if (binding.clientAuthentication) {
    const current = await selectClientAuthentication({
      document,
      metadata: discovery.authorizationServerMetadata as Record<string, unknown> | undefined,
      loadSigningKey,
    });
    if (current?.keyDid !== binding.clientAuthentication.keyDid || current.algorithm !== binding.clientAuthentication.algorithm) {
      await markReauthorizationRequired(session, path, auditPath, "binding_mismatch");
      throw new OAuthReauthorizationRequiredError(
        operatorCommand,
        `The OAuth client key changed since login. Run ${operatorCommand}.`,
      );
    }
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
  if (!binding) return Object.keys(expected).filter((key) => !NON_BINDING_EXPECTATIONS.has(key)).length === 0;
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
  const registrationFailed = (message: string) => new OAuthOperatorError("OAUTH_CLIENT_REGISTRATION_FAILED", message);
  if (client.type === "static" || (client.type === "auto" && client.clientId)) {
    const configuredClientId = client.clientId;
    if (!configuredClientId || existing?.client_id !== configuredClientId) {
      throw registrationFailed("OAuth static client information is unavailable or does not match configuration");
    }
    return { mode: "static", clientId: configuredClientId };
  }
  if (client.type === "cimd") {
    // OAUTH-12A, §4.1: no dynamic registration and no public-client fallback.
    if (metadata?.client_id_metadata_document_supported !== true) {
      throw registrationFailed("OAuth CIMD mode is configured but the authorization server does not advertise it");
    }
    return { mode: "cimd", clientId: client.clientIdMetadataDocument };
  }
  if (client.type === "dynamic") {
    if (!metadata?.registration_endpoint) {
      throw registrationFailed("OAuth dynamic client registration is configured but not advertised");
    }
    return { mode: "dynamic", clientId: existing?.client_id ?? "dynamic-registration-pending" };
  }
  if (client.clientIdMetadataDocument && metadata?.client_id_metadata_document_supported === true) {
    return { mode: "cimd", clientId: client.clientIdMetadataDocument };
  }
  if (metadata?.registration_endpoint) {
    return { mode: "dynamic", clientId: existing?.client_id ?? "dynamic-registration-pending" };
  }
  throw registrationFailed("OAuth auto client selection found no static client, advertised CIMD, or advertised dynamic registration");
}

function assertCimdUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthOperatorError("OAUTH_CLIENT_REGISTRATION_FAILED", "OAuth Client ID Metadata Document URL is invalid");
  }
  if (url.protocol !== "https:" || url.pathname === "/") {
    throw new OAuthOperatorError(
      "OAUTH_CLIENT_REGISTRATION_FAILED",
      "OAuth Client ID Metadata Document URL must use HTTPS and contain a non-root path",
    );
  }
}

const MAX_CLIENT_METADATA_DOCUMENT_BYTES = 65_536;
const LOOPBACK_REDIRECT_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/**
 * Fetches and validates a Client ID Metadata Document (OAUTH-12). Retrieval failures
 * keep their cause (§6): a timeout, 429 or 5xx is temporary and never evidence that
 * the identity is invalid.
 */
export async function validateClientMetadataDocument(
  clientId: string,
  redirectUrl: string | undefined,
  refreshRequested: boolean,
  fetchFn: FetchLike | undefined,
): Promise<Record<string, unknown>> {
  assertCimdUrl(clientId);
  if (!redirectUrl || !fetchFn) {
    throw new OAuthOperatorError("OAUTH_CLIENT_REGISTRATION_FAILED", "OAuth CIMD validation prerequisites are unavailable");
  }
  let response: Response;
  try {
    response = await fetchFn(clientId, { redirect: "manual" });
  } catch (error) {
    if (isTransportFailure(error)) {
      throw new OAuthOperatorError(
        "OAUTH_TEMPORARILY_UNAVAILABLE",
        "OAuth Client ID Metadata Document is temporarily unavailable",
        { cause: error, diagnostic: { phase: "client_metadata" } },
      );
    }
    throw new OAuthOperatorError(
      "OAUTH_CLIENT_REGISTRATION_FAILED",
      `OAuth Client ID Metadata Document could not be loaded: ${error instanceof Error ? error.message : "request rejected"}`,
      { cause: error },
    );
  }
  const diagnostic = { status: response.status, phase: "client_metadata" };
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    throw new OAuthOperatorError("OAUTH_RATE_LIMITED", "OAuth Client ID Metadata Document retrieval is rate limited", {
      diagnostic,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    throw new OAuthOperatorError("OAUTH_TEMPORARILY_UNAVAILABLE", "OAuth Client ID Metadata Document is temporarily unavailable", { diagnostic });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new OAuthOperatorError("OAUTH_CLIENT_REGISTRATION_FAILED", "OAuth Client ID Metadata Document could not be loaded", { diagnostic });
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_CLIENT_METADATA_DOCUMENT_BYTES) {
    throw new OAuthOperatorError("OAUTH_CLIENT_REGISTRATION_FAILED", "OAuth Client ID Metadata Document exceeds the size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new OAuthOperatorError("OAUTH_CLIENT_REGISTRATION_FAILED", "OAuth Client ID Metadata Document is not valid JSON");
  }
  return validateClientMetadataDocumentValue(value, clientId, redirectUrl, refreshRequested);
}

/**
 * OAUTH-12, OAUTH-15A, OAUTH-15F field rules. Standard RFC 7591 metadata is accepted
 * subject to field-specific checks; a name containing `token` or `credential` is not a
 * reason to reject. Private key material, secrets and deployment-secret references are.
 */
export function validateClientMetadataDocumentValue(
  value: unknown,
  clientId: string,
  redirectUrl: string,
  refreshRequested: boolean,
): Record<string, unknown> {
  const reject = (message: string) => new OAuthOperatorError("OAUTH_CLIENT_REGISTRATION_FAILED", message);
  if (!isRecord(value)) throw reject("OAuth Client ID Metadata Document must be a JSON object");
  if (value.client_id !== clientId) {
    throw reject("OAuth Client ID Metadata Document client_id does not match its URL");
  }
  if (typeof value.client_name !== "string" || value.client_name.length === 0) {
    throw reject("OAuth Client ID Metadata Document is missing client_name");
  }
  const redirectUris = value.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 ||
      !redirectUris.every((uri) => typeof uri === "string" && uri.length > 0)) {
    throw reject("OAuth Client ID Metadata Document is missing redirect_uris");
  }
  if (!redirectUris.some((registered) => matchesRegisteredRedirectUri(registered as string, redirectUrl))) {
    throw reject("OAuth Client ID Metadata Document does not register the selected redirect URI");
  }
  for (const field of ["grant_types", "response_types"]) {
    const list = value[field];
    if (list !== undefined && (!Array.isArray(list) || !list.every((entry) => typeof entry === "string"))) {
      throw reject(`OAuth Client ID Metadata Document ${field} must be an array of strings`);
    }
  }
  if (refreshRequested && (!Array.isArray(value.grant_types) || !value.grant_types.includes("refresh_token"))) {
    throw reject("OAuth Client ID Metadata Document does not advertise refresh_token");
  }
  if (value.token_endpoint_auth_method !== undefined && typeof value.token_endpoint_auth_method !== "string") {
    throw reject("OAuth Client ID Metadata Document token_endpoint_auth_method must be a string");
  }
  if (value.jwks !== undefined) {
    const keys = isRecord(value.jwks) ? value.jwks.keys : undefined;
    if (!Array.isArray(keys) || !keys.every(isRecord)) {
      throw reject("OAuth Client ID Metadata Document jwks must hold a keys array");
    }
    if (keys.some((key) => PRIVATE_JWK_MEMBERS.some((member) => member in key))) {
      throw reject("OAuth Client ID Metadata Document must not contain private key material");
    }
    if (value.jwks_uri !== undefined) {
      throw reject("OAuth Client ID Metadata Document must not declare both jwks and jwks_uri");
    }
  }
  for (const key of Object.keys(value)) {
    if (/secret|password|private[_-]?key|registration_access_token/i.test(key)) {
      throw reject("OAuth Client ID Metadata Document must not contain credentials or private keys");
    }
  }
  if (JSON.stringify(value).includes("{{credential:")) {
    throw reject("OAuth Client ID Metadata Document must not contain deployment-secret references");
  }
  return value;
}

/**
 * OAUTH-12, RFC 8252 §7.3: a registered loopback HTTP redirect matches the adapter's
 * callback on any port, with scheme, host, path and query unchanged. Every other
 * redirect, HTTPS included, must match exactly. `localhost` never matches an IP literal.
 */
export function matchesRegisteredRedirectUri(registered: string, selected: string): boolean {
  if (registered === selected) return true;
  let left: URL;
  let right: URL;
  try {
    left = new URL(registered);
    right = new URL(selected);
  } catch {
    return false;
  }
  if (left.protocol !== "http:" || !LOOPBACK_REDIRECT_HOSTS.has(left.hostname)) return false;
  return right.protocol === "http:" &&
    right.hostname === left.hostname &&
    right.pathname === left.pathname &&
    right.search === left.search &&
    right.hash === "" && left.hash === "" &&
    right.username === "" && right.password === "" &&
    left.username === "" && left.password === "";
}

function boundedJitter(maximum: number): number {
  const bounded = Math.min(Math.max(maximum, 0), MAX_OAUTH_REFRESH_JITTER_MS);
  if (bounded === 0) return 0;
  return randomBytes(4).readUInt32BE(0) % (bounded + 1);
}

async function revokeAdvertisedTokens(
  session: StoredOAuthSession,
  options: Pick<FileOAuthOperatorServiceOptions, "fetch" | "testOnlyAllowHttpLoopback"> & {
    loadSigningKey?: LoadClientSigningKey;
  },
): Promise<{ outcome: "succeeded" | "unavailable" | "failed"; reason?: OAuthReasonCode }> {
  const metadata = session.discovery?.authorizationServerMetadata;
  const rawMetadata = metadata as unknown as Record<string, unknown> | undefined;
  const endpoint = typeof rawMetadata?.revocation_endpoint === "string"
    ? rawMetadata.revocation_endpoint
    : undefined;
  const accessToken = session.tokens?.access_token;
  const refreshToken = session.tokens?.refresh_token;
  if (!endpoint || (!accessToken && !refreshToken)) return { outcome: "unavailable" };
  const clientAuthentication = session.binding?.clientAuthentication;
  if (clientAuthentication) {
    // OAUTH-15G: never send an unauthenticated revocation for a private_key_jwt client.
    try {
      assertRevocationAuthentication(clientAuthentication, rawMetadata);
    } catch {
      return { outcome: "failed", reason: "oauth_client_authentication_failed" };
    }
  }
  const fetchFn = createOAuthFetchPolicy({
    fetch: options.fetch,
    testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback,
  });
  const tokens = [
    ...(refreshToken ? [{ value: refreshToken, hint: "refresh_token" }] : []),
    ...(accessToken ? [{ value: accessToken, hint: "access_token" }] : []),
  ];
  let succeeded = true;
  let reason: OAuthReasonCode | undefined;
  for (const token of tokens) {
    const body = new URLSearchParams({ token: token.value, token_type_hint: token.hint });
    if (session.clientInformation?.client_id) body.set("client_id", session.clientInformation.client_id);
    if (session.clientInformation?.client_secret) body.set("client_secret", session.clientInformation.client_secret);
    try {
      if (clientAuthentication && session.binding) {
        await applyClientAssertion(body, {
          clientId: session.binding.clientId,
          audience: session.binding.issuer,
          binding: clientAuthentication,
          loadSigningKey: options.loadSigningKey,
        });
      }
    } catch {
      return { outcome: "failed", reason: "oauth_client_authentication_failed" };
    }
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) {
        succeeded = false;
        const failure = await tokenErrorFromResponse(response, "revocation");
        reason ??= oauthReasonForCode(failure.code);
      }
    } catch {
      succeeded = false;
      reason ??= "oauth_temporarily_unavailable";
    }
  }
  return succeeded ? { outcome: "succeeded" } : { outcome: "failed", ...(reason ? { reason } : {}) };
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
  state: "authorized" | "refresh_due" | "login_required" | "reauthorization_required" | "refresh_uncertain" | "missing" | "malformed" | "misbound" | "insecure_permissions" | "access_denied";
  error?: "OAUTH_LOGIN_REQUIRED" | "OAUTH_REAUTHORIZATION_REQUIRED" | "OAUTH_TOKEN_REFRESH_FAILED" | "OAUTH_SESSION_NOT_FOUND" | "OAUTH_SESSION_MALFORMED" | "OAUTH_SESSION_BINDING_MISMATCH" | "OAUTH_SESSION_INSECURE_PERMISSIONS" | "OAUTH_SESSION_ACCESS_DENIED";
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
  if (session.refreshState?.status === "uncertain") {
    return { ok: false, state: "refresh_uncertain", error: "OAUTH_TOKEN_REFRESH_FAILED" };
  }
  if (shouldRefreshAccessToken(session, normalizeRefreshPolicy(request.refresh))) {
    if (typeof session.tokens.refresh_token === "string") return { ok: true, state: "refresh_due" };
    // §4.2: no refresh token was issued; the session ends at expiry.
    return isAccessTokenExpired(session.tokens, session.tokensSavedAt)
      ? { ok: false, state: "login_required", error: "OAUTH_LOGIN_REQUIRED" }
      : { ok: true, state: "authorized" };
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

interface LoginDiscovery {
  challengeScopes?: string[];
  resourceMetadataUrl?: string;
  resourceScopes?: string[];
  authorizationServerScopes?: string[];
}

/**
 * §5 steps 1-4 for operator login. The resource is first contacted without
 * credentials so its challenge scope and `resource_metadata` can be used (OAUTH-11A,
 * §4.2). Resource and authorization-server scope lists are kept apart (P4-01).
 */
async function discoverLoginScopes(resourceUrl: string, fetchFn: FetchLike): Promise<LoginDiscovery> {
  const challenge = await probeResourceChallenge(resourceUrl, fetchFn);
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(resourceUrl, {
      fetchFn,
      ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: new URL(challenge.resourceMetadataUrl) } : {}),
    });
  } catch (error) {
    if (error instanceof OAuthOperatorError) throw error;
    throw new OAuthOperatorError(
      "OAUTH_DISCOVERY_FAILED",
      `OAuth metadata discovery failed: ${error instanceof Error ? error.message : "invalid metadata"}`,
      { cause: error },
    );
  }
  if (!info.resourceMetadata || !info.authorizationServerMetadata) {
    throw new OAuthOperatorError("OAUTH_DISCOVERY_FAILED", "OAuth protected-resource or authorization-server metadata is missing");
  }
  return {
    ...(challenge.scopes ? { challengeScopes: challenge.scopes } : {}),
    ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
    ...(Array.isArray(info.resourceMetadata.scopes_supported)
      ? { resourceScopes: uniqueScopes(info.resourceMetadata.scopes_supported) }
      : {}),
    ...(Array.isArray(info.authorizationServerMetadata.scopes_supported)
      ? { authorizationServerScopes: uniqueScopes(info.authorizationServerMetadata.scopes_supported) }
      : {}),
  };
}

async function probeResourceChallenge(
  resourceUrl: string,
  fetchFn: FetchLike,
): Promise<{ scopes?: string[]; resourceMetadataUrl?: string }> {
  let response: Response;
  try {
    response = await fetchFn(resourceUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "mpas-credential-adapter", version: "1.0.0" },
        },
      }),
    });
  } catch {
    // The probe is advisory; protected-resource discovery below is authoritative.
    return {};
  }
  await response.body?.cancel().catch(() => {});
  if (response.status !== 401) return {};
  const { scope, resourceMetadataUrl } = extractWWWAuthenticateParams(response);
  const scopes = scope?.split(/ +/).filter(Boolean).slice(0, 64);
  return {
    ...(scopes?.length ? { scopes } : {}),
    ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.toString() } : {}),
  };
}

/**
 * P4-05: operator reauthorization keeps previously granted scopes that current policy
 * permits. With explicit scopes that is the configured set; with discovery delegation
 * it is the prior grant for the same binding. Removed permissions are not retained
 * as authority; a refused scope is reported once by the authorization server.
 */
function reauthorizationScopes(previous: StoredOAuthSession | undefined, request: OAuthOperatorRequest): string[] {
  if (!previous?.tokens || previous.applicationDid !== request.applicationDid ||
      canonicalResourceUrl(previous.resourceUrl) !== canonicalResourceUrl(request.resourceUrl)) return [];
  const granted = typeof previous.tokens.scope === "string"
    ? previous.tokens.scope.split(/\s+/).filter(Boolean)
    : previous.binding?.requestedScopes ?? [];
  if (request.scopes) return granted.filter((scope) => request.scopes!.includes(scope));
  return granted;
}

/** Records request outcomes during one login phase so failures keep their cause (§6, §11.1). */
class OAuthRequestEvidence {
  private phase = "discovery";
  private failures: Array<{ status?: number; transport?: boolean; retryAfterSeconds?: number }> = [];

  begin(phase: string): void {
    this.phase = phase;
    this.failures = [];
  }

  observe(fetchFn: FetchLike): FetchLike {
    return async (input, init) => {
      try {
        const response = await fetchFn(input, init);
        if (response.status === 429 || response.status >= 500) {
          const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
          this.failures.push({ status: response.status, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) });
        }
        return response;
      } catch (error) {
        if (isTransportFailure(error)) this.failures.push({ transport: true });
        throw error;
      }
    };
  }

  temporaryFailure(cause: unknown): OAuthOperatorError | undefined {
    const limited = this.failures.find((failure) => failure.status === 429);
    if (limited) {
      return new OAuthOperatorError("OAUTH_RATE_LIMITED", `An OAuth ${this.phase} endpoint is rate limited`, {
        cause,
        diagnostic: { status: 429, phase: this.phase },
        ...(limited.retryAfterSeconds !== undefined ? { retryAfterSeconds: limited.retryAfterSeconds } : {}),
      });
    }
    const unavailable = this.failures.find((failure) => failure.transport || (failure.status ?? 0) >= 500);
    if (unavailable) {
      return new OAuthOperatorError("OAUTH_TEMPORARILY_UNAVAILABLE", `An OAuth ${this.phase} endpoint is temporarily unavailable`, {
        cause,
        diagnostic: { phase: this.phase, ...(unavailable.status ? { status: unavailable.status } : {}) },
      });
    }
    return undefined;
  }

  get currentPhase(): string {
    return this.phase;
  }
}

function classifyLoginFailure(error: unknown, evidence: OAuthRequestEvidence): unknown {
  if (error instanceof OAuthOperatorError) {
    // A discovery or registration verdict reached while a temporary failure was
    // observed is reported as temporary: an outage is not invalid enrollment (§6).
    if (error.code === "OAUTH_DISCOVERY_FAILED" || error.code === "OAUTH_CLIENT_REGISTRATION_FAILED") {
      return evidence.temporaryFailure(error) ?? error;
    }
    return error;
  }
  if (error instanceof OAuthScopeChangeRequiredError || error instanceof OAuthReauthorizationRequiredError) return error;
  const temporary = evidence.temporaryFailure(error);
  if (temporary) return temporary;
  if (error instanceof OAuthIssuerMismatchError || error instanceof OAuthPkceMetadataError ||
      evidence.currentPhase === "discovery") {
    return new OAuthOperatorError("OAUTH_DISCOVERY_FAILED", error instanceof Error ? error.message : "OAuth discovery failed", { cause: error });
  }
  return error;
}

/** Network-level failures: fetch rejects with these, never for an HTTP response. */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof OAuthOperatorError) return false;
  if (error instanceof HardenedFetchError) return true;
  if (error instanceof OAuthFetchPolicyError) return error.cause instanceof HardenedFetchError;
  if (connectFailureCode(error) !== undefined || isDnsFailure(error)) return true;
  return error instanceof TypeError ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}

/** A name that did not resolve proves no request reached a server (OAUTH-30). */
function isDnsFailure(error: unknown, depth = 0): boolean {
  if (depth > 4 || error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
  return isDnsFailure((error as { cause?: unknown }).cause, depth + 1);
}

/**
 * Classifies token-endpoint responses before the MCP SDK sees them, so an OAuth
 * error never triggers the SDK's own retry with the same code or refresh token
 * (OAUTH-18, OAUTH-30) and `invalid_client` is never mistaken for a user-grant
 * failure (§11.1).
 */
function observeTokenRequests(
  fetchFn: FetchLike,
  hooks: {
    onFailure?: (failure: OAuthOperatorError) => void;
    onResponse?: (status: number, grantType: "authorization_code" | "refresh_token") => void;
  } = {},
): FetchLike {
  return async (input, init) => {
    const grantType = tokenGrantType(init);
    if (!grantType) return fetchFn(input, init);
    let response: Response;
    try {
      response = await fetchFn(input, init);
    } catch (error) {
      if (error instanceof OAuthOperatorError) throw error;
      const failure = tokenTransportFailure(error, grantType);
      hooks.onFailure?.(failure);
      throw failure;
    }
    hooks.onResponse?.(response.status, grantType);
    if (response.ok) {
      if (grantType !== "refresh_token") return response;
      // OAUTH-30: the server answered success, so it may have rotated the grant. A body
      // the adapter cannot use is ambiguous, never a reason to resend the old token.
      const usable = await usableRefreshResponse(response);
      if (usable) return usable;
      const failure = new OAuthOperatorError("OAUTH_TOKEN_REFRESH_FAILED", "The refresh response could not be used", {
        ambiguous: true,
        diagnostic: { status: response.status, phase: grantType },
      });
      hooks.onFailure?.(failure);
      throw failure;
    }
    const failure = await tokenErrorFromResponse(response, grantType);
    hooks.onFailure?.(failure);
    throw failure;
  };
}

const MAX_TOKEN_RESPONSE_BYTES = 65_536;

/**
 * Re-creates a successful refresh response for the SDK when its body is a usable
 * Bearer token response (RFC 6749 §5.1, RFC 6750); otherwise returns undefined.
 * The SDK's own schema accepts any `token_type`, which this adapter cannot present.
 */
async function usableRefreshResponse(response: Response): Promise<Response | undefined> {
  let text: string;
  let body: unknown;
  try {
    text = await response.text();
    if (text.length > MAX_TOKEN_RESPONSE_BYTES) return undefined;
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(body)) return undefined;
  if (typeof body.access_token !== "string" || body.access_token.length === 0) return undefined;
  if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") return undefined;
  if (body.refresh_token !== undefined && typeof body.refresh_token !== "string") return undefined;
  if (body.scope !== undefined && typeof body.scope !== "string") return undefined;
  // The SDK coerces a numeric string, which some servers send.
  const expiresIn = body.expires_in;
  if (expiresIn !== undefined &&
      !(typeof expiresIn === "number" && Number.isFinite(expiresIn)) &&
      !(typeof expiresIn === "string" && /^\d{1,10}$/.test(expiresIn))) {
    return undefined;
  }
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

function tokenGrantType(init: RequestInit | undefined): "authorization_code" | "refresh_token" | undefined {
  if (init?.method?.toUpperCase() !== "POST" || !(init.body instanceof URLSearchParams)) return undefined;
  const grantType = init.body.get("grant_type");
  return grantType === "authorization_code" || grantType === "refresh_token" ? grantType : undefined;
}

function tokenTransportFailure(error: unknown, grantType: "authorization_code" | "refresh_token"): OAuthOperatorError {
  const diagnostic = { phase: grantType };
  if (connectFailureCode(error) !== undefined || isDnsFailure(error)) {
    // Proven to precede processing: no request bytes reached the server (OAUTH-30).
    return new OAuthOperatorError("OAUTH_TEMPORARILY_UNAVAILABLE", "The token endpoint could not be reached; the request was not processed", {
      cause: error,
      diagnostic,
    });
  }
  if (grantType === "refresh_token") {
    return new OAuthOperatorError("OAUTH_TOKEN_REFRESH_FAILED", "The refresh request may have been processed without a usable response", {
      cause: error,
      ambiguous: true,
      diagnostic,
    });
  }
  return new OAuthOperatorError("OAUTH_TEMPORARILY_UNAVAILABLE", "The authorization code exchange did not complete; run login again", {
    cause: error,
    diagnostic,
  });
}

async function tokenErrorFromResponse(
  response: Response,
  phase: "authorization_code" | "refresh_token" | "revocation",
): Promise<OAuthOperatorError> {
  const status = response.status;
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
  let error: string | undefined;
  try {
    const text = await response.text();
    if (text.length <= 16_384) {
      const parsed = JSON.parse(text) as unknown;
      error = isRecord(parsed) ? sanitizeOAuthErrorCode(parsed.error) : undefined;
    }
  } catch {
    // An unparseable body stays unknown.
  }
  const diagnostic = { status, phase, ...(error ? { error } : {}) };
  if (error === "invalid_client") {
    return new OAuthOperatorError(
      "OAUTH_CLIENT_AUTHENTICATION_FAILED",
      "The authorization server rejected the client authentication (invalid_client). This is a client configuration or enrollment problem, not an invalid user grant.",
      { diagnostic },
    );
  }
  if (status === 429) {
    return new OAuthOperatorError("OAUTH_RATE_LIMITED", "The token endpoint is rate limited", {
      diagnostic,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }
  if (status >= 500) {
    return phase === "refresh_token"
      ? new OAuthOperatorError("OAUTH_TOKEN_REFRESH_FAILED", "The token endpoint failed after the refresh request was sent", { diagnostic, ambiguous: true })
      : new OAuthOperatorError("OAUTH_TEMPORARILY_UNAVAILABLE", "The token endpoint is temporarily unavailable", { diagnostic });
  }
  if (error === "invalid_grant") {
    return new OAuthOperatorError("OAUTH_INVALID_GRANT", "The authorization grant is invalid, expired or revoked", { diagnostic });
  }
  if (error === "invalid_scope") {
    return new OAuthOperatorError("OAUTH_INSUFFICIENT_SCOPE", "The authorization server rejected the requested scopes (invalid_scope)", { diagnostic });
  }
  if (error === "temporarily_unavailable") {
    return new OAuthOperatorError("OAUTH_TEMPORARILY_UNAVAILABLE", "The token endpoint is temporarily unavailable", { diagnostic });
  }
  return new OAuthOperatorError(
    "OAUTH_UNKNOWN_ERROR",
    "The token endpoint returned an unrecognized error. No recovery was attempted.",
    { diagnostic },
  );
}

async function readRawSession(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Puts back exactly what was stored before a failed login, or removes the attempt. */
async function restoreSession(path: string, previous: Buffer | undefined): Promise<void> {
  if (!previous) {
    await rm(path, { force: true });
    return;
  }
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, previous, { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
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
