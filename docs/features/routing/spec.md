# MPAS Routing and Delivery — Feature Specification

**Status:** Draft
**Created:** 2026-08-20
**Revised:** 2026-08-22
**Tracks:** [#45](https://github.com/oma3dao/mpas/issues/45), [#20](https://github.com/oma3dao/mpas/issues/20), [#17](https://github.com/oma3dao/mpas/issues/17)
**Companion:** [plan.md](./plan.md)
**Related specs:** [HTTP Profile](../../../specs/mpas-profile-http.md), [MPAS Core](../../../specs/mpas-specification.md), [MCP Proposer Bridge Profile](../../../specs/mpas-profile-mcp-proposer-bridge-client.md)

---

## 1. Purpose

This feature defines a protocol-level delivery model for MPAS artifacts routed through a Coordination Service. Today, the HTTP Profile specifies polling endpoints and lists webhook event types as optional/deployment-specific (§9.2–9.3). No delivery envelope schema or body-level idempotency mechanism is defined.

This leaves two gaps:

1. **Idempotency** is header-only (§4.5). Non-HTTP transports (MCP over stdio, WebSocket frames, future transports) cannot use HTTP headers.
2. **Routing metadata** (destination DIDs, expiration) lives implicitly in Authorization Requirements. Making it explicit in a delivery envelope enables richer topologies without altering MPAS verification semantics.

This specification introduces:

- A **Delivery Envelope** that wraps any MPAS artifact for routing without modifying the artifact or inspecting its contents.
- A **body-level `idempotencyKey` field** that supersedes the HTTP header for transport neutrality.

Push delivery mechanisms (webhooks, WebSocket, SSE, message queues) are implementation details of individual Coordination Service deployments. This specification does not define transport bindings — it defines the payload format that any transport can carry.

---

## 2. Scope

### 2.1 In Scope

- Delivery Envelope schema definition (transport-layer wrapper).
- Body-level idempotency key (migration from HTTP header).
- Security properties and trust boundaries for envelope routing.
- Compatibility with existing polling-first model.

### 2.2 Out of Scope

- Changes to MPAS artifact schemas (Action Package, Approval, Execution Receipt, etc.).
- Changes to verification or authorization semantics.
- Transport bindings (webhooks, WebSocket, etc.) — these are implementation choices for Coordination Service deployments.
- Subscription management APIs — implementation-specific.
- End-to-end encryption of envelope payloads (future work).
- DID enrollment, rotation, suspension, or revocation (tracked separately).
- MCP transport binding (covered by MCP Proposer Bridge Profile).
- Credential Adapter plugin internals.

---

## 3. Design Principles

1. **Wrap, never alter.** The Delivery Envelope is a pure transport wrapper. Enclosed MPAS artifacts remain independently verifiable. A recipient MUST be able to extract and verify the artifact without understanding the envelope.

2. **Layer separation.** The envelope is a routing layer. It MUST NOT inspect, duplicate, or depend on fields within the enclosed payload. Like the OSI network layer, it addresses and delivers without understanding application semantics.

3. **Polling remains mandatory.** Push delivery (however implemented) is an optimization. A conforming Coordination Service MUST continue to expose `/mpas/v1/coordination/poll`. Push delivery is informational — recipients MUST verify canonical artifacts before acting.

4. **DID-scoped delivery.** Recipients receive only artifacts addressed to their authenticated DIDs. Routing metadata MUST NOT grant signer eligibility or execution authority.

5. **Idempotent by default.** Duplicate, delayed, reordered, or replayed deliveries MUST NOT cause duplicate execution. The idempotency key in the message body ensures this property across all transports.

6. **Transport-neutral idempotency.** The idempotency key lives in the message body so it is available on all transports and automatically covered by content-digest.

---

## 4. Delivery Envelope

### 4.1 Schema

```json
{
  "version": "1",
  "type": "DeliveryEnvelope",
  "sender": "did:web:coordination.example",
  "recipients": ["did:web:adapter.example", "did:web:signer.example"],
  "createdAt": "2026-08-20T12:00:00.000Z",
  "expiresAt": "2026-08-20T12:05:00.000Z",
  "payload": { ... }
}
```

### 4.2 Field Definitions

| Field        | Required | Description |
| ------------ | :------: | ----------- |
| `version`    | Yes      | MUST be `"1"`. |
| `type`       | Yes      | MUST be `"DeliveryEnvelope"`. |
| `sender`     | Yes      | DID string identifying the sending participant or service. |
| `recipients` | Yes      | Array of DID strings identifying intended recipients. |
| `createdAt`  | Yes      | ISO 8601 timestamp of envelope creation. |
| `expiresAt`  | Optional | ISO 8601 timestamp after which the delivery is stale. Recipients SHOULD discard expired envelopes. |
| `payload`    | Yes      | The enclosed MPAS artifact. Opaque to the routing layer. MUST NOT be modified, inspected, or interpreted by the envelope. |

### 4.3 Design Rationale

The envelope deliberately excludes fields that describe the payload:

- **No `artifactType`** — The routing layer does not need to know what it is delivering. The recipient inspects the payload's `type` field after extraction.
- **No `actionRef`** — Action correlation is a property of the payload, not the envelope. The recipient determines which action a payload belongs to by examining the payload itself.
- **No `event`** — Event classification is application semantics. The routing layer delivers; the recipient classifies.
- **No `deliveryId`** — Deduplication is handled by the `idempotencyKey` on mutating requests, or by the payload's own identity (e.g., `actionId` + artifact type). A synthetic delivery ID adds complexity without value when the payload already carries identity.
- **No recipient `role`** — Roles are determined by the payload and the recipient's relationship to the action, not by the envelope. The Coordination Service addresses recipients by DID; what they do with the payload is their concern.
- **`sender` is a plain DID string** — No need for an object wrapper when a single field suffices.

### 4.4 Payload Integrity

The Delivery Envelope carries routing semantics only. It MUST NOT alter the verification or authorization semantics of the enclosed artifact.

Implementations MUST:

- Preserve the payload byte-for-byte through routing (no re-serialization that alters field order or whitespace when content-digest is used).
- Not sign the envelope as if it were an MPAS Approval or Execution Receipt.
- Not use envelope metadata (sender, recipients) as input to Verifier policy evaluation.

Recipients MUST:

- Verify the enclosed artifact independently using standard MPAS verification rules before acting on it.
- Treat envelope metadata as advisory routing hints, not authorization signals.

### 4.5 Relationship to Push Delivery

The Delivery Envelope is the payload format for any push delivery mechanism. Whether a Coordination Service delivers via webhook, WebSocket, server-sent events, message queue, or any other transport, the body of the delivery is a Delivery Envelope.

The choice of push transport, subscription management, delivery acknowledgement, retry policy, and dead-letter handling are implementation decisions for each Coordination Service deployment. They are not specified here.

The only normative requirement on push delivery is: **polling remains the consistency guarantee.** Any push mechanism is supplementary. Recipients SHOULD poll periodically regardless of push subscription status.

---

## 5. Body-Level Idempotency Key

### 5.1 Motivation

HTTP Profile §4.5 defines `Idempotency-Key` as an HTTP header. MPAS aims to be transport-neutral — transports without headers (MCP over stdio, WebSocket frames, future non-HTTP bindings) benefit from the same idempotency semantics.

A body-level key is automatically covered by content-digest and requires no special handling in the RFC 9421 signature's covered components.

The body-level idempotency key is independent of the Delivery Envelope. It benefits any request that creates or mutates state, whether or not a Delivery Envelope is involved.

### 5.2 Specification

All Coordination Service request messages that create or mutate state SHOULD include an `idempotencyKey` field in the request body:

```json
{
  "version": "1",
  "type": "CoordinationActionRequest",
  "idempotencyKey": "2f8d8bb4-392d-4b7e-8077-07c88fd4e980",
  "actionPackage": { ... },
  "authorizationRequirements": { ... }
}
```

| Field            | Required    | Description |
| ---------------- | :---------: | ----------- |
| `idempotencyKey` | Recommended | Opaque client-generated string, max 128 characters. UUID v4 recommended. |

Applicable request types:
- `CoordinationActionRequest`
- `CoordinationApprovalSubmission`
- `CoordinationActionCancelRequest`

### 5.3 Semantics

- Same `idempotencyKey` + same request body → return the stored result.
- Same `idempotencyKey` + different request body → `409 Conflict` with error code `idempotency_conflict`.
- `idempotencyKey` and RFC 9421 signature `nonce` remain orthogonal. A retry carries the same idempotency key and a fresh nonce.

### 5.4 Migration from HTTP Header

During the migration period:

1. A Coordination Service MUST accept `idempotencyKey` in the body.
2. A Coordination Service SHOULD continue to accept `Idempotency-Key` in the HTTP header for backwards compatibility.
3. If both are present, the body field takes precedence. If they differ, the server SHOULD return `400` with error code `idempotency_mismatch`.
4. The HTTP header is deprecated. A future version of the HTTP Profile MAY remove it.

### 5.5 Non-HTTP Transports

On non-HTTP transports (WebSocket frames, MCP tool arguments), only the body-level `idempotencyKey` applies. There is no header equivalent.

---

## 6. Security Requirements

### 6.1 Envelope Security Properties

- Participants MAY retrieve only artifacts addressed to their authenticated DIDs.
- Routing metadata (sender, recipients) MUST NOT grant signer eligibility or execution authority.
- Sender-selected recipients MUST NOT override Verifier policy.
- Underlying MPAS artifacts MUST remain unchanged and independently verifiable.
- Push notifications (however delivered) MUST be treated only as hints.
- Duplicate, delayed, reordered, or replayed deliveries MUST NOT cause duplicate execution.

### 6.2 Coordination Service Trust Boundary

The Coordination Service:

- MUST NOT hold participant private keys or downstream application credentials.
- MUST NOT alter enclosed MPAS artifacts.
- MUST NOT forge or fabricate artifacts.
- MUST NOT use delivery metadata as authorization input.
- SHOULD treat all push delivery as best-effort and ensure polling availability as the reliable fallback.

A compromised Coordination Service can:
- Delay or suppress deliveries (mitigated by polling catch-up).
- Replay deliveries (mitigated by idempotency key deduplication).
- Read artifact contents in transit (mitigated by future end-to-end encryption, out of scope).

A compromised Coordination Service CANNOT:
- Forge valid Approvals (requires signer private keys).
- Alter Action Envelopes without detection (hash binding).
- Produce valid Execution Receipts (requires Credential Adapter keys).
- Grant execution authority (Verifier policy is locally configured).

### 6.3 Idempotency Security

- `idempotencyKey` is not a security mechanism — it prevents accidental double-submission.
- The Coordination Service SHOULD expire stored idempotency records after the action's `expiresAt` plus a retention buffer.
- Idempotency keys are per-sender. Different senders may use the same key value without conflict.

---

## 7. Polling Compatibility

### 7.1 Unchanged Requirements

The existing polling endpoints (`/mpas/v1/coordination/poll`) remain mandatory and unchanged. Any push delivery mechanism is supplementary.

### 7.2 Polling as Consistency Guarantee

Even participants with active push delivery (however implemented) SHOULD poll periodically as a consistency check. Recommended catch-up interval: every 60 seconds for Credential Adapters, every 5 minutes for interactive signers.

### 7.3 Envelope Delivery via Poll

Poll responses MAY optionally wrap returned artifacts in Delivery Envelopes when the participant has opted into envelope delivery. This is controlled by an optional `envelope` field in the poll request:

```json
{
  "version": "1",
  "type": "CoordinationPollRequest",
  "did": "did:web:adapter.example",
  "envelope": true
}
```

When `envelope` is `true`, the poll response wraps each artifact in a Delivery Envelope for consistent handling across transports. When `envelope` is absent or `false`, the response format is unchanged from HTTP Profile §8.5.

---

## 8. Compatibility and Migration

### 8.1 Backwards Compatibility

- Existing polling clients are unaffected. No changes to poll request/response format unless `envelope: true` is explicitly requested.
- Existing `Idempotency-Key` header continues to work during the migration period.
- Coordination Services that do not implement push delivery continue to conform to the HTTP Profile via polling.

### 8.2 Incremental Adoption

Participants adopt delivery features independently:

1. Participants start sending body-level `idempotencyKey` → servers accept both header and body.
2. Coordination Service implementations add push delivery (transport of their choice) → participants subscribe using implementation-specific mechanisms.
3. After sufficient adoption, the HTTP header is deprecated in a future profile version.

---

## 9. Open Questions

1. Should the Delivery Envelope support a `priority` field for time-sensitive deliveries (e.g., expiring actions)?
2. Is access-controlled storage sufficient for delivered artifacts, or should a future version support end-to-end encryption for recipients?
3. How are Adapter and Signer DIDs enrolled, rotated, suspended, and revoked? (Likely a separate feature.)
4. Should the envelope carry a `correlationId` for request/response artifact pairing, or is action identity in the payload sufficient?

---

## 10. References

- [MPAS Core Specification](../../../specs/mpas-specification.md) — §4.2 Coordination Service, §6.8 Topologies, §7.7.5 Push/Polling
- [MPAS HTTP Profile](../../../specs/mpas-profile-http.md) — §4.5 Idempotency, §8 Coordination API, §9 Polling and Webhooks
- [GitHub Issue #45](https://github.com/oma3dao/mpas/issues/45) — Routing/Delivery Envelope architecture
- [GitHub Issue #20](https://github.com/oma3dao/mpas/issues/20) — Idempotency-Key body migration
- [GitHub Issue #17](https://github.com/oma3dao/mpas/issues/17) — Demo Coordination Service validation
- RFC 9421 — HTTP Message Signatures
