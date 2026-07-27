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
- DID authentication, OAuth, passkey, SSO, mTLS, or enterprise identity protocols.
- Smart contract interfaces.
- MPC/TSS signing protocols.

Authentication, tenancy, authorization to call an HTTP endpoint, rate limiting, and service operator policy are deployment-specific. HTTP authentication is not an MPAS Approval.

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

Plain HTTP **MAY** be used only for local development, loopback connections, test fixtures, or private test networks where transport security is provided by other means.

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

Implementations **MAY** use API keys, OAuth2, OIDC, SAML, DID-auth, mTLS, signed HTTP requests, passkeys, enterprise SSO, or another authentication mechanism.

A Verifier **MUST NOT** treat HTTP authentication, Coordination Service routing, notification delivery, or transport metadata as an Approval unless the Verifier's policy explicitly recognizes a corresponding MPAS Approval or trusted external approval record.

### 4.5 Idempotency

Unsafe `POST` requests that create or mutate coordination state **SHOULD** include:

```http
Idempotency-Key: <opaque-client-generated-value>
```

Idempotency keys are especially important for:

- submitting an Action Package to a Coordination Service;
- submitting an Approval to a Coordination Service;
- submitting a completed Action Package to a Verifier when retrying after network failure.

If the same idempotency key is reused with a different request body, the server **SHOULD** return `409 Conflict`.

### 4.6 HTTP Status Codes vs MPAS Result Codes

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

### 4.7 Standard HTTP Status Mapping

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

### 4.8 Standard Error Envelope

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
| `conflict`                     | Request conflicts with existing coordination state.                         |
| `idempotency_conflict`         | Idempotency key was reused with a different request body.                   |
| `artifact_malformed`           | MPAS artifact is malformed.                                                 |
| `artifact_not_canonicalizable` | MPAS artifact cannot be canonicalized.                                      |
| `artifact_hash_mismatch`       | Hash binding does not match the supplied artifact.                          |
| `signature_invalid`            | Signature verification failed.                                              |
| `not_supported`                | Target application, operation, signature format, or profile is unsupported. |
| `policy_unavailable`           | Policy could not be loaded or evaluated.                                    |
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

---

## 6. Verifier / Application Action Interface

### 6.1 Purpose

The Verifier / Application Action Interface is used to submit an Action Package to the Verifier.

The caller is asking the Verifier to process the Action Package and execute the Action if policy is satisfied.

Verification is the deterministic processing step performed by the Verifier. It is not the name of the primary HTTP operation.

### 6.2 Endpoint

| Client   | Endpoint Host          | Method | Endpoint          | Request         | Response         |
| -------- | ---------------------- | -----: | ----------------- | --------------- | ---------------- |
| Proposer | Verifier / Application | `POST` | `/mpas/v1/action` | `ActionRequest` | `ActionResponse` |

The Verifier may be embedded in a native MPAS Application or in another MPAS-aware execution component. This profile refers to that endpoint as the Verifier. It does not distinguish Credential Adapter implementations from native MPAS Application implementations at the HTTP protocol level.

### 6.3 ActionRequest

`ActionRequest` carries an MPAS Action Package.

```json
{
  "version": "1",
  "type": "ActionRequest",
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
| `context`       | Optional | Non-authoritative request metadata. MUST NOT override policy or MPAS artifact contents. |

The same endpoint and request type are used for:

- initial Action Package submission;
- completed Action Package submission after additional Approvals have been collected;
- retry after transport failure, subject to idempotency and replay rules.

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
| `error`                     |  Optional   | Machine-readable detail for `rejected`/`failed`/`malformed` results (`{ code, message }`). Distinct from the transport-level `MpasHttpError` (Section 4.8). |
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
Idempotency-Key: 2f8d8bb4-392d-4b7e-8077-07c88fd4e980
```

```json
{
  "version": "1",
  "type": "ActionRequest",
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

| Client                                                     | Endpoint Host        | Method | Endpoint                                | Purpose                                                                                                                          |
| ---------------------------------------------------------- | -------------------- | -----: | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Proposer                                                   | Coordination Service | `POST` | `/mpas/v1/coordination/action`          | Submit an Action Package and Authorization Requirements into a coordination workflow for approval collection.                    |
| Signer, Proposer, or participant client                    | Coordination Service | `POST` | `/mpas/v1/coordination/poll`            | Poll for pending Approval Requests (signers) and action state updates with completed Action Packages (proposers).                |
| Signer                                                     | Coordination Service | `POST` | `/mpas/v1/coordination/approval`        | Submit an Approval for an Action.                                                                                                |
| Proposer                                                   | Coordination Service | `POST` | `/mpas/v1/coordination/action-cancel`   | Cancel a pending action that is still awaiting approvals.                                                                        |

Implementations **MAY** expose a `GET /mpas/v1/coordination/health` endpoint for daemon startup checks, monitoring, and CLI status commands. This is not a protocol endpoint.

A separate receipt endpoint is not required in v0.2. Receipts may be returned directly in `ActionResponse` or distributed through `/mpas/v1/coordination/poll`.

### 8.4 POST /mpas/v1/coordination/action

Used by a Proposer to submit an Action Package to a Coordination Service for approval collection.

The Coordination Service stores the Action Package and makes it available to eligible Signers for review.

Request:

```json
{
  "version": "1",
  "type": "CoordinationActionRequest",
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

- The Coordination Service **MUST** compute the Action Envelope hash from the received Action Envelope.
- The Coordination Service **SHOULD** compute and store the Execution Payload hash and Action Package hash for audit/debugging, but those hashes are not substitutes for the normative Action Envelope binding.
- If `authorizationRequirements` are provided, the Coordination Service **SHOULD** use them to determine which Signers are eligible and expose Approval Requests accordingly.
- The Coordination Service makes collected Approvals and completed Action Packages available to the Proposer through `/mpas/v1/coordination/poll`.

### 8.5 POST /mpas/v1/coordination/poll

Used by Signers and Proposers to poll for pending work and action state updates.

Polling is mandatory for Coordination Service interoperability. Participants using a Coordination Service topology **MUST** be able to retrieve pending messages by polling, even when push notifications or webhooks are also supported.

The Coordination Service determines what to return based on the participant's DID alone:

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
| `did`     |   Yes    | DID of the participant polling for work or status updates.  |
| `cursor`  | Optional | Opaque continuation token from a previous response's `nextCursor`. Paginating servers use it to resume; omit it to start from the beginning. |

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
  ]
}
```

Rules:

- `approvalRequests` contains pending Approval Requests for actions where the DID is listed in `eligibleSigners` and the action is in `awaitingApprovals` state. Cancelled actions are not included.
- `actionUpdates` contains state and progress for actions where the DID is the proposer.
- Each action update includes a `progress` object with `required` (threshold count), `collected` (approvals collected so far), and `pending` (eligible DIDs that haven't responded). Not present for cancelled actions.
- When state is `readyForResubmission`, the action update includes the completed `actionPackage`. The Proposer can take this Action Package and submit it directly to the Verifier without further assembly.
- When state is `cancelled`, the action update includes `cancelledAt` and no `progress` or `actionPackage`.
- Both arrays may be empty.
- **Pagination (optional).** A Coordination Service that paginates MAY return a partial result together with a `nextCursor` token; the client re-polls with that token in `cursor` to retrieve the next page. Absence of `nextCursor` means the result is complete. A server that does not paginate omits `nextCursor` and ignores any supplied `cursor`. Pagination is defined now because a future signer-history query makes responses unbounded, and retrofitting it later would silently break pre-cursor clients.

A Verifier does not poll the Coordination Service. The Proposer always submits Action Packages directly to the Verifier using `/mpas/v1/action`.

### 8.6 POST /mpas/v1/coordination/approval

Used by a Signer to submit an Approval to the Coordination Service.

Request:

```json
{
  "version": "1",
  "type": "CoordinationApprovalSubmission",
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

- The Coordination Service **MUST** store Approval objects unmodified.
- The Coordination Service **MAY** perform structural checks, hash checks, duplicate detection, and signature pre-validation.
- Coordination Service pre-validation is not authoritative unless the Verifier explicitly trusts the Coordination Service for that role.
- The Verifier remains responsible for final policy evaluation.
- The Coordination Service **MUST** reject Approvals submitted for cancelled actions with `404`.
- Duplicate Approvals from the same signer DID and decision **MAY** be accepted idempotently but **MUST NOT** inflate threshold counts.

### 8.7 POST /mpas/v1/coordination/action-cancel

Used by the original Proposer to cancel a pending action that is still awaiting approvals.

Request:

```json
{
  "version": "1",
  "type": "CoordinationActionCancelRequest",
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
| `proposerDid` |   Yes    | DID of the proposer requesting cancellation. Must match the original proposer's DID.   |

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

The Verifier performs authoritative verification when the Proposer re-submits
the completed Action Package.

---

## 9. Polling and Optional Webhooks

### 9.1 Polling-First Requirement

The Coordination Service interface is polling-first.

A Coordination Service implementing this profile **MUST** expose `/mpas/v1/coordination/poll`.

Participant clients using the Coordination Service topology **MUST** be able to retrieve pending messages by polling.

### 9.2 Optional Webhooks

Coordination Services **MAY** support webhooks or push notifications in addition to polling.

Webhook delivery is informational. A receiving client **SHOULD** verify or fetch canonical MPAS artifacts before signing, executing, or displaying final status.

### 9.3 Recommended Webhook Event Types

If a Coordination Service implements webhook or push notification delivery, it **SHOULD** use the following event type identifiers:

| Event Type              | Meaning                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `approvalRequested`     | Signer ApprovalRequest is available.                                                  |
| `approvalSubmitted`     | Approval was submitted.                                                               |
| `readyForResubmission`  | Coordination Service believes the action may be resubmitted with collected Approvals. |
| `actionCancelled`       | Action was cancelled by the proposer.                                                 |
| `actionResolved`        | Action reached a final coordination state.                                            |

Webhook payload format is deployment-specific. Implementations **MAY** use any format that includes the `actionRef` and event type.

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
- `ActionRequest`;
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

- `POST /mpas/v1/coordination/action`;
- `POST /mpas/v1/coordination/poll`;
- `POST /mpas/v1/coordination/approval`;
- `POST /mpas/v1/coordination/action-cancel`;
- polling-first participant delivery;
- storage of unmodified Approvals;
- conflict detection for same `actionId` with different `actionEnvelopeHash`;
- assembly of completed Action Packages for proposer retrieval via poll.

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

### 14.1 Coordinated Initial Submission

```text
Proposer -> Verifier: ActionRequest(initial ActionPackage)
Verifier -> Proposer: ActionResponse(additionalApprovalsRequired)
Proposer -> Coordination Service: CoordinationActionRequest(ActionPackage + AuthorizationRequirements)
Coordination Service -> Proposer: CoordinationActionResponse(awaitingApprovals)
```

The Proposer always submits Action Packages directly to the Verifier. If the Verifier returns `additionalApprovalsRequired`, the Proposer stores the pending action in the Coordination Service so that eligible Signers can discover it.

### 14.2 Signer Polling

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

### 14.3 Completed Action Package Retrieval and Submission

```text
Proposer -> Coordination Service: CoordinationPollRequest(did)
Coordination Service -> Proposer: CoordinationPollResponse(actionUpdates: [state: readyForResubmission, actionPackage: ...])
Proposer -> Verifier: ActionRequest(completed ActionPackage)
Verifier -> Proposer: ActionResponse(executed + ExecutionReceipt)
```

The Proposer polls the Coordination Service for status updates on its proposed actions. When the state transitions to `readyForResubmission`, the poll response includes a completed Action Package (original Execution Payload, Action Envelope, and an updated Approval Bundle containing all collected Approvals including the Proposer's original Approval). The Proposer takes this Action Package and submits it directly to the Verifier.

### 14.4 Proposer Polling for Status

In the `wait` approval strategy, the Proposer polls the Coordination Service after submitting the pending action:

```text
Proposer -> Coordination Service: CoordinationPollRequest(did)
Coordination Service -> Proposer: CoordinationPollResponse(actionUpdates: [state: awaitingApprovals, progress: ...])
... Signers approve ...
Proposer -> Coordination Service: CoordinationPollRequest(did)
Coordination Service -> Proposer: CoordinationPollResponse(actionUpdates: [state: readyForResubmission, actionPackage: ...])
Proposer -> Verifier: ActionRequest(completed ActionPackage from poll response)
Verifier -> Proposer: ActionResponse(executed + ExecutionReceipt)
```

The Proposer MAY poll at a deployment-appropriate interval. When the state transitions to `readyForResubmission`, the Proposer extracts the completed Action Package from the poll response and re-submits to the Verifier.

### 14.5 Proposer Cancellation

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
- DID-auth or signed HTTP request profiles;
- OMATrust identity and key authorization bindings;
- x402 payment or receipt extensions.

---

## 16. Summary

This HTTP profile defines a minimal interoperable transport contract for MPAS:

- `/mpas/v1/action` is the primary Verifier / Application endpoint.
- The wire messages are `ActionRequest` and `ActionResponse`.
- `/mpas/v1/approval-request` is the direct Signer endpoint.
- Coordination Services expose a small polling-first routing interface with four endpoints: `action`, `poll`, `approval`, and `action-cancel`.
- The poll endpoint returns both Approval Requests (for signers) and action state updates with completed Action Packages (for proposers).
- Authorization Requirements bind to exactly one `actionEnvelopeHash`.
- `actionId` remains the workflow and replay identifier inside the Action Envelope.
- Coordination Services may index by `actionId` but must reject same-`actionId`, different-`actionEnvelopeHash` conflicts.
- The Coordination Service assembles completed Action Packages (with all collected Approvals) and delivers them to the Proposer through the poll response.
- The Verifier returns Execution Receipts to whoever called `/mpas/v1/action`.
- Coordination is routing and workflow, not approval authority.
