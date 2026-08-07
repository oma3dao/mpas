# MPAS Coordination Authentication — Specification

**Status:** Draft
**Issue:** [#3 — Add signature-based authentication to Coordination poll API](https://github.com/oma3dao/mpas/issues/3)
**Affects:** `specs/mpas-profile-http.md`, `sdk/protocol/`, `examples/demo/src/coordination/`
**Downstream:** [`wivity/mpas-coordination-server`](https://github.com/wivity/mpas-coordination-server)
**Mechanism:** RFC 9421 HTTP Message Signatures, Ed25519, `keyid` = caller DID
**Decisions:** [`decisions.md`](./decisions.md)

---

## 1. Purpose

Authenticate callers to a Coordination Service by proving control of the DID they claim, so that DID-scoped coordination state is only readable and mutable by the participant that owns it.

- **Privacy.** Pending Approval Requests contain the full `SignerReviewSet`. Only the holder of the DID's private key may read them.
- **Commercial.** A hosted Coordination Service must attribute calls to a payer or account.

Authentication identifies the caller to the service. It is **not** an MPAS Approval. Per HTTP profile §4.4, nothing in this design may create a path by which a transport identity is treated as approval authority.

---

## 2. Architecture

| Layer | Question | Subject | Varies by revenue model |
|---|---|---|---|
| **Authentication** | Do you control this DID? | the `did:jwk` key | No — identical in all tiers |
| **Entitlement** | Does this call get served, and who is billed? | wallet / account / terms record | Yes |

The authenticated DID is the privacy boundary in every tier. Entitlement is layered above it and never substitutes for it. This document defines the authentication layer normatively and the entitlement layer as an interface (§8).

The **trust boundary** is the operator-defined set of components and administrative principals within which unauthenticated participant identity claims are accepted. Authentication may be disabled only if every caller able to reach that Coordination Service is trusted to make any participant claim the instance accepts, or equivalent isolation prevents cross-participant access. Access to participant keys is relevant evidence in deployment assessment but does not define the boundary. Network placement alone does not define it. Outside this boundary, Coordination Service authentication MUST be enforced.

---

## 3. Wire Format

```http
POST /mpas/v1/coordination/poll HTTP/1.1
Content-Type: application/mpas+json
Content-Digest: sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:
Signature-Input: mpas=("@method" "@path" "content-digest");\
  created=1754400000;expires=1754400060;\
  keyid="did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Ii4uLiJ9";\
  nonce="f9a3c1b7e2d4508a";tag="mpas-v1"
Signature: mpas=:K2qGT5srn2OGbOIDzQ6kYT+ruaycnDAAUpKv+ePFfD0RAxn...:

{"version":"1","type":"CoordinationPollRequest",
 "did":"did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Ii4uLiJ9",
 "audience":"https://coordination.example.com"}
```

Signature base:

```
"@method": POST
"@path": /mpas/v1/coordination/poll
"content-digest": sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:
"@signature-params": ("@method" "@path" "content-digest");created=1754400000;\
expires=1754400060;keyid="did:jwk:...";nonce="f9a3c1b7e2d4508a";tag="mpas-v1"
```

---

## 4. Requirements

### 4.1 Signature profile

| # | Requirement |
|---|---|
| AUTH-01 | Covered components MUST be exactly `("@method" "@path" "content-digest")`. |
| AUTH-02 | `@authority` and `@target-uri` MUST NOT be covered (proxy rewriting; see [decisions.md §4](./decisions.md#4-why-audience-lives-in-the-body-not-authority)). |
| AUTH-03 | `keyid` MUST be the caller's `did:jwk` DID. The embedded JWK MUST be public-only; any private key material MUST be rejected. |
| AUTH-04 | The verification key MUST be derived from `keyid` via the MPAS `did:jwk` decoding rule. No DID document is fetched; no resolver is invoked. |
| AUTH-05 | The algorithm is EdDSA, derived from the Ed25519 key in the `did:jwk`. If `alg` is present in signature parameters, it MUST equal `ed25519` — any other value MUST be rejected. Signers SHOULD omit it (HTTP profile §4.6.2); verifiers MUST accept both forms. Future key types define their own algorithm binding. |
| AUTH-06 | `created` and `expires` MUST be present integer timestamps. `expires` MUST be strictly greater than `created`, and `expires - created` MUST NOT exceed 60 seconds. |
| AUTH-07 | `nonce` MUST be present on all four protocol endpoints. |
| AUTH-08 | Signers MUST set `tag="mpas-v1"`; the tag identifies the MPAS application profile and is covered by `@signature-params`. A verifier MUST select exactly one tagged `Signature-Input` member and require a same-label `Signature` member. The label SHOULD be `mpas`, but any matching label conforms. Zero or multiple MPAS candidates MUST be rejected. |
| AUTH-09 | Every signed request MUST carry `audience`. The client derives it from the origin of its configured coordination URL (scheme + host + port when non-default, no path, no trailing slash); there is no separate bridge audience setting. An unsigned request sent to an unenforcing service MAY omit `audience`, and an unenforcing server MUST ignore it if present. An enforcing server's configured audience is a non-empty set of valid service origins and MUST compare by exact string match. |
| AUTH-10 | `Content-Digest` MUST be present and MUST use the `sha-256` algorithm (RFC 9530). The server MUST verify the digest against the received body. |
| AUTH-11 | Requests MUST be served over HTTPS in production (HTTP profile §4.1). TLS is separate transport protection and does not replace authentication when AUTH-20 requires enforcement. |

#### Signature label and tag

`Signature-Input` and `Signature` are Structured Fields dictionaries. A dictionary **label** correlates one input definition with the signature bytes under the same key; it does not authenticate identity. The label SHOULD be `mpas`, but an alternate label is conforming when it matches in both dictionaries. The `tag="mpas-v1"` signature parameter identifies the MPAS application profile and is covered by `@signature-params`.

A verifier parses both dictionaries. If both signature headers are absent while enforcement is enabled, it returns `401 authentication_required`. If only one header is present, either dictionary is malformed, or a selected input has no same-label `Signature` member, it returns `401 signature_invalid`. It selects exactly one `Signature-Input` member tagged `mpas-v1`, ignores unrelated signatures carrying other tags, and rejects zero or multiple MPAS candidates.

For example, this request has one unrelated signature and one MPAS candidate under the conforming alternate label `coord`:

```http
Signature-Input: legacy=("@method");tag="other", coord=("@method" "@path" "content-digest");created=1754400000;expires=1754400060;keyid="did:jwk:...";nonce="f9a3c1b7e2d4508a";tag="mpas-v1"
Signature: legacy=:...:, coord=:...:
```

### 4.2 Identity equality and endpoint authorization

| # | Requirement |
|---|---|
| AUTH-12 | Before processing `poll`, signature `keyid` MUST equal `CoordinationPollRequest.did`; mismatch MUST be rejected with 403. The request MUST be scoped to that agreed DID. |
| AUTH-13 | Before processing `action-cancel`, signature `keyid` MUST equal request `proposerDid`, and both MUST equal the stored proposer; any mismatch MUST be rejected with 403. |
| AUTH-14 | Before processing `action`, signature `keyid` MUST equal `actionPackage.actionEnvelope.proposer.did`; mismatch MUST be rejected with 403. |
| AUTH-15 | Before processing `approval`, signature `keyid` MUST equal the signer DID decoded from the Approval, and that DID MUST be an eligible signer for the referenced workflow; mismatch or ineligibility MUST be rejected with 403 before the Approval is stored or counted. |

Once the representations required by an endpoint are equal, this specification does not prescribe which equal representation an implementation uses internally.

For `action-cancel` and `approval`, an unknown Action or workflow cannot establish the required stored-proposer or eligible-signer relationship. With enforcement enabled this is `403 permission_denied`, avoiding an existence oracle; with enforcement disabled the existing `404 ACTION_NOT_FOUND` behavior remains unchanged.

### 4.3 Redundant body fields (v1)

| Field | Handling |
|---|---|
| `CoordinationPollRequest.did` | Required in request schema v1 and MUST equal signature `keyid` on signed requests before processing; mismatch is rejected with 403. |
| `CoordinationActionCancelRequest.proposerDid` | Required in request schema v1 and MUST equal signature `keyid` and the stored proposer before processing; mismatch is rejected with 403. |

A future request schema version MAY remove redundant identity fields only at an explicit version boundary. Version 1 will not be mutated in place. Migration and versioning details will be decided if a future revision is proposed.

### 4.4 Replay and freshness

| # | Requirement |
|---|---|
| AUTH-16 | The server MUST reject non-integer timestamps, `expires <= created`, `expires - created > 60`, a `created` value in the future beyond configured `clockSkew`, or an `expires` value that has passed. The declared lifetime maximum is 60 seconds; future clock skew can extend the server-observed acceptance horizon by up to `clockSkew`. |
| AUTH-17 | For `action`, `approval`, and `action-cancel`, only after signature, digest, freshness, audience, identity, authorization, and side-effect-free business preflight validation succeeds and immediately before mutation, the server MUST atomically claim `(keyid, nonce)`. Exactly one concurrent claim succeeds; a successful claim is retained through `expires`; a failed claim is rejected as replay. Invalid requests MUST NOT consume a nonce. |
| AUTH-18 | On `poll`, freshness alone is acceptable initially — the endpoint is read-only and idempotent. |

### 4.5 Configuration

| Setting | Default | Meaning |
|---|---|---|
| enforcement | reference: off; fresh hosted: on | Enforce authentication on protocol endpoints according to the trust boundary. |
| audience | — | Non-empty set of valid origins for this service (for example, `https://coordination.example.com`). Required when enforcing. |
| clockSkew | `30s` | Tolerance for `created` in the future; may extend the server-observed acceptance horizon by up to this amount. |
| signatureLifetime | `60s` | Maximum declared lifetime emitted or accepted by deployment policy; if configurable, MUST be `<= 60s`. |

| # | Requirement |
|---|---|
| AUTH-19 | `GET /mpas/v1/coordination/health` SHOULD remain unauthenticated. |
| AUTH-20 | The trust boundary defined in §2 is the sole enforcement rule. Authentication MAY be disabled only if every caller able to reach the Coordination Service is trusted to make any participant claim the instance accepts, or equivalent isolation prevents cross-participant access. Outside this boundary, Coordination Service authentication MUST be enforced. Key access is relevant assessment evidence but does not define the boundary; network placement alone does not define it. Production HTTPS remains independently required and does not replace authentication. |
| AUTH-21 | Configuration MUST fail closed: enforcement enabled with an empty audience set or any invalid audience origin MUST refuse to start. |
| AUTH-22 | A fresh hosted Coordination Service outside the trust boundary defaults enforcement **on** and MUST NOT be exposed unenforced. The reference implementation defaults enforcement **off** only for its documented in-boundary topology. Existing deployments follow the coordinated rollout in the plan. |

---

## 5. Tenant Isolation

The authenticated DID is the isolation boundary — cryptographic, unforgeable, no mapping table to misconfigure. An explicit tenant concept is required only for subscription billing and arrives as the account above the DID boundary (§8).

---

## 6. Error Responses

A request that presents signature headers but fails any signature selection, parameter, key, digest-independent verification, freshness, nonce, or audience check MUST receive the generic external failure `401 signature_invalid`; implementations MAY retain non-sensitive internal diagnostics. Status codes per HTTP profile §4.8; error codes per §4.9.

| Condition | Status | Code |
|---|---|---|
| Signature headers absent while enforcing | 401 | `authentication_required` |
| Signature malformed, unverifiable, or key mismatch | 401 | `signature_invalid` |
| `created`/`expires` outside window | 401 | `signature_invalid` |
| `nonce` replayed | 401 | `signature_invalid` |
| `audience` mismatch | 401 | `signature_invalid` |
| `Content-Digest` mismatch | 400 | `artifact_hash_mismatch` |
| Authenticated but not the proposer / not an eligible signer | 403 | `permission_denied` |
| Required endpoint identity representations are not all equal | 403 | `permission_denied` |
| Entitlement exhausted or absent | 402 / 429 | deployment-specific |

| # | Requirement |
|---|---|
| AUTH-23 | Failures MUST NOT disclose whether a DID exists or has pending work. |
| AUTH-24 | `Signature`, `Signature-Input`, `keyid`, nonce values, and body content MUST NOT be logged by application, framework, or error logging. |

---

## 7. SDK Surface

### 7.1 API

```ts
// signing — client side
signMpasRfc9421(opts): Promise<Record<string, string>>   // headers

// verification — server side, framework-agnostic
verifyMpasRfc9421(opts): Promise<{ did: Did } | AuthFailure>

// replay storage seam
interface NonceStore {
  // Atomic: exactly one concurrent claim succeeds; successful claims remain through expiresAt.
  claim(keyid: string, nonce: string, expiresAt: Date): Promise<boolean>;
}
```

For mutating endpoints, callers invoke `claim` only after signature, digest, freshness, audience, identity, authorization, and side-effect-free business preflight validation and immediately before mutation. Invalid requests never call `claim` and therefore do not consume nonces. The SDK MUST NOT depend on any HTTP framework (Fastify, Express, Hono, etc.). Verification accepts plain values — method, path, headers, and body bytes — so any server can call it regardless of framework.

### 7.2 Client behavior (`CoordinationClient`)

The `CoordinationClient` already has two things it needs: the coordination service URL (from config) and a `KeyManager` (for signing Approvals and Action Envelopes). Authentication reuses both — no new configuration is required.

| Behavior | Description |
|---|---|
| **Audience derivation** | For every signed request, the client derives `audience` from the configured coordination service URL origin (scheme + host + non-default port; no path or trailing slash). No separate audience config field is used. |
| **Automatic signing** | Real clients and bridges sign all four coordination requests automatically with their existing or lazily resolved `KeyManager`. There is no opt-in flag. |
| **Identity equality** | Before signing, the client ensures its signer DID equals the required endpoint representation: poll `did`, cancel `proposerDid`, Action Envelope proposer DID, or decoded Approval signer DID. It does not send a signed request with a mismatch. |
| **Unsigned fallback** | A client with no signer, such as a keyless test harness, may send an unsigned request without `audience` only to an unenforcing service. |
| **Enforcing service** | A signed request with required audience authenticates normally. An unsigned request receives 401. |
| **Unenforcing service** | Signed and unsigned requests succeed; the server ignores signature headers and ignores `audience` if present. |
| **Auth error distinction** | 401/403 responses surface as `MpasAuthError`, distinct from `CoordinationUnavailableError` (which covers transport failures and 5xx). External presented-signature failures remain generic `signature_invalid`. |

### 7.3 Server behavior (verification)

| Behavior | Description |
|---|---|
| **Enforcement on** | All four protocol endpoints require a valid signature and signed-request audience. `/health` is always unauthenticated (AUTH-19). |
| **Enforcement off** | Signature headers and `audience` are ignored. Identity comes from required v1 body identity fields. |
| **Identity equality and authorization** | When enforcing, verify the endpoint invariant before processing: poll `keyid == did`; cancel `keyid == proposerDid == stored proposer`; action `keyid == actionEnvelope.proposer.did`; approval `keyid == decoded Approval signer DID`, with that DID eligible for the referenced workflow. Reject mismatch or ineligibility with 403. Once equal, no internal representation is prescribed. |
| **NonceStore** | The server supplies a `NonceStore`: in-memory for the demo/reference and durable for hosted deployments. Its claim is atomic across all server instances, exactly one concurrent claim succeeds, successful claims remain through `expires`, and validation failures do not consume nonces. |

| # | Requirement |
|---|---|
| AUTH-25 | The Coordination Service is optional in the MPAS topology. Direct Proposer-to-Verifier and Proposer-to-Signer flows remain valid. |

---

## 8. Entitlement Layer (Interface)

Not part of the protocol. Documented so deployments implement it correctly.

| Tier | Entitlement credential | Billing subject | Enrolment |
|---|---|---|---|
| **x402** | payment header, 402 challenge | wallet address | none |
| **Subscription** | account record with registered DIDs | account | operator registers DIDs |
| **Free (data-use terms)** | terms-acceptance record | none | self-enrol, accept terms |

| # | Requirement |
|---|---|
| AUTH-26 | Entitlement MUST be evaluated only after authentication succeeds. |
| AUTH-27 | Failing entitlement MUST NOT return DID-scoped data. |
| AUTH-28 | No entitlement outcome may be recorded in a way a Verifier could mistake for an Approval. |

---

## 9. HTTP Profile Changes

Implemented in `specs/mpas-profile-http.md` as a v0.2 revision. §15 already reserves "DID-auth or signed HTTP request profiles" as an extension point.

| Section | Change | Strength |
|---|---|---|
| §4.6 | Defines the RFC 9421 authentication profile: covered components, `keyid` = DID, `audience`, freshness, and `tag`. Clients sign per this profile; servers verify per this profile. | normative |
| §4.5 | Clarifies `Idempotency-Key` / `nonce` orthogonality | SHOULD |
| §8.5 | Scopes returned data to the *authenticated* DID when authentication is enforced | MUST |
| §8.5 / §8.7 | Marks `did` and `proposerDid` redundant when authentication is in use | SHOULD |
| §10.3 | Requires a Coordination Service outside the trust boundary to authenticate callers using the §4.6 profile | MUST |
| §11.3 | Includes authentication in Coordination Service conformance requirements | MUST implement |
| §6, §7 | Allows Verifier and Signer endpoints to adopt the same profile | MAY |

Conformance fixtures for the signature base belong in `conformance/`.

---

## 10. Resolved Questions

| # | Question | Resolution |
|---|---|---|
| OQ-01 | Enforcement default | Reference topology off. A fresh hosted Coordination Service outside the trust boundary defaults enforcement on and MUST NOT be exposed unenforced. Existing hosted deployments enable only at the coordinated Phase 7 cutover (§4.5). |
| OQ-02 | Does hosted ingress preserve signed inputs? | The profile excludes `@authority`, but preservation of signature headers and body bytes is verified through the real production proxy/TLS path in Phase 5 before enforcement. |
| OQ-03 | Are 60s validity and 30s skew correct for containers? | Yes. `created` and `expires` are integers, `expires` is strictly later, and the declared lifetime is at most 60 seconds. Configured future `clockSkew` is separate and can extend the server-observed acceptance horizon by up to that skew. See [decisions.md §1.1](./decisions.md#11-why-the-60-second-ceiling-is-mandatory). |
| OQ-04 | x402 in scope? | No — x402 is entitlement-layer, out of scope. If x402 adopts RFC 9421, signatures coexist via different `tag` values. |
| OQ-05 | Nonce store as shared-state hot path at horizontal scale? | Atomic claim semantics are protocol correctness requirements. Storage technology and scaling (Redis, Postgres, etc.) are operator concerns. |

---

## 11. Non-Goals

- Payload encryption (separate concern — encryption for eligible signers)
- Signing `AuthorizationRequirements` (Verifier re-evaluates authoritatively)
- Account-layer authentication (deployment product, not protocol)
- `did:web` or general DID resolution (identity is the key)
- Transport-agnostic proof format (deferred until industry ratifies one)
- Authentication of the MCP client-to-bridge boundary (MCP defines that boundary)
- RFC 7523 token exchange (deferred, not rejected)

---

## 12. Acceptance Criteria

| # | Criterion |
|---|---|
| AC-01 | A signed poll whose signature `keyid` equals required v1 `did` returns only that agreed DID's approval requests and action updates. |
| AC-02 | A poll whose required v1 `did` differs from signature `keyid` is rejected 403 before processing. |
| AC-03 | A cancel unless signature `keyid`, required v1 `proposerDid`, and stored proposer are all equal is rejected 403 before processing. |
| AC-04 | An unsigned request to any protocol endpoint is rejected 401 when enforcing. |
| AC-05 | A captured signature replayed after `expires` is rejected; equal, reversed, non-integer, and over-60-second timestamp pairs are rejected. |
| AC-06 | On a mutating endpoint, nonce claim occurs only after signature, digest, freshness, audience, identity, authorization, and side-effect-free business preflight checks and immediately before mutation; invalid requests do not consume nonces. |
| AC-07 | Exactly one of two concurrent valid mutations using the same `(keyid, nonce)` succeeds, and its claim remains through `expires`. |
| AC-08 | A signature replayed against a different `audience` is rejected; origin derivation handles paths, trailing slashes, ports, and IPv6. |
| AC-09 | A signature replayed with a modified body is rejected on `Content-Digest`. |
| AC-10 | `/health` answers without authentication. |
| AC-11 | With enforcement off, unsigned clients may omit `audience`, and the server ignores it when present. |
| AC-12 | No signature value, `Signature-Input`, `keyid`, nonce, or body content appears in application, framework, or error logs. |
| AC-13 | The demo runs a complete authenticated MPAS workflow with real keys. |
| AC-14 | RFC 9421 Appendix B vectors and MPAS conformance fixtures are committed before release and pass byte-exact on signature base and signature; vectors are not generated by this implementation. |
| AC-15 | No code path, config, entitlement outcome, or documentation allows authenticated identity or authentication success to count as an Approval or satisfy Authorization Requirements. |
| AC-16 | An `action` whose signature `keyid` differs from `actionPackage.actionEnvelope.proposer.did` is rejected 403 before processing. |
| AC-17 | An `approval` whose signature `keyid` differs from the signer DID decoded from the Approval is rejected 403 before processing. |
| AC-18 | Enforcement with an empty audience set or any invalid audience origin refuses startup. |
| AC-19 | Presented-signature validation failures, including malformed, partial, ambiguous, missing-parameter, wrong-tag, freshness, nonce, audience, and key failures, expose only `401 signature_invalid`. |
| AC-20 | With enforcement enabled, absence of both signature headers yields `authentication_required`; one header, malformed dictionaries, or a missing same-label signature yields `signature_invalid`. Exactly one `Signature-Input` member tagged `mpas-v1` is selected, unrelated other-tag signatures are ignored, matching alternate labels conform, and zero or multiple MPAS candidates are rejected. |
| AC-21 | Authentication failures reveal no DID existence or pending-work information; responses for known and unknown DIDs and for DIDs with and without pending work are externally indistinguishable. |
| AC-22 | An authenticated Approval submitter whose DID is not an eligible signer for the referenced workflow is rejected 403 before the Approval is stored or counted. |
