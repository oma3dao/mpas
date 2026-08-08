# MPAS Coordination Authentication — Decisions

**Companion to:** [`spec.md`](./spec.md)
**Issue:** [#3](https://github.com/oma3dao/mpas/issues/3)

This document captures the reasoning behind key design choices. The spec states what we build; this explains why.

---

## 1. Current State and Motivation

The HTTP profile defines Coordination Service authentication end to end. §4.6 specifies the RFC 9421 profile, §8.5 scopes returned data to the participant DID after the required identity representations agree, §10.3 requires enforcement outside the trust boundary, and §11.3 includes authentication in Coordination Service conformance. Authentication may remain disabled only for endpoints inside that boundary. The reference topology defaults enforcement off. A fresh hosted Coordination Service outside the trust boundary defaults enforcement on and must not be exposed unenforced; existing deployments stage server support, ship signing bridges, and then perform a coordinated cutover.

The trust boundary is the operator-defined set of components and administrative principals within which unauthenticated participant identity claims are accepted. Authentication may be disabled only if every caller able to reach the Coordination Service is trusted to make any participant claim the instance accepts, or equivalent isolation prevents cross-participant access. Access to participant keys is relevant evidence when assessing a deployment but does not define the boundary, and network placement alone does not define it. Outside this boundary, Coordination Service authentication must be enforced.

The implementation plan tracks adoption of those requirements. Until an implementation enforces the profile, its existing unauthenticated behavior remains safe only within the local, single-operator trust model for which it was built:

| # | Unauthenticated behaviour | Consequence if exposed beyond the trust boundary |
|---|---|---|
| CUR-01 | Poll scopes data using a body-supplied DID | Supplying another participant's DID can disclose pending Approval Requests and execution payloads. |
| CUR-02 | Cancel compares against a body-supplied DID | The ownership check has no authenticated caller identity to bind. |
| CUR-03 | Writes are accepted from any caller | Anyone may submit Action Packages or Approvals. Artifact signatures prevent forged content; they do not prevent flooding or state-machine abuse. |

The approval guarantee is unaffected — Approvals remain signed and hash-bound. Authentication addresses confidentiality, availability, and tenant isolation rather than changing MPAS approval authority.

### 1.1 Why the 60-second ceiling is mandatory

The 60-second maximum for `expires - created` is a deliberate MPAS profile constraint, not a suggested implementation default. Both values are integer timestamps, `expires` must be strictly greater than `created`, and the difference must not exceed 60 seconds. This bounds the declared lifetime of a captured signature and the state-retention window for nonce replay protection. Clients and deployments may choose a shorter declared lifetime but not a longer one.

Clock-skew tolerance is separate and remains configurable, with 30 seconds as the suggested default. The declared maximum lifetime remains 60 seconds, but accepting `created` up to the configured future `clockSkew` can extend the server-observed acceptance horizon by up to that skew. This deliberately tightens RFC 9421, which defines the parameters but does not impose the MPAS maximum.

---

## 2. Why RFC 9421

Every participant already holds a signing key — a Signer cannot produce an Approval without one, a Proposer cannot sign an Action Envelope without one. Authentication that reuses that key adds no provisioning step.

`did:jwk` makes the key self-certifying: the DID *contains* the public key. Verification requires no registry, no resolution, no network call, and no stored secret.

RFC 9421 has a designated application-profile slot — choose covered components, set `keyid`, pick an expiry window. The only MPAS-specific statement is that `keyid` is the caller's DID.

---

## 3. Alternatives Considered

| Option | Ratified | Reuses signer key | Outcome |
|---|:---:|:---:|---|
| **RFC 9421 + RFC 9530** | Yes (2024) | Yes | **Selected** |
| DPoP (RFC 9449) standalone | Yes (2023) | Yes | Rejected — see §3.1 |
| DPoP as designed (with OAuth AS) | Yes | Yes | Rejected — introduces an authorization server dependency; token machinery with no delegated authority to express |
| Signed JSON body (issue #3 shape) | No — bespoke | Yes | Rejected as normative |
| Custom JWT proof artifact | Container only | Yes | Rejected — invented, unadopted binding claims |
| RFC 7523 token exchange | Yes (2015) | Yes, at issuance | Deferred — adds a token endpoint to a mailbox service |
| mTLS (RFC 8705) | Yes | No | Rejected — requires X.509 issuance; TLS terminates upstream |
| OIDC / SAML / enterprise SSO | Yes | No | Rejected — human-interactive; appropriate for account layer only |
| Passkeys / WebAuthn | Yes | No | Rejected — user-present ceremony, wrong for headless polling |
| API keys / bearer tokens | No | No | Rejected as authentication. Viable as entitlement handle |
| DIDComm / SIOPv2 / OID4VP | Partly | Yes | Rejected — VC infrastructure for no gain at this boundary |

### 3.1 Why not DPoP

RFC 9449 is built for sender-constraining an OAuth access token. Used standalone (no token to bind to), it operates in a mode the RFC does not define.

- Its required claims (`htm`, `htu`) are HTTP-specific — no more transport-agnostic than RFC 9421.
- It cannot bind the request body. There is no digest claim and no slot for one.

Real-world usage confirms the token-coupled shape: atproto mandates DPoP for token requests and resource requests; FAPI 2.0 permits it as one of two sender-constraining options. Both are OAuth deployments.

---

## 4. Why `audience` Lives in the Body, Not `@authority`

`@authority` derives from the `Host` header. A TLS-terminating reverse proxy may rewrite it, making verification brittle.

Without an audience binding, a signature captured at deployment A replays at deployment B whenever a participant DID exists on both.

A configured identifier in the body is strictly better:

| | `@authority` | `audience` in body |
|---|---|---|
| Value derived from | the connection (`Host`) | configured coordination URL origin |
| Survives proxy rewriting and TLS termination | No | Yes |
| Covered by the signature | directly | transitively, via `content-digest` |

The client derives the value from its configured coordination URL origin, including a non-default port and excluding path and trailing slash. Bridges use that same URL and their existing or lazily resolved `KeyManager`; there is no separate audience configuration. Signed requests always carry `audience`. Only an unsigned request to an unenforcing service may omit it, and an unenforcing server ignores it if present.

Same pattern as OAuth `aud` claims and RFC 8707 resource indicators.

---

## 5. What `content-digest` Is For

Not in-flight integrity — TLS handles that, and MPAS artifacts carry their own signatures.

It is **replay scoping**. A captured `/action-cancel` signature without body binding replays with any `actionId`, cancelling a different action belonging to the same proposer. Covering the digest constrains replay to the exact original body.

---

## 6. Why Two Layers (Authentication vs Entitlement)

x402 identifies a **payer** (wallet address), not a **principal**. Its specification states that servers "do not need to manage client identities." If payment were the access gate, any party could pay and read another participant's mailbox.

The authenticated DID is the privacy boundary in every tier. Entitlement is layered above it and never substitutes for it.

---

## 7. Transport Scope

RFC 9421 is HTTP-bound. Accepted deliberately:

- A Coordination Service is inherently networked — a mailbox multiple parties poll. All four endpoints are HTTP.
- MCP streamable HTTP is HTTP; RFC 9421 headers traverse it unmodified.
- Components over stdio are bridges, which are out of scope. MCP is developing its own authorization for that boundary.

The authentication profile belongs in the HTTP profile (§4), not `mpas-specification.md`. The core spec stays transport-neutral.

---

## 8. Enforcement Defaults

Enforcement follows the trust boundary defined in §1. Key access may inform the assessment but does not define the boundary, and network placement alone is insufficient.

| Deployment | Default | Rationale |
|---|---|---|
| Reference / demo | **Off** | Its documented topology keeps the endpoint inside the trust boundary. |
| Fresh hosted / cloud outside the trust boundary | **On** | It must enforce authentication and must not be exposed unenforced. |

Existing deployments use the coordinated cutover in the implementation plan. Production endpoints use HTTPS independently; TLS does not replace required participant authentication.

---

## 9. Why `Idempotency-Key` and `nonce` Are Separate

They pull in opposite directions:

| | `Idempotency-Key` | `nonce` |
|---|---|---|
| Purpose | a retry produces the *same* result | a replay is *rejected* |
| On retransmission | unchanged | fresh |

Collapsing them would cause a legitimate network-failure retry to hit the nonce cache and return 401.

For mutating endpoints, replay protection is a commit guard rather than an early parser side effect. Signature, digest, freshness, audience, and identity checks run first; only a request eligible to mutate state atomically claims `(keyid, nonce)` immediately before mutation. Exactly one concurrent claimant succeeds, the claim remains through `expires`, and invalid requests do not burn a nonce. Hosted deployments therefore need a durable store whose claim operation preserves these semantics across processes, not merely a durable key-value cache.

An integration whose store operation currently combines validation and mutation must introduce a side-effect-free preflight followed by commit. The nonce claim sits between those operations: preflight establishes that the request is eligible to mutate, the claim supplies the replay commit guard, and the mutation follows immediately. This ordering is what allows a corrected request to reuse a nonce that appeared on an invalid request.

---

## 10. Enrolment

Authentication is self-enrolling. `did:jwk` is self-certifying — nothing to register.

Authorization to act comes from coordination state itself (a DID may read or submit an Approval for a workflow only if it appears in that workflow's eligible signers, and may cancel only what it proposed).

Relating enrolment to policy `signerGroups` is deliberately avoided — those express approval authority, evaluated by the Verifier. Using them as a transport access list would collapse the authentication/approval boundary.

---

## 11. Dependency Choice

**Selected:** [`http-message-signatures`](https://github.com/dhensby/node-http-message-signatures) (dhensby) `1.0.6`.

**Content-Digest:** [`structured-headers`](https://www.npmjs.com/package/structured-headers) `2.0.3` — to be added as an exact direct SDK dependency and pinned in the lockfile; RFC 9651/8941 implementation.

**Ed25519 / keys:** `jose` (existing) + `KeyManager` — already in the SDK. `KeyManager.sign()` produces compact JWS for MPAS artifacts, whereas RFC 9421 Ed25519 signs the raw signature-base bytes. Phase 1 therefore adds a raw Ed25519 signing capability or adapter without changing the compact-JWS artifact API.

### 11.1 Why the original choice was withdrawn

This document previously named Cloudflare [`web-bot-auth`](https://github.com/cloudflare/web-bot-auth) as primary, with dhensby as a fallback to be used only "if Cloudflare's library cannot produce/verify known-answer vectors." That condition was met. Three findings, in increasing order of weight:

**The primary and a rejected option were the same code.** The list below rejected `http-message-sig` as "fork of `@ltonetwork`, 0.x." But `http-message-sig` *is* `web-bot-auth`'s RFC 9421 engine — same monorepo (`cloudflareresearch/web-bot-auth`), same maintainer, and `web-bot-auth`'s sole dependency for signature construction. Adopting the primary meant adopting the rejected package transitively. The two entries could not both stand.

**The wrapper enforces an incompatible profile.** `web-bot-auth`'s own API is not merely opinionated but actively rejects this profile: it hard-enforces `tag="web-bot-auth"`, defaults covered components to `("@authority")` or `("@authority" "signature-agent")`, requires a 64-byte nonce, and identifies keys by RFC 7638 JWK thumbprint resolved from a fetched `/.well-known/http-message-signatures-directory`. Every one of those contradicts §4.6 — AUTH-02 forbids `@authority`, AUTH-08 requires `mpas-v1`, and AUTH-04 forbids resolution. Using it therefore means bypassing the wrapper and importing the engine directly, which returns to the previous finding.

**The engine cannot reproduce RFC 9421's own vectors.** See §12. `http-message-sig` unconditionally injects `alg="ed25519"` into `@signature-params`, so it cannot produce the signature base or signature bytes in RFC 9421 B.2.6, nor the wire format in HTTP profile §4.6.1, which omits `alg`. dhensby reproduces both byte-exactly.

To be precise about severity: the injected `alg` is **not** an interop bug. `alg` is an optional RFC 9421 parameter, and a verifier reconstructs the base from the received `@signature-params` verbatim, so Cloudflare-signed requests verify correctly against conforming verifiers. What it precludes is pinning our implementation to the RFC's vectors, and emitting the wire format this specification documents.

### 11.2 Supporting signals

Measured 2026-08-07:

| package | weekly downloads | version | last release |
|---|---:|---|---|
| `http-message-signatures` (dhensby) | 22,416 | 1.0.6 | 2026-06-04 |
| `http-message-sig` (Cloudflare engine) | 31,994 | 0.2.0 | 2026-01-14 |
| `web-bot-auth` (Cloudflare wrapper) | 27,938 | 0.1.3 | 2026-03-09 |
| `@ltonetwork/http-message-signatures` | 1,421 | 0.1.12 | 2024-09-26 |

Cloudflare's engine has the higher raw count, but that traffic is captive — it is a dependency of `web-bot-auth`, so its downloads largely reflect the wrapper's adoption and exercise one narrow path (`@authority`-only signing, thumbprint keyids). dhensby's count is independent general-purpose adoption across varied component sets, which is the surface this profile depends on. dhensby is also post-1.0 with a semver commitment, versus 0.x.

On lineage: Cloudflare forked `ltonetwork/http-message-signatures`, which is dormant (last release 2024-09-26, four stars) and whose README targets `draft-ietf-httpbis-message-signatures-00` — years before RFC 9421 was ratified. Cloudflare has evolved the fork forward in-tree and does not appear to upstream. There is no shared canonical implementation in this ecosystem to converge on; see §12.

**Rejected:**
- `web-bot-auth` — enforces a conflicting profile (§11.1); built on `http-message-sig`.
- `http-message-sig` — 0.x fork of a dormant draft-00 implementation; fails RFC 9421 B.2.6 (§12); base construction not exported, forcing verification through a non-injectable clock.
- `@misskey-dev/node-http-message-signatures` — last publish 2024; ActivityPub-oriented; under-maintained.
- Hand-rolled signature base — last resort only if the selected library fails vectors.

---

## 12. Conformance Vectors

Known-answer vectors are taken from **RFC 9421 Appendix B**, not generated by our implementation.

A vector generated from the library under test is self-referential: it proves that signing and verification agree, not that either is correct, and it will ratify a shared bug on both sides. Since sign and verify deliberately share signature-base construction (a drift-prevention measure), a self-generated vector cannot detect a fault in the thing it is most important to get right.

The RFC's vectors are the vendor-neutral artifact. This is the general pattern for IETF specifications: the shared, independently-governed reference is the specification and its test vectors, not a blessed implementation. That is why no canonical community repository exists for RFC 9421 and why looking for one is the wrong search — interop is anchored to Appendix B, and each implementation is checked against it.

**Vectors used:**

| Source | Content |
|---|---|
| B.1.4 | `test-key-ed25519` — Ed25519 keypair, given in JWK form |
| B.2 | `test-request` — the canonical request message |
| B.2.6 | "Signing a Request Using ed25519" — expected signature base and signature |

Ed25519 is deterministic (RFC 8032 §5.1.6), so a fixed key over a fixed base yields exactly one correct signature and byte comparison is valid. The RFC notes this does **not** hold for ECDSA (B.2.4), whose signatures vary per run and can only be validated, not reproduced. Vector selection reflects that: B.2.6 is used for byte-exact assertions.

B.2.6 covers `("date" "@method" "@path" "@authority" "content-type" "content-length")` — deliberately not the MPAS covered-component set. It validates general signature-base construction, including that `@path` excludes the query string. The MPAS profile's own three-component set is then exercised separately by round-trip and policy tests, and by the fixtures in `conformance/`.

Because these vectors are library-independent, the dependency in §11 is replaceable without changing the correctness gate.
