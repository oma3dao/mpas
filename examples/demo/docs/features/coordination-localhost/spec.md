# MPAS Local Coordination Service — Specification

**Status:** Draft  
**Feature:** Localhost Coordination Service  
**Target Platform:** macOS local development daemon  
**Depends on:** [MPAS HTTP Profile v0.2](../../../../oma3/mpas-docs/specification/mpas-profile-http.md), [MPAS Core Specification v0.2](../../../../oma3/mpas-docs/specification/mpas-specification.md), [Credential Adapter MVP](../mvp/spec.md)

---

## 1. Overview

The local coordination service is a lightweight in-memory service that runs as a separate Node.js process alongside the Credential Adapter. It implements the MPAS HTTP Profile Coordination Service endpoints for local development, integration tests, and demos.

The service is a mailbox, Action relay, and state machine for approval collection. It maintains a non-authoritative workflow view of action progress per MPAS Core. Its states reflect coordination workflow progress, not Verifier authorization state.

The service is not a Verifier, does not hold application credentials, does not execute actions, and does not share memory or internal state with the Credential Adapter.

The demo supports both HTTP Profile topologies. A Proposer may submit directly to the Verifier and create a coordination workflow after `additionalApprovalsRequired`, or submit `DeliveryEnvelope<ActionRequest>` through the Coordination Service relay. Relayed Verifier responses return through `/mpas/v1/coordination/delivery`. Participants retrieve authoritative work through polling; the optional WebSocket only signals that polling work exists.

---

## 2. Goals

- Provide a localhost-only coordination service for development and testing.
- Implement the MPAS HTTP Profile Section 8.3 Coordination Service endpoints.
- Store pending Action Packages, Authorization Requirements, Approval Requests, and Approvals in memory.
- Let maintainer bridges poll for pending work and submit Approvals.
- Let proposer bridges poll for workflow state changes.
- Let proposer bridges fetch a completed Action Package ready for direct resubmission to the Verifier.
- Relay addressed Action requests and Verifier responses through Delivery Envelopes.
- Offer notification-only WebSocket sessions without moving payload retrieval off the signed poll.
- Detect `actionId` conflicts where the same action ID is submitted with a different Action Envelope hash.
- Run alongside the adapter via unified `mpas daemon start`, on port `7545` by default.
- Follow the adapter's Fastify, TypeScript, ESM, and Vitest patterns.

---

## 3. Non-Goals

- Acting as a Verifier or Credential Adapter.
- Calling the Credential Adapter or any other Verifier.
- Executing actions against target MCP servers or applications.
- Producing or signing Execution Receipts.
- Performing authoritative policy evaluation.
- Providing production authentication, tenancy, authorization, persistence, audit retention, or HA.
- Storing private signer keys, proposer keys, application credentials, or reusable secrets.
- WebSocket, SSE, push notifications, or webhooks (this is for future work).

---

## 4. System Flow

```text
1. Proposer bridge -> Credential Adapter: Action Package
2. Credential Adapter -> Proposer bridge: additionalApprovalsRequired + Authorization Requirements
3. Proposer bridge -> Local Coordination Service: CoordinationActionRequest (original Action Package + Authorization Requirements)
4. Maintainer bridge -> Local Coordination Service: CoordinationPollRequest (discovers pending Approval Requests)
5. Maintainer bridge -> Local Coordination Service: CoordinationApprovalSubmission
6. Proposer bridge -> Local Coordination Service: CoordinationPollRequest (state + completed Action Package when ready)
7. Proposer bridge -> Credential Adapter: completed Action Package
8. Credential Adapter -> Proposer bridge: Execution Receipt or rejection
```

The local coordination service does not participate in steps 1, 2, 7, or 8.

---

## 5. HTTP Interface

All protocol endpoints use JSON request bodies. For local compatibility, the implementation accepts `application/json` and `application/mpas+json`.

Canonical message types and field semantics are defined by `mpas-profile-http.md`, especially Section 8.3.

### 5.1 Health (operational)

```http
GET /mpas/v1/coordination/health
```

Response:

```json
{
  "status": "ok",
  "actions": 3,
  "readyForResubmission": 1
}
```

This endpoint is not part of the MPAS protocol. It exists for daemon startup checks, monitoring, and CLI status commands.

### 5.2 Create Workflow

```http
POST /mpas/v1/coordination/workflow
Content-Type: application/mpas+json
```

`POST /mpas/v1/coordination/action` is retained temporarily as a deprecated alias of the workflow endpoint. It accepts the same request and returns the same response.

Request:

```json
{
  "version": "1",
  "type": "CoordinationActionRequest",
  "actionPackage": {
    "version": "1",
    "type": "ActionPackage",
    "executionPayload": {
      "name": "delete_branch_demo",
      "arguments": {
        "owner": "oma3dao",
        "repo": "app-registry",
        "branch": "feature/old-experiment"
      }
    },
    "actionEnvelope": {
      "version": "1",
      "type": "ActionEnvelope",
      "proposer": {
        "did": "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Ims2TzdjaVFrbXBodUVFdDFpM3lBaW1KSldlR0ttT3EzdF9mc05renphNm8ifQ"
      },
      "target": {
        "applicationDid": "did:web:github.example",
        "resource": "repo:oma3dao/app-registry"
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
        "value": "urn:uuid:11111111-1111-4111-8111-111111111111"
      },
      "createdAt": "2026-06-10T18:00:00.000Z",
      "expiresAt": "2026-06-10T19:00:00.000Z"
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
            "value": "eyJ..."
          },
          "createdAt": "2026-06-10T18:00:01.000Z"
        }
      ],
      "createdAt": "2026-06-10T18:00:02.000Z"
    }
  },
  "authorizationRequirements": {
    "version": "1",
    "type": "AuthorizationRequirements",
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    },
    "result": "additionalApprovalsRequired",
    "verifier": {
      "did": "did:web:adapter.local"
    },
    "approvalRequirements": {
      "anyOf": [
        {
          "type": "threshold",
          "threshold": 2,
          "eligibleSigners": [
            "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6IjhzRFY3NmI4aUY3NlBJbUF3NUk5V3ZlanNfOGJTOE4xMld2SHpQYTVWdzgifQ",
            "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
          ],
          "decision": "approve",
          "description": "2 maintainer approvals required for branch deletion"
        }
      ]
    },
    "createdAt": "2026-06-10T18:00:03.000Z",
    "expiresAt": "2026-06-10T19:00:00.000Z"
  }
}
```

Response:

```json
{
  "version": "1",
  "type": "CoordinationActionResponse",
  "actionRef": {
    "actionId": {
      "value": "urn:uuid:11111111-1111-4111-8111-111111111111"
    },
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    }
  },
  "state": "awaitingApprovals",
  "createdAt": "2026-06-10T18:00:00.000Z"
}
```

Rules:

- The service computes `actionEnvelopeHash` from `actionPackage.actionEnvelope` using JCS SHA-256.
- The service indexes the workflow by `actionId.value` and `actionEnvelopeHash.value`.
- Re-submitting the same `actionId` with the same `actionEnvelopeHash` is idempotent and returns the existing workflow.
- Re-submitting the same `actionId` with a different `actionEnvelopeHash` returns `409 Conflict`.
- A newly stored action enters `awaitingApprovals` immediately.

### 5.3 Poll

```http
POST /mpas/v1/coordination/poll
```

Request:

```json
{
  "version": "1",
  "type": "CoordinationPollRequest",
  "did": "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Ims2TzdjaVFrbXBodUVFdDFpM3lBaW1KSldlR0ttT3EzdF9mc05renphNm8ifQ"
}
```

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
        "actionId": {
          "value": "urn:uuid:22222222-2222-4222-8222-222222222222"
        },
        "actionEnvelopeHash": {
          "alg": "sha-256",
          "value": "base64url-encoded-digest"
        }
      },
      "signerReviewSet": {
        "version": "1",
        "type": "SignerReviewSet",
        "actionEnvelope": { },
        "executionPayload": { },
        "authorizationRequirements": { }
      },
      "requestedDecision": "approve"
    }
  ],
  "actionUpdates": [
    {
      "version": "1",
      "type": "CoordinationActionUpdate",
      "actionRef": {
        "actionId": {
          "value": "urn:uuid:11111111-1111-4111-8111-111111111111"
        },
        "actionEnvelopeHash": {
          "alg": "sha-256",
          "value": "base64url-encoded-digest"
        }
      },
      "state": "awaitingApprovals",
      "progress": {
        "required": 2,
        "collected": 1,
        "pending": ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"]
      }
    },
    {
      "version": "1",
      "type": "CoordinationActionUpdate",
      "actionRef": {
        "actionId": {
          "value": "urn:uuid:33333333-3333-4333-8333-333333333333"
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
        "type": "ActionPackage",
        "executionPayload": { },
        "actionEnvelope": { },
        "approvalBundle": {
          "version": "1",
          "type": "ApprovalBundle",
          "actionEnvelopeHash": { },
          "approvals": [ ]
        }
      }
    },
    {
      "version": "1",
      "type": "CoordinationActionUpdate",
      "actionRef": {
        "actionId": {
          "value": "urn:uuid:44444444-4444-4444-8444-444444444444"
        },
        "actionEnvelopeHash": {
          "alg": "sha-256",
          "value": "base64url-encoded-digest"
        }
      },
      "state": "cancelled",
      "cancelledAt": "2026-06-10T18:06:00.000Z"
    }
  ]
}
```

Rules:

- The service determines what to return based on the DID alone.
- `approvalRequests` contains pending Approval Requests for actions where the DID is listed in `eligibleSigners` and the action is in `awaitingApprovals` state. Empty array if none. Cancelled and expired actions are not included.
- `actionUpdates` contains state and progress for actions where the DID is the proposer. Empty array if none.
- Each action update carries `version` and `type` (`CoordinationActionUpdate`) and includes a `progress` object with `required` (threshold count), `collected` (approvals collected so far), and `pending` (eligible DIDs that haven't responded), consistent with the HTTP Profile §8.5. Progress is not present for rejected, cancelled, or expired actions.
- When state is `readyForResubmission`, the action update includes the completed `actionPackage`.
- `actionPackage` is only present when state is `readyForResubmission`. It contains the original Execution Payload, Action Envelope, and an updated Approval Bundle with all collected Approvals (including the Proposer's original Approval).
- When state is `cancelled`, the action update includes `cancelledAt` and no `progress` or `actionPackage`.
- When state is `expired`, the action update includes no `progress` or `actionPackage`. The `expiresAt` from the original Action Envelope indicates when expiry occurred.
- When immutable Signer decisions make the requirements unreachable, state becomes `rejected`, the update includes `rejectedAt`, and no further approval request is returned.
- A DID that is both a proposer on one action and an eligible signer on another receives both in the same response.
- The proposer can take the `actionPackage` from an action update and submit it directly to the Credential Adapter without further assembly.
- The Coordination Service is polling-first and also implements its optional notification-only WebSocket. Coordination polling returns Approval Requests and action updates in full and never returns relay deliveries or relay cursors. The independently exposed Action Relay uses `/relay/poll` and its own notification session and WebSocket for addressed deliveries (HTTP Profile §§8.4 and 8.5).
- On each poll, the service checks `actionEnvelope.expiresAt` for all relevant actions and transitions expired actions to `expired` state before computing the response.

### 5.4 Submit Approval

```http
POST /mpas/v1/coordination/approval
```

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
      "value": "eyJ..."
    },
    "createdAt": "2026-06-10T18:04:00.000Z"
  }
}
```

Response:

```json
{
  "version": "1",
  "type": "CoordinationApprovalSubmissionResponse",
  "accepted": true,
  "actionRef": {
    "version": "1",
    "type": "ActionRef",
    "actionId": { "value": "urn:uuid:11111111-1111-4111-8111-111111111111" },
    "actionEnvelopeHash": { "alg": "sha-256", "value": "base64url-encoded-digest" }
  },
  "state": "awaitingApprovals",
  "createdAt": "2026-06-10T18:04:00.000Z"
}
```

Rules:

- The service stores Approval objects unmodified.
- The service rejects Approvals whose `actionEnvelopeHash` does not match the workflow.
- The service rejects Approvals submitted for expired actions with `404` (same behavior as post-cancellation).
- Duplicate Approvals from the same signer DID and decision may be accepted idempotently or ignored, but must not inflate threshold counts.
- The service may decode signed Approval payloads to discover `signerDid`; this is pre-validation only and not authoritative.
- Final signature verification and policy evaluation remain the adapter's responsibility.

### 5.5 Cancel Action

```http
POST /mpas/v1/coordination/action-cancel
```

Request:

```json
{
  "version": "1",
  "type": "CoordinationActionCancelRequest",
  "actionId": {
    "value": "urn:uuid:11111111-1111-4111-8111-111111111111"
  },
  "proposerDid": "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Ims2TzdjaVFrbXBodUVFdDFpM3lBaW1KSldlR0ttT3EzdF9mc05renphNm8ifQ"
}
```

Response:

```json
{
  "version": "1",
  "type": "CoordinationActionCancelResponse",
  "actionRef": {
    "actionId": {
      "value": "urn:uuid:11111111-1111-4111-8111-111111111111"
    },
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    }
  },
  "state": "cancelled",
  "cancelledAt": "2026-06-10T18:06:00.000Z"
}
```

Rules:

- Only the original proposer (matching `actionPackage.actionEnvelope.proposer.did`) may cancel an action.
- A cancelled action is no longer served to signers in poll responses.
- Approvals submitted after cancellation are rejected with `404`.
- Cancellation is final — a cancelled action cannot be re-activated. The proposer must submit a new action if they want to retry.
- Cancellation is a coordination-workflow courtesy only. Per MPAS Core Section 6.9.2, the Verifier has no cancellation concept; the `actionId` remains pinned at the Verifier until the envelope expires.
- Returns `404` if the action ref is unknown.
- Returns `409` if the action is already in `readyForResubmission` state (too late to cancel — the proposer already has the completed package).
- Returns `409` if the action is already in `expired` state.
---

## 6. Coordination State Machine

The local service maintains a non-authoritative workflow view using the following states. These states are coordination-workflow states per MPAS Core Section 6.9.4 and MUST NOT be conflated with the Verifier's authoritative lifecycle (open, executing, resolved).

| State | Meaning |
|---|---|
| `awaitingApprovals` | The action is stored and more Approvals are needed. |
| `readyForResubmission` | Stored Approvals appear to satisfy the Authorization Requirements threshold count. |
| `rejected` | Immutable Signer decisions have made the approval expression unreachable. This is a non-authoritative coordination result. |
| `cancelled` | The proposer cancelled the action. No longer served to signers. |
| `expired` | The Action Envelope's `expiresAt` has passed. No longer served to signers. |

State transitions:

```text
awaitingApprovals
  -> readyForResubmission   (threshold met)
  -> cancelled              (proposer cancels)
  -> expired                (envelope expiresAt reached)

readyForResubmission
  -> expired                (envelope expiresAt reached before proposer retrieves)

cancelled (terminal)
expired (terminal)
```

An action enters `awaitingApprovals` on submission. There is no separate `submitted` state because the coordination service only accepts actions that include Authorization Requirements.

`readyForResubmission` is a hint only. It is not final authorization and does not imply adapter policy satisfaction. The Credential Adapter verifies the completed Action Package from scratch after the proposer re-submits it.

`cancelled` is terminal. A cancelled action cannot transition to any other state.

`expired` is terminal. An expired action cannot transition to any other state. The `expired` state is consistent with the Core receipt result meaning: the Action Envelope's `expiresAt` timestamp has passed.

### 6.1 Expiry Detection

The coordination service MUST check `actionEnvelope.expiresAt` against the current time:

- **On poll:** When computing `approvalRequests` and `actionUpdates`, the service checks each action's envelope expiry. Actions whose `expiresAt` has passed transition to `expired` and are excluded from signer `approvalRequests`. They appear in proposer `actionUpdates` with `state: "expired"`.
- **On approval submission:** If the action's envelope has expired, the service rejects the approval with `404` (same behavior as post-cancellation).
- **Lazy evaluation:** The service MAY transition actions to `expired` lazily (on next access) rather than proactively scanning all stored actions.

The `409 Conflict` rule for same-`actionId`-different-`actionEnvelopeHash` submissions is consistent with the Core Action Lifecycle's pinned-hash rule (Core Section 6.9.2): once an `actionId` is pinned to an envelope hash, a submission with the same `actionId` and a different envelope hash MUST be rejected.

---

## 7. Storage Model

All state is in memory and lost when the process exits.

Primary structures:

- `actionsByActionId: Map<string, CoordinationRecord>`
- `actionsByEnvelopeHash: Map<string, CoordinationRecord>`

`CoordinationRecord` stores:

- `actionPackage` (original, unmodified)
- computed `actionEnvelopeHash`
- `authorizationRequirements`
- `state`
- collected `approvals`
- `createdAt`
- `updatedAt`
- `cancelledAt` (if cancelled)

The implementation MUST keep stored MPAS artifacts (Action Package, Approvals) unmodified. The coordination service never mutates the Execution Payload, Action Envelope, or individual Approval objects.

---

## 8. Ready-for-Resubmission Heuristic

The local service determines `readyForResubmission` using a simple non-authoritative threshold count:

1. Read threshold requirements from `authorizationRequirements.approvalRequirements.anyOf` and `allOf`.
2. Decode each stored Approval payload enough to find `signerDid` and `decision`.
3. Count unique signer DIDs whose Approval decision matches the requirement decision, defaulting to `approve`.
4. Count only signers listed in `eligibleSigners` when that list is present.
5. Mark the action `readyForResubmission` when any `anyOf` threshold is met and all `allOf` thresholds are met.

This heuristic does not replace adapter verification. It may be conservative or optimistic; the adapter remains authoritative.

---

## 9. Daemon Integration

`mpas daemon start` starts two separate processes:

- the Credential Adapter HTTP server on port `7544`;
- the local Coordination Service HTTP server on port `7545`.

They run as independent Node.js processes. They do not share memory, internal state, or function calls. They communicate only through HTTP if needed (which in normal operation they do not — the proposer bridge is the intermediary).

Individual commands are also available:

```bash
mpas adapter start        # starts adapter only (port 7544)
mpas coordination start   # starts coordination only (port 7545)
```

---

## 10. Error Handling

The service returns profile-style JSON errors for transport and structural failures:

- `400 Bad Request` — invalid request shape or missing required fields.
- `404 Not Found` — action ref not found.
- `409 Conflict` — same `actionId` with different `actionEnvelopeHash`.
- `422 Unprocessable Entity` — structurally invalid MPAS artifact.
- `500 Internal Server Error` — unexpected failure.

For the MVP, no authentication errors are expected because the service is localhost-only.
