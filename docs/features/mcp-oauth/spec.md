# Credential Adapter MCP OAuth — Specification

**Status:** Draft v0.2; requirements, not a claim of implementation completeness
**Created:** 2026-08-08
**Updated:** 2026-11-05
**Issue:** [#23 — Credential Adapter: support OAuth 2.1 lifecycle for remote MCP servers](https://github.com/oma3dao/mpas/issues/23)
**Companion:** [plan.md](./plan.md)
**Affects:** Credential Adapter, MCP execution target configuration, operator tooling
**Motivating target:** Official Vercel MCP server (`https://mcp.vercel.com`)
**Normative baseline:** MCP Authorization specification `2026-07-28` and the RFCs/drafts it references

---

## 1. Purpose

Enable a Credential Adapter (CA) to authenticate to OAuth-protected remote MCP servers without requiring an operator to copy short-lived access tokens into static credential configuration.

The CA acts as the OAuth client and owns the complete credential lifecycle inside its trust boundary: discovery, authorization-code flow with PKCE, token storage, refresh, rotation, reauthorization, and revocation. A proposer or MCP bridge may identify the required credential class, but it never receives an access token, refresh token, authorization code, client secret, or PKCE verifier.

OAuth authenticates the CA to the downstream MCP server. It does not authorize an MPAS Action. The CA MUST complete normal MPAS verification and policy evaluation before it may dispatch a tool call with an OAuth credential.

This is the shared authorization contract for CLI and native credential
adapters. Operator commands are the CLI presentation; a native adapter may
provide equivalent trusted foreground controls. The upstream server speaks
standard MCP. The separate MCP Proposer Bridge Profile defines the interface
to the agent, and the MCP Execution Profile defines MPAS dispatch and receipt
classification. This document does not redefine either interface.

## 2. Scope

### 2.1 In scope

- OAuth 2.1 authorization-code flow with PKCE for remote MCP servers.
- MCP protected-resource and authorization-server metadata discovery.
- OAuth Authorization Server Metadata and OpenID Connect Discovery.
- Client ID Metadata Documents, static preregistration, and deprecated
  compatibility-only dynamic client registration.
- Operator-configured static client information when registration is unavailable.
- `private_key_jwt` client authentication (RFC 7523) with the CA's own DID key, when its Client ID Metadata Document declares it.
- Secure persistence and refresh-token rotation.
- Resource and scope binding.
- Operator login, status, reauthorization, logout, and revocation workflows.
- Authenticated MCP Streamable HTTP dispatch.
- Failure mapping, audit events, and secret redaction.
- Headless and remote CA deployments where the browser and callback listener may be on different machines.

### 2.2 Out of scope

- Treating OAuth consent as an MPAS Approval.
- Giving proposers or bridges direct access to OAuth credentials.
- Standardizing one operating-system secret store for every CA implementation.
- OAuth grants other than authorization code + PKCE in the first implementation.
- General-purpose identity-provider account management.
- Changing the MPAS Action Package, Approval, or Execution Receipt formats.

## 3. Roles and trust boundaries

| Role | Responsibility |
| :--- | :--- |
| Operator | Chooses the downstream account, reviews the authorization request, and completes browser consent. |
| Credential Adapter | OAuth client; stores credentials; verifies MPAS authorization; dispatches the approved MCP request. |
| MCP bridge / proposer | Constructs an MPAS Action naming the application and operation. Never handles downstream OAuth secrets. |
| Authorization server | Authenticates the operator, records consent, and issues OAuth credentials. |
| Remote MCP server | Protected resource receiving Bearer-token-authenticated MCP requests. |
| Coordination Service / signers | Coordinate and approve MPAS Actions. They have no access to downstream OAuth credentials. |

OAuth state and tokens are confined to the CA trust boundary. Authorization URLs and non-secret status may be presented to the operator. Callback parameters are accepted only by the CA's OAuth session handler and MUST NOT be copied into an Action Package or coordination record.

## 4. Configuration model

OAuth is selected by an `mcp.http` execution target. The following shape is an implementation contract for the demo CA; a future normative deployment-config schema MAY standardize it without changing the behavioral requirements in this document.

```json
{
  "executionTarget": {
    "type": "mcp.http",
    "url": "https://mcp.example.com",
    "auth": {
      "type": "oauth2",
      "session": "example-production",
      "scopes": ["example:mcp"],
      "scopePolicy": "fixed",
      "client": {
        "type": "auto",
        "clientIdMetadataDocument": "https://adapter.example.com/oauth/client-metadata.json"
      }
    }
  }
}
```

A static client uses a secret-store reference, never an inline secret:

```json
{
  "client": {
    "type": "static",
    "clientId": "example-client-id",
    "clientSecret": "{{credential:example-oauth-client-secret}}"
  }
}
```

Requirements:

| # | Requirement |
| :--- | :--- |
| OAUTH-01 | The session name MUST resolve within the selected Application DID and execution target; it is not a globally interchangeable token handle. |
| OAUTH-02 | The CA MUST bind a session to the tuple `(Application DID, exact canonical MCP resource URI, authorization-server issuer, client identity, granted scopes)`. Resource paths are security boundaries: `https://host/mcp-a` and `https://host/mcp-b` MUST NOT share a resource binding merely because their origins match. |
| OAUTH-03 | Configuration MUST NOT contain access tokens, refresh tokens, authorization codes, PKCE verifiers, or literal client secrets. |
| OAUTH-04 | Redirect URIs and requested scopes MUST be operator-controlled configuration or values derived under documented CA rules. Untrusted MCP tool arguments MUST NOT alter them. |
| OAUTH-05 | Changing the Application DID, exact canonical MCP resource URI, issuer, client identity, or requested scopes MUST invalidate the session for dispatch until the operator authorizes the new binding. |
| OAUTH-05A | `scopePolicy` defaults to `fixed`. Under `fixed`, requests are limited to the configured scopes or, when selection is delegated to discovery, the baseline established during operator login under §4.2. A later challenge requiring a scope outside that baseline produces `oauth_insufficient_scope`. An implementation MAY support operator-initiated `step_up` constrained to a deployment-defined `allowedScopes` allowlist. An Action or tool argument MUST NOT initiate consent or scope escalation. |

### 4.1 Trusted client selection

The exact resource, client metadata document or preregistered identity, callback,
and signing-key reference come from authenticated operator configuration or a
trusted installed capability configuration. They MUST NOT be selected by chat
text, Action arguments, arbitrary server instructions, or an error-supplied URL.
Configuration supplied through a catalog must have accepted publisher/integrity
and version information and follow the deployment's update policy.

A service that requires an enrolled adapter needs its authorized per-install
client document and signing key to be configured before login. A server URL
alone does not supply that enrollment. Discovery determines whether the server
supports the selected client mode; failure MUST NOT silently downgrade to a
public client, register a replacement identity, or select another key. Ordinary
servers remain usable with the deployment's default client configuration.

### 4.2 Scope and refresh intent

Scopes here are permissions issued by the MCP authorization server for the
configured resource. A proxy may separately hold permissions from an upstream
provider. The CA treats scope strings as opaque; a provider prefix in a name
does not make it a second authorization protocol or authorize the CA to contact
that provider directly.

When a deployment explicitly configures scopes, OAUTH-05A applies. When it
leaves scope selection to discovery, initial operator login follows the pinned
MCP priority: the resource's validated challenge scope, otherwise its protected-
resource metadata's scope list, otherwise omit `scope`. Record that selected
request set before consent and use it as the fixed baseline for subsequent
unattended requests. Discovery MUST NOT silently expand an existing session's
scope policy. A later expansion requires an explicit operator workflow.

Refresh support does not require a particular scope name. The client SHOULD
advertise `refresh_token` in its grant types. Under trusted local refresh policy,
it MAY request `offline_access` when the authorization server advertises that
scope. It MUST NOT require `offline_access` in protected-resource metadata or
assume every server issues refresh tokens. If a valid response issues a refresh
token without that scope, the CA may use it under the same session binding.
`offline_access` expresses renewal without repeated interactive login; it grants
neither offline network access nor authority over another provider resource.
The pinned MCP specification says protected resources SHOULD NOT advertise
`offline_access` in their metadata or scope challenges: refresh is not a
resource permission. This is server guidance, not a requirement for the CA to
reject a resource that advertises it.

Keep requested and actually granted scopes distinct. A returned `scope` replaces
the recorded granted set; an omitted value follows OAuth's rules for the relevant
initial or refresh response. Additional returned scopes MUST NOT automatically
expand local configuration or its step-up allowlist. Missing required scopes
produce `oauth_insufficient_scope` for affected dispatch. Operator-initiated
reauthorization SHOULD preserve previously granted scopes where current local
policy permits them; it cannot guarantee that revoked or retired permissions
will be granted again. Do not retain removed permissions as effective authority
or retry `invalid_scope` indefinitely. Provider capability diagnostics belong
to the upstream tool contract unless the authorization server exposes them as
actual OAuth scopes it accepts in requests.

## 5. Discovery and server validation

The CA follows the MCP Authorization specification and the OAuth metadata specifications it references.

1. Connect to the configured MCP resource URL without credentials when no usable session exists.
2. If the response includes a `WWW-Authenticate` challenge with a
   `resource_metadata` parameter, retrieve protected-resource metadata from
   that URL. Otherwise, probe RFC 9728 well-known URIs in this order:
   1. for a resource URI with a path, insert the path after
      `/.well-known/oauth-protected-resource` (for example,
      `https://host/.well-known/oauth-protected-resource/mcp/a`);
   2. probe the origin-root URI
      `https://host/.well-known/oauth-protected-resource`.
3. Select an advertised authorization server under operator policy.
4. Probe authorization-server metadata in the current MCP-required order,
   stopping at the first acceptable document whose `issuer` exactly matches
   the selected issuer:
   1. RFC 8414 OAuth Authorization Server Metadata with well-known path
      insertion;
   2. OpenID Connect Discovery with well-known path insertion;
   3. when the issuer has a path, OpenID Connect Discovery with
      `/.well-known/openid-configuration` appended to the issuer path.
   An unavailable or invalid probe advances to the next candidate. The CA does
   not require multiple published documents to exist or agree on optional
   endpoints.
5. Validate metadata and endpoints before beginning authorization.

| # | Requirement |
| :--- | :--- |
| OAUTH-06 | Production authorization, token, registration, revocation, and protected-resource endpoints MUST use HTTPS. Loopback redirect URIs are the only HTTP exception. |
| OAUTH-07 | Redirects during metadata retrieval MUST be bounded and MUST NOT permit downgrade from HTTPS. |
| OAUTH-08 | For each authorization-server metadata candidate, the CA MUST require exact string equality between the document's `issuer` and the selected issuer. An issuer mismatch makes that candidate invalid and MUST NOT be accepted; discovery then follows the ordered MCP algorithm. |
| OAUTH-09 | The CA MUST reject an authorization server that is not advertised for the configured protected resource unless the operator explicitly pins that issuer in deployment configuration. |
| OAUTH-10 | Discovery responses MUST have size and time limits and MUST be parsed as untrusted input. |
| OAUTH-11 | The CA MUST send the same exact canonical MCP resource URI as the `resource` parameter in the authorization request, authorization-code token exchange, and every refresh-token request. Tokens acquired for one exact resource URI MUST NOT be used for another. |
| OAUTH-11A | The CA MUST prefer a protected resource's `WWW-Authenticate` `resource_metadata` URL. When absent, it MUST probe the RFC 9728 path-specific well-known URI first and the origin-root well-known URI second. A challenge-provided metadata URL remains untrusted and is subject to OAUTH-06 through OAUTH-10. |
| OAUTH-11B | The CA MUST implement the authorization-server probe order in step 4 verbatim. It MUST accept the first valid, exact-issuer document and MUST NOT require a second metadata format to exist or compare optional endpoints across independently published documents. |
| OAUTH-11C | Before starting authorization, the CA MUST verify that `code_challenge_methods_supported` is present and includes `S256`. Missing metadata or a list without `S256` MUST be rejected; the CA MUST NOT infer support or fall back to `plain`. |

## 6. Client registration

The first implementation supports four selection modes. Client ID Metadata Documents
(CIMD) are a first-class mode for current MCP Authorization interoperability;
dynamic registration is deprecated and compatibility-only. A deployment
with existing pre-registered client information may continue to select static
mode explicitly.

- **Automatic (`auto`):** use an operator-configured pre-registered/static
  client when available; otherwise use CIMD when advertised; otherwise use
  dynamic registration when advertised; otherwise return an actionable
  operator-configuration error. The selected mode is fixed before
  authorization begins.
- **Client ID Metadata Document (`cimd`):** use an HTTPS URL as the OAuth
  `client_id`. The document at that exact URL describes the client and its
  redirect URIs. The CA operator controls the document and deployment binding;
  the authorization server retrieves and validates it.
- **Dynamic:** when explicitly selected or reached by `auto`, register a public
  OAuth client using advertised dynamic client registration. This deprecated
  compatibility mode persists the resulting client information with the OAuth
  session.
- **Static:** use operator-provisioned client information. A client secret, when present, is resolved only inside the CA secret-store boundary.

| # | Requirement |
| :--- | :--- |
| OAUTH-12 | In CIMD mode, the `client_id` MUST be the exact HTTPS URL of the Client ID Metadata Document and that URL MUST contain a non-root path component. The CA MUST reject redirects, non-HTTPS URLs, a document whose declared `client_id` differs from its URL, and a selected callback absent from its permitted `redirect_uris`. The document MUST contain `client_id`, `client_name`, and `redirect_uris`; when refresh is requested, its `grant_types` MUST advertise `refresh_token`. Accept multiple registered redirects and validate the selected one. HTTPS redirects match exactly; a native loopback redirect matches on any port, with the host, path and other components unchanged (RFC 8252 §7.3). Other RFC 7591 client metadata, such as `token_endpoint_auth_method` and public `jwks`, MUST be accepted subject to field-specific validation. Do not reject safe metadata merely because a field name contains `token` or `credential`. |
| OAUTH-12A | The CA MUST select CIMD only when authorization-server metadata advertises `client_id_metadata_document_supported: true`. If CIMD is configured but not advertised, the CA MUST fail with an actionable registration error rather than silently selecting another mode. |
| OAUTH-13 | Registration access tokens and client secrets are credentials and receive the same storage and redaction protections as OAuth tokens. |
| OAUTH-14 | A public client MUST use PKCE and MUST NOT invent or persist a client secret. |
| OAUTH-15 | Static-client mode MUST fail closed when required client information cannot be resolved. |
| OAUTH-15A | The CA operator tooling MUST validate a CIMD before login and SHOULD be able to publish it at the stable configured HTTPS URL. Publication and rotation MUST be an authenticated operator action, use atomic replacement, preserve the URL-form `client_id`, and require reauthorization before incompatible redirect, grant, or key metadata changes take effect. The document MUST NOT contain credentials or deployment-secret references. |
| OAUTH-15B | Deprecated compatibility-only dynamic registration MUST be used only when advertised by the authorization server and selected by `auto` or explicit deployment policy. It MUST use exact redirect URIs, set `application_type: "native"` for local loopback CLI callbacks or `application_type: "web"` for remote HTTPS callbacks, and MUST NOT request capabilities beyond authorization code + PKCE and refresh. |
| OAUTH-15C | Client mode is part of the session binding. Explicit `cimd`, `dynamic`, and `static` modes fail closed. `auto` MUST apply the order static/pre-registered, CIMD, deprecated DCR, then actionable error; after it selects a mode, the CA MUST NOT silently fall back during that authorization attempt or session. |
| OAUTH-15D | In CIMD mode, when the selected document declares `token_endpoint_auth_method: "private_key_jwt"` and its `jwks` holds the CA's own public key, the CA MUST authenticate every token request (code exchange and refresh) and every revocation request with an RFC 7523 client assertion. If authorization-server metadata does not list `private_key_jwt` in `token_endpoint_auth_methods_supported`, the CA MUST fail with `oauth_client_registration_failed` rather than send an unauthenticated request. A document that declares no authentication method, or `none`, keeps the CA a public client. The method is part of the session binding and never changes during a session. |
| OAUTH-15E | The assertion MUST be signed with the CA's DID key inside the CA's signing boundary, with `alg` `EdDSA` for Ed25519 or `ES256` for P-256 and the header `typ: client-authentication+jwt`. Its claims are `iss` and `sub` equal to the `client_id`, `aud` equal to the authorization server's issuer identifier, a fresh random `jti` of at least 128 bits, `iat`, and `exp` at most 60 seconds after `iat`. A new assertion is made for each request and is never stored. The `typ` and `aud` keep it from being accepted as an MPAS signature or by another server. |
| OAUTH-15F | A metadata document MUST NOT contain a private key or a reference to one. A document SignerSet publishes for the CA's enrolled DID (coordination server entitlement spec §4.3) is a valid CIMD under OAUTH-12: its URL is the `client_id`, and SignerSet publishes it instead of the operator (OAUTH-15A). The operator chooses the document per session, so a client ID specific to one install is shown only to the servers configured to use it. |
| OAUTH-15G | An unsupported declared authentication method, a mismatched public key, or an unavailable signing key MUST stop the affected authenticated request; none may be treated as a public-client configuration. Validate advertised signing algorithms and, when present, revocation-endpoint authentication metadata against the selected method. No failure permits exporting the key, selecting another key, or sending an unauthenticated fallback. Local logout still follows OAUTH-31. |

A client metadata document's host does not determine the callback's host. A
registered HTTPS callback may be hosted independently, provided the client owns
or claims it under its platform rules and the authorization server accepts the
exact registered URI. A server's additional restrictions are compatibility
constraints to report, not reasons to weaken callback validation.

Metadata retrieval failures must retain their cause (§11). A timeout, rate limit,
or service outage is not evidence that enrollment was removed or that the key
is invalid. Temporary retrieval failures MUST NOT erase the configured identity
or its stored grant.

## 7. Authorization-code flow

The CA creates an authorization session containing a cryptographically random `state`, PKCE verifier, derived `S256` challenge, redirect URI, issuer, resource, client identity, requested scopes, creation time, and expiration time.

The operator starts the login workflow by executing an explicit CA operator
command. That command may open the authorization URL in the operator's browser,
where the operator authenticates and grants consent. An agent, proposer, bridge,
or submitted Action may report that login is required and display the command
for the operator to run, but MUST NOT execute the command, open a browser, or
start consent itself. The authorization server redirects to the CA callback.
The CA validates the callback and exchanges the code directly with the token
endpoint.

| # | Requirement |
| :--- | :--- |
| OAUTH-16 | PKCE with `S256` is mandatory and may be used only after OAUTH-11C metadata validation succeeds. `plain` PKCE MUST NOT be used. |
| OAUTH-17 | `state` and the PKCE verifier MUST contain at least 256 bits of cryptographically random entropy. |
| OAUTH-18 | Authorization sessions MUST be single-use, expire within 10 minutes by default, and be atomically consumed before code exchange. If the CA crashes after consumption but before durable token persistence, it MUST require clean reauthorization and MUST NOT retry or reuse the code. |
| OAUTH-19 | The callback MUST match the expected state, redirect URI, and an outstanding unexpired authorization session containing the validated issuer. If authorization-server metadata advertises `authorization_response_iss_parameter_supported`, a callback without `iss` MUST be rejected. Whenever `iss` is present, it MUST exactly equal the recorded issuer. These rules apply to successful and OAuth error callbacks before error details are exposed. |
| OAUTH-20 | Authorization codes MUST be sent only to the discovered token endpoint and only with the verifier from their originating session. |
| OAUTH-21 | The CA MUST validate token response syntax, supported `token_type`, expiry data, and returned scope when present. It MUST NOT assume an opaque access token exposes issuer, client, audience, or resource claims. Instead, it MUST bind the token locally to the validated issuer/client/exact-resource transaction that acquired it, send it only to that exact resource, and rely on the protected resource to validate token audience. |
| OAUTH-22 | Authorization codes and PKCE verifiers MUST NOT be persisted after a terminal exchange and MUST never appear in logs. |
| OAUTH-23 | The browser-facing completion page MUST reveal no token material and SHOULD tell the operator that the window may be closed. |

### 7.1 Callback deployment modes

- **Local native CA:** use a preconfigured loopback redirect URI. The listener
  MUST bind strictly to a loopback address, follow the configured fixed-port or
  authorization-server-supported ephemeral-port policy, accept only the exact
  callback path, and close after the bounded session completes.
- **Remote CA:** use an exact pre-registered HTTPS redirect URI. Only an
  authenticated and authorized operator may initiate the session; the callback
  correlates state to that operator and session but does not use browser
  cookies as the OAuth security binding.
- **Browser and callback on different machines:** v1 requires an
  operator-controlled tunnel that preserves the exact pre-registered redirect
  URI and terminates only at the CA callback listener. Implementations without
  such a controlled route MUST defer this topology until a future device
  authorization grant rather than inventing a copy/paste callback flow.

The callback endpoint is an OAuth protocol endpoint, not an MPAS submission endpoint. It MUST expose only generic success or failure text and follow OAUTH-19 before revealing even sanitized OAuth error details.

## 8. Credential storage and lifecycle

The CA stores a logical OAuth session containing the minimum material necessary to use and renew the grant: access token, refresh token if issued, expiry, token type, granted scopes, issuer, resource, client registration reference, and refresh-generation metadata.

| # | Requirement |
| :--- | :--- |
| OAUTH-24 | Tokens, client credentials and signing keys MUST remain confidential in transit and storage within the CA's authorized trust boundary. The adapter's deployment/security design owns the storage mechanism, access controls and recovery policy; this interoperability specification prescribes no particular OS store, encryption backend or key location. Document the threats and authorized access that design addresses. |
| OAUTH-25 | Agents, proposers and bridge processes MUST NOT be able to read credentials or use private signing keys outside the authorized CA workflow. Enforce that boundary through the deployment's applicable process, identity, platform and access controls. Protect logs, backups and exports under the same credential policy. |
| OAUTH-26 | Refresh MUST occur inside the CA and SHOULD occur before expiry with bounded jitter to avoid synchronized refresh. |
| OAUTH-27 | Refresh-token rotation MUST be atomic: a successful response replaces the prior token set as one durable update before the new access token is used. |
| OAUTH-28 | Concurrent requests for one session MUST share one refresh operation or serialize refreshes. They MUST NOT race the same refresh token. |
| OAUTH-29 | An unqualified `invalid_grant`, revoked grant, or binding mismatch marks the session `reauthorization_required`; the CA MUST NOT repeatedly retry it. If a supported explicit machine-readable reason identifies an entitlement/service denial, preserve that reason and use `oauth_access_denied` instead of reconnect guidance (§11). Do not infer that distinction from free text. A generic `invalid_grant` alone cannot distinguish those causes. |
| OAUTH-30 | Transient refresh failures MAY be retried before dispatch only when the failure is known to precede processing or a documented replay-safe refresh contract permits it. Honor bounded `Retry-After` and backoff. A timeout, connection loss or 5xx after a token POST may hide successful rotation; absent replay-safe recovery, retain the ambiguous state and require operator recovery instead of blindly reusing the old refresh token. A temporary failure MUST NOT be reported as a definite revocation or entitlement denial, and MUST NOT erase the stored session. |
| OAUTH-31 | Logout MUST delete local credentials. When the server advertises revocation, operator-requested logout SHOULD revoke refresh and access tokens before local deletion. Local deletion MUST still succeed when revocation is unavailable. |

## 9. MPAS dispatch integration

OAuth preparation is part of resolving the `mcp.http` execution target. It does not modify Action authorization.

Dispatch order:

1. Parse the Action Package and perform all normal MPAS structural, signature, target, expiry, schema, proposer, and policy checks.
2. Resolve the configured OAuth session and ensure it is bound to this Application DID and MCP resource.
3. Refresh the session if necessary.
4. Establish the MCP connection and complete initialization.
5. Write the dispatch-ledger `executing` entry according to the existing CA lifecycle.
6. Send every MCP Streamable HTTP request in the connection lifecycle with the
   access token in the HTTP `Authorization` header, including initialization,
   `tools/call`, and any GET, DELETE, or session-management requests.
7. Resolve the ledger and issue the normal signed Execution Receipt.

| # | Requirement |
| :--- | :--- |
| OAUTH-32 | A transport-authenticated OAuth identity, consent result, or scope grant MUST NOT count as an Approval or satisfy Authorization Requirements. |
| OAUTH-33 | The CA MUST NOT begin OAuth dispatch preparation for an Action that has failed MPAS verification or policy evaluation. Interactive login remains a separate operator workflow and is not triggered by an unapproved Action. |
| OAUTH-33A | An agent, proposer, bridge, Action submission, or automatic retry MUST NOT execute an OAuth login command, open a browser, follow an authorization URL, or initiate interactive consent. When login or reauthorization is required, it MAY return a redacted status containing the exact operator command to run. Only an authenticated operator action may start login: execution of that command for the CLI, or an equivalent trusted foreground Connect/Reconnect control for a native adapter. Neither starts or approves the affected tool call. |
| OAUTH-34 | Discovery, token refresh, and MCP connection setup are pre-dispatch preparation. A definitive failure before the `executing` ledger write rejects the submission without dispatch. |
| OAUTH-35 | After the `executing` entry, existing MPAS indeterminate-result rules apply. The CA MUST NOT refresh and automatically replay a tool call in response to a downstream 401 after request transmission. |
| OAUTH-36 | The Bearer token MUST be attached to every MCP Streamable HTTP request and only when the request targets the session's exact canonical MCP resource URI under the transport's defined request routing. Redirects MUST NOT forward the `Authorization` header across origins or escape the exact resource binding. |
| OAUTH-37 | The access token MUST NOT appear in the Execution Receipt, execution reference, MCP result, or externally visible error. |

### 9.1 Account preconditions and connection replacement

An opaque OAuth token supplies no universally readable upstream account ID.
The adapter MUST NOT infer that two grants represent the same person merely
because resource, issuer, client and scopes match. Session replacement must
preserve the distinction between the previously selected connection and the
new grant; it does not approve pending work for a different account.

An upstream tool may require an expected-account argument. When present, the
bridge exposes it under the accepted application plugin, the human review
shows the intended account, and the Approval binds it as part of the execution
payload. The adapter MUST forward that payload unchanged. It MUST NOT replace
the expected account after login or use the argument to select arbitrary
credentials. The upstream server validates the precondition against the
presented grant before performing the write. This requires no provider-specific
OAuth code in the adapter.

Connection repair may resume eligible, never-dispatched work only after current
lifecycle, expiry, approval, policy and connection checks. Where a trusted
account binding or server-enforced signed precondition cannot establish that
the intended account is preserved, use explicit account confirmation/new review
under the action lifecycle instead of silently resuming with replacement
credentials. A repair never revives a terminated Action or permits automatic
replay of a transmitted call. Generic discovery alone does not establish an
account identity or an expected-account guarantee.

## 10. Operator interface

The reference CA SHOULD provide commands equivalent to:

```text
mpas oauth login  --deployment <id> --session <name>
mpas oauth status --deployment <id> --session <name>
mpas oauth logout --deployment <id> --session <name>
```

`login` is an operator-only command. After the operator executes it, the command
returns or opens an authorization URL and waits only for the bounded OAuth
callback, not for MPAS approval. An agent-facing failure or status response may
tell the operator to run `mpas oauth login --deployment <id> --session <name>`,
but the agent does not execute it. `status` returns issuer, resource, client
mode, granted scope names, expiry/refreshability state, and whether
reauthorization or another recovery action is required. It MUST NOT return tokens, client secrets,
authorization codes, PKCE material, or raw callback data.

Implementations SHOULD support a non-browser-opening mode that prints the authorization URL for headless operation.

| # | Requirement |
| :--- | :--- |
| OAUTH-37A | Remote operator CLI/API endpoints MUST authenticate the operator and authorize login, status, CIMD publication/rotation, step-up, session replacement, logout, and revocation separately. Local CLI access MUST rely on an explicit OS-user/process trust boundary rather than unauthenticated network reachability. |
| OAUTH-37B | Each OAuth session MUST have an operator owner and an explicit sharing policy identifying which deployments or operator principals may use or administer it. Rebinding a shared session to another downstream account requires an authorized replacement workflow and invalidates the prior binding. |
| OAUTH-37C | Every operator-plane mutation MUST record the authenticated operator identity, session, deployment, action, outcome, and timestamp in the audit log without OAuth secrets. Status output MUST be limited by the same ownership and sharing policy. |

## 11. Errors

OAuth preparation failures are stateless Action rejections before dispatch.
After dispatch, connection health and recovery guidance are recorded separately
from the Action's execution outcome; they do not change the receipt rules or
authorize replay. Implementations SHOULD expose the following stable, non-secret
reason codes. These are adapter-local codes, not additional standard
OAuth errors to send to an upstream authorization server:

| Code | Meaning | Operator action |
| :--- | :--- | :--- |
| `oauth_login_required` | No authorized session exists. The response may include a non-secret operator command, but must not start login. | Operator runs the displayed login command. |
| `oauth_reauthorization_required` | Grant is revoked, invalid, or no longer satisfies the binding. The response may include a non-secret operator command, but must not start login. | Operator runs the displayed login command again. |
| `oauth_insufficient_scope` | Session lacks a configured required scope. | Reauthorize with the required scopes. |
| `oauth_access_denied` | A supported machine-readable response identifies account, organization, service or adapter entitlement denial. The compatibility case of HTTP 403 with bounded JSON error `account_not_allowed` and no Bearer challenge maps here. This application-specific code is not an MCP/OAuth standard. | Restore the applicable service access, through an owner/admin where appropriate; do not suggest repeated login. |
| `oauth_authorization_denied` | A validated authorization callback reports `access_denied` without a more specific supported reason. It can represent declined consent; it does not prove an organization entitlement denial. | Keep the connection incomplete; the operator may reconsider the request. Do not restart consent automatically. |
| `oauth_discovery_failed` | Protected-resource or issuer metadata is invalid, missing, or incompatible, without evidence of a temporary retrieval failure. | Check server and configuration. |
| `oauth_client_registration_failed` | CIMD validation failed, dynamic registration failed, or static client configuration is incomplete. | Correct client configuration. |
| `oauth_client_authentication_failed` | The token/revocation endpoint reports `invalid_client`, or the selected signing key/method cannot be used. This is distinct from an invalid user grant. | Repair client configuration, enrollment or key availability; do not restart user consent automatically. |
| `oauth_temporarily_unavailable` | Metadata, authorization or resource service is temporarily unavailable, including a timeout or 5xx without a more specific supported result. | Wait or perform bounded safe recovery; preserve the session and any ambiguous dispatch/refresh evidence. |
| `oauth_rate_limited` | A relevant endpoint returned HTTP 429 or a supported rate-limit response. | Honor bounded retry guidance; never automatically replay a transmitted tool call. |
| `oauth_token_refresh_failed` | Safe refresh recovery exhausted its bounded policy, or processing/rotation may have occurred without a usable response. | Retry later only where replay is safe; otherwise use explicit recovery. Do not claim revocation or replay an affected tool call. |

Error messages MUST NOT distinguish sensitive account details, echo OAuth responses verbatim, or include credentials.

### 11.1 Phase-aware classification

| Phase and evidence | Required interpretation |
| :--- | :--- |
| Metadata timeout, 429 or 5xx | Temporary failure/rate limit, not invalid enrollment. Keep retrieval status distinct from invalid JSON, a mismatched identity or an unavailable registration. |
| Authorization callback | Verify state/issuer before interpreting errors. `access_denied` alone is authorization denied; `temporarily_unavailable` is retryable only through an operator-initiated login. |
| Token/revocation endpoint `invalid_client` | Client authentication failure, even when HTTP status is 401. Do not treat it as a resource Bearer-token challenge. |
| Refresh `invalid_grant` | Apply OAUTH-29. A supported explicit entitlement reason takes precedence over generic reconnect advice; without one, do not invent a cause. |
| MCP resource Bearer challenge before tool transmission | Invalid credentials may trigger bounded noninteractive refresh or a login-required state. `insufficient_scope` follows the configured scope policy, never automatic consent expansion. |
| MCP resource 403 without an understood reason | Preserve denial and sanitized status without guessing that login or expanded consent will fix it. An unknown body is not evidence of the specific `account_not_allowed` condition. |
| HTTP 429 or temporary failure | Preserve retry timing, affected phase and transmission evidence. Retry eligibility depends on the operation and whether processing could have occurred, not status alone. |
| Authorization error after tool transmission | Record connection repair separately; do not replay. Preserve the execution evidence under the MCP Execution Profile. |
| Revocation unavailable or failed | Report the failure without blocking local credential deletion (OAUTH-31). Local deletion is not proof of remote revocation. |

Parse only bounded structured responses from the validated transaction/resource.
Do not use free-text matching to choose a security-sensitive recovery action,
follow an error's login URL, or execute a returned command. Recovery routes come
from trusted local configuration and validated discovery. Unknown codes remain
unknown; retain safe diagnostic information without assuming a provider's meaning.

### 11.2 Upstream application results and shared interoperability

MCP permits a tool execution error with `isError: true` and structured result
data. That response can describe a downstream API failure after side effects
may have occurred. `isError` alone does not prove rollback or safe retry.
Preserve the result for the caller under the existing result/redaction contract.
That contract may persist a terminal result for delivery recovery; OAuth
credential isolation is not a guarantee that provider result bodies are
transient. Provider-specific retention limits require a separate compatible
result-storage policy across adapters, relays and bridges.
The adapter MUST NOT automatically replay a transmitted mutation based on an
error description, a `retryable` field or a successful reconnection.

Discovery may publish descriptions, schemas and supported optional semantics.
Automatic interpretation of application-specific recovery or outcome fields
requires a separately specified, versioned interoperability contract supported
by both server and adapter and accepted under deployment trust policy. It must
define discovery, validation, reason/outcome mappings and fallback behavior.
Neither a schema nor an arbitrary server instruction alone changes MPAS policy
or establishes that contract. No provider-specific OAuth branch is required.

Servers without that optional contract remain usable through standard MCP/OAuth;
their unfamiliar application errors remain application errors, with conservative
retry behavior. Codes such as `reconnect_required`, `account_mismatch`,
`client_upgrade_required` and `outcome_unknown` are not standard MCP errors.
Their recovery semantics must not be assumed from their names alone.

The MCP Execution Profile currently maps all received `isError` results to
receipt result `failed`. This OAuth revision does not silently override that
mapping. Explicit downstream uncertainty must be preserved in the result and
must not be presented as proof that no write occurred. The shared
interoperability specification must resolve its receipt representation with
the Execution Profile before implementations claim richer outcome conformance.
The agent-facing proposer bridge must preserve the resulting semantics too.

## 12. Logging and audit

| # | Requirement |
| :--- | :--- |
| OAUTH-38 | Logs MUST redact `Authorization`, tokens, authorization codes, PKCE values, client secrets, registration access tokens, client assertions, cookies, callback query strings, and token endpoint response bodies. |
| OAUTH-39 | Audit events SHOULD record session identifier, exact issuer, exact canonical MCP resource URI, requested/granted scope names, client mode, authenticated operator identity when applicable, event type, outcome, and timestamps without credential values. |
| OAUTH-40 | Login, refresh, reauthorization-required, logout, revocation, and binding-change events SHOULD be auditable. |
| OAUTH-41 | Debug modes MUST preserve the same secret-redaction rules. |

## 13. Conformance and tests

A conforming implementation MUST test:

- exact ordered metadata probes, including path-bearing MCP resources and
  path-bearing issuers; issuer mismatch; malicious redirects; oversized
  documents; and timeouts;
- PKCE S256, state entropy, mismatch, expiry, single-use, and concurrent callback consumption;
- auto, CIMD, deprecated dynamic, and static client modes, including selection
  order, CIMD required fields/path/document binding, DCR `application_type`,
  redirect rejection, and no post-selection fallback;
- standard public metadata fields, multiple registered redirects, native
  loopback port variation, and an exact registered HTTPS callback on a domain
  different from the client metadata host;
- `private_key_jwt`: assertion claims, `typ`, and algorithm for Ed25519 and
  P-256 keys, a fresh `jti` per request, assertions on code exchange, refresh,
  and revocation, failure when the server does not advertise the method, and
  no assertion when the document declares none;
- unsupported methods/algorithms, mismatched or unavailable signing keys,
  token/revocation `invalid_client`, and no unauthenticated downgrade;
- protected-resource discovery through `WWW-Authenticate resource_metadata`
  and through the RFC 9728 well-known fallback;
- authorization-server discovery through RFC 8414 path insertion, OIDC path
  insertion, and OIDC path appending, accepting the first valid exact-issuer
  document without requiring multiple formats;
- PKCE metadata with `S256`, without `S256`, and with
  `code_challenge_methods_supported` absent;
- authorization response `iss` present/matching, present/mismatching,
  advertised-but-absent, and OAuth error callback cases;
- secure restart persistence without returning secrets through APIs or logs,
  including crash after state consumption but before token persistence;
- refresh before expiry, refresh-token rotation, concurrent refresh serialization, transient failure, `invalid_grant`, and revocation;
- a lost refresh response after rotation, with and without a documented safe
  recovery contract; neither blind replay nor invented revocation;
- exact Application DID/resource URI/issuer/client/scope binding and
  cross-session isolation; `resource` in authorization, code exchange, and
  refresh requests;
- no Authorization-header forwarding across origins;
- Bearer authentication on every Streamable HTTP lifecycle request, including
  initialize, `tools/call`, GET, DELETE, and session management;
- OAuth preparation before the ledger `executing` write and no automatic replay after it;
- agent/action paths report an operator login command without executing it,
  opening a browser, or initiating consent;
- OAuth outcomes never satisfying MPAS approvals;
- redaction from logs, errors, Action Packages, coordination records, receipts, and MCP results;
- fixed-scope challenge handling and operator-initiated allowlisted step-up;
- scopes omitted from configuration versus explicitly fixed scopes; requested
  versus granted sets; removed permissions; server-granted extra scopes not
  expanding local policy; and OAuth-defined omitted-scope response behavior;
- optional `offline_access` advertised by the authorization server but absent
  from resource metadata; refresh tokens issued without that scope; no refresh
  token issued; and independent refresh grants for different provider resources;
- identical entitlement denial during resource access and refresh when an
  explicit supported reason is available, with no repeated login advice;
  unqualified `invalid_grant` retains the generic reauthorization fallback;
- metadata 404/invalid document versus timeout/429/5xx, validated callback
  denial versus entitlement denial, and unknown response codes;
- ordinary MCP tool errors and supported explicit uncertain-outcome results,
  preserving result data and prohibiting automatic mutation replay; unsupported
  custom codes must not acquire guessed semantics;
- expected-account arguments unchanged across dispatch and repair; same-account
  and different-account reconnection against a fixture server enforcing that
  precondition; no implicit credential selection from tool arguments;
- trusted client-profile configuration and updates bound to the exact resource;
  chat, Action and server-error inputs cannot select a key or downgrade a client;
- operator authentication/authorization, ownership/sharing, login, status,
  callback modes, CIMD rotation, session replacement, reauthorization, and
  logout paths.

The test suite SHOULD include an in-process OAuth authorization server and protected MCP resource for deterministic conformance tests. A separately gated integration test MAY exercise the official Vercel MCP server with operator-owned test credentials; CI MUST NOT depend on an interactive third-party login.

## 14. Compatibility and migration

Existing static credential injection remains supported. An `mcp.http` target without `auth.type: "oauth2"` behaves as before. Deployments currently injecting a manually obtained access token migrate by:

1. configuring an OAuth session and required scopes;
2. completing operator login;
3. verifying authenticated MCP initialization and a read-only call;
4. removing the static token binding;
5. revoking or rotating the copied grant/token where possible, then deleting
   local copies from legacy stores and configuration history.

No deployment silently converts a static token into a managed OAuth session.
Copied Bearer tokens are incident-remediation material: commits, backups,
support bundles, and third-party logs may be immutable or outside the
operator's control, so deletion alone is not sufficient evidence of
invalidation.

## 15. Open questions

1. Should the OAuth execution-target configuration become normative in the MCP Execution Profile or remain a CA deployment extension until multiple implementations converge?
2. What deployment-specific credential custody, isolation, backup and recovery design meets OAUTH-24 and OAUTH-25 on each supported platform? This is a security design decision, not a shared storage-backend mandate.
3. Should revocation be mandatory when advertised, or remain a `SHOULD` so local logout cannot be blocked by an unavailable server?
4. Should a CA support device authorization grant in a later version for headless environments that cannot receive callbacks?
5. Publish the optional shared upstream-server/adapter interoperability contract described in §11.2, including discovery/versioning and safe fallback. Coordinate the explicit entitlement reason at refresh and uncertain-write receipt mapping with server authors and the MCP Execution Profile. Until then, unqualified OAuth errors cannot provide those distinctions.

### Cross-repository alignment required

- **Wivity Link scopes:** as of 2026-11-05, authorization accepts the current
  endpoint's provider-prefixed scopes returned by its token response, so
  resubmitting that granted scope set no longer causes `invalid_scope` solely
  because of those prefixes. The provider manifest still selects upstream
  permissions; accepting a requested scope does not guarantee it is granted.
  The CA must record the actual response under §4.2. Remove `offline_access`
  from protected-resource metadata to follow the pinned MCP SHOULD NOT
  guidance; keep its authorization-server advertisement. Refresh-token use
  must continue to work whether or not that scope was requested.
- **Wivity Link refresh denial:** its current contract returns only
  `invalid_grant` for entitlement denial. Until the shared machine-readable
  reason contract exists, the CA uses generic reauthorization guidance under
  OAUTH-29. That is a recovery attempt, not a diagnosis or a promise that login
  restores access. If the operator's login then returns `access_denied`, show
  authorization denial and stop; do not automatically repeat login or infer a
  specific entitlement cause from that generic callback error.
- **Native adapter:** apply the same phase-aware failures and OAUTH-29 exception
  in its connection UI; not every failed refresh means Reconnect needed. Its
  trusted foreground action substitutes for the CLI command. Enrolled client
  provisioning and callback ownership remain native/backend responsibilities.
- **Coordination service:** native setup reuses the existing audited
  participant/client administration operations after choosing an organization
  the user owns/administers or creating another as owner. Native authentication
  and the extended organization-creation contract remain implementation
  dependencies. Client metadata is generated from the authorized records;
  enrolled-only connection readiness requires those records to be complete.

These are specification/integration dependencies, not claims that existing
implementations already satisfy this revision.

## Appendix A: non-normative implementation guidance

The reference TypeScript Credential Adapter should prefer the official
`@modelcontextprotocol/sdk` OAuth client and
`StreamableHTTPClientTransport` over a parallel MCP OAuth implementation. A CA
can implement the SDK's `OAuthClientProvider` interface while keeping token
storage, session binding, operator authorization, callback correlation,
redaction, and MPAS dispatch controls inside the CA trust boundary.

Library use does not weaken or replace any requirement in this specification.
The implementation plan requires a conformance spike and a
requirement-to-owner matrix before relying on SDK behavior. Any uncovered gap
must be handled by a narrow CA wrapper, a custom bounded transport policy, or an
upstream SDK fix. A second general-purpose OAuth library should be introduced
only for a demonstrated gap; `oauth4webapi` is the preferred low-level fallback
for the TypeScript reference implementation.

### Unattended scope challenges and ambiguous token requests

The reference integration must intercept `insufficient_scope` challenges before MCP SDK automatic
reauthorization, including during initialization and tool dispatch. A 401/403
challenge requesting scopes outside the operator-configured set or the fixed
baseline established under §4.2 must also be intercepted. It reports
`OAUTH_SCOPE_CHANGE_REQUIRED`, bounded requested/granted/configured scope lists,
and the operator login command. A `dispatch` trace with result
`oauth_scope_challenge` records those lists, never tokens or raw headers.
The operator must review the trusted deployment scope configuration before login;
a remote challenge does not update that configuration, replay the tool call, or
create PKCE state. Ordinary invalid-token refresh behavior is unchanged.

A token POST that times out after connection has an unknown remote outcome.
An authorization-code exchange is not retried automatically (OAUTH-18).
A refresh may use only the replay-safe recovery allowed by OAUTH-30.
GET/HEAD discovery requests may retry on an
attempt timeout; replayable requests may retry known pre-connection failures.
Both managed fetch and Agent use the installed Undici package. Its streaming
response is adapted to the global Response interface required by the MCP SDK.
IPv4-origin caching and broader transport telemetry remain separate follow-ups.

## References

- [MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), including scope selection and refresh guidance.
- [OAuth 2.0, RFC 6749](https://www.rfc-editor.org/rfc/rfc6749), §§3.3, 5.1, 5.2 and 6 for granted scopes, token errors and refresh responses.
- [Native-app redirects, RFC 8252](https://www.rfc-editor.org/rfc/rfc8252), §7 for callback forms and loopback matching.
- [MCP tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), for the upstream tool-result shape; each deployment pins its supported MCP transport/tool version separately from authorization.
- [MPAS MCP Execution Profile](../../../specs/mpas-profile-mcp.md), for dispatch and receipt classification.
- [MPAS MCP Proposer Bridge Profile](../../../specs/mpas-profile-mcp-proposer-bridge-client.md), for the agent-facing interface.
