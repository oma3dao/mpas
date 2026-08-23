# MPAS Routing and Delivery — Implementation Plan

**Status:** Draft
**Created:** 2026-08-20
**Revised:** 2026-08-22
**Feature specification:** [spec.md](./spec.md)
**Tracks:** [#45](https://github.com/oma3dao/mpas/issues/45), [#20](https://github.com/oma3dao/mpas/issues/20), [#17](https://github.com/oma3dao/mpas/issues/17)

---

## 1. Purpose

This plan sequences the specification, implementation, and validation work for MPAS routing and delivery. It covers the Delivery Envelope, body-level idempotency key migration, demo Coordination Service hardening, and MPAS specification updates.

Push delivery mechanisms (webhooks, WebSocket, etc.) are implementation details handled in individual Coordination Service deployments (e.g., the SignerSet Coordination Service plan at `wivity/mpas-coordination-server/docs/features/routing/plan.md`). This plan covers the protocol-level work that lives in the MPAS repository.

---

## 2. Delivery Order

| Phase | Deliverable | Scope | Status |
| :--- | :--- | :--- | :--- |
| 0 | Feature documentation | `docs/features/routing/` | Complete |
| 1 | Request validation hardening | Demo Coordination Service | Complete |
| 2 | Delivery Envelope schema and body-level idempotency key | SDK types + demo implementation | Not started |
| 3 | MPAS specification updates | `specs/mpas-profile-http.md` | Not started |
| 4 | Integration testing and conformance | Demo + conformance suite | Not started |

Phase 1 is a standalone code-quality fix (landed). Phase 2 defines the protocol-level schemas. Phase 3 updates the normative MPAS specifications. Phase 4 validates everything end-to-end.

---

## 3. Phase 0 — Feature Documentation

### Deliverables

- `docs/features/routing/spec.md` — Feature specification.
- `docs/features/routing/plan.md` — This plan.

### Exit Criteria

- Specification reviewed and accepted as the basis for implementation.
- Open questions (spec.md §9) resolved or deferred with rationale.
- Agreement on envelope minimalism (no payload inspection, no transport binding specification).

---

## 4. Phase 1 — Request Validation Hardening (#17)

### Motivation

The demo Coordination Service (`examples/demo/src/coordination/coordination-api-server.ts`) casts request bodies directly to TypeScript types without runtime validation. Malformed requests (missing `version`, wrong `type`, missing required fields) are silently accepted.

### Deliverables

- A shared validation helper in `examples/demo/src/coordination/validation.ts` that validates `version`, `type`, and required fields for all four Coordination Service endpoints.
- Each route handler calls the validator before authentication and business logic.
- Malformed requests return `400` with error code `INVALID_REQUEST` and a human-readable message.

### Implementation

Validation module with per-endpoint validators:

```typescript
function validateCoordinationActionRequest(body: unknown): CoordinationActionRequest;
function validateCoordinationPollRequest(body: unknown): CoordinationPollRequest;
function validateCoordinationApprovalSubmission(body: unknown): CoordinationApprovalSubmission;
function validateCoordinationActionCancelRequest(body: unknown): CoordinationActionCancelRequest;
```

Each function:
1. Checks `body` is a non-null object.
2. Checks `version === "1"`.
3. Checks `type` matches the expected string.
4. Checks required fields are present and have expected types (string, object, etc.).
5. Throws `CoordinationStoreError(400, "INVALID_REQUEST", "<message>")` on failure.

Reference implementation: the `validatePollRequest` in the SignerSet Coordination Service.

### Exit Criteria

- All four endpoints reject malformed requests with 400.
- Existing tests continue to pass.

---

## 5. Phase 2 — Delivery Envelope Schema and Body-Level Idempotency Key (#20, #45)

### Deliverables

- TypeScript type definitions for `DeliveryEnvelope` in the SDK.
- Body-level `idempotencyKey` field added to all coordination request types.
- Demo Coordination Service store updated to accept `idempotencyKey` from the body (with fallback to HTTP header during migration).

### Implementation

#### 2a. Delivery Envelope Types

```typescript
interface DeliveryEnvelope {
  version: "1";
  type: "DeliveryEnvelope";
  sender: string;       // DID of sending participant or service
  recipients: string[]; // DID array of intended recipients
  createdAt: string;    // ISO 8601
  expiresAt?: string;   // ISO 8601, optional
  payload: unknown;     // Opaque MPAS artifact — not inspected by the envelope
}
```

The envelope is deliberately minimal. No artifact type, no action ref, no event classification, no recipient roles. The payload speaks for itself.

#### 2b. Body-Level Idempotency Key

Add `idempotencyKey?: string` to:
- `CoordinationActionRequest`
- `CoordinationApprovalSubmission`
- `CoordinationActionCancelRequest`

This is independent of the Delivery Envelope. Any transport carrying these request types benefits from body-level idempotency.

Update the Coordination Service store to:
1. Check body `idempotencyKey` first.
2. Fall back to `Idempotency-Key` HTTP header if body field is absent.
3. If both are present and differ, return `400` with `idempotency_mismatch`.
4. Store idempotency records keyed by `(senderDid, idempotencyKey)`.

### Exit Criteria

- Types compile and are exported from the SDK.
- Demo Coordination Service accepts body-level idempotency key.
- Existing header-based idempotency continues to work.
- Conflict detection (same key, different body) returns 409.

---

## 6. Phase 3 — MPAS Specification Updates

### Motivation

The normative MPAS specification documents (`specs/mpas-profile-http.md`, `specs/mpas-specification.md`) need updates to incorporate the Delivery Envelope and body-level idempotency key as protocol features.

### Deliverables

- Update `specs/mpas-profile-http.md`:
  - §4.5: Add body-level `idempotencyKey` field alongside the existing header. Deprecation notice for header-only usage.
  - §8 (or new subsection): Define the Delivery Envelope as the standard payload format for push delivery, without prescribing transport.
  - §9: Note that push delivery mechanisms are implementation-specific; polling remains mandatory.
  - §5.4 (service discovery): Mention that implementations MAY advertise push delivery support, without prescribing the format.
- Update `specs/mpas-specification.md` (if needed):
  - §4.2 (Coordination Service): Reference the Delivery Envelope as the standard wrapper for outbound artifacts.
  - §7.7.5 (Push/Polling): Clarify that push transports are implementation choices carrying Delivery Envelopes.

### Exit Criteria

- HTTP Profile is self-consistent with the routing feature spec.
- Existing normative requirements are not weakened.
- Deprecation of `Idempotency-Key` header is clearly marked as future removal (not immediate).
- No transport-specific (webhook, WebSocket) normative requirements are introduced.

---

## 7. Phase 4 — Integration Testing and Conformance

### Deliverables

- Conformance test: idempotency key in body behaves correctly (same key/same body, same key/different body, header+body mismatch).
- Conformance test: malformed requests rejected per Phase 1 rules.
- Integration test: Delivery Envelope round-trip through poll (with `envelope: true`).
- Verify no regressions in existing polling-based flow.

### Exit Criteria

- All integration tests pass in the demo environment.
- Tests are reproducible and documented.
- No regressions in existing polling-based flow.

---

## 8. Dependencies and Risks

| Risk | Mitigation |
| :--- | :--- |
| Body-level idempotency key requires all clients to update | Migration period accepts both header and body. Header removal is a future version. |
| Delivery Envelope adoption requires Coordination Service implementations to update | Envelope is opt-in via `envelope: true` in poll. Existing behavior unchanged by default. |
| Spec updates may introduce unintended normative changes | Review spec diffs carefully. Existing requirements preserved. |

---

## 9. Non-Goals for This Plan

- Transport binding specifications (webhooks, WebSocket, SSE, message queues) — these are implementation details for individual deployments.
- Subscription management APIs — implementation-specific.
- End-to-end encryption of delivery payloads.
- DID enrollment, rotation, suspension, and revocation.
- MCP transport binding for delivery (covered by MCP Proposer Bridge Profile).
- Production deployment guidance (infrastructure, scaling, monitoring).
- Conformance certification program.

---

## 10. Review Decisions Needed

- [ ] Confirm the Delivery Envelope is minimal (no payload inspection, no roles, no artifact type).
- [ ] Confirm body-level `idempotencyKey` applies only to Coordination Service endpoints (not Verifier endpoints like `/mpas/v1/action`).
- [ ] Decide retention period for idempotency records.
- [ ] Decide whether `correlationId` belongs in the envelope or is left to the payload.
