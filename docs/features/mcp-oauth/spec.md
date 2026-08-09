# Credential Adapter MCP OAuth — Specification

**Status:** Draft v0.1
**Created:** 2026-08-08
**Issue:** [#23 — Credential Adapter: support OAuth 2.1 lifecycle for remote MCP servers](https://github.com/oma3dao/mpas/issues/23)
**Companion:** [plan.md](./plan.md)
**Affects:** Credential Adapter, MCP execution target configuration, operator tooling
**Motivating target:** Official Vercel MCP server (`https://mcp.vercel.com`)

---

## 1. Purpose

Enable a Credential Adapter (CA) to authenticate to OAuth-protected remote MCP servers without requiring an operator to copy short-lived access tokens into static credential configuration.

The CA acts as the OAuth client and owns the complete credential lifecycle inside its trust boundary: discovery, authorization-code flow with PKCE, token storage, refresh, rotation, reauthorization, and revocation. A proposer or MCP bridge may identify the required credential class, but it never receives an access token, refresh token, authorization code, client secret, or PKCE verifier.

OAuth authenticates the CA to the downstream MCP server. It does not authorize an MPAS Action. The CA MUST complete normal MPAS verification and policy evaluation before it may dispatch a tool call with an OAuth credential.

## 2. Scope

### 2.1 In scope

- OAuth 2.1 authorization-code flow with PKCE for remote MCP servers.
- MCP protected-resource and authorization-server metadata discovery.
- OAuth Authorization Server Metadata discovery.
- Dynamic client registration when supported.
- Operator-configured static client information when registration is unavailable.
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
      "client": {
        "type": "cimd",
        "clientId": "https://adapter.example.com/oauth/client-metadata.json"
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
| OAUTH-02 | The CA MUST bind a session to the canonical protected-resource origin, authorization-server issuer, client identity, and granted scopes. |
| OAUTH-03 | Configuration MUST NOT contain access tokens, refresh tokens, authorization codes, PKCE verifiers, or literal client secrets. |
| OAUTH-04 | Redirect URIs and requested scopes MUST be operator-controlled configuration or values derived under documented CA rules. Untrusted MCP tool arguments MUST NOT alter them. |
| OAUTH-05 | Changing the resource, issuer, client identity, or requested scopes MUST invalidate the session for dispatch until the operator authorizes the new binding. |

## 5. Discovery and server validation

The CA follows the MCP Authorization specification and the OAuth metadata specifications it references.

1. Connect to the configured MCP resource URL without credentials when no usable session exists.
2. If the response includes a `WWW-Authenticate` challenge with a
   `resource_metadata` parameter, retrieve protected-resource metadata from
   that URL. Otherwise, use the RFC 9728 well-known protected-resource
   metadata fallback derived from the configured MCP resource URL.
3. Select an advertised authorization server under operator policy.
4. Retrieve authorization-server metadata from the issuer, supporting both
   OAuth Authorization Server Metadata (RFC 8414) and OpenID Connect
   Discovery. If both are available, they MUST describe the same issuer and
   compatible endpoints.
5. Validate metadata and endpoints before beginning authorization.

| # | Requirement |
| :--- | :--- |
| OAUTH-06 | Production authorization, token, registration, revocation, and protected-resource endpoints MUST use HTTPS. Loopback redirect URIs are the only HTTP exception. |
| OAUTH-07 | Redirects during metadata retrieval MUST be bounded and MUST NOT permit downgrade from HTTPS. |
| OAUTH-08 | The CA MUST validate issuer equality according to the applicable metadata specification and reject conflicting metadata. |
| OAUTH-09 | The CA MUST reject an authorization server that is not advertised for the configured protected resource unless the operator explicitly pins that issuer in deployment configuration. |
| OAUTH-10 | Discovery responses MUST have size and time limits and MUST be parsed as untrusted input. |
| OAUTH-11 | The CA MUST preserve the configured MCP resource binding in authorization and token requests as required by the MCP Authorization specification. Tokens obtained for one resource MUST NOT be used for another. |
| OAUTH-11A | The CA MUST prefer a protected resource's `WWW-Authenticate` `resource_metadata` URL and MUST support the RFC 9728 well-known fallback when that parameter is absent. A challenge-provided metadata URL remains untrusted and is subject to OAUTH-06 through OAUTH-10. |
| OAUTH-11B | The CA MUST support authorization-server discovery through both RFC 8414 OAuth Authorization Server Metadata and OpenID Connect Discovery. Conflicting issuer or endpoint claims MUST fail closed. |
| OAUTH-11C | Before starting authorization, the CA MUST verify that `code_challenge_methods_supported` is present and includes `S256`. Missing metadata or a list without `S256` MUST be rejected; the CA MUST NOT infer support or fall back to `plain`. |

## 6. Client registration

The first implementation supports three modes. Client ID Metadata Documents
(CIMD) are a first-class mode for current MCP Authorization interoperability;
dynamic registration remains a backwards-compatibility option. A deployment
with existing pre-registered client information may continue to select static
mode explicitly.

- **Client ID Metadata Document (`cimd`):** use an HTTPS URL as the OAuth
  `client_id`. The document at that exact URL describes the client and its
  redirect URIs. The CA operator controls the document and deployment binding;
  the authorization server retrieves and validates it.
- **Dynamic:** register a public OAuth client using advertised registration
  metadata when CIMD is unavailable and the authorization server supports
  dynamic client registration. The CA persists the resulting client
  information with the OAuth session.
- **Static:** use operator-provisioned client information. A client secret, when present, is resolved only inside the CA secret-store boundary.

| # | Requirement |
| :--- | :--- |
| OAUTH-12 | In CIMD mode, the `client_id` MUST be the exact HTTPS URL of the Client ID Metadata Document. The CA MUST reject redirects, non-HTTPS URLs, a document whose declared `client_id` differs from its URL, and redirect URIs that do not exactly match CA configuration. |
| OAUTH-12A | The CA MUST select CIMD only when authorization-server metadata advertises `client_id_metadata_document_supported: true`. If CIMD is configured but not advertised, the CA MUST fail with an actionable registration error rather than silently selecting another mode. |
| OAUTH-13 | Registration access tokens and client secrets are credentials and receive the same storage and redaction protections as OAuth tokens. |
| OAUTH-14 | A public client MUST use PKCE and MUST NOT invent or persist a client secret. |
| OAUTH-15 | Static-client mode MUST fail closed when required client information cannot be resolved. |
| OAUTH-15A | The CA and its operator tooling SHOULD support publishing or validating a CIMD containing only the client metadata required for MCP OAuth. The document MUST NOT contain credentials or deployment-secret references. |
| OAUTH-15B | Dynamic registration MUST be used only when advertised by the authorization server and selected by deployment policy. It MUST use exact redirect URIs and MUST NOT request capabilities beyond authorization code + PKCE and refresh. |
| OAUTH-15C | Client mode is part of the session binding. The CA MUST NOT silently fall back among CIMD, dynamic, and static modes after authorization begins. |

## 7. Authorization-code flow

The CA creates an authorization session containing a cryptographically random `state`, PKCE verifier, derived `S256` challenge, redirect URI, issuer, resource, client identity, requested scopes, creation time, and expiration time.

The operator opens the returned authorization URL, authenticates to the authorization server, and grants consent. The authorization server redirects to the CA callback. The CA validates the callback and exchanges the code directly with the token endpoint.

| # | Requirement |
| :--- | :--- |
| OAUTH-16 | PKCE with `S256` is mandatory and may be used only after OAUTH-11C metadata validation succeeds. `plain` PKCE MUST NOT be used. |
| OAUTH-17 | `state` and the PKCE verifier MUST contain at least 256 bits of cryptographically random entropy. |
| OAUTH-18 | Authorization sessions MUST be single-use, expire within 10 minutes by default, and be atomically consumed before code exchange. |
| OAUTH-19 | The callback MUST match the expected state, redirect URI, issuer/session binding, and an outstanding unexpired authorization session. |
| OAUTH-20 | Authorization codes MUST be sent only to the discovered token endpoint and only with the verifier from their originating session. |
| OAUTH-21 | The CA MUST reject token responses whose granted scope, resource, issuer, or client binding is incompatible with the configured session. |
| OAUTH-22 | Authorization codes and PKCE verifiers MUST NOT be persisted after a terminal exchange and MUST never appear in logs. |
| OAUTH-23 | The browser-facing completion page MUST reveal no token material and SHOULD tell the operator that the window may be closed. |

### 7.1 Headless operation

The CA MAY expose either:

- a loopback callback listener on the operator's machine through a documented tunnel; or
- an HTTPS callback endpoint reachable by the browser.

The callback endpoint is an OAuth protocol endpoint, not an MPAS submission endpoint. If it is remotely reachable, it MUST be protected against cross-session confusion by the requirements above and SHOULD expose only generic success or failure text.

## 8. Credential storage and lifecycle

The CA stores a logical OAuth session containing the minimum material necessary to use and renew the grant: access token, refresh token if issued, expiry, token type, granted scopes, issuer, resource, client registration reference, and refresh-generation metadata.

| # | Requirement |
| :--- | :--- |
| OAUTH-24 | Tokens and client credentials MUST be encrypted at rest using an OS secret store, HSM-backed store, or an implementation-defined encrypted store whose key is kept separately. Plaintext files are non-conforming for production. |
| OAUTH-25 | File permissions and process boundaries MUST prevent proposer and bridge processes from reading the OAuth store. |
| OAUTH-26 | Refresh MUST occur inside the CA and SHOULD occur before expiry with bounded jitter to avoid synchronized refresh. |
| OAUTH-27 | Refresh-token rotation MUST be atomic: a successful response replaces the prior token set as one durable update before the new access token is used. |
| OAUTH-28 | Concurrent requests for one session MUST share one refresh operation or serialize refreshes. They MUST NOT race the same refresh token. |
| OAUTH-29 | An `invalid_grant`, revoked grant, or binding mismatch marks the session `reauthorization_required`; the CA MUST NOT repeatedly retry it. |
| OAUTH-30 | Network and 5xx failures during refresh MAY be retried with bounded backoff before dispatch. They MUST NOT trigger unbounded retries or reuse a known-invalid access token. |
| OAUTH-31 | Logout MUST delete local credentials. When the server advertises revocation, operator-requested logout SHOULD revoke refresh and access tokens before local deletion. Local deletion MUST still succeed when revocation is unavailable. |

## 9. MPAS dispatch integration

OAuth preparation is part of resolving the `mcp.http` execution target. It does not modify Action authorization.

Dispatch order:

1. Parse the Action Package and perform all normal MPAS structural, signature, target, expiry, schema, proposer, and policy checks.
2. Resolve the configured OAuth session and ensure it is bound to this Application DID and MCP resource.
3. Refresh the session if necessary.
4. Establish the MCP connection and complete initialization.
5. Write the dispatch-ledger `executing` entry according to the existing CA lifecycle.
6. Send the `tools/call` request with the access token in the HTTP `Authorization` header.
7. Resolve the ledger and issue the normal signed Execution Receipt.

| # | Requirement |
| :--- | :--- |
| OAUTH-32 | A transport-authenticated OAuth identity, consent result, or scope grant MUST NOT count as an Approval or satisfy Authorization Requirements. |
| OAUTH-33 | The CA MUST NOT begin OAuth dispatch preparation for an Action that has failed MPAS verification or policy evaluation. Interactive login remains a separate operator workflow and is not triggered by an unapproved Action. |
| OAUTH-34 | Discovery, token refresh, and MCP connection setup are pre-dispatch preparation. A definitive failure before the `executing` ledger write rejects the submission without dispatch. |
| OAUTH-35 | After the `executing` entry, existing MPAS indeterminate-result rules apply. The CA MUST NOT refresh and automatically replay a tool call in response to a downstream 401 after request transmission. |
| OAUTH-36 | The Bearer token MUST be attached only to requests whose origin and resource binding match the session. Redirects MUST NOT forward the `Authorization` header across origins. |
| OAUTH-37 | The access token MUST NOT appear in the Execution Receipt, execution reference, MCP result, or externally visible error. |

## 10. Operator interface

The reference CA SHOULD provide commands equivalent to:

```text
mpas oauth login  --deployment <id> --session <name>
mpas oauth status --deployment <id> --session <name>
mpas oauth logout --deployment <id> --session <name>
```

`login` returns or opens an authorization URL and waits only for the bounded OAuth callback, not for MPAS approval. `status` returns issuer, resource, client mode, granted scope names, expiry/refreshability state, and whether reauthorization is required. It MUST NOT return tokens, client secrets, authorization codes, PKCE material, or raw callback data.

Implementations SHOULD support a non-browser-opening mode that prints the authorization URL for headless operation.

## 11. Errors

OAuth preparation failures are stateless Action rejections before dispatch. Implementations SHOULD expose stable, non-secret reason codes:

| Code | Meaning | Operator action |
| :--- | :--- | :--- |
| `oauth_login_required` | No authorized session exists. | Run the login workflow. |
| `oauth_reauthorization_required` | Grant is revoked, invalid, or no longer satisfies the binding. | Log in again. |
| `oauth_insufficient_scope` | Session lacks a configured required scope. | Reauthorize with the required scopes. |
| `oauth_discovery_failed` | Protected-resource or issuer metadata is invalid/unavailable. | Check server and configuration. |
| `oauth_client_registration_failed` | CIMD validation failed, dynamic registration failed, or static client configuration is incomplete. | Correct client configuration. |
| `oauth_token_refresh_failed` | A retryable refresh failure exhausted its bounded retry policy. | Retry later; do not resubmit if dispatch may have begun. |

Error messages MUST NOT distinguish sensitive account details, echo OAuth responses verbatim, or include credentials.

## 12. Logging and audit

| # | Requirement |
| :--- | :--- |
| OAUTH-38 | Logs MUST redact `Authorization`, tokens, authorization codes, PKCE values, client secrets, registration access tokens, cookies, callback query strings, and token endpoint response bodies. |
| OAUTH-39 | Audit events SHOULD record session identifier, issuer origin, resource origin, requested/granted scope names, client mode, event type, outcome, and timestamps without credential values. |
| OAUTH-40 | Login, refresh, reauthorization-required, logout, revocation, and binding-change events SHOULD be auditable. |
| OAUTH-41 | Debug modes MUST preserve the same secret-redaction rules. |

## 13. Conformance and tests

A conforming implementation MUST test:

- metadata discovery success, issuer mismatch, malicious redirects, oversized documents, and timeouts;
- PKCE S256, state entropy, mismatch, expiry, single-use, and concurrent callback consumption;
- CIMD, dynamic, and static client modes, including CIMD URL/document binding,
  redirect rejection, and no silent mode fallback;
- protected-resource discovery through `WWW-Authenticate resource_metadata`
  and through the RFC 9728 well-known fallback;
- authorization-server discovery through RFC 8414 and OpenID Connect
  Discovery, including conflicting metadata;
- PKCE metadata with `S256`, without `S256`, and with
  `code_challenge_methods_supported` absent;
- secure restart persistence without returning secrets through APIs or logs;
- refresh before expiry, refresh-token rotation, concurrent refresh serialization, transient failure, `invalid_grant`, and revocation;
- exact resource/origin/client/scope binding and cross-session isolation;
- no Authorization-header forwarding across origins;
- authenticated MCP initialization and `tools/call` dispatch;
- OAuth preparation before the ledger `executing` write and no automatic replay after it;
- OAuth outcomes never satisfying MPAS approvals;
- redaction from logs, errors, Action Packages, coordination records, receipts, and MCP results;
- operator login, status, headless callback, reauthorization, and logout paths.

The test suite SHOULD include an in-process OAuth authorization server and protected MCP resource for deterministic conformance tests. A separately gated integration test MAY exercise the official Vercel MCP server with operator-owned test credentials; CI MUST NOT depend on an interactive third-party login.

## 14. Compatibility and migration

Existing static credential injection remains supported. An `mcp.http` target without `auth.type: "oauth2"` behaves as before. Deployments currently injecting a manually obtained access token migrate by:

1. configuring an OAuth session and required scopes;
2. completing operator login;
3. verifying authenticated MCP initialization and a read-only call;
4. removing the static token binding;
5. deleting the copied token from legacy stores and configuration history where possible.

No deployment silently converts a static token into a managed OAuth session.

## 15. Open questions

1. Should the OAuth execution-target configuration become normative in the MCP Execution Profile or remain a CA deployment extension until multiple implementations converge?
2. Which encrypted fallback store is acceptable on platforms without an OS secret service?
3. Should revocation be mandatory when advertised, or remain a `SHOULD` so local logout cannot be blocked by an unavailable server?
4. Should a CA support device authorization grant in a later version for headless environments that cannot receive callbacks?
