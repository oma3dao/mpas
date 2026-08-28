# MPAS HTTP Profile

**Status:** Draft v0.2
**Companion to:** MPAS Core Specification  
**Scope:** HTTP transport profile for MPAS Action Package submission, Action execution requests, Signer approval requests, Approval collection, Coordination Service routing, polling, and receipt distribution.  
**Normative keywords:** The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described in RFC 2119 and RFC 8174.

---

## 1. Introduction

The core MPAS specification defines transport-neutral artifacts and processing rules for multi-party authorization of digital Actions. Those artifacts include:

- Execution Payload
- Action Envelope
- Signer Review Set
- Approval
- Approval Bundle
- Action Package
- Authorization Requirements
- Execution Receipt

This profile defines how MPAS participants exchange those artifacts over HTTP.

The primary operation in this profile is not a request for abstract verification. The primary operation is a request to process an Action Package and execute the Action if policy is satisfied. Verification is the deterministic processing step performed by the Verifier before execution.

This profile defines three HTTP interfaces:

1. **Verifier / Application Action Interface**  
   Used by a Proposer to submit an Action Package to the Verifier using `POST /mpas/v1/action`.

2. **Signer Approval Interface**  
   Used by a Proposer or Coordination Service to request a Signer decision using `POST /mpas/v1/approval-request`.

3. **Coordination Service Interface**  
   Used by Proposers and Signers to route MPAS artifacts, poll for work, submit Approvals, cancel pending actions, and retrieve completed Action Packages.

The Coordination Service topology is optional. Direct Proposer-to-Verifier and Proposer-to-Signer flows remain valid.

---

## 2. Scope and Non-Goals

### 2.1 Scope

This profile specifies:

- HTTP content type and message conventions.
- Standard HTTP status code usage.
- Standard error envelope.
- Action request and response wire format.
- Signer approval request and response wire format.
- Minimal Coordination Service HTTP interface.
- Polling-first coordination behavior.
- Optional service discovery.
- Coordination Service trust boundary.
- Coordination Service conflict rules for `actionId` and `actionEnvelopeHash`.
- Execution Receipt return and distribution behavior.

### 2.2 Non-Goals

This profile does not define:

- A universal policy language.
- A Credential Adapter plugin system.
- Hosted platform administration APIs.
- Billing, tenant, notification-vendor, or dashboard-specific APIs.
- Application-specific Execution Payload schemas.
- Human-readable rendering descriptors.
- DID authentication, OAuth, passkey, SSO, mTLS, or enterprise identity protocols other than the RFC 9421 profile defined in §4.6.
- Smart contract interfaces.
- MPC/TSS signing protocols.

Authentication is defined in §4.6. Tenancy, rate limiting, and service operator policy beyond authentication are deployment-specific. HTTP authentication is not an MPAS Approval.

---

## 3. Relationship to Core MPAS

This document profiles the transport behavior for the core MPAS protocol. It does not replace the core MPAS specification.

The core MPAS specification remains authoritative for:

- object definitions;
- canonicalization;
- hash computation;
- Approval validity;
- Approval Bundle validity;
- Signer review obligations;
- Verifier processing obligations;
- Execution Receipt semantics;
- separation between coordination and authorization.

This HTTP profile adds a concrete API contract so independently implemented Proposers, Signers, Coordination Services, Verifiers, and Applications can interoperate.

---

## 4. Common HTTP Rules

### 4.1 TLS

HTTP endpoints implementing this profile **MUST** use HTTPS in production deployments.

Plain HTTP **MAY** be used only in non-production deployments where transport risk is addressed. This allowance never relaxes the authentication enforcement requirements in §4.6.5.

### 4.2 Content Type

Requests and responses carrying MPAS profile messages **MUST** use:

```http
Content-Type: application/mpas+json
Accept: application/mpas+json
```

Implementations **MAY** accept `application/json` for compatibility, but conforming clients **SHOULD** use `application/mpas+json`.

### 4.3 POST-Based Protocol Operations

All MPAS protocol operations in this profile use `POST`.

This profile intentionally avoids using `GET` for protocol operations because MPAS messages often contain scoped identifiers, hashes, sensitive metadata, cursors, and participant filters that are safer and simpler to represent in JSON request bodies.

`GET` **MAY** be used for optional service discovery, health checks, or static metadata.

### 4.4 Authentication Is Not Approval

HTTP authentication identifies the caller to the service. It is not an MPAS Approval.

MPAS participant authentication **MUST** use the RFC 9421 profile defined in §4.6. Deployments **MAY** additionally impose transport or infrastructure controls (mTLS, enterprise SSO, gateway authentication, network allowlists); these are not a substitute for the §4.6 profile and **MUST NOT** be used to derive participant identity.

A Verifier **MUST NOT** treat HTTP authentication, Coordination Service routing, notification delivery, or transport metadata as an Approval unless the Verifier's policy explicitly recognizes a corresponding MPAS Approval or trusted external approval record.

### 4.5 Idempotency

Unsafe requests that create or mutate coordination state **SHOULD** include an `idempotencyKey` field in the request message. The field is an opaque client-generated string of at most 128 characters. A UUID is RECOMMENDED.

For objects that have a routing wrapper around the request (for example, `DeliveryEnvelope<ActionRequest>`), the key remains inside the enclosed request; the wrapper has no idempotency field. The Action-processing layer, not the routing layer, resolves the key.

Request equivalence is layered: every object carrying `idempotencyKey`, and every routing frame around it, defines the significant fields for its own layer. Version 1 defines:

- `DeliveryEnvelope`: `sender`, `recipients` compared as a set, and the enclosed payload's equivalence contribution are significant; `createdAt`, `expiresAt`, and `audience` are not. The first accepted envelope remains authoritative, so a retry does not extend its stored expiry.
- `ActionRequest`, `CoordinationActionRequest`, `CoordinationApprovalSubmission`, and `CoordinationActionCancelRequest`: every field except `idempotencyKey` and `audience` is significant.

An object with no defined equivalence scope **MUST NOT** carry a body-level idempotency key. Implementations **MUST** fail closed for an unknown scope rather than silently use a whole-body fingerprint.

Idempotency keys are especially important for:

- submitting an Action Package to a Coordination Service;
- submitting an Approval to a Coordination Service;
- submitting a completed Action Package to a Verifier when retrying after network failure.

If the same idempotency key is reused with a non-equivalent request, the server **SHOULD** return `409 Conflict`.

`idempotencyKey` and RFC 9421 signature `nonce` (§4.6) are orthogonal. A retry carries the same idempotency key (to get the stored result) and a fresh nonce (to pass replay protection). Collapsing them would cause a legitimate retry to be rejected as a replay.

A server **SHOULD** accept the HTTP header `Idempotency-Key` when the request message omits `idempotencyKey`. If both are present and differ, it **MUST** return `400 idempotency_mismatch`. Header-only idempotency is compatibility behavior.

### 4.6 Authentication Profile (RFC 9421)

Authentication enforcement is determined solely by the trust boundary and endpoint role (§4.6.5).

Authentication uses [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421) with [RFC 9530 Content-Digest](https://www.rfc-editor.org/rfc/rfc9530). The caller proves control of the DID it claims by signing the request with the corresponding Ed25519 key.

#### 4.6.1 Wire Format

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

#### 4.6.2 Signature Requirements

Covered components **MUST** be exactly `("@method" "@path" "content-digest")`. `@authority` and `@target-uri` **MUST NOT** be covered — TLS-terminating reverse proxies may rewrite `Host`, making verification brittle.

`keyid` **MUST** be the caller's DID. The DID **MUST** use the `did:jwk` method. The verification key **MUST** be derived from `keyid` by decoding the embedded JWK. The embedded JWK **MUST** contain public key material only; a verifier **MUST** reject any `did:jwk` containing private key material. No DID document is fetched; no resolver is invoked.

The algorithm is EdDSA, derived from the Ed25519 key in the `did:jwk`. If `alg` is present in signature parameters, it **MUST** equal `ed25519`; any other value **MUST** be rejected. (Note: `EdDSA` is the JWS/JWK algorithm name; `ed25519` is the RFC 9421 HTTP Message Signatures registry name. They refer to the same algorithm.) Future key types define their own algorithm binding.

Signers **SHOULD** omit `alg` to match the canonical wire example in §4.6.1 and avoid redundant metadata when the key embedded in `keyid` already determines the algorithm. Omitting it also keeps RFC 9421 B.2.6 directly usable as the byte-exact known-answer gate. Verifiers **MUST** accept a signature whose parameters omit `alg`, and **MUST** accept one where it is present and equal to `ed25519`. Both forms interoperate and can be fixtured independently; every byte-exact fixture must specify which form it covers because `@signature-params` is reproduced verbatim in the signature base.

`created` and `expires` **MUST** be present integer timestamps. `expires` **MUST** be strictly greater than `created`, and `expires - created` **MUST NOT** exceed 60 seconds. This ceiling is the declared-lifetime MPAS profile constraint that bounds replay exposure and nonce-retention requirements. Clients and deployments **MAY** choose a shorter period but not a longer one. The server **MUST** reject requests whose `created` is in the future beyond configured `clockSkew` (suggested default: 30 seconds), or whose `expires` has passed. The declared maximum lifetime remains 60 seconds, but configured future clock skew can extend the server-observed acceptance horizon by up to `clockSkew`.

`nonce` **MUST** be present. On state-mutating endpoints, only after signature, digest, freshness, audience, identity, authorization, and side-effect-free business preflight validation succeeds and immediately before mutation, the server **MUST** atomically claim `(keyid, nonce)`. Exactly one concurrent claim **MUST** succeed. A successful claim **MUST** remain retained through `expires`; a failed claim **MUST** be rejected as replay. Invalid requests **MUST NOT** consume a nonce. An integration whose store operation combines validation and mutation **MUST** introduce a side-effect-free preflight so that the nonce claim can occur after validation and before commit. On read-only idempotent endpoints, freshness validation alone is acceptable. For Coordination Service endpoints specifically: `/action`, `coordination/workflow`, `approval`, `action-cancel`, `delivery`, and `session` are state-mutating; `poll` is read-only. The temporary `coordination/action` compatibility alias has the same state-mutating behavior as `coordination/workflow`.

Signers **MUST** set the `tag` signature parameter to `mpas-v1`. The `tag` identifies the MPAS application profile and, as a signature parameter, is covered by `@signature-params`. A dictionary member's label correlates its `Signature-Input` value with the member of the same label in `Signature`; the label does not authenticate identity. The label **SHOULD** be `mpas`, but an alternate label is conforming when it matches in both dictionaries.

A verifier **MUST** parse both dictionaries. Absence of both signature headers is handled as missing authentication under §4.6.6. If only one header is present, either dictionary is malformed, or the selected input lacks its same-label `Signature` member, verification **MUST** fail as `signature_invalid`. The verifier **MUST** select exactly one `Signature-Input` member tagged `mpas-v1`; unrelated members with other tags are ignored for MPAS candidate selection. Zero or multiple `mpas-v1` candidates **MUST** be rejected. For example, `Signature-Input: legacy=(...);tag="other", alt=(...);tag="mpas-v1"` is conforming when `Signature` contains an `alt` member; the alternate `alt` label carries no identity semantics.

`Content-Digest` **MUST** be present and **MUST** use the `sha-256` algorithm (RFC 9530). The server **MUST** verify the digest against the received body.

#### 4.6.3 Audience

Every request carrying an MPAS HTTP Message Signature **MUST** carry an `audience` field in its outermost body object. Other interfaces add `audience` to their request schemas when they adopt enforcement (§4.6.4.2, §4.6.4.3).

The client derives `audience` from the origin of its configured service URL: scheme + host + port when non-default, with no path or trailing slash. For example, `https://coordination.example.com/mpas/v1/coordination/` yields `https://coordination.example.com`. This derivation is the only audience configuration clients and bridges need.

An enforcing server's configured audience is a non-empty set of valid origins. The server **MUST** compare the request's `audience` against each configured value using exact string match; no normalization or subdomain matching is applied. A match against any member satisfies the check. Every configured origin **MUST** genuinely be an origin of that service.

`audience` is bound to the signature transitively through `content-digest`. It prevents a signature captured at one deployment from being replayed at another.

An unsigned request sent to a service that does not enforce authentication **MAY** omit `audience`. A server that does not enforce authentication **MUST** ignore `audience` if present. This ensures signed and unsigned clients work against unenforcing servers without special-casing.

#### 4.6.4 Identity Binding and Endpoint Authorization

Before processing a signed Coordination Service request, every representation of the participant identity required by that endpoint **MUST** be equal. Any mismatch **MUST** be rejected with `403 permission_denied`. Once the representations are equal, this profile does not prescribe which equal representation an implementation uses internally.

Each endpoint interface defines the required equality invariant and resulting scope.

##### 4.6.4.1 Coordination Service

- `poll`: signature `keyid` **MUST** equal `CoordinationPollRequest.did`; the request **MUST** be scoped to that agreed DID.
- `action-cancel`: signature `keyid` **MUST** equal request `proposerDid`, and both **MUST** equal the stored proposer.
- `action`: signature `keyid` **MUST** equal `actionPackage.actionEnvelope.proposer.did`.
- `DeliveryEnvelope<ActionRequest>` submitted to `/action`: signature `keyid` **MUST** equal `DeliveryEnvelope.sender` and the enclosed `ActionEnvelope.proposer.did`.
- `delivery`: signature `keyid` **MUST** equal `DeliveryEnvelope.sender`, `ActionResponse.verifier.did`, and the workflow's configured Verifier DID.
- `session`: signature `keyid` **MUST** equal `CoordinationSessionRequest.did`.
- `approval`: signature `keyid` **MUST** equal the signer DID decoded from the Approval, and that DID **MUST** be an eligible signer for the referenced workflow.

Each equality and eligibility check occurs before processing, and any mismatch or ineligibility **MUST** be rejected with `403 permission_denied`. Version 1 retains the required `CoordinationPollRequest.did` and `CoordinationActionCancelRequest.proposerDid` fields. A future request schema version **MAY** remove redundant fields only at an explicit version boundary; v1 will not be mutated in place. Migration and versioning details will be decided if a future revision is proposed.

When authentication is enforced, an unknown Action or workflow cannot satisfy the stored-proposer or eligible-signer requirement. An enforcing Coordination Service therefore returns `403 permission_denied` for an unknown `action-cancel` target or Approval workflow rather than revealing existence with `404`. With enforcement disabled, the existing Coordination Service `404 ACTION_NOT_FOUND` behavior is unchanged.

##### 4.6.4.2 Verifier

For `DeliveryEnvelope<ActionRequest>`, signature `keyid` **MUST** equal `DeliveryEnvelope.sender` and the enclosed `ActionEnvelope.proposer.did`. For bare `ActionRequest`, signature `keyid` **MUST** equal the enclosed `ActionEnvelope.proposer.did`. HTTP authentication establishes request provenance; it is not an Approval and does not replace MPAS policy evaluation.

##### 4.6.4.3 Signer

Identity binding for `POST /mpas/v1/approval-request` is not yet defined. Until this section is specified, a Signer endpoint that adopts §4.6 authentication establishes caller identity for rate limiting and audit only — with no effect on the Signer's approval decision.

#### 4.6.5 Enforcement

The **trust boundary** is the operator-defined set of components and administrative principals within which unauthenticated participant identity claims are accepted. Authentication **MAY** be disabled only if every caller able to reach that Coordination Service is trusted to make any participant claim the instance accepts, or equivalent isolation prevents cross-participant access. Access to participant keys is relevant evidence in deployment assessment but does not define the boundary. Network placement alone does not define it. Outside this boundary, Coordination Service authentication **MUST** be enforced.

Enforcement requirements by role:

- A **Coordination Service** outside the trust boundary **MUST** enforce authentication.
- Any other **MPAS endpoint** (Verifier or Signer) outside that boundary **MAY** enforce authentication. Identity binding for those interfaces remains limited as specified in §4.6.4.2 and §4.6.4.3.

A fresh hosted Coordination Service outside the trust boundary **MUST** default enforcement on and **MUST NOT** be exposed unenforced. Existing deployments use a coordinated cutover so callers sign before enforcement is enabled.

Production HTTPS remains independently required by §4.1. TLS protects transport but does not replace authentication when this section requires enforcement.

Configuration **MUST** fail closed: enforcement enabled with an empty configured audience set or any configured value that is not a valid origin **MUST** refuse to start.

Health-check endpoints (`GET /mpas/v1/coordination/health` and equivalents) **SHOULD** remain unauthenticated so deployment probes and monitoring continue to function.

#### 4.6.6 Error Responses

When enforcement is enabled, a request with no signature headers returns `401 authentication_required`. A request that presents signature headers but fails candidate selection; has malformed input or a missing or wrong required signature parameter, including `tag`; has an invalid or mismatched key; fails cryptographic verification; or fails freshness, nonce, or audience validation uniformly returns `401 signature_invalid`. This prevents an attacker from distinguishing signature-validation failure modes. A `Content-Digest` mismatch remains `400 artifact_hash_mismatch`, and an authenticated caller that is not authorized for the requested operation remains `403 permission_denied`.

Failures **MUST NOT** disclose whether a DID exists or has pending work.

| Condition | Status | Code |
|---|---|---|
| Signature headers absent while enforcing | 401 | `authentication_required` |
| Presented-signature selection, required-parameter or tag, key, cryptographic, freshness, nonce, or audience failure | 401 | `signature_invalid` |
| `Content-Digest` mismatch | 400 | `artifact_hash_mismatch` |
| Authenticated but not authorized for the requested operation | 403 | `permission_denied` |
| Required Coordination Service identity representations are not all equal | 403 | `permission_denied` |

Signature values, `Signature-Input`, `keyid`, nonce values, and body content **MUST NOT** be logged by application, framework, or error logging. A logged `Signature` header is a replayable credential for the duration of the freshness window.

#### 4.6.7 Applicability

This profile is the sole MPAS participant authentication mechanism defined by this HTTP profile. Enforcement requirements per role are in §4.6.5. Future versions may define additional mechanisms; until then, implementations that authenticate **MUST** use this profile.

### 4.7 HTTP Status Codes vs MPAS Result Codes

HTTP status codes describe transport/API processing. MPAS result values describe protocol outcomes.

A policy rejection is not an HTTP authorization failure. For example, a Verifier that successfully evaluates an Action Package and rejects it under policy should generally return:

```http
HTTP/1.1 200 OK
Content-Type: application/mpas+json
```

with an `ActionResponse` body containing:

```json
{
  "result": "rejected"
}
```

For example, a Verifier implementing the JSON Verifier Policy Profile returns a matched blocked-action rule synchronously as:

```http
HTTP/1.1 200 OK
Content-Type: application/mpas+json

{
  "version": "1",
  "type": "ActionResponse",
  "result": "rejected",
  "error": {
    "code": "ACTION_BLOCKED_BY_POLICY",
    "message": "Action github.delete_repository is blocked by policy."
  }
}
```

This is a deterministic MPAS protocol rejection, not an HTTP authorization failure. The response MUST NOT include Authorization Requirements, and the Verifier MUST NOT dispatch the action.

### 4.8 Standard HTTP Status Mapping

|                  HTTP Status | Meaning                                                                                                      |
| ---------------------------: | ------------------------------------------------------------------------------------------------------------ |
|                     `200 OK` | Request was processed. The MPAS protocol result is in the response body.                                     |
|                `201 Created` | Coordination state, approval record, subscription, or similar resource was created.                          |
|               `202 Accepted` | Request was accepted for asynchronous processing.                                                            |
|            `400 Bad Request` | Invalid HTTP request shape, invalid JSON, missing required HTTP-level fields.                                |
|           `401 Unauthorized` | HTTP authentication missing or invalid.                                                                      |
|              `403 Forbidden` | Authenticated caller is not allowed to use the endpoint or see the requested coordination state.             |
|              `404 Not Found` | Requested coordination object, action, approval request, or cursor was not found or not visible to caller.   |
|               `409 Conflict` | Idempotency conflict, duplicate submission conflict, or same `actionId` with different `actionEnvelopeHash`. |
|                   `410 Gone` | Resource expired or no longer available under retention policy.                                              |
| `415 Unsupported Media Type` | Unsupported content type.                                                                                    |
|   `422 Unprocessable Entity` | JSON was syntactically valid, but MPAS artifact was structurally invalid or not canonicalizable.             |
|      `429 Too Many Requests` | Rate limit.                                                                                                  |
|  `500 Internal Server Error` | Unexpected server error.                                                                                     |
|    `503 Service Unavailable` | Temporary policy, verifier, application, or dependency unavailability.                                       |

### 4.9 Standard Error Envelope

When returning a transport or structural error, implementations **SHOULD** use `MpasHttpError`.

```json
{
  "version": "1",
  "type": "MpasHttpError",
  "requestId": "req_123",
  "error": {
    "code": "artifact_hash_mismatch",
    "message": "Execution Payload hash does not match actionEnvelope.executionPayloadHash.",
    "retryable": false,
    "details": [
      {
        "path": "/actionPackage/actionEnvelope/executionPayloadHash",
        "reason": "Expected base64url digest did not match computed digest."
      }
    ]
  }
}
```

Recommended error codes:

| Code                           | Meaning                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `unsupported_version`          | Unsupported MPAS object or HTTP profile version.                            |
| `invalid_content_type`         | Unsupported or missing content type.                                        |
| `authentication_required`      | HTTP authentication is required.                                            |
| `permission_denied`            | Caller is authenticated but not authorized for this API operation.          |
| `not_found`                    | Requested object was not found or not visible to caller.                    |
| `invalid_request`              | The HTTP request message is structurally or semantically invalid.           |
| `conflict`                     | Request conflicts with existing coordination state.                         |
| `idempotency_mismatch`         | Body and compatibility-header idempotency keys differ.                      |
| `idempotency_conflict`         | Idempotency key was reused with a non-equivalent request.                   |
| `artifact_malformed`           | MPAS artifact is malformed.                                                 |
| `artifact_not_canonicalizable` | MPAS artifact cannot be canonicalized.                                      |
| `artifact_hash_mismatch`       | Hash binding does not match the supplied artifact.                          |
| `signature_invalid`            | Signature verification failed. Under §4.6, this also covers HTTP Message Signature failures including expired/future timestamps, replayed nonce, and audience mismatch. |
| `not_supported`                | Target application, operation, signature format, or profile is unsupported. |
| `policy_unavailable`           | Policy could not be loaded or evaluated.                                    |
| `relay_timeout`                | A Coordination Service's bounded wait for the designated Verifier expired. Retryable; the relay record survives. |
| `expired`                      | Artifact or coordination workflow expired.                                  |
| `rate_limited`                 | Rate limit exceeded.                                                        |
| `server_error`                 | Unexpected server error.                                                    |

---

## 5. Common Reference Objects

### 5.1 Hash Object

Hash objects use the core MPAS form:

```json
{
  "alg": "sha-256",
  "value": "base64url-encoded-digest"
}
```

JSON objects that are hashed or signed **MUST** be canonicalized using the canonicalization rules defined by the core MPAS specification.

### 5.2 ActionRef

`ActionRef` is a typed convenience object used by HTTP and coordination messages to refer to an existing workflow or Action Envelope.

`ActionRef` is not a core authorization artifact. It does not replace the Action Envelope, Approval, Approval Bundle, Authorization Requirements, or Execution Receipt bindings.

```json
{
  "version": "1",
  "type": "ActionRef",
  "actionId": {
    "scope": "optional-replay-domain",
    "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
  },
  "actionEnvelopeHash": {
    "alg": "sha-256",
    "value": "base64url-encoded-digest"
  }
}
```

Fields:

| Field                | Required | Description                                                                                  |
| -------------------- | :------: | :------------------------------------------------------------------------------------------- |
| `version`            |   Yes    | MUST be `"1"`.                                                                               |
| `type`               |   Yes    | MUST be `ActionRef`.                                                                         |
| `actionId`           |   Yes    | The workflow and replay identifier from the Action Envelope.                                 |
| `actionEnvelopeHash` |   Yes    | The immutable proposal binding (hash of the Action Envelope).                                |

Rules:

- `actionId` is the workflow and replay identifier from the Action Envelope.
- `actionEnvelopeHash` is the immutable proposal binding.
- Coordination Services **MAY** index workflows by `actionId`.
- Coordination Services **MUST** compute `actionEnvelopeHash` from the received Action Envelope.
- Once a Coordination Service has observed a binding from `actionId` to `actionEnvelopeHash`, a later submission with the same `actionId` and different `actionEnvelopeHash` **MUST** be rejected with `409 Conflict`, unless the deployment explicitly defines a supersession mechanism using a new Action Envelope and new Action ID.
- Authorization Requirements **MUST NOT** rely on `ActionRef`; they bind directly to `actionEnvelopeHash`.

### 5.3 Participant Reference

Participant references identify MPAS actors such as Proposers, Signers, Verifiers, Coordination Services, Applications, or auditors.

```json
{
  "did": "did:web:alice.example"
}
```

Implementations **MAY** include non-authoritative routing hints:

```json
{
  "did": "did:web:alice.example",
  "endpoint": "https://alice.example/mpas/v1/approval-request"
}
```

Routing hints are not authorization.

### 5.4 Optional Service Discovery

Implementations **MAY** expose service discovery at:

```http
GET /.well-known/mpas.json
```

Service discovery is optional. Deployments **MAY** configure endpoints out-of-band.

Service discovery can help clients learn:

- service role: Verifier, Signer, Coordination Service, or multiple roles;
- supported MPAS HTTP profile versions;
- supported artifact versions;
- supported signature formats;
- endpoint paths;
- service DID;
- sync, async, polling, callback, and webhook capabilities.

Service discovery metadata is not policy, not an Approval, and not authorization.

Example:

```json
{
  "version": "1",
  "type": "MpasServiceDescription",
  "serviceDid": "did:web:verifier.example",
  "roles": ["verifier"],
  "profiles": ["mpas-http-action-approval-coordination-v1"],
  "artifactVersions": ["1"],
  "signatureFormats": ["jws", "eip712"],
  "endpoints": {
    "action": "https://verifier.example/mpas/v1/action"
  },
  "capabilities": {
    "syncActionResponse": true,
    "asyncActionResponse": true,
    "polling": false
  }
}
```

### 5.5 DeliveryEnvelope

`DeliveryEnvelope` is routing metadata around an MPAS message or artifact. It does not assign an MPAS role and does not replace verification of its payload.

```json
{
  "version": "1",
  "type": "DeliveryEnvelope",
  "sender": "did:jwk:...sender...",
  "recipients": ["did:jwk:...recipient..."],
  "createdAt": "2026-08-25T12:00:00.000Z",
  "expiresAt": "2026-08-25T12:05:00.000Z",
  "audience": "https://coordination.example.com",
  "payload": {
    "version": "1",
    "type": "ActionRequest"
  }
}
```

| Field | Required | Description |
| --- | :---: | --- |
| `version` | Yes | MUST be `"1"`. |
| `type` | Yes | MUST be `DeliveryEnvelope`. |
| `sender` | Yes | DID of the participant responsible for the payload's recorded provenance. |
| `recipients` | Yes | Non-empty array of unique recipient DIDs. |
| `createdAt` | Yes | MPAS Core §5 timestamp: RFC 3339 UTC with exactly three fractional digits and a `Z` suffix. |
| `expiresAt` | Optional | MPAS Core §5 timestamp and retrieval deadline later than `createdAt`. |
| `audience` | Conditional | Receiving service origin when the envelope is the signed HTTP request body (§4.6.3). |
| `payload` | Yes | JSON representation of the applicable MPAS message or artifact. |

A receiving Coordination Service creates an independent retrieval obligation for each authorized recipient. Retrieval by one recipient does not consume another recipient's delivery. Routing uses the explicit recipient list and does not inspect the payload to infer recipients or roles. A participant-authored signed submission establishes `keyid == sender`; the envelope is not an end-to-end signature.

A receiving endpoint **MUST** reject an envelope whose `expiresAt` is not in the future at submission, before creating any delivery obligation. Implementations **SHOULD** enforce a finite deployment-specific recipient-count limit to bound authorization work and delivery fan-out.

Every recipient receives the complete envelope and therefore learns the complete `recipients` array. In multi-tenant deployments, administrator-added recipients are visible to the other recipients carried in that envelope.

The Delivery Envelope equivalence contribution is defined in §4.5.

---

## 6. Common Action Interface

### 6.1 Purpose

The Action Interface is used to submit an Action Package to either a directly reachable Verifier or a Coordination Service relay.

The caller is asking the Verifier to process the Action Package and execute the Action if policy is satisfied.

Verification is the deterministic processing step performed by the Verifier. It is not the name of the primary HTTP operation.

### 6.2 Endpoint

| Client   | Endpoint Host                      | Method | Endpoint          | Request                                                       | Response         |
| -------- | ---------------------------------- | -----: | ----------------- | ------------------------------------------------------------- | ---------------- |
| Proposer | Verifier / Application             | `POST` | `/mpas/v1/action` | `ActionRequest` or `DeliveryEnvelope<ActionRequest>`          | `ActionResponse` |
| Proposer | Coordination Service relay         | `POST` | `/mpas/v1/action` | `DeliveryEnvelope<ActionRequest>`                             | `ActionResponse` |

The Verifier may be embedded in a native MPAS Application or in another MPAS-aware execution component. This profile refers to that endpoint as the Verifier. It does not distinguish Credential Adapter implementations from native MPAS Application implementations at the HTTP protocol level.

### 6.3 ActionRequest

`ActionRequest` carries an MPAS Action Package. A directly reachable Verifier **MUST** accept both a bare `ActionRequest` and `DeliveryEnvelope<ActionRequest>`. A Coordination Service relay **MUST** require the envelope because it supplies the routing metadata. A raw `ActionPackage` is not a request form for this endpoint.

```json
{
  "version": "1",
  "type": "ActionRequest",
  "idempotencyKey": "28ebf760-3948-493a-bc46-cc2f18e7172a",
  "actionPackage": {
    "version": "1",
    "type": "ActionPackage"
  },
  "context": {
    "requestPurpose": "initialSubmission"
  }
}
```

Fields:

| Field           | Required | Description                                                                             |
| --------------- | :------: | --------------------------------------------------------------------------------------- |
| `version`       |   Yes    | MUST be `"1"`.                                                                          |
| `type`          |   Yes    | MUST be `ActionRequest`.                                                                |
| `actionPackage` |   Yes    | Complete MPAS Action Package.                                                           |
| `idempotencyKey` | Recommended | Action-processing idempotency key (§4.5).                                            |
| `audience`       | Conditional | Action endpoint origin only when this is the outer body of a signed bare request.     |
| `context`       | Optional | Non-authoritative request metadata. MUST NOT override policy or MPAS artifact contents. |

The same endpoint and request type are used for:

- initial Action Package submission;
- completed Action Package submission after additional Approvals have been collected;
- retry after transport failure, subject to idempotency and replay rules.

For enveloped submission, the envelope `sender` and signed `keyid` equal the Action Envelope Proposer DID. A directly reachable Verifier selects its configured Verifier DID locally and requires that DID to occur in `DeliveryEnvelope.recipients`; it does not require itself to be the only recipient and is not responsible for forwarding to other recipients unless it also implements routing.

A Coordination Service selects the designated Verifier DID from trusted deployment configuration, requires it among the authorized recipients, records it independently of the recipient list, stores the workflow and deliveries, and keeps the request pending until it receives the first qualifying Verifier-authored `ActionResponse` through §8.9. It **MUST NOT** synthesize an `ActionResponse` merely to acknowledge relay acceptance. An equivalent idempotent retry waits for or returns the stored Verifier response.

Before storing or exposing a relayed Action, the Coordination Service **MUST** verify that the Execution Payload matches `actionEnvelope.executionPayloadHash` and that `approvalBundle.actionEnvelopeHash` matches the computed Action Envelope hash. A mismatch is `400 artifact_hash_mismatch` and creates no delivery.

The relay **MUST** bound how long it holds each HTTP submission open. If the deployment-selected bound expires before a qualifying response arrives, it returns `503 relay_timeout` with `retryable: true`; it **MUST NOT** synthesize an `ActionResponse`. The relayed Action and delivery records survive. An equivalent idempotent retry resumes waiting for, or returns, the same stored Verifier response. This profile does not fix the bound's duration.

### 6.4 ActionResponse

`ActionResponse` reports the Verifier's protocol result.

```json
{
  "version": "1",
  "type": "ActionResponse",
  "verifier": {
    "did": "did:web:verifier.example"
  },
  "actionEnvelopeHash": {
    "alg": "sha-256",
    "value": "base64url-encoded-digest"
  },
  "result": "additionalApprovalsRequired",
  "authorizationRequirements": {
    "version": "1",
    "type": "AuthorizationRequirements"
  },
  "createdAt": "2026-05-31T18:00:00.000Z"
}
```

Fields:

| Field                       |  Required   | Description                                                                                                                                              |
| --------------------------- | :---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                   |     Yes     | MUST be `"1"`.                                                                                                                                           |
| `type`                      |     Yes     | MUST be `ActionResponse`.                                                                                                                                |
| `verifier.did`              | Recommended | DID of the Verifier returning the response. Required when the response includes Authorization Requirements or Execution Receipt issuer identity matters. |
| `actionEnvelopeHash`        | Recommended | Hash of the Action Envelope, when computable.                                                                                                            |
| `result`                    |     Yes     | Action result value.                                                                                                                                     |
| `authorizationRequirements` | Conditional | Required when `result` is `additionalApprovalsRequired`.                                                                                                 |
| `executionReceipt`          | Conditional | Recommended when the Action is resolved. Required by profiles that require receipts for completed Actions.                                               |
| `executionResult`           |  Optional   | INFORMATIVE execution-profile-native response content (see Section 6.4.1). Not hash-bound, not covered by the receipt signature, not an attestation of output. |
| `error`                     |  Optional   | Machine-readable detail for `rejected`/`failed`/`malformed` results (`{ code, message }`). Distinct from the transport-level `MpasHttpError` (Section 4.9). |
| `actionRequestId`           |  Optional   | Verifier-local identifier for async processing.                                                                                                          |
| `pollAfter`                 |  Optional   | Suggested time after which the caller may poll or retry, if async behavior is supported.                                                                 |
| `context`                   |  Optional   | Non-authoritative explanatory metadata, including profile-defined diagnostics (Section 6.4.2).                                                           |
| `createdAt`                 | Recommended | Response timestamp.                                                                                                                                      |

If both `ActionResponse.actionEnvelopeHash` and `authorizationRequirements.actionEnvelopeHash` are present, they MUST be identical. A client SHOULD reject a response where they differ.

#### 6.4.1 executionResult (Informative)

`executionResult` carries the execution-profile-native response content the target produced. For `mcp.toolsCall`, it is the target MCP server's `tools/call` result object, **verbatim**, so an upper-layer implementation can relay or retain exactly what the target returned. It is INFORMATIVE only: it is not hash-bound, not covered by the Execution Receipt signature, and not an attestation of output (the MCP Execution Profile §7 reserves output commitment as future work). This profile does not define how or when an upper-layer interface delivers that material to its client.

Presence rule:

- `result: executed` → `executionResult` present, verbatim target response.
- `result: failed` where the target returned a tool-level failure (`isError: true`) → `executionResult` present, verbatim — this is a normal MCP tool response the agent is built to handle.
- `result: failed` from a JSON-RPC/protocol error, and all pure-MPAS outcomes (`additionalApprovalsRequired`, `pending`, `rejected`, `expired`, `malformed`, `indeterminate`) → `executionResult` ABSENT; a bridge synthesizes a response for the agent, since the real server would never have produced these outcomes.

#### 6.4.2 context.diagnostic (Informative)

`context.diagnostic` carries sanitized, machine-readable information about where and how processing failed. It is INFORMATIVE and non-authoritative: it is not hash-bound, is not covered by the Execution Receipt signature, and MUST NOT override or contradict `result`, an Execution Receipt, Authorization Requirements, or any other MPAS artifact.

```json
{
  "context": {
    "diagnostic": {
      "code": "DISPATCH_TIMEOUT",
      "phase": "tools/call",
      "transport": "stdio",
      "message": "The upstream server did not respond before the dispatch timeout."
    }
  }
}
```

| Field       | Required | Description |
| ----------- | :------: | ----------- |
| `code`      |   Yes    | Stable machine-readable diagnostic code. Execution profiles SHOULD define interoperable values. |
| `phase`     | Optional | Profile-defined processing phase in which the condition occurred. |
| `transport` | Optional | Profile- or deployment-defined transport identifier. |
| `message`   | Optional | Sanitized human-readable explanation suitable for logs and agent-facing error reporting. |

A Verifier SHOULD include `context.diagnostic` when a `failed`, `indeterminate`, or transient pre-dispatch response would otherwise be difficult to operate or reconcile. Diagnostic metadata MUST NOT change retry, idempotency, or lifecycle rules. In particular, a diagnostic on `result: indeterminate` does not make the same `actionId` safe to retry.

Diagnostic content MUST be sanitized and resource-bounded. It MUST NOT contain credentials, authorization headers, environment-variable values, secrets, tokens, private keys, raw command arguments, or raw process output. Implementations MUST ignore unknown diagnostic fields and codes without changing their interpretation of `result`.

### 6.5 ActionResponse Result Values

| Result                        | Meaning                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executed`                    | The Action was authorized and executed. An Execution Receipt SHOULD be present.                                                                           |
| `additionalApprovalsRequired` | The Action Package does not yet satisfy policy but may be authorized if additional Approvals are collected. Authorization Requirements SHOULD be present. |
| `rejected`                    | The Verifier rejected the Action, including a deterministic policy block. An Execution Receipt SHOULD be present if the Action is resolved.                 |
| `notSupported`                | The Verifier does not support the requested Application, operation, payload format, or verification mode.                                                 |
| `malformed`                   | The Action Package is structurally invalid, not canonicalizable, or has invalid hash bindings.                                                            |
| `policyUnavailable`           | The Verifier cannot determine applicable policy at this time.                                                                                             |
| `pending`                     | The action has been accepted and is executing or awaiting execution. No second dispatch will occur for an identical resubmission.                          |
| `failed`                      | Execution was attempted but failed definitively. An Execution Receipt SHOULD be present.                                                                  |
| `indeterminate`               | Execution was dispatched but the outcome could not be confirmed. An Execution Receipt SHOULD be present.                                                  |
| `expired`                     | The Action expired before execution. An Execution Receipt SHOULD be present.                                                                              |
| `cancelled`                   | The Action was cancelled before execution. Reserved for verifier-side signed cancellation (Core Section 6.9.6); not produced by dispatch in this version. An Execution Receipt SHOULD be present. |

Implementations **MAY** define additional application-specific result values, but portable clients should not depend on unknown values.

#### 6.5.1 Derivation from Core Action Lifecycle

The ActionResponse `result` values are a projection of the Core Action Lifecycle (Core Section 6.9), which is a **dispatch ledger**: verification is stateless and a ledger entry exists only once an action is authorized for dispatch.

| Wire Result                   | Core Lifecycle Mapping                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pending`                     | `executing` ledger entry — dispatch is in progress; an identical resubmission triggers no second dispatch.                     |
| `additionalApprovalsRequired` | Stateless response — no ledger entry; verification deterministically reports unmet policy.                                     |
| `rejected`                    | Stateless response — no ledger entry; deterministic rejection (invalid signature, unknown application, disabled operation, resource restriction, policy denial). Repeatable. |
| `expired`                     | Stateless response — no ledger entry; the envelope is past `expiresAt`. Repeatable.                                            |
| `malformed`                   | Stateless response — no ledger entry; artifact-level structural failure inside a hashable package.                            |
| `policyUnavailable`           | Stateless response — no ledger entry; transient.                                                                              |
| `notSupported`                | Stateless response — no ledger entry.                                                                                         |
| `executed`                    | `resolved(executed)` ledger entry — terminal.                                                                                 |
| `failed`                      | `resolved(failed)` ledger entry — terminal.                                                                                   |
| `indeterminate`               | `resolved(indeterminate)` ledger entry — terminal. Callers MUST NOT auto-retry; reconciliation is out of band.               |

**Idempotency and `pending`:** When a Verifier receives an identical resubmission (same `actionId`, same envelope hash) whose ledger entry is `executing`, it MUST return `pending` and MUST NOT transmit again. This ties the HTTP profile's Idempotency-Key guidance to the Core lifecycle: the idempotency guarantee is that an `executing` action cannot be double-dispatched. A submission with the same `actionId` but a different envelope hash, or against a `resolved` entry, MUST be rejected.

### 6.6 Low-Impact Direct Execution Example

Request:

```http
POST /mpas/v1/action
Content-Type: application/mpas+json
Accept: application/mpas+json
```

```json
{
  "version": "1",
  "type": "ActionRequest",
  "idempotencyKey": "2f8d8bb4-392d-4b7e-8077-07c88fd4e980",
  "actionPackage": {
    "version": "1",
    "type": "ActionPackage",
    "executionPayload": {
      "name": "app.low_impact_operation",
      "arguments": {}
    },
    "actionEnvelope": {
      "version": "1",
      "type": "ActionEnvelope",
      "proposer": {
        "did": "did:web:agent.example"
      },
      "target": {
        "applicationDid": "did:web:app.example",
        "resource": "example-resource"
      },
      "executionProfile": {
        "id": "did:web:profiles.oma3.org:mcp",
        "format": "mcp.toolsCall"
      },
      "executionPayloadHash": {
        "alg": "sha-256",
        "value": "base64url-encoded-digest"
      },
      "actionId": {
        "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
      },
      "createdAt": "2026-05-31T18:00:00.000Z",
      "expiresAt": "2026-05-31T19:00:00.000Z"
    },
    "approvalBundle": {
      "version": "1",
      "type": "ApprovalBundle",
      "actionEnvelopeHash": {
        "alg": "sha-256",
        "value": "base64url-encoded-digest"
      },
      "approvals": [
        {
          "version": "1",
          "type": "Approval",
          "actionEnvelopeHash": {
            "alg": "sha-256",
            "value": "base64url-encoded-digest"
          },
          "decision": "approve",
          "signature": {
            "format": "jws",
            "value": "jws-compact-serialization"
          },
          "createdAt": "2026-05-31T18:00:01.000Z"
        }
      ]
    }
  }
}
```

Response:

```json
{
  "version": "1",
  "type": "ActionResponse",
  "verifier": {
    "did": "did:web:verifier.example"
  },
  "actionEnvelopeHash": {
    "alg": "sha-256",
    "value": "base64url-encoded-digest"
  },
  "result": "executed",
  "executionReceipt": {
    "version": "1",
    "type": "ExecutionReceipt"
  },
  "createdAt": "2026-05-31T18:00:02.000Z"
}
```

### 6.7 Additional Approvals Required Example

```json
{
  "version": "1",
  "type": "ActionResponse",
  "verifier": {
    "did": "did:web:verifier.example"
  },
  "actionEnvelopeHash": {
    "alg": "sha-256",
    "value": "base64url-encoded-digest"
  },
  "result": "additionalApprovalsRequired",
  "authorizationRequirements": {
    "version": "1",
    "type": "AuthorizationRequirements",
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    },
    "result": "additionalApprovalsRequired",
    "verifier": {
      "did": "did:web:verifier.example"
    },
    "approvalRequirements": {
      "anyOf": [
        {
          "type": "threshold",
          "threshold": 2,
          "eligibleSigners": [
            "did:web:alice.example",
            "did:web:bob.example",
            "did:web:carol.example"
          ],
          "decision": "approve"
        }
      ]
    },
    "createdAt": "2026-05-31T18:00:02.000Z",
    "expiresAt": "2026-05-31T19:00:02.000Z"
  },
  "createdAt": "2026-05-31T18:00:02.000Z"
}
```

### 6.8 Execution Receipt Return Behavior

The Verifier returns the Execution Receipt to the caller of `/mpas/v1/action`.

Participants MAY retrieve receipts from the Verifier, from a Coordination Service that has received them, or from any other service that stores them. How receipts propagate beyond the initial response is deployment-specific.

This profile does not require a separate receipt retrieval endpoint. Future profiles or deployments MAY define one.

### 6.9 Async Action Behavior

A Verifier **MAY** process Actions asynchronously.

Example async response:

```json
{
  "version": "1",
  "type": "ActionResponse",
  "verifier": {
    "did": "did:web:verifier.example"
  },
  "actionEnvelopeHash": {
    "alg": "sha-256",
    "value": "base64url-encoded-digest"
  },
  "result": "pending",
  "actionRequestId": "arq_123",
  "pollAfter": "2026-05-31T18:01:00.000Z",
  "createdAt": "2026-05-31T18:00:02.000Z"
}
```

Async completion may be delivered by deployment-specific polling, callback, webhook, or Coordination Service mechanisms.

---

## 7. Signer Approval Interface

### 7.1 Purpose

The Signer Approval Interface is used to ask a Signer to produce an MPAS Approval decision for a Signer Review Set.

The core MPAS object provided to the Signer is still the `SignerReviewSet`. The HTTP transport message is called an `ApprovalRequest` because the requester is asking for an Approval decision.

### 7.2 Endpoint

| Client                           | Endpoint Host | Method | Endpoint                    | Request           | Response           |
| -------------------------------- | ------------- | -----: | --------------------------- | ----------------- | ------------------ |
| Proposer or Coordination Service | Signer        | `POST` | `/mpas/v1/approval-request` | `ApprovalRequest` | `ApprovalResponse` |

The endpoint path does not include the component name `signer` because the host identifies the service role. Deployments **MAY** expose role-prefixed aliases, but the canonical endpoint is `/mpas/v1/approval-request`.

### 7.3 ApprovalRequest

```json
{
  "version": "1",
  "type": "ApprovalRequest",
  "signerReviewSet": {
    "version": "1",
    "type": "SignerReviewSet"
  },
  "requestedDecision": "approve",
  "returnMode": "sync",
  "context": {
    "message": "Approval requested for production deployment."
  }
}
```

Fields:

| Field               | Required | Description                                                         |
| ------------------- | :------: | ------------------------------------------------------------------- |
| `version`           |   Yes    | MUST be `"1"`.                                                      |
| `type`              |   Yes    | MUST be `ApprovalRequest`.                                          |
| `signerReviewSet`   |   Yes    | Signer Review Set containing Execution Payload and Action Envelope. |
| `requestedDecision` | Optional | Requested decision.                                                 |
| `returnMode`        | Optional | `sync` or `async`. Defaults to deployment behavior.                 |
| `context`           | Optional | Non-authoritative explanatory metadata.                             |

### 7.4 ApprovalResponse

```json
{
  "version": "1",
  "type": "ApprovalResponse",
  "status": "completed",
  "approval": {
    "version": "1",
    "type": "Approval"
  },
  "createdAt": "2026-05-31T18:10:00.000Z"
}
```

Fields:

| Field               |  Required   | Description                                                                                          |
| ------------------- | :---------: | ---------------------------------------------------------------------------------------------------- |
| `version`           |     Yes     | MUST be `"1"`.                                                                                       |
| `type`              |     Yes     | MUST be `ApprovalResponse`.                                                                          |
| `status`            |     Yes     | Transport/process status of the approval request.                                                    |
| `approval`          | Conditional | Required when `status` is `completed`. Contains the MPAS Approval object with the Signer's decision. |
| `approvalRequestId` |  Optional   | Signer-local request identifier for async review.                                                    |
| `context`           |  Optional   | Non-authoritative explanatory metadata.                                                              |
| `createdAt`         | Recommended | Response timestamp.                                                                                  |

Status values:

| Status         | Meaning                                                                                                                   | `approval` present? |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `completed`    | Signer produced an Approval. The Signer's decision (`approve`, `reject`, `abstain`, `propose`) is in `approval.decision`. | Yes                 |
| `pending`      | Human, custody, hardware, or async review is pending.                                                                     | No                  |
| `declined`     | Signer declined to participate without producing an Approval.                                                             | No                  |
| `malformed`    | Signer Review Set is structurally invalid or cannot be verified.                                                          | No                  |
| `notSupported` | Signer does not support the requested signature format or artifact version.                                               | No                  |
| `expired`      | Action Envelope or request expired before the Signer could respond.                                                       | No                  |
| `failed`       | Review failed for another reason.                                                                                         | No                  |

The `status` field describes what happened at the transport/process level. The Signer's actual decision (`approve`, `reject`, `abstain`) is expressed only in the embedded `approval.decision` field, which is the signed, authoritative artifact. The `status` field MUST NOT be used to infer the Signer's decision.

A Signer's `reject` decision is valid workflow and audit feedback. It does not by itself block execution unless the Verifier's policy independently determines rejection. Policy SHOULD NOT depend on collecting `reject` Approvals because a Proposer-assembled bundle can omit them.

### 7.5 Signer Verification Requirements

Before producing an Approval, a Signer **MUST** verify that the Execution Payload matches the Action Envelope's `executionPayloadHash`.

A Signer **SHOULD** verify:

- Action Envelope structure;
- Action Envelope expiration;
- Action Envelope canonicalizability;
- target information from the Action Envelope, execution profile, profile-derived operation/tool/command identity, profile-native payload fields, Proposer DID, Action ID, and expiration;
- any Authorization Requirements included for context;
- whether the requested decision is within the Signer's authority.

Signer Review Sets are not authorization artifacts and do not need to be signed by the Coordination Service.

A Signer **MUST NOT** approve if the Execution Payload is missing, unavailable, or cannot be verified against the Action Envelope.

### 7.6 Async Signer Review

If a human, hardware device, custody workflow, or policy signer cannot respond immediately, the Signer endpoint may return:

```json
{
  "version": "1",
  "type": "ApprovalResponse",
  "status": "pending",
  "approvalRequestId": "apr_123",
  "createdAt": "2026-05-31T18:10:00.000Z"
}
```

Async completion may be handled through a Coordination Service poll, callback, webhook, or deployment-specific mechanism.

---

## 8. Coordination Service Interface

### 8.1 Purpose

A Coordination Service is an optional workflow, routing, synchronization, and state component.

A Coordination Service may:

- accept Action Packages from Proposers;
- store Authorization Requirements from Proposers;
- expose Signer Review Sets or Approval Requests to eligible Signers;
- collect Approvals;
- assemble Approval Bundles;
- allow Proposers to fetch Approvals or Approval Bundles;
- distribute Execution Receipts reported by the Proposer;
- expose workflow status and audit views.

A Coordination Service is not the source of approval authority. It should be understood as a state machine and mailbox. It understands participants, workflow state, and routing metadata.

### 8.2 Coordination Service Trust Boundary

A Coordination Service:

- **MUST NOT** alter Execution Payloads, Action Envelopes, or Approval objects without causing verification failure.
- **MUST NOT** treat chat messages, comments, dashboard clicks, notifications, or transport authentication as MPAS Approvals unless the Verifier's policy explicitly recognizes a corresponding trusted external approval record.
- **MUST NOT** be treated as approval authority unless the Verifier's policy explicitly trusts it for a specific role.
- **SHOULD NOT** hold application credentials, reusable signer credentials, private keys, or downstream application secrets.
- **MAY** assemble Approval Bundles from unmodified Approvals.
- **MAY** call Verifiers and Signers using the direct HTTP interfaces defined above.

### 8.3 Coordination Service Endpoints

| Client                                  | Endpoint Host        | Method | Endpoint                                | Purpose                                                                                                       |
| --------------------------------------- | -------------------- | -----: | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Proposer                                | Coordination Service | `POST` | `/mpas/v1/action`                       | Submit canonical `DeliveryEnvelope<ActionRequest>` and receive the first Verifier-authored `ActionResponse`.  |
| Proposer                                | Coordination Service | `POST` | `/mpas/v1/coordination/workflow`        | Create an approval workflow after direct Verifier evaluation returned Authorization Requirements.             |
| Participant                             | Coordination Service | `POST` | `/mpas/v1/coordination/poll`            | Poll for pending Approval Requests, action state updates, and addressed deliveries.                           |
| Signer                                  | Coordination Service | `POST` | `/mpas/v1/coordination/approval`        | Submit an Approval for an Action.                                                                             |
| Proposer                                | Coordination Service | `POST` | `/mpas/v1/coordination/action-cancel`   | Cancel a pending action that is still awaiting approvals.                                                     |
| Verifier                                | Coordination Service | `POST` | `/mpas/v1/coordination/delivery`        | Return `DeliveryEnvelope<ActionResponse>` after processing a relayed Action.                                  |
| Participant                             | Coordination Service | `POST` | `/mpas/v1/coordination/session`         | Obtain a short-lived ticket for the optional notification-only WebSocket.                                     |

Implementations **MAY** expose a `GET /mpas/v1/coordination/health` endpoint for daemon startup checks, monitoring, and CLI status commands. This is not a protocol endpoint.

A separate receipt endpoint is not required in v0.2. Receipts may be returned directly in `ActionResponse` or distributed through `/mpas/v1/coordination/poll`.

For migration, a Coordination Service **SHOULD** temporarily accept `POST /mpas/v1/coordination/action` as a deprecated alias of `POST /mpas/v1/coordination/workflow`. The alias accepts the same request, returns the same response, and enters the same DID-scoped idempotency domain; it does not create a second workflow or mutation namespace. New clients **MUST** use `/mpas/v1/coordination/workflow`.

### 8.4 POST /mpas/v1/coordination/workflow

Used by a Proposer to submit an Action Package to a Coordination Service for approval collection.

The Coordination Service stores the Action Package and makes it available to eligible Signers for review.

This endpoint is used with the direct-Verifier-then-coordinate topology. Coordination-Service-relayed Verifier submission uses `/mpas/v1/action` and the common contract in §6.

The version 1 wire discriminants remain `CoordinationActionRequest` and `CoordinationActionResponse`. Renaming the endpoint does not create a second message format or silently revise the version 1 payload schemas.

Request:

```json
{
  "version": "1",
  "type": "CoordinationActionRequest",
  "idempotencyKey": "28ebf760-3948-493a-bc46-cc2f18e7172a",
  "actionPackage": {
    "version": "1",
    "type": "ActionPackage"
  },
  "authorizationRequirements": {
    "version": "1",
    "type": "AuthorizationRequirements"
  },
  "context": {
    "ticket": "JIRA-1234"
  }
}
```

Fields:

| Field                       |  Required   | Description                                                                                                                                        |
| --------------------------- | :---------: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                   |     Yes     | MUST be `"1"`.                                                                                                                                     |
| `type`                      |     Yes     | MUST be `CoordinationActionRequest`.                                                                                                               |
| `actionPackage`             |     Yes     | Complete MPAS Action Package.                                                                                                                      |
| `authorizationRequirements` | Recommended | Authorization Requirements returned by the Verifier. Tells the Coordination Service what approvals are needed so it can route to eligible Signers. |
| `idempotencyKey`            | Recommended | Mutation idempotency key (§4.5).                                                                                                                    |
| `audience`                  | Conditional | Configured service URL origin (§4.6.3). Required whenever the request carries an MPAS signature; MAY be omitted only on an unsigned request to an unenforcing service. |
| `context`                   |  Optional   | Non-authoritative metadata.                                                                                                                        |

Response:

```json
{
  "version": "1",
  "type": "CoordinationActionResponse",
  "actionRef": {
    "version": "1",
    "type": "ActionRef",
    "actionId": {
      "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
    },
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    }
  },
  "state": "awaitingApprovals",
  "createdAt": "2026-05-31T18:00:03.000Z"
}
```

Rules:

- On a signed request, signature `keyid` **MUST** equal `actionPackage.actionEnvelope.proposer.did` before processing; mismatch **MUST** be rejected with `403`.
- The Coordination Service **MUST** compute the Action Envelope hash from the received Action Envelope.
- Before creating a workflow, it **MUST** verify `actionEnvelope.executionPayloadHash` and `approvalBundle.actionEnvelopeHash`; verify the Authorization Requirements' exact Action hash and Verifier binding; reject expired requirements; and reject duplicate or unachievable `eligibleSigners` threshold sets. A failure creates no workflow. Hash failures use `400 artifact_hash_mismatch`, expired requirements use `409 expired`, and other requirements failures use `400 invalid_request`.
- The Proposer DID is not categorically forbidden from `eligibleSigners`. Whether a Proposer Approval counts is determined by the applicable Verifier policy or policy profile.
- The Coordination Service **SHOULD** compute and store the Execution Payload hash and Action Package hash for audit/debugging, but those hashes are not substitutes for the normative Action Envelope binding.
- If `authorizationRequirements` are provided, the Coordination Service **SHOULD** use them to determine which Signers are eligible and expose Approval Requests accordingly.
- The Coordination Service makes collected Approvals and completed Action Packages available to the Proposer through `/mpas/v1/coordination/poll`.

### 8.5 POST /mpas/v1/coordination/poll

Used by MPAS participants to poll for pending work, action state updates, and addressed deliveries.

Polling is mandatory for Coordination Service interoperability. Participants using a Coordination Service topology **MUST** be able to retrieve pending messages by polling, even when push notifications or webhooks are also supported.

The Coordination Service determines what to return based on the participant DID:

- When authentication is enforced (§4.6), signature `keyid` and the required body `did` **MUST** be equal before processing; mismatch is `403`. The response is scoped to that agreed DID, without prescribing which equal representation is used internally.
- When authentication is not enforced, the participant's DID is the body-supplied `did` field.

- **Signers** receive `approvalRequests` — pending Approval Requests for actions where their DID is listed in `eligibleSigners` and the action is in `awaitingApprovals` state.
- **Proposers** receive `actionUpdates` — state and progress updates for actions they proposed, including completed Action Packages when state is `readyForResubmission`.

A DID that is both a proposer on one action and an eligible signer on another receives both arrays populated in the same response.

Request:

```json
{
  "version": "1",
  "type": "CoordinationPollRequest",
  "did": "did:web:alice.example"
}
```

Fields:

| Field     | Required | Description                                                 |
| --------- | :------: | ----------------------------------------------------------- |
| `version` |   Yes    | MUST be `"1"`.                                              |
| `type`    |   Yes    | MUST be `CoordinationPollRequest`.                          |
| `did`      |   Yes    | DID of the participant polling for work or status updates. Required in request schema v1. On a signed request, signature `keyid` **MUST** equal this field before processing or the server rejects with `403`; the response is scoped to that agreed DID. |
| `audience` | Conditional | Configured service URL origin (§4.6.3). Required whenever the request carries an MPAS signature; MAY be omitted only on an unsigned request to an unenforcing service. |
| `cursor`   | Optional | Opaque continuation token from a previous response's `nextCursor`. Paginating servers use it to resume; omit it to start from the beginning. |

Response:

```json
{
  "version": "1",
  "type": "CoordinationPollResponse",
  "approvalRequests": [
    {
      "version": "1",
      "type": "ApprovalRequest",
      "actionRef": {
        "version": "1",
        "type": "ActionRef",
        "actionId": {
          "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
        },
        "actionEnvelopeHash": {
          "alg": "sha-256",
          "value": "base64url-encoded-digest"
        }
      },
      "signerReviewSet": {
        "version": "1",
        "type": "SignerReviewSet",
        "executionPayload": {},
        "actionEnvelope": {},
        "authorizationRequirements": {}
      },
      "requestedDecision": "approve"
    }
  ],
  "actionUpdates": [
    {
      "version": "1",
      "type": "CoordinationActionUpdate",
      "actionRef": {
        "version": "1",
        "type": "ActionRef",
        "actionId": {
          "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
        },
        "actionEnvelopeHash": {
          "alg": "sha-256",
          "value": "base64url-encoded-digest"
        }
      },
      "state": "readyForResubmission",
      "expiresAt": "2026-05-31T19:00:00.000Z",
      "progress": {
        "required": 2,
        "collected": 2,
        "pending": []
      },
      "actionPackage": {
        "version": "1",
        "type": "ActionPackage"
      }
    }
  ],
  "deliveries": [
    {
      "version": "1",
      "type": "DeliveryEnvelope",
      "sender": "did:jwk:...sender...",
      "recipients": ["did:jwk:...recipient..."],
      "createdAt": "2026-08-25T12:00:00.000Z",
      "payload": {
        "version": "1",
        "type": "ActionRequest"
      }
    }
  ]
}
```

Rules:

- On a signed request, the server **MUST** establish `keyid == did` before processing, reject mismatch with `403`, and scope all returned data to that agreed DID.
- `approvalRequests` contains pending Approval Requests for actions where the DID is listed in `eligibleSigners` and the action is in `awaitingApprovals` state. Cancelled actions are not included.
- `actionUpdates` contains state and progress for actions where the DID is the proposer.
- Every action update includes `expiresAt`, copied unchanged from `ActionEnvelope.expiresAt`. This is the Action's authoritative deadline, not the time at which the Coordination Service noticed or recorded expiration.
- Each action update includes a `progress` object with `required` (threshold count), `collected` (approvals collected so far), and `pending` (eligible DIDs that haven't responded). Not present for cancelled actions.
- When state is `readyForResubmission`, the action update includes the completed `actionPackage`. The Proposer can take this Action Package and submit it directly to the Verifier without further assembly.
- When state is `cancelled`, the action update includes `cancelledAt` and no `progress` or `actionPackage`.
- When state is `rejected`, the action update includes `rejectedAt`. This records when the Coordination Service's non-authoritative workflow view became rejected.
- An action update MUST NOT contain an `expiredAt` field. When and how an implementation marks a workflow expired is internal bookkeeping and is not part of the wire protocol.
- The existing `approvalRequests` and `actionUpdates` arrays may be empty.
- `deliveries` is optional; absence is equivalent to an empty array. Every returned envelope is unexpired and contains the authenticated poll DID in `recipients`.
- A Verifier may poll for a relayed `ActionRequest` addressed to its configured DID.
- Delivery is at least once. Repeating a cursor may return the same envelope, so recipients apply the enclosed MPAS object's identity and replay rules.
- `nextCursor` reflects delivery position only. `approvalRequests` and `actionUpdates` are returned in full and are not cursor-paged in version 1.
- **Delivery page cap (optional).** A Coordination Service MAY cap the number of `deliveries` in one response. Every non-empty delivery page **MUST** include `nextCursor` identifying the last returned delivery, including the currently known final page. The client persists that checkpoint only after durably accepting the page and re-polls with it. A subsequent caught-up poll may return no deliveries and omit `nextCursor`.

There is no delivery-specific cursor in version 1.

### 8.6 POST /mpas/v1/coordination/approval

Used by a Signer to submit an Approval to the Coordination Service.

Request:

```json
{
  "version": "1",
  "type": "CoordinationApprovalSubmission",
  "idempotencyKey": "28ebf760-3948-493a-bc46-cc2f18e7172a",
  "actionEnvelopeHash": {
    "alg": "sha-256",
    "value": "base64url-encoded-digest"
  },
  "approval": {
    "version": "1",
    "type": "Approval",
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    },
    "decision": "approve",
    "signature": {
      "format": "jws",
      "value": "jws-compact-serialization"
    },
    "createdAt": "2026-05-31T18:10:00.000Z"
  }
}
```

Fields:

| Field                | Required | Description                                                                          |
| -------------------- | :------: | ------------------------------------------------------------------------------------ |
| `version`            |   Yes    | MUST be `"1"`.                                                                       |
| `type`               |   Yes    | MUST be `CoordinationApprovalSubmission`.                                            |
| `actionEnvelopeHash` |   Yes    | Hash of the Action Envelope identifying the coordination workflow.                   |
| `approval`           |   Yes    | The MPAS Approval object.                                                            |
| `idempotencyKey`     | Recommended | Mutation idempotency key (§4.5).                                                  |
| `audience`           | Conditional | Configured service URL origin (§4.6.3). Required whenever the request carries an MPAS signature; MAY be omitted only on an unsigned request to an unenforcing service. |

Response:

```json
{
  "version": "1",
  "type": "CoordinationApprovalSubmissionResponse",
  "accepted": true,
  "actionRef": {
    "version": "1",
    "type": "ActionRef",
    "actionId": {
      "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
    },
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    }
  },
  "state": "awaitingApprovals",
  "createdAt": "2026-05-31T18:12:00.000Z"
}
```

Rules:

- On a signed request, signature `keyid` **MUST** equal the signer DID decoded from the Approval, and that DID **MUST** be an eligible signer for the referenced workflow before processing; mismatch or ineligibility **MUST** be rejected with `403` before the Approval is stored or counted.
- The Coordination Service **MUST** store Approval objects unmodified.
- The Coordination Service **MAY** perform structural checks, hash checks, duplicate detection, and signature pre-validation.
- Coordination Service pre-validation is not authoritative unless the Verifier explicitly trusts the Coordination Service for that role.
- The Verifier remains responsible for final policy evaluation.
- The Coordination Service **MUST** reject Approvals submitted for cancelled actions with `404`.
- For one `actionEnvelopeHash`, a Signer's first valid additional-approval decision is final. A duplicate with the same decision **MAY** be accepted idempotently but **MUST NOT** inflate threshold counts. A later different decision **MUST** be rejected with `409 Conflict`. Changing a decision requires a new Action Envelope and workflow. The Proposer's initial `propose` Approval is not an additional-approval decision under this rule.

### 8.7 POST /mpas/v1/coordination/action-cancel

Used by the original Proposer to cancel a pending action that is still awaiting approvals.

Request:

```json
{
  "version": "1",
  "type": "CoordinationActionCancelRequest",
  "idempotencyKey": "28ebf760-3948-493a-bc46-cc2f18e7172a",
  "actionId": {
    "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
  },
  "proposerDid": "did:web:agent.example"
}
```

Fields:

| Field         | Required | Description                                                                            |
| ------------- | :------: | -------------------------------------------------------------------------------------- |
| `version`     |   Yes    | MUST be `"1"`.                                                                         |
| `type`        |   Yes    | MUST be `CoordinationActionCancelRequest`.                                             |
| `actionId`    |   Yes    | The Action ID of the action to cancel.                                                 |
| `proposerDid` |   Yes    | DID of the proposer requesting cancellation. Required in request schema v1. On a signed request, signature `keyid`, this field, and the stored proposer **MUST** all be equal before processing or the server rejects with `403`. |
| `idempotencyKey` | Recommended | Mutation idempotency key (§4.5).                                                |
| `audience`    | Conditional | Configured service URL origin (§4.6.3). Required whenever the request carries an MPAS signature; MAY be omitted only on an unsigned request to an unenforcing service. |

Response:

```json
{
  "version": "1",
  "type": "CoordinationActionCancelResponse",
  "actionRef": {
    "version": "1",
    "type": "ActionRef",
    "actionId": {
      "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
    },
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    }
  },
  "state": "cancelled",
  "cancelledAt": "2026-05-31T18:15:00.000Z"
}
```

Rules:

- On a signed request, the server **MUST** establish `keyid == proposerDid == stored proposer` before processing; any mismatch **MUST** be rejected with `403`.
- Only the original proposer (matching `actionPackage.actionEnvelope.proposer.did`) **MAY** cancel an action.
- Cancellation is only allowed when the action is in `awaitingApprovals` state. If the action is already in `readyForResubmission`, the Coordination Service **MUST** return `409 Conflict`.
- A cancelled action **MUST NOT** be served to signers in poll responses.
- Approvals submitted after cancellation **MUST** be rejected with `404`.
- Cancellation is final — a cancelled action cannot be re-activated. The proposer must submit a new action if they want to retry.
- Returns `404` if the action is unknown.
- Returns `403` if the requesting DID does not match the original proposer.

### 8.8 Coordination States

Coordination Services maintain a non-authoritative workflow view of action progress (per MPAS Core Section 6.9.5). Coordination states reflect the Coordination Service's local understanding and MUST NOT be conflated with the Verifier's authoritative lifecycle.

Coordination Services **MAY** use the following state values:

| State                  | Meaning                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `awaitingApprovals`    | Additional approvals are required.                                                                                                                                     |
| `readyForResubmission` | Coordination Service has collected enough apparent Approvals to allow the Proposer to submit a completed Action Package. This is not final authorization.              |
| `executed`             | Action was executed successfully.                                                                                                                                      |
| `rejected`             | Action was rejected.                                                                                                                                                   |
| `expired`              | Action expired.                                                                                                                                                        |
| `cancelled`            | Action was cancelled.                                                                                                                                                  |

Coordination `state` and Verifier `ActionResponse.result` are separate typed
contexts. In particular:

- `state: awaitingApprovals` means the Coordination Service is maintaining an
  approval-collection workflow; the Verifier result that initiated that
  workflow is `additionalApprovalsRequired`.
- `result: pending` means the Verifier has an `executing` dispatch-ledger
  entry. It MUST NOT mean waiting for Approvals.
- `state: readyForResubmission` is a coordination hint only. It is not final
  authorization.
- `state: cancelled` stops only the coordination workflow and MUST NOT be
  interpreted as Verifier `result: cancelled`.

Coordination state is not Verifier policy. How the Coordination Service learns
of final states (`executed`, `rejected`, `expired`) is deployment-specific.
When a state name reuses a Verifier result, its meaning MUST remain consistent
with that result.

Because additional-approval decisions are immutable under §8.6, a Coordination Service **SHOULD** transition its non-authoritative workflow view to `rejected` as soon as no `anyOf` threshold path remains reachable or any `allOf` threshold can no longer be reached with the remaining undecided eligible Signers. The Verifier still performs authoritative policy evaluation.

The Verifier performs authoritative verification when it receives the completed Action Package through the direct or relayed Action interface.

### 8.9 POST /mpas/v1/coordination/delivery

This endpoint exists so a Verifier that retrieved a relayed `ActionRequest` through poll can return its Verifier-authored `ActionResponse` to the Coordination Service. It is not the initial Action submission path and does not accept arbitrary participant payloads in this version.

The request body is `DeliveryEnvelope<ActionResponse>`. Its `recipients` array **MUST** include the Proposer DID and **SHOULD** include the Maintainer DIDs authorized for the Action. The endpoint **MUST** require `payload.type == "ActionResponse"` and establish:

```text
signature keyid == DeliveryEnvelope.sender
                == ActionResponse.verifier.did
                == configured workflow Verifier DID
```

The configured workflow Verifier DID is recorded independently when the canonical Action request is accepted. It must have occurred in that request's recipient array, but it need not have been the only recipient. The service correlates the response by the exact Action identity and hashes; it does not compare commands or parameters. Only a response from the recorded designated Verifier satisfies the workflow.

The Coordination Service **MUST** reject an additional response recipient unless that DID is authorized by the authenticated `AuthorizationRequirements` for the Action or by Coordination Service administrative policy. Recipient authorization does not make a recipient a Signer or Verifier. The response envelope distributes the `ActionResponse`; the existing `ApprovalRequest` and `SignerReviewSet` messages provide the Action review material to eligible Signers.

Before a response delivery creates an approval workflow, the Coordination Service **MUST** validate the Verifier-authored Authorization Requirements using the same exact-hash, Verifier, expiry, unique-signer, and achievable-threshold checks defined in §8.4. It rejects an invalid response delivery before storing any recipient delivery or creating a workflow. A Proposer DID is not categorically invalid in `eligibleSigners`; applicable policy determines whether it can count.

After durable storage, the endpoint returns:

```json
{
  "version": "1",
  "type": "CoordinationDeliveryResponse",
  "accepted": true,
  "createdAt": "2026-08-25T12:00:01.000Z"
}
```

This response acknowledges delivery to the Coordination Service; it is not an Action result. The unchanged Verifier-authored `ActionResponse` completes the pending relayed `/mpas/v1/action` request and remains pollable for its addressed recipients. The envelope has no body-level idempotency field. A Coordination Service **MAY** deduplicate repeated response submissions by authenticated sender plus the exact enclosed payload hash; otherwise retries may create repeated delivery records.

### 8.10 POST /mpas/v1/coordination/session

This endpoint creates a ticket for the optional notification-only WebSocket. Its signed request is:

```json
{
  "version": "1",
  "type": "CoordinationSessionRequest",
  "did": "did:jwk:...participant...",
  "audience": "https://coordination.example.com"
}
```

The service establishes `keyid == did`, claims the nonce, and returns:

```json
{
  "version": "1",
  "type": "CoordinationSessionResponse",
  "websocketUrl": "wss://coordination.example.com/mpas/v1/coordination/ws",
  "ticket": "opaque-single-use-value",
  "expiresAt": "2026-08-25T12:05:00.000Z"
}
```

The ticket is opaque, unguessable, one-use, DID-bound, omitted from URLs and logs, and valid for no more than five minutes.

The participant uses `websocketUrl` exactly as returned and performs a WebSocket upgrade with `GET`, presenting `Authorization: Bearer <ticket>`. It **MUST NOT** place the ticket in the URL. A successful upgrade returns HTTP `101 Switching Protocols`; an invalid, expired, or previously used ticket returns `401`. The ticket authorizes only the upgrade. After the upgrade, the participant follows §9.2: it waits for `CoordinationWorkAvailable` and then uses the ordinary RFC 9421-authenticated poll. After disconnection, it obtains a new session ticket before reconnecting. Polls and submissions continue to use §4.6.

---

## 9. Polling and Optional Push Notification

### 9.1 Polling-First Requirement

The Coordination Service interface is polling-first.

A Coordination Service implementing this profile **MUST** expose `/mpas/v1/coordination/poll`.

Participant clients using the Coordination Service topology **MUST** be able to retrieve pending messages by polling.

### 9.2 Optional WebSocket Notification

Coordination Services **MAY** support the session and WebSocket binding in §8.10 in addition to polling. After establishing the connection exactly as described there, the client waits for a notification containing only:

```json
{
  "version": "1",
  "type": "CoordinationWorkAvailable"
}
```

The notification contains no URL, cursor, count, `DeliveryEnvelope`, or other MPAS payload. The client polls the Coordination Service HTTPS origin retained from its signed session request; it does not derive that origin by rewriting `websocketUrl`.

After binding every authenticated connection, including the first, the service **MUST** send a notification when pollable work already exists for that DID. It **SHOULD** notify after committing new pollable work. Notifications may be duplicated, coalesced, delayed, or lost; the authenticated poll remains authoritative.

Heartbeat, reconnect, backoff, connection limits, and local wake-up behavior are deployment choices. Polling remains sufficient for interoperability.

---

## 10. Security Requirements

### 10.1 Verifier Requirements

A Verifier implementing this profile **MUST**:

- receive a complete Action Package in `ActionRequest`;
- deterministically verify the Execution Payload hash against the Action Envelope;
- compute `actionEnvelopeHash` from the Action Envelope;
- verify that the Approval Bundle binds to the computed Action Envelope hash;
- verify candidate Approvals needed to satisfy or block policy;
- determine policy from trusted configuration, application state, smart contract logic, enterprise policy, or another deterministic trusted source;
- not rely on Proposer-supplied policy fields, unsigned metadata, Coordination Service routing, or HTTP caller identity as authoritative policy;
- enforce replay and Action ID rules;
- return Authorization Requirements with `actionEnvelopeHash` when additional Approvals may satisfy policy;
- return an Execution Receipt when required by the deployment or profile.

### 10.2 Signer Requirements

A Signer implementing this profile **MUST**:

- verify that the Execution Payload matches the Action Envelope's `executionPayloadHash` before approving;
- produce Approvals that bind to `actionEnvelopeHash`;
- not approve if the Execution Payload is missing, unavailable, or does not match the Action Envelope;
- avoid relying only on untrusted summaries or coordination metadata.

### 10.3 Coordination Service Requirements

A Coordination Service implementing this profile **MUST**:

- authenticate callers using the RFC 9421 authentication profile (§4.6) when outside the trust boundary;
- store and forward core MPAS artifacts without alteration;
- compute and store `actionEnvelopeHash` for received Action Packages;
- reject same-`actionId`, different-`actionEnvelopeHash` conflicts unless a supersession mechanism is explicitly defined;
- expose polling for participants;
- treat Coordination Service state, comments, notifications, routing, and HTTP authentication as non-authoritative for MPAS approval;
- not treat itself as approval authority unless explicitly trusted by Verifier policy for a specific role;
- not hold downstream application credentials in the ordinary Coordination Service role.

### 10.4 Credential and Application Secret Handling

This profile refers only to the Verifier at the HTTP layer. A Verifier may be embedded in a native MPAS Application or another MPAS-aware component.

Any component that holds or uses application credentials **MUST**:

- use credentials only after the Action Package satisfies Verifier policy;
- bind credential use to the approved Execution Payload;
- not expose reusable credentials to Proposers, Signers, agents, or Coordination Services;
- select credentials from trusted configuration, not from Proposer-supplied payload fields or unsigned metadata.

---

## 11. Conformance Requirements

### 11.1 Verifier / Application Conformance

A conforming Verifier / Application endpoint **MUST** support:

- `POST /mpas/v1/action`;
- `DeliveryEnvelope<ActionRequest>` and bare `ActionRequest`;
- `ActionResponse`;
- `application/mpas+json`;
- deterministic MPAS artifact verification;
- `additionalApprovalsRequired` responses with Authorization Requirements bound by `actionEnvelopeHash`;
- final or non-final ActionResponse result values defined in this profile.

### 11.2 Signer Conformance

A conforming Signer endpoint **MUST** support:

- `POST /mpas/v1/approval-request`;
- `ApprovalRequest`;
- `ApprovalResponse`;
- verification of Execution Payload hash before Approval creation;
- production or return of a valid MPAS Approval when approving, rejecting, or abstaining.

### 11.3 Coordination Service Conformance

A conforming Coordination Service **MUST** support:

- RFC 9421 authentication profile (§4.6) — deterministic signature selection, signature verification, identity binding, freshness, atomic nonce claiming after validation and before mutation, signed-request audience validation, fail-closed configuration, generic external failures, and logging redaction;
- `POST /mpas/v1/coordination/workflow`;
- `POST /mpas/v1/action` with `DeliveryEnvelope<ActionRequest>`;
- `POST /mpas/v1/coordination/poll`;
- `POST /mpas/v1/coordination/approval`;
- `POST /mpas/v1/coordination/action-cancel`;
- `POST /mpas/v1/coordination/delivery` for `DeliveryEnvelope<ActionResponse>`;
- polling-first participant delivery;
- rejection of already-expired Delivery Envelopes before creating delivery obligations;
- a bounded relay wait that returns retryable `503 relay_timeout` without deleting durable relay state;
- independent recipient obligations and optional `CoordinationPollResponse.deliveries`;
- delivery-position cursor checkpoints and bounded delivery pages when a page cap is used;
- storage of unmodified Approvals;
- first-decision-final handling for additional-approval decisions;
- Action Package hash-binding and Verifier-requirements validation before delivery or workflow creation;
- conflict detection for same `actionId` with different `actionEnvelopeHash`;
- assembly of completed Action Packages for proposer retrieval via poll.

During the migration period, it **SHOULD** also support the deprecated `/mpas/v1/coordination/action` alias defined in §8.3.

---

## 12. Direct Flow: Low-Impact Action

The simplest flow does not require a Coordination Service or additional Signers.

```text
Proposer -> Verifier: ActionRequest(initial ActionPackage)
Verifier -> Proposer: ActionResponse(executed + ExecutionReceipt)
```

Steps:

1. Proposer constructs Execution Payload.
2. Proposer constructs Action Envelope with `executionPayloadHash` and `actionId`.
3. Proposer creates its own Approval.
4. Proposer assembles initial Approval Bundle.
5. Proposer submits ActionRequest to `/mpas/v1/action`.
6. Verifier verifies the package.
7. If the Proposer's Approval satisfies policy, Verifier executes the Action.
8. Verifier returns ActionResponse with Execution Receipt.

---

## 13. Direct Flow: Additional Signer Approvals

This flow uses direct calls to Signers and does not require a Coordination Service.

```text
Proposer -> Verifier: ActionRequest(initial ActionPackage)
Verifier -> Proposer: ActionResponse(additionalApprovalsRequired + AuthorizationRequirements)

Proposer -> Signer A: ApprovalRequest(SignerReviewSet)
Signer A -> Proposer: ApprovalResponse(Approval)

Proposer -> Signer B: ApprovalRequest(SignerReviewSet)
Signer B -> Proposer: ApprovalResponse(Approval)

Proposer assembles updated Approval Bundle.

Proposer -> Verifier: ActionRequest(completed ActionPackage)
Verifier -> Proposer: ActionResponse(executed + ExecutionReceipt)
```

Rules:

- Authorization Requirements bind to `actionEnvelopeHash`.
- Signers receive the Execution Payload and Action Envelope in a Signer Review Set.
- Signers verify the Execution Payload hash before approving.
- Approvals bind to the same `actionEnvelopeHash`.
- The Proposer includes collected Approvals in a completed Approval Bundle.
- The Verifier performs final authorization and execution.

---

## 14. Coordination Service Topology

This appendix describes a neutral Coordination Service topology. It is informative except where it references normative endpoint behavior defined above.

### 14.1 Direct-to-Verifier Initial Submission

```text
Proposer -> Verifier: ActionRequest or DeliveryEnvelope(ActionRequest)
Verifier -> Proposer: ActionResponse
```

The direct-to-Verifier topology remains a first-class MPAS topology. A Verifier accepts both request forms defined in §6. When the request is enveloped, the Verifier requires its configured DID among `recipients`, but it need not be the only recipient. Unless the Verifier also implements routing, the Proposer remains responsible for delivery to any other recipients.

If the Verifier returns `additionalApprovalsRequired`, the Proposer may continue through `/mpas/v1/coordination/workflow` as described in §8.4:

```text
Proposer -> Coordination Service: CoordinationActionRequest(ActionPackage + AuthorizationRequirements)
Coordination Service -> Proposer: CoordinationActionResponse(awaitingApprovals)
```

### 14.2 Coordination-Service-Relayed Initial Submission

```text
Proposer -> Coordination Service: DeliveryEnvelope(ActionRequest, configured Verifier among recipients)
Coordination Service -> Verifier: poll returns addressed DeliveryEnvelope(ActionRequest)
Verifier -> Coordination Service: DeliveryEnvelope(ActionResponse)
Coordination Service -> Proposer: unchanged Verifier-authored ActionResponse
```

The Coordination Service resolves the designated Verifier DID from trusted deployment configuration, requires it among the authorized envelope recipients, and records it independently. Other recipients do not become Verifiers or Signers merely by receiving the envelope.

### 14.3 Signer Polling

```text
Signer -> Coordination Service: CoordinationPollRequest(did)
Coordination Service -> Signer: CoordinationPollResponse(approvalRequests: [...])
Signer -> Coordination Service: CoordinationApprovalSubmission(actionEnvelopeHash, Approval)
```

The Coordination Service generates Approval Requests from:

- the original Execution Payload;
- the original Action Envelope;
- Authorization Requirements returned by the Verifier;
- non-authoritative coordination context.

The Signer must still verify the Execution Payload hash against the Action Envelope before approving.

### 14.4 Coordination-Service-Relayed Completed Action Submission

```text
Verifier -> Coordination Service: CoordinationPollRequest(did)
Coordination Service -> Verifier: CoordinationPollResponse(deliveries: [ActionRequest(completed ActionPackage)])
Verifier -> Coordination Service: DeliveryEnvelope(ActionResponse(executed + ExecutionReceipt))
Coordination Service -> Proposer: addressed delivery and stored Action result
```

The Coordination Service may continue to expose the existing Proposer action update. In the relayed topology it also makes the completed package available to the recorded designated Verifier and any separately authorized recipients. The Verifier returns its response through §8.9.

### 14.5 Direct-to-Verifier Completed Action Submission

In the direct-to-Verifier topology, the Proposer retrieves the completed Action Package and returns it to the same direct Action endpoint:

```text
Proposer -> Coordination Service: CoordinationPollRequest(did)
Coordination Service -> Proposer: CoordinationPollResponse(actionUpdates: [state: readyForResubmission, actionPackage: ...])
Proposer -> Verifier: ActionRequest(completed ActionPackage from poll response)
Verifier -> Proposer: ActionResponse(executed + ExecutionReceipt)
```

The Proposer may use either Action request form accepted by §6. This completion path does not require the Coordination Service to relay to the Verifier.

### 14.6 Proposer Polling for Status

In either coordination topology, the Proposer may poll at a deployment-appropriate interval for non-authoritative workflow status:

```text
Proposer -> Coordination Service: CoordinationPollRequest(did)
Coordination Service -> Proposer: CoordinationPollResponse(actionUpdates: [state: awaitingApprovals, progress: ...])
```

When the state becomes `readyForResubmission`, the direct topology continues through §14.5. In the relayed topology, the Coordination Service also routes the completed package as described in §14.4.

### 14.7 Proposer Cancellation

```text
Proposer -> Coordination Service: CoordinationActionCancelRequest(actionId, proposerDid)
Coordination Service -> Proposer: CoordinationActionCancelResponse(state: cancelled, cancelledAt: ...)
```

The Proposer may cancel a pending action while it is still in
`awaitingApprovals` state. After cancellation, the action is no longer visible
to Signers and subsequent approval submissions are rejected. This affects only
the coordination workflow and does not produce Verifier `result: cancelled`.

---

## 15. Open Extension Points

Future companion profiles may define:

- application-specific Execution Payload schemas;
- clear-signing and human-readable rendering descriptors;
- richer async execution lifecycle events;
- receipt query endpoints for large or multi-receipt workflows;
- webhook subscription management;
- Credential Adapter application plugin profiles;
- policy language mappings for OPA/Rego, Cedar, OpenFGA, smart contracts, or enterprise IAM;
- additional authentication mechanisms for MPAS endpoints (§4.6 is the sole mechanism in this version);
- OMATrust identity and key authorization bindings;
- x402 payment or receipt extensions.

---

## 16. Summary

This HTTP profile defines a minimal interoperable transport contract for MPAS:

- `/mpas/v1/action` is the primary Verifier / Application endpoint.
- The wire messages are `ActionRequest` and `ActionResponse`.
- `/mpas/v1/approval-request` is the direct Signer endpoint.
- Coordination Services expose the common `/action` relay plus workflow, poll, approval, cancellation, Verifier response delivery, and optional session endpoints. `/coordination/workflow` creates the approval workflow used by the direct-to-Verifier topology when the Verifier has already returned Authorization Requirements. `/coordination/action` is only a temporary migration alias.
- The poll endpoint returns Approval Requests, action state updates, and optional addressed `DeliveryEnvelope` objects.
- Authorization Requirements bind to exactly one `actionEnvelopeHash`.
- `actionId` remains the workflow and replay identifier inside the Action Envelope.
- Coordination Services may index by `actionId` but must reject same-`actionId`, different-`actionEnvelopeHash` conflicts.
- The Coordination Service may assemble completed Action Packages and route them to the recorded designated Verifier and other authorized recipients.
- A relayed Verifier returns `DeliveryEnvelope<ActionResponse>` to the Coordination Service, which preserves the response and any Execution Receipt unchanged.
- Coordination is routing and workflow, not approval authority.
