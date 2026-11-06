# Credential Adapter OAuth — Implementation Plan

**Specification:** [spec.md](./spec.md)
**Shipped baseline:** [the MCP OAuth draft](../mcp-oauth/spec.md) and its [plan](../mcp-oauth/plan.md), implemented in `cli/src/adapter/` (PR #24, PR #101)
**First interoperability target:** Wivity Link (`signerset/mpas-api-proxy`), whose LinkedIn endpoint admits only enrolled adapters
**Issue:** [#23](https://github.com/oma3dao/mpas/issues/23)
**Date:** 2026-11-05

Requirements are cited by their spec IDs (`OAUTH-n`) or section numbers. Test IDs (`Pn-nn`) are local to this plan.

---

## What this plan covers

The adapter already implements the shipped draft: discovery, PKCE, the CIMD, dynamic and static client modes, the scope guard, refresh with rotation, and `mpas oauth login|status|logout`. This plan builds only what the revised spec adds or changes:

| Spec change | Code today | Phase |
| :--- | :--- | :--- |
| OAUTH-12: several redirect URIs, loopback on any port, standard metadata fields | `validateClientMetadataDocument` requires one redirect equal to the exact loopback URL and rejects field names containing `token` or `credential` | 2 |
| §4.1, OAUTH-15F: trusted client selection; SignerSet-published documents | Client document comes from configuration; no enrolled-adapter path | 2 |
| §6: metadata failures keep their cause and never erase the identity or grant | Discovery failures are not classified | 2 |
| OAUTH-15D to OAUTH-15G: `private_key_jwt` with the adapter's DID key | Not implemented | 3 |
| OAUTH-38: client assertions redacted | Not implemented | 3 |
| OAUTH-05A, §4.2: discovery-selected scope baseline; `offline_access` only from authorization-server metadata | Requests the union of resource and authorization-server `scopes_supported` | 4 |
| OAUTH-29, OAUTH-30, §11, §11.1: phase-aware failures, ambiguous refresh, new reason codes | `reauthorization_required` and discovery failure only; most §11 codes absent | 5 |
| §9.1, §11.2, OAUTH-33A: expected account, upstream results, native wording | Payload forwarded unchanged; no tests for these cases | 6 |

OAUTH-24 and OAUTH-25 changed wording only; the existing file store and process boundary still satisfy them. OAUTH-29's machine-readable reason waits on the shared interoperability contract (spec §15, question 5), so only its fallback and the `account_not_allowed` compatibility case are built here.

Every phase keeps the shipped suites passing: `cli/tests/adapter/mcp-oauth-sdk-conformance.test.ts`, `oauth-operator.test.ts`, `oauth-fetch-policy.test.ts`, `oauth-scope-guard.test.ts`, `oauth-scope-refresh.test.ts`, `mcp-http.test.ts`, and `cli/tests/cli/oauth.test.ts`. A shipped test that contradicts the revised spec is changed in the same commit as the behavior, with the requirement cited.

---

## Phase 0: Decisions

Accepted 2026-11-05.

- **Ambiguous refresh (OAUTH-30).** A timeout, connection loss, or 5xx after a refresh request was sent leaves the stored session unchanged and marks it `refresh_uncertain`. Dispatch is refused before the ledger's `executing` write with `oauth_token_refresh_failed`. `mpas oauth status` shows the state and the login command. The adapter never resends the old refresh token on its own; the operator recovers with `mpas oauth login`, which replaces the session. No server's grace period is relied on, because none is a documented replay-safe contract.
- **Reason codes (§11).** Status output, operator errors, and agent-facing rejections use the spec's lowercase reason codes. Existing uppercase constants such as `OAUTH_REAUTHORIZATION_REQUIRED` map to them, and the mapping is one table in `oauth-operator.ts`.
- **Signing key (OAUTH-15E).** The adapter's existing DID key (the `adapterKey` the daemon loads) signs client assertions. `mpas oauth login` and `logout` load it from the same file as the daemon; no copy is made and no second key is created.

### Exit criteria

- Done: the three decisions above are accepted. They need no spec change, since `refresh_uncertain` is an adapter-local state reported with the existing `oauth_token_refresh_failed` code.

---

## Phase 1: Fixtures

**Area:** `cli/tests/fixtures/oauth-protected-mcp.ts`

Extend the in-process authorization server and protected MCP resource:

- `private_key_jwt` mode: advertises it with `EdDSA` and `ES256`, verifies assertions on the token and revocation endpoints, records each `jti`, and returns `invalid_client` for a bad assertion.
- Client documents served from a fake SignerSet origin: several redirect URIs, a portless loopback redirect, an HTTPS callback on another domain, `token_endpoint_auth_method`, and public `jwks`.
- Failure injection: metadata 404, invalid JSON, timeout, 429 and 5xx; a refresh that rotates the token and then drops the response; a 403 with body `{"error":"account_not_allowed"}` and no Bearer challenge; an authorization callback with `access_denied`.
- Scope modes: `offline_access` only in authorization-server metadata; a refresh token issued without it; no refresh token at all; provider-prefixed scopes in the token response.
- A write tool that checks an `expectedAccountId` argument against the grant's account and returns a tool error on mismatch.

| # | Test |
| :--- | :--- |
| P1-01 | Every fixture mode starts and stops in-process with no network access and logs no secret by default. |

### Exit criteria

- Done: P1-01 passes, and the shipped suites pass against the extended fixture.

---

## Phase 2: Client documents and selection

**Area:** `oauth-operator.ts` (`validateClientMetadataDocument`), `config-loader.ts`, `oauth-discovery.ts`

| # | Test |
| :--- | :--- |
| P2-01 | A document with three redirect URIs is accepted when the selected callback is one of them. A selected callback absent from the list is rejected. OAUTH-12 |
| P2-02 | A registered `http://127.0.0.1/callback` matches the adapter's callback on any port; host, path and query must match exactly. `localhost` does not match `127.0.0.1`. OAUTH-12 |
| P2-03 | An exact registered HTTPS callback on a domain other than the document's host is accepted. §6 |
| P2-04 | A document with `token_endpoint_auth_method`, public `jwks`, `grant_types` and `response_types` is accepted. A document with a private key member (`d`) in `jwks`, or a field referring to a private key, is rejected. OAUTH-12, OAUTH-15F |
| P2-05 | The shipped rejections still hold: non-HTTPS URL, root path, redirect during fetch, `client_id` differing from the URL, oversized body, timeout, missing `client_name` or `redirect_uris`, and missing `refresh_token` grant when refresh is requested. OAUTH-12 |
| P2-06 | A document at the fake SignerSet URL for the adapter's DID is accepted as CIMD, with that URL as `client_id`. OAUTH-15F |
| P2-07 | CIMD configured but `client_id_metadata_document_supported` absent fails with `oauth_client_registration_failed`; no dynamic registration and no public-client fallback happen. OAUTH-12A, §4.1 |
| P2-08 | Client document, callback and signing-key reference come only from operator configuration. A tool argument, Action payload, chat-supplied value or server error URL cannot change them. §4.1, OAUTH-04 |
| P2-09 | A metadata timeout, 429 or 5xx reports `oauth_temporarily_unavailable` or `oauth_rate_limited`, and the stored session and configured identity are unchanged. A 404 or invalid document reports `oauth_discovery_failed` or `oauth_client_registration_failed`. §6, §11.1 |

### Exit criteria

- Done: P2-01 to P2-09 pass in CI.

---

## Phase 3: `private_key_jwt`

**Area:** new `cli/src/adapter/oauth-client-auth.ts`, used by the token and revocation requests in `oauth-operator.ts`

| # | Test |
| :--- | :--- |
| P3-01 | With a document declaring `private_key_jwt` and the adapter's public key, code exchange, refresh and revocation each carry a client assertion and `client_assertion_type` `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`. OAUTH-15D |
| P3-02 | The assertion header has `alg` `EdDSA` for an Ed25519 key and `ES256` for a P-256 key, and `typ` `client-authentication+jwt`. Its claims are `iss` and `sub` equal to `client_id`, `aud` equal to the issuer, a `jti` of at least 128 bits, `iat`, and `exp` at most 60 seconds after `iat`. OAUTH-15E |
| P3-03 | Two requests never share a `jti`, and no assertion is written to the session store. OAUTH-15E |
| P3-04 | Authorization-server metadata without `private_key_jwt` in `token_endpoint_auth_methods_supported` fails with `oauth_client_registration_failed` before any token request. OAUTH-15D |
| P3-05 | A document declaring `none`, or no method, sends no assertion. OAUTH-15D |
| P3-06 | An unsupported declared method, a `jwks` key differing from the adapter's DID key, a signing algorithm the server does not advertise, or an unreadable key file each stop the request with `oauth_client_authentication_failed`, and nothing is sent unauthenticated. OAUTH-15G |
| P3-07 | A token or revocation response of `invalid_client` reports `oauth_client_authentication_failed`, not `oauth_reauthorization_required`, and does not start login. §11.1 |
| P3-08 | The method is part of the session binding: changing the document's method after login makes the session unusable for dispatch until the operator logs in again. OAUTH-15D, OAUTH-05 |
| P3-09 | An assertion cannot verify as an MPAS RFC 9421 signature, and an MPAS signature cannot pass as an assertion. OAUTH-15E |
| P3-10 | Logs, status output, errors and audit records across login, refresh and logout contain no assertion. OAUTH-38 |
| P3-11 | Agent, proposer and bridge processes cannot read the adapter key or cause an assertion to be signed. OAUTH-25 |
| P3-12 | Logout with an unavailable signing key still deletes local credentials, reports that revocation failed, and sends no unauthenticated revocation. OAUTH-15G, OAUTH-31 |

### Exit criteria

- Done: P3-01 to P3-12 pass in CI for both key types.

---

## Phase 4: Scopes

**Area:** `oauth-operator.ts` (`discoverSupportedScopes`), `oauth-scope-guard.ts`

| # | Test |
| :--- | :--- |
| P4-01 | With scopes omitted from configuration, first login requests the challenge's scope; without a challenge, the resource metadata's `scopes_supported`; without either, no `scope`. Authorization-server `scopes_supported` is not merged in. §4.2 |
| P4-02 | The requested set is recorded before consent and used for later unattended requests. A later challenge outside it returns `oauth_insufficient_scope` and starts no consent. OAUTH-05A |
| P4-03 | With `offline_access` only in authorization-server metadata and refresh policy enabled, the adapter may request it; a refresh token issued without it is used; with no refresh token, the session expires to `oauth_login_required` without error. §4.2 |
| P4-04 | A returned `scope` replaces the recorded granted set. Extra granted scopes, including provider-prefixed ones, do not expand configuration or the step-up allowlist. §4.2 |
| P4-05 | Operator reauthorization requests the previously granted scopes the current policy permits, and `invalid_scope` is reported once, not retried. §4.2 |
| P4-06 | Explicitly configured fixed scopes behave as in the shipped draft, including allowlisted operator step-up. OAUTH-05A |
| P4-07 | Two sessions for different resources on one authorization server refresh independently. §4.2 |

### Exit criteria

- Done: P4-01 to P4-07 pass, and `oauth-scope-guard.test.ts` and `oauth-scope-refresh.test.ts` pass with any changes cited.

---

## Phase 5: Refresh and failure classification

**Area:** `oauth-operator.ts`, `dispatch/mcp-http.ts`, `adapter-api-server.ts`

| # | Test |
| :--- | :--- |
| P5-01 | A rotation whose response is lost leaves the stored session unchanged, marks it `refresh_uncertain`, and refuses dispatch with `oauth_token_refresh_failed` before the `executing` write. The old refresh token is not resent. OAUTH-30, Phase 0 decision |
| P5-02 | A refresh refused before processing (connection refused, DNS failure) may retry within the bounded policy, honoring `Retry-After`. OAUTH-30 |
| P5-03 | A temporary refresh failure is never reported as revoked or denied, and never erases the session. OAUTH-30 |
| P5-04 | An unqualified `invalid_grant` marks the session `reauthorization_required` once and gives the login command; it is not retried. OAUTH-29 |
| P5-05 | A resource 403 with JSON error `account_not_allowed` and no Bearer challenge reports `oauth_access_denied` with no login advice, both at dispatch and in status. OAUTH-29, §11 |
| P5-06 | A resource 403 with any other body keeps the denial and sanitized status without suggesting login or more scopes. §11.1 |
| P5-07 | An authorization callback `access_denied` reports `oauth_authorization_denied`, keeps the connection incomplete, and does not restart login. §11.1 |
| P5-08 | An unknown error code is reported as unknown with safe diagnostics; no recovery is chosen from free text, and no URL or command in a response is followed. §11.1 |
| P5-09 | Each §11 code that applies to the CLI appears in status output and agent-facing rejections with no secret, and maps from the existing constants by one table. §11, Phase 0 decision |
| P5-10 | After an MCP 401, a refresh whose outcome is unknown once sent (a 2xx with invalid JSON, a missing or non-string `access_token`, or a `token_type` other than Bearer; a 5xx; a lost response) persists `refresh_uncertain` and is reported with `oauth_token_refresh_failed`. The next call is refused before the `executing` write without resending the old refresh token, and `mpas oauth login` recovers. OAUTH-30, Phase 0 decision |
| P5-11 | A proactive refresh answered 2xx with any of those unusable bodies is handled the same way: `refresh_uncertain`, `oauth_token_refresh_failed`, and the old refresh token is not resent. OAUTH-30 |
| P5-12 | `refresh_uncertain` is recorded before a refresh request is sent and cleared only in the write that commits the new tokens, or on a definite outcome. If the session write fails after a rotating 2xx, after an MCP 401 or on a proactive refresh, the stored session keeps the old tokens marked `refresh_uncertain`, dispatch reports `oauth_token_refresh_failed`, and the old refresh token is not resent. A same-process caller waits for the in-flight refresh instead of reading its marker. OAUTH-30, Phase 0 decision |

### Exit criteria

- Done: P5-01 to P5-12 pass in CI.

---

## Phase 6: Dispatch, accounts and results

**Area:** `dispatch/mcp-http.ts`, dispatch ledger

| # | Test |
| :--- | :--- |
| P6-01 | An `expectedAccountId` argument reaches the server unchanged, after dispatch and after connection repair. No argument selects a credential. §9.1 |
| P6-02 | After the operator reconnects as the same account, a pending never-dispatched write succeeds. After reconnecting as a different account, the fixture's precondition fails and the adapter does not substitute credentials or alter the argument. §9.1 |
| P6-03 | A tool error with `isError: true`, including structured `outcome_unknown`, `account_mismatch`, `reconnect_required` and `client_upgrade_required` results, is preserved for the caller and recorded `failed`, and is never replayed, including after reconnection. §11.2, OAUTH-35 |
| P6-04 | A path that needs login returns the login command and neither runs it, opens a browser, nor starts consent. OAUTH-33A |

### Exit criteria

- Done: P6-01 to P6-04 pass in CI, and the shipped dispatch-ledger tests still pass.

---

## Phase 7: Interoperability and release

| # | Test |
| :--- | :--- |
| P7-01 | Against a local Wivity Link with the synthetic provider on an `enrolled_adapter` endpoint and a fake SignerSet publishing the adapter's document, `mpas oauth login` completes with `private_key_jwt`, calls a tool, refreshes, and logs out with revocation. |
| P7-02 | The same against an `open` endpoint as a public client, unchanged from the shipped behavior. |
| P7-03 | Against Wivity Link staging with the real SignerSet document for an enrolled adapter, login and one tool call succeed. A second organization's adapter is refused at login with `oauth_authorization_denied`. |

Then:

- Release `@oma3/mpas-cli` with this work.
- Wivity Link pins that version for its P2-23 adapter test and turns on the `enrolled_adapter` run.
- Update the shipped draft's status line to point here, and document the enrolled-adapter configuration in the CLI README.

### Exit criteria

- P7-01 and P7-02 pass in CI. P7-03 passes against staging once Wivity Link's Phase 3 is deployed.
- Partly done: P7-01 and P7-02 pass against a local Wivity Link through the separately gated `npm run test:interop:wivity-link`. It needs a `mpas-api-proxy` checkout and PostgreSQL, so it is not part of `npm test` or CI yet.

---

## Cross-repository work

**`signerset/mpas-api-proxy` (Wivity Link)** — remove `offline_access` from its protected-resource metadata and keep it in authorization-server metadata (spec §15). Its P2-23 test pins the release from Phase 7. Its refresh denial stays `invalid_grant` until the shared reason contract exists.

**`signerset/mpas-coordination-server`** — publishes the enrolled adapter's client document (entitlement spec §4.3). Already built; P7-03 needs its staging deployment.

**`signerset/mpas-companions-ios`** — the native adapter meets the same spec through its own plan (its spec §11.3). Nothing here blocks it.

---

## Risks

| Risk | Effect | Mitigation |
| :--- | :--- | :--- |
| The MCP SDK's token requests cannot carry a client assertion | `private_key_jwt` needs its own token request code | Check the SDK's `addClientAuthentication` hook first; fall back to a narrow wrapper for token and revocation requests only |
| An operator command cannot read the adapter key under the deployment's file permissions | Login fails for enrolled adapters | Load the key through the same path and permission checks as the daemon (Phase 0 decision) |
| Relaxing `validateClientMetadataDocument` accepts a document it should not | Weaker client binding | P2-04 and P2-05 keep every shipped rejection |
| A server's refresh is ambiguous often | Operators log in again more often | Accepted: no blind replay (OAUTH-30); revisit when a server documents a replay-safe contract |

---

## Definition of done

- [ ] P1-01 to P7-02 pass in CI, and P7-03 passes against staging.
- [x] Every changed requirement in the table above maps to a passing test.
- [x] The shipped suites pass, with any changed test citing its requirement.
- [x] No token, assertion or private key appears in logs, status, errors, receipts or MCP results.
- [ ] A released CLI connects to Wivity Link's `enrolled_adapter` endpoint.
