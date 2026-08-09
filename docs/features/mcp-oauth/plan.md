# Credential Adapter MCP OAuth — Implementation Plan

**Specification:** [spec.md](./spec.md)
**Issue:** [#23](https://github.com/oma3dao/mpas/issues/23)
**Initial target:** Official Vercel MCP server (`https://mcp.vercel.com`)

---

## Strategy

Build the protocol core against deterministic local fixtures, integrate it with the demo Credential Adapter, then validate a real hosted MCP server. Keep OAuth session management separate from Action submission so an agent can neither initiate consent nor turn OAuth authentication into MPAS authorization.

```text
spec + threat model
        │
        ▼
OAuth client/session library ──► deterministic OAuth + MCP fixtures
        │
        ▼
CA operator login/status/logout
        │
        ▼
CA mcp.http dispatch integration
        │
        ▼
Vercel MCP integration validation
        │
        ▼
conformance, hardening, documentation
```

## Phase 0: specification and threat model

- [ ] Review and merge [spec.md](./spec.md).
- [ ] Decide whether OAuth configuration is normative MCP Execution Profile text or a reference-CA deployment extension for v1.
- [ ] Resolve the secret-store fallback and revocation open questions.
- [ ] Document threats: authorization response injection, state/PKCE theft, malicious discovery metadata, issuer mix-up, resource confusion, open redirects, token exfiltration through logs/results, refresh races, callback CSRF, and replay after uncertain dispatch.
- [ ] Record interoperability baselines from the current MCP Authorization specification and OAuth 2.1-related RFCs used by MCP.

**Exit:** contracts, trust boundary, and unresolved decisions are explicit before implementation dependencies are selected.

## Phase 1: deterministic OAuth and protected MCP fixtures

**Area:** `examples/demo/tests/fixtures/`

- [ ] Add an in-process authorization server fixture with protected-resource metadata, authorization-server metadata, authorization endpoint, token endpoint, optional registration endpoint, and revocation endpoint.
- [ ] Support authorization code + PKCE, access-token expiry, refresh-token rotation, scope enforcement, resource binding, revocation, and configurable failure injection.
- [ ] Add a Streamable HTTP MCP fixture that challenges unauthenticated clients and accepts fixture-issued Bearer tokens.
- [ ] Add malicious fixture modes: issuer mismatch, cross-origin redirect, altered state, repeated callback, wrong resource, insufficient scope, oversized metadata, slow endpoint, malformed token response, and `invalid_grant`.
- [ ] Ensure test fixtures never log fixture secrets by default.

**Exit:** all OAuth lifecycle behavior can be tested offline and deterministically; third-party credentials are unnecessary for CI.

## Phase 2: OAuth session core

**Area:** reference Credential Adapter OAuth module

- [ ] Define typed models for protected-resource metadata, authorization-server metadata, client registration, authorization sessions, token sets, session bindings, and public session status.
- [ ] Implement bounded metadata retrieval, redirect policy, HTTPS enforcement, issuer validation, and authorization-server selection.
- [ ] Implement dynamic client registration and static client configuration through secret references.
- [ ] Implement authorization URL construction with resource indicators, requested scopes, random state, and PKCE S256.
- [ ] Implement atomic, expiring, single-use authorization-session storage.
- [ ] Implement callback validation and authorization-code exchange.
- [ ] Implement token validation sufficient to enforce token type, expiry, granted scopes, issuer, client, and resource binding without requiring access tokens to be JWTs.
- [ ] Define typed, redacted failures for discovery, registration, login, exchange, and binding errors.
- [ ] Unit tests for every OAUTH-06 through OAUTH-23 requirement.

**Exit:** the library can create and complete a bound OAuth session against the local fixture without an MCP dispatch.

## Phase 3: secure credential persistence and refresh

**Area:** CA credential store and lifecycle service

- [ ] Define an `OAuthSessionStore` interface with atomic create/update/delete and compare-and-swap or transaction semantics for rotation.
- [ ] Implement the production platform secret-store backend and a clearly marked test/development backend.
- [ ] Separate searchable non-secret metadata from encrypted credential payloads.
- [ ] Persist access token, refresh token, expiry, scopes, issuer/resource/client binding, and registration credential references.
- [ ] Implement single-flight refresh per session, refresh-before-expiry with jitter, bounded retry for pre-dispatch transient failures, and atomic refresh-token rotation.
- [ ] Mark `invalid_grant`, revocation, and binding changes as `reauthorization_required` without retry loops.
- [ ] Implement revocation and local deletion semantics.
- [ ] Add restart, crash-during-rotation, concurrent refresh, file-permission, unavailable-store, and corrupted-record tests.
- [ ] Add a repository-wide secret-redaction test covering normal and debug logging.

**Exit:** sessions survive restart, rotate safely under concurrency, and cannot be read from proposer or bridge processes.

## Phase 4: operator workflows

**Area:** Credential Adapter CLI/API

- [ ] Implement `oauth login` selection by deployment and session.
- [ ] Support automatic browser opening and print-only/headless authorization URLs.
- [ ] Implement loopback callback with random state and configurable bounded timeout.
- [ ] Document a secure HTTPS callback or tunnel pattern for remote/headless CA deployments.
- [ ] Implement redacted `oauth status` output.
- [ ] Implement `oauth logout`, remote revocation when advertised, and unconditional local deletion.
- [ ] Prevent Action submission from automatically opening a browser or starting an interactive grant.
- [ ] Audit login, exchange, refresh, reauthorization-required, revocation, and logout without secret values.
- [ ] Tests for simultaneous login sessions, callback to the wrong session, expired callbacks, operator cancellation, unavailable browser, and remote callback routing.

**Exit:** an operator can provision and remove a session without manually viewing or copying any token.

## Phase 5: MCP HTTP dispatch integration

**Area:** CA MCP execution target

- [ ] Extend `mcp.http` configuration with OAuth session, scopes, and dynamic/static client mode.
- [ ] Validate session binding to Application DID, MCP resource, issuer, client, and configured scopes.
- [ ] Resolve or refresh OAuth credentials only after MPAS verification and policy satisfaction.
- [ ] Initialize the remote MCP transport with a Bearer token while preventing cross-origin Authorization-header forwarding.
- [ ] Keep discovery, refresh, connection, and initialization before the dispatch-ledger `executing` write.
- [ ] Preserve existing timeout and indeterminate-result rules after the ledger write.
- [ ] On a downstream 401 after request transmission, do not refresh and replay the tool call automatically; resolve conservatively under existing dispatch semantics.
- [ ] Map pre-dispatch OAuth failures to stable, redacted Action rejection reasons.
- [ ] Prove OAuth identity, consent, and scopes cannot satisfy or alter MPAS Authorization Requirements or Approval counts.
- [ ] Integration tests for read-only and governed tools, expired-token refresh, insufficient scope, wrong resource, revoked grant, transport redirects, timeout, and downstream 401 before/after dispatch boundaries.

**Exit:** an MPAS-authorized Action executes once against the protected MCP fixture using a CA-managed token, with no token visible outside the CA.

## Phase 6: Vercel MCP validation

**Repos:** `oma3dao/mpas` and `oma3dao/mpas-applications`

- [ ] Confirm the current official Vercel protected-resource metadata, authorization-server metadata, scopes, dynamic-registration behavior, and callback requirements.
- [ ] Update the Vercel deployment configuration to use a managed OAuth session rather than `Authorization: Bearer {{credential:vercelMcpOAuthAccessToken}}`.
- [ ] Run operator authorization against a dedicated non-production Vercel team/account.
- [ ] Verify MCP initialization plus public and authenticated read-only tools.
- [ ] Verify a governed write requires normal MPAS approval before the CA attaches the OAuth credential.
- [ ] Force or wait for access-token expiry and verify refresh/rotation without reauthorization.
- [ ] Revoke the grant and verify `oauth_reauthorization_required` with no retry loop or credential leakage.
- [ ] Capture only non-secret interoperability evidence; never commit token-store contents or debug logs containing protocol credentials.
- [ ] Gate the live test behind explicit operator opt-in; keep it out of required CI.

**Exit:** the official Vercel MCP integration works through the managed lifecycle, including refresh and revocation, without copied access tokens.

## Phase 7: conformance, documentation, and rollout

- [ ] Add OAuth conformance scenarios covering every MUST in the spec.
- [ ] Add redaction assertions for logs, errors, Action Packages, coordination payloads, Execution Receipts, MCP results, and status APIs.
- [ ] Add dependency and supply-chain review for the chosen OAuth implementation libraries.
- [ ] Document deployment configuration, secret-store setup, callback networking, static client provisioning, dynamic registration, login/status/logout, backup/restore implications, and incident response.
- [ ] Document migration from static Bearer-token injection, including removal from legacy stores and configuration history.
- [ ] Add operational metrics that expose counts and outcomes but never token values or callback parameters.
- [ ] Run security review and interoperability review before marking the feature stable.

**Exit:** the feature is documented, testable, observable without secrets, and ready for opt-in production deployment.

## Suggested PR sequence

Keep reviews single-purpose:

1. Specification and threat-model docs.
2. Deterministic OAuth + MCP fixtures.
3. OAuth discovery, registration, and authorization-session core.
4. Secure store and refresh lifecycle.
5. Operator login/status/logout workflows.
6. MCP HTTP dispatch integration and ledger-boundary tests.
7. Vercel application migration and opt-in integration test.
8. Conformance, hardening, and production documentation.

## Definition of done

- [ ] Every normative requirement in `spec.md` maps to an automated test or an explicitly documented operational control.
- [ ] No OAuth secret crosses the CA trust boundary or appears in logs and MPAS artifacts.
- [ ] OAuth authentication never substitutes for MPAS authorization.
- [ ] Refresh and rotation are safe across concurrency, crash, and restart.
- [ ] Resource, issuer, client, and scope bindings prevent token confusion.
- [ ] Pre-dispatch failures and post-dispatch uncertainty preserve the existing MPAS at-most-once dispatch invariant.
- [ ] A real Vercel MCP session completes login, authenticated calls, refresh, and revocation through the CA.
