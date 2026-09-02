# MPAS Action Relay, Routing, and Work Notification — Implementation Plan

**Status:** Separation revision planned; earlier combined implementation exists
**Created:** 2026-08-20
**Revised:** 2026-08-29
**Feature specification:** [spec.md](./spec.md)
**Tracks:** [#45](https://github.com/oma3dao/mpas/issues/45), [#20](https://github.com/oma3dao/mpas/issues/20), [#17](https://github.com/oma3dao/mpas/issues/17)

---

## 1. Purpose

This plan sequences the MPAS repository work for participant-authored DID routing through a logically separate Action Relay, relay polling, optional WebSocket work notifications, action-result return delivery, and body-level idempotency. The existing Coordination Service workflow remains an explicit client-selected step.

The normative files in `specs/` are updated before SDK or reference implementation work. SignerSet deployment work is planned separately in `wivity/mpas-coordination-server/docs/features/routing/plan.md` and starts only after the upstream wire protocol is accepted.

## 2. Delivery Order

| Phase | Deliverable | Repository scope | Status |
| --- | --- | --- | --- |
| 0 | Feature design | `docs/features/routing/` | Accepted for implementation |
| 1 | Normative protocol changes | `specs/` | Implemented |
| 2 | SDK routing types, clients, and helpers | `sdk/protocol` | Implemented |
| 3 | Request validation and body idempotency | Demo Verifier, Action Relay, and Coordination Service | Separation update pending |
| 4 | Reference Action Relay and relay poll | Demo Action Relay | Separation update pending |
| 5 | Service-scoped WebSocket notification binding | Demo relay/coordination services + clients | Separation update pending |
| 6 | Verifier response, explicit workflow flow, and conformance | SDK + demo + conformance | Separation update pending |

The demo Action Relay uses an in-memory, recipient-indexed reference store. It demonstrates routing, correlation, retry, cursor, and audit semantics but is not production-durable across process restarts. Its relay state remains independent from the demo Coordination Service workflow state. Persistent delivery records, recovery, and operational retention belong to the separate SignerSet implementation plan.

## 3. Phase 0 — Feature Design

### Deliverables

- References to the existing Core actor definitions, adding only the service distinction that an Action Relay or Coordination Service hosts endpoints without becoming a protocol participant or requiring a DID.
- Exact workflow correlation through `actionEnvelopeHash` and `executionPayloadHash`, without semantic command/parameter matching.
- A participant-authored `DeliveryEnvelope` with an authenticated `sender`.
- A common `POST /mpas/v1/verifier/action` interface on a Verifier or Action Relay, with canonical `DeliveryEnvelope<ActionRequest>` input and `/mpas/v1/action` as a temporary compatibility alias.
- Trusted endpoint or Action Relay deployment configuration that selects one designated Verifier DID and requires that DID to occur in the envelope's potentially multi-recipient `recipients` array.
- The existing Verifier-authored `ActionResponse` as the response from either a direct Verifier or an Action Relay.
- Signed Verifier submission of `DeliveryEnvelope<ActionResponse>` to an Action Relay.
- `RelayPollRequest` and `RelayPollResponse` for addressed delivery retrieval.
- A relay WebSocket that sends only `RelayWorkAvailable` notifications.
- A signed session request and DID-bound, one-use upgrade ticket.
- Action-specific recipient authorization from authenticated Verifier `AuthorizationRequirements`, administrator additions, and auditable routing decisions.
- Initial Verifier routing through a `DeliveryEnvelope` whose payload is `ActionRequest` containing the initial Action Package, with the designated Verifier selected by trusted endpoint or Action Relay configuration.
- Explicit Coordination Service workflow creation after `additionalApprovalsRequired`, followed by client-controlled first submission of the completed replacement Action Package.
- An asynchronous Verifier result path using the existing `ActionResponse` and `ExecutionReceipt` types.
- Body-level idempotency on `ActionRequest` and the existing coordination mutation requests, without adding it to `DeliveryEnvelope` or portable artifact schemas.
- Layered request equivalence that ignores regenerated routing metadata while retaining sender, recipient-set, and Action identity changes.
- A bounded synchronous relay wait that preserves the durable relayed Action for retry.
- Immutable per-Signer additional-approval decisions and deterministic unreachable-workflow evaluation.

### Review Decisions

- Separate relay and coordination poll contracts, each scoped to its own service and work type.
- One canonical Action submission body and response state machine for direct-Verifier and Action-Relay topologies.
- No direct Proposer-to-Verifier network requirement when the configured Action origin is an Action Relay; the relay is the durable intermediary for that topology.
- The Action Relay delivery endpoint is the Verifier response return path and initially accepts `DeliveryEnvelope<ActionResponse>`; arbitrary payload relay is not required.
- A relay response never creates a Coordination Service workflow, and a ready replacement Action Package is returned to the Proposer for explicit first submission rather than automatically delivered to a Verifier.
- A direct Verifier validates its configured DID and its membership in `recipients`; it does not require a single-recipient envelope or forward to other recipients unless it also implements routing.
- No WebSocket payload delivery or acknowledgement protocol.
- No Coordination Service DID requirement.
- No recipient discovery or multi-service coordination protocol.
- No Signer-harness or agent-framework integration.

### Exit Criteria

- The feature specification is accepted as the design baseline.
- The roles of sender, Action Relay, Coordination Service, poll recipient, and payload verifier are unambiguous.
- The notification-only WebSocket and action-result return flow are accepted.
- Verifier-produced Signer eligibility is the baseline approval-routing source; administrator additions are distinct, additive, and auditable.

## 4. Phase 1 — Normative Specifications First (#20, #45)

### 4.1 HTTP Profile

Update `specs/mpas-profile-http.md` before changing TypeScript:

- §4.5: define body `idempotencyKey`, body/header mismatch behavior, equivalence, and header deprecation.
- §6: define `/mpas/v1/verifier/action` as the common Verifier-or-Action-Relay submission interface:
  - canonical `DeliveryEnvelope<ActionRequest>` body;
  - required support for both `DeliveryEnvelope<ActionRequest>` and bare `ActionRequest` at a directly reachable Verifier;
  - body `ActionRequest.idempotencyKey`;
  - conditional `DeliveryEnvelope.audience` for canonical submission and `ActionRequest.audience` only for a signed bare direct request;
  - configured-Verifier membership in a non-empty, unique recipient array;
  - direct Verifier identity matching without a recipient-cardinality restriction or implied forwarding obligation;
  - outer-type normalization and endpoint identity equality; and
  - the existing `ActionResponse` for both direct and relayed submission, with no synthetic relay result.
- §4.6: add endpoint equality rules:
  - Verifier response delivery: `signature keyid == DeliveryEnvelope.sender == ActionResponse.verifier.did == recorded relayed-Action Verifier DID`;
  - session request: `signature keyid == request.did`.
- §4.6: classify Verifier response delivery and session issuance as state-mutating for nonce-claim ordering.
- §8 endpoint table: add `POST /mpas/v1/relay/poll`, `POST /mpas/v1/relay/delivery`, `POST /mpas/v1/relay/session`, and `GET /mpas/v1/relay/ws`.
- §8.4: retain `/mpas/v1/coordination/workflow` as the explicit workflow-creation interface after a direct or relayed Verifier returns Authorization Requirements.
- Define `/mpas/v1/coordination/action` as a temporary compatibility alias sharing the canonical workflow endpoint's request, response, authorization, idempotency scope, and side effects.
- Keep coordination poll focused on `approvalRequests` and `actionUpdates`; define separate `RelayPollRequest` and `RelayPollResponse` messages for deliveries.
- Add schemas and rules for:
  - `DeliveryEnvelope`;
  - `ActionRequest` additions and the deferred Action Relay return of the existing `ActionResponse`;
  - Verifier `DeliveryEnvelope<ActionResponse>` submission and `RelayDeliveryResponse`;
  - `RelayPollRequest` and `RelayPollResponse`;
  - `RelaySessionRequest` and `RelaySessionResponse`; and
  - `RelayWorkAvailable`.
- Define the notification-only WebSocket upgrade and one-use ticket behavior.
- Define the routed `ActionResponse` return flow and its relationship to a signed `ExecutionReceipt`.
- Preserve authenticated `AuthorizationRequirements` in the Verifier response while keeping later workflow creation explicit and independently authorized by the Coordination Service.
- Extend the direct Proposer-to-Verifier lifecycle with the same logical Action contract through an Action Relay. Keep Coordination Service workflow creation and completed-package retrieval as explicit client operations.
- Add `idempotency_mismatch` and `idempotency_conflict` to the error table where needed.
- Add `timeout` as the retryable transport result of a bounded wait, returned by the Action Relay and available to a directly reachable Verifier.
- Define rejection of already-expired Delivery Envelopes, recipient-list disclosure, a recommended finite recipient cap, delivery-only cursor semantics, and optional duplicate response-delivery deduplication.
- Define first-decision-final coordination behavior and recommended unreachable-threshold detection.

### 4.2 Core Specification

Update `specs/mpas-specification.md` only where transport-neutral text is needed:

- identify `DeliveryEnvelope` as routing metadata, not execution authorization;
- state that the enclosed artifact retains its existing verification requirements; and
- cross-reference the HTTP profile for routed asynchronous delivery.

Do not change `ActionPackage`, `ActionEnvelope`, `Approval`, `ActionResponse`, or `ExecutionReceipt` schemas for routing or submission idempotency.

### 4.3 Normative Schema Artifacts

If the repository's normative JSON Schema bundle includes HTTP transport messages, add the new messages and the optional poll-response field there. `DeliveryEnvelope.payload` accepts JSON representations admitted by the applicable MPAS message or profile schema; routing does not define a generic application payload vocabulary.

### Exit Criteria

- The official specifications are internally consistent and pass their document/schema checks.
- Existing coordination poll authentication is referenced rather than duplicated.
- The normative text contains no WebSocket payload frame or service-DID assumption, and does not transfer trust or state between relay and coordination operations.
- Each new normative requirement has a planned conformance case.

## 5. Phase 2 — SDK Routing Types, Clients, and Helpers (#20, #45)

### 5.1 New Types

Add and export the accepted normative shapes in `sdk/protocol/src/types/mpas.ts`:

```typescript
export interface DeliveryEnvelope<TPayload = JsonValue> {
  version: "1";
  type: "DeliveryEnvelope";
  sender: Did;
  recipients: Did[];
  createdAt: Timestamp;
  expiresAt?: Timestamp;
  audience?: string;
  payload: TPayload;
}

export interface ActionRequest {
  version: "1";
  type: "ActionRequest";
  actionPackage: ActionPackage;
  idempotencyKey?: string;
  audience?: string;
  context?: Record<string, JsonValue>;
}

export interface RelayDeliveryResponse {
  version: "1";
  type: "RelayDeliveryResponse";
  accepted: true;
  createdAt?: Timestamp;
}

export interface RelayPollRequest {
  version: "1";
  type: "RelayPollRequest";
  did: Did;
  cursor?: string;
  audience?: string;
}

export interface RelayPollResponse {
  version: "1";
  type: "RelayPollResponse";
  deliveries: DeliveryEnvelope[];
  nextCursor?: string;
}

export interface RelaySessionRequest {
  version: "1";
  type: "RelaySessionRequest";
  did: Did;
  audience?: string;
}

export interface RelaySessionResponse {
  version: "1";
  type: "RelaySessionResponse";
  websocketUrl: string;
  ticket: string;
  expiresAt: Timestamp;
}

export interface RelayWorkAvailable {
  version: "1";
  type: "RelayWorkAvailable";
}
```

Use the SDK's existing `Did`, `Timestamp`, and JSON value types. Align types with the normative schema if that review changes a field name.

### 5.2 Existing Types

- Add `RelayPollRequest` and `RelayPollResponse`, including `deliveries`, `cursor`, and `nextCursor`.
- Add `idempotencyKey?: string` to:
  - `ActionRequest` as shown above;
  - `CoordinationActionRequest`;
  - `CoordinationApprovalSubmission`;
  - `CoordinationActionCancelRequest`.

### 5.3 Delivery Envelope Parsing and Construction

- Add a runtime `DeliveryEnvelope` parser that validates the outer discriminant, sender and recipient DIDs, non-empty unique recipients, timestamps, conditional audience, and JSON payload shape.
- Keep envelope parsing separate from payload parsing. After the outer parser succeeds, dispatch the payload by its own `type` to the existing or new MPAS message parser.
- Add typed helpers for `DeliveryEnvelope<ActionRequest>` and `DeliveryEnvelope<ActionResponse>` without making the routing parser infer roles from payload content.
- Add envelope builders that preserve the payload object and require callers to provide sender, recipients, timestamps, and any HTTP audience.
- Add helpers for recipient membership and expiration checks used by poll consumers.

### 5.4 Body Idempotency Support

- Add body `idempotencyKey` construction and validation for `ActionRequest` and the existing coordination mutation request types.
- Add shared body/header resolution, mismatch detection, request fingerprinting, and authenticated-DID scoping helpers for clients and servers.
- Dispatch idempotency fingerprinting by registered message type. Compose Delivery Envelope sender and recipient-set equivalence with the enclosed request scope; reject unregistered types.
- Ensure a retry reuses the body idempotency key while generating a fresh RFC 9421 nonce.
- Do not add or look for an idempotency key on `DeliveryEnvelope`.
- Add a pure `evaluateApprovalRequirements` SDK helper that reports `satisfied`, `pending`, or `unreachable` from immutable Signer decisions without claiming authoritative Verifier policy evaluation.

### 5.5 Action Relay Client and Verifier Polling Support

- Add `CoordinationServiceClient.createApprovalWorkflow` for the canonical workflow endpoint, while retaining deprecated client wrappers and the `/coordination/action` server alias during migration.
- Add `ActionRelayClient` with participant-bound, RFC 9421-authenticated `submitAction`, `pollDeliveries`, `submitActionResponse`, and relay-session support. It may share internal HTTP and parsing helpers with other clients without exposing relay methods on `CoordinationServiceClient`.
- Parse the outer envelopes in `RelayPollResponse.deliveries`, preserve the cursor contract, and leave each payload opaque until the caller dispatches on its `type`.
- Provide recipient-membership, expiration, and typed `DeliveryEnvelope<ActionRequest>` parsers for the Verifier to apply before handing a payload to Action processing.
- Reuse the existing Action parser and Verifier processing interface after explicit caller-controlled unwrapping; the poll client does not infer the participant's role or reimplement Action verification or execution.
- Persist or advance `nextCursor` only after the caller durably accepts the page, and tolerate at-least-once duplicate envelopes using existing Action identity rules.
- Support both one-shot polling and a cancellable polling loop with caller-supplied cadence and error handling.

### 5.6 WebSocket Notification Support

- Add a client for the signed relay session request, one-use bearer-ticket upgrade, and `RelayWorkAvailable` frame validation.
- Use the returned WebSocket URL exactly, present the ticket in the upgrade `Authorization` header, propagate upgrade failures through the supplied socket adapter, and obtain a new ticket after disconnection.
- Bind each socket to its originating Action Relay HTTPS URL, audience, authenticated DID, and poll cursor.
- Trigger the normal authenticated poll when a notification arrives; never parse a payload from the WebSocket frame.
- Support reconnect and the server's notification-on-connect behavior without treating notification loss as delivery loss.
- Keep polling usable without WebSockets.

### 5.7 Verifier ActionResponse Delivery

- Use the generic `buildDeliveryEnvelope` helper to construct `DeliveryEnvelope<ActionResponse>` with the authenticated Verifier DID as `sender` and the verified Proposer DID among `recipients`; do not add a response-specific builder.
- Allow the Verifier to address the response to relay-administrator-authorized recipients in addition to the required Proposer.
- Preserve the Verifier-authored `ActionResponse` and any `ExecutionReceipt` unchanged as the payload.
- Add an RFC 9421-authenticated client method that posts the envelope to `/mpas/v1/relay/delivery` and parses `RelayDeliveryResponse`.
- Apply the outer request `audience` for the Action Relay origin and do not add routing-level body idempotency.
- Keep Verifier processing policy outside the transport client. Document composition of `pollWork`, the typed envelope parsers, the existing Verifier handler, `buildDeliveryEnvelope`, and `submitActionResponseDelivery` without adding a high-level processing method.

### 5.8 Common Action Endpoint Client Support

- Add `buildActionRequest` for the inner Action layer and keep Delivery Envelope construction separate.
- Allow `ActionEndpointClient.submitActionRequest` to submit canonical `DeliveryEnvelope<ActionRequest>` to either a direct Verifier or an Action Relay and parse the same existing `ActionResponse` from both.
- Require a direct Verifier to support both enveloped and bare `ActionRequest`; keep the Action Relay envelope-only.
- Preserve Action body idempotency across a disconnected relayed request and its retry.

### Exit Criteria

- New types compile and are exported by `@oma3/mpas`.
- Type and parser fixtures cover each new message, both typed Action envelope payloads, and the delivery-focused poll response.
- Verifier polling works with and without WebSocket notification and handles cursor retries without losing work.
- A Verifier can process a polled `ActionRequest` and submit the resulting `DeliveryEnvelope<ActionResponse>` through the SDK client.
- Body idempotency helpers cover body-only, header fallback, mismatch, equivalent retry, changed-body conflict, and fresh-nonce behavior.
- Direct and relayed Action submissions both return the existing `ActionResponse`; no relay-specific Action response type is exported.
- Existing coordination consumers compile without adopting relay types; compatibility wrappers remain temporarily available where the earlier combined SDK exposed them.

## 6. Phase 3 — Validation and Body Idempotency (#17, #20)

The existing DID-scoped poll authentication remains in place. This phase adds only validation needed by accepted message changes and the body idempotency migration.

### Deliverables

- Runtime validation for enveloped and bare Action submission, Verifier `DeliveryEnvelope<ActionResponse>` submission, and relay poll/session messages before authentication binding or mutation.
- Validation for:
  - outer Action body discriminant (`DeliveryEnvelope` or bare `ActionRequest`);
  - `DeliveryEnvelope.payload.type == "ActionRequest"` for canonical Action submission;
  - non-empty, unique recipient arrays;
  - configured Verifier DID membership in the recipients as side-effect-free endpoint or routing-policy validation;
  - RFC 3339 timestamps and `expiresAt > createdAt`;
  - rejection when `expiresAt` is not in the future at submission;
  - valid MPAS JSON payload representation;
  - idempotency key length on messages that define one; and
  - secure `wss://` URLs outside explicit local tests.
- Add body `idempotencyKey` handling to `ActionRequest` and the existing coordination workflow-creation, approval, and cancellation requests.
- Do not add an idempotency field to `DeliveryEnvelope`; Verifier response delivery has no body-level routing idempotency key.
- Retain `Idempotency-Key` header fallback.
- Return `400 idempotency_mismatch` when body and header values differ.
- Scope idempotency records by authenticated DID and key.
- Return the stored response for an equivalent retry and `409 idempotency_conflict` for a changed body.
- Verify Action Package hash bindings and Verifier-authored requirements before creating relay deliveries or approval workflows.
- Treat a Signer's first additional-approval decision for an Action Envelope as final; accept same-decision duplicates idempotently and reject changes with `409`.

### Ordering

1. Parse and validate the request body.
2. Verify RFC 9421, digest, freshness, audience, and endpoint identity equality.
3. Complete side-effect-free business validation.
4. Atomically claim the RFC 9421 nonce.
5. For a request message that defines `idempotencyKey`, resolve or claim the idempotency record.
6. Commit the mutation once.

An idempotent retry of such a request uses the same `idempotencyKey` and a new RFC 9421 nonce.

### Exit Criteria

- Malformed new requests fail without consuming a nonce.
- Body/header match, mismatch, retry, conflict, and concurrent-claim tests pass.
- Existing coordination request tests continue to pass.

## 7. Phase 4 — Reference Action Relay and Polling (#45)

### Deliverables

- `POST /mpas/v1/relay/delivery` as the Verifier `ActionResponse` return path.
- `POST /mpas/v1/verifier/action` on the demo Verifier and Action Relay, using one normalization contract and different direct/deferred host behavior.
- A recipient-indexed reference envelope store with an independent delivery record for every recipient DID. The demo implementation is in memory; deployment persistence is specified separately.
- Storage of administrator-added delivery authorizations scoped by purpose and applicable MPAS value.
- Storage of the designated Verifier DID resolved from trusted Action Relay deployment configuration, independent of any additional envelope recipients.
- Verifier response binding `signature keyid == DeliveryEnvelope.sender == ActionResponse.verifier.did == recorded relayed-Action Verifier DID`.
- `RelayPollResponse.deliveries` from `POST /mpas/v1/relay/poll`.
- Expiration and existing cursor handling.
- No relay hook that creates a workflow or submits a ready package. The Coordination Service returns `readyForSubmission` to the Proposer, which controls the replacement Action's first Verifier submission.
- Pending-request and stored-result handling that completes the relayed `/mpas/v1/verifier/action` call with the first authenticated Verifier `ActionResponse`.
- A deployment-configurable bounded HTTP wait returning retryable `503 timeout` while retaining the pending relay record.
- Capped delivery pages whose cursor is an acknowledgement checkpoint for delivery position only.
- Threshold-impossibility detection that moves the non-authoritative workflow to `rejected` as soon as immutable decisions make it unreachable.
- An audit record for sender provenance, requested and decided recipients, authorization scope, time, and payload hash or MPAS reference.

### Required Behavior

- A canonical Action request is accepted only when `signature keyid == DeliveryEnvelope.sender == ActionEnvelope.proposer.did` and trusted endpoint or Action Relay configuration selects a Verifier DID that occurs in the non-empty, unique recipient array. The relay records that configured DID and creates records for every authorized recipient.
- The delivery endpoint accepts `DeliveryEnvelope<ActionResponse>` from the recorded designated Verifier; arbitrary payload delivery is not required in this implementation phase.
- A Verifier normalizes both enveloped and bare `ActionRequest` into the same Action processor; an Action Relay rejects the bare form because it lacks recipient routing and audit metadata.
- A direct Verifier returns its existing `ActionResponse`; an Action Relay keeps the request pending after durable relay and delivery commit and returns the first authenticated `ActionResponse` from the recorded designated Verifier.
- An Action Relay never synthesizes `ActionResponse.result: pending` merely because it accepted or delivered the envelope.
- If the original connection ends, an equivalent idempotent retry attaches to the existing relayed Action and waits for or returns its stored first Verifier response.
- If the relay wait bound expires, the endpoint returns `503 timeout` without synthesizing an Action result or deleting the relayed Action and deliveries.
- Initial Verifier designation comes from trusted endpoint or Action Relay deployment configuration, not from Proposer-authored fields or recipient position.
- The designated Verifier DID recorded for the relayed Action must equal the authenticated `ActionResponse.verifier.did`.
- A Verifier response addresses the Proposer and may also address relay-administrator-authorized recipients.
- Eligible and applicable override Signers continue to receive existing Approval Requests; administrator additions do not become Signers and their Approvals do not count unless new Verifier requirements include them.
- The Coordination Service returns a ready package to the Proposer through its existing action update. It does not route or submit that package to the Verifier.
- The routing store does not inspect payloads to derive recipients.
- The stored envelope preserves the sender's submitted fields.
- A recipient that is not the designated Verifier gains no Verifier or Signer role, and its response cannot satisfy the Action workflow.
- A direct Verifier does not forward to other recipients unless it separately implements routing.
- One recipient's poll does not consume another recipient's copy.
- Only the authenticated poll DID receives its addressed envelopes.
- Reusing the prior cursor after a lost response can return the same page.
- Expired envelopes are not returned.
- Already-expired envelopes are rejected before storage.
- No successful poll or socket notification is treated as proof of payload processing.

### Exit Criteria

- Cross-DID access is rejected.
- A Verifier response envelope with any payload type other than `ActionResponse` is rejected by the initial delivery endpoint implementation.
- A Proposer sends the same `DeliveryEnvelope<ActionRequest>` to a directly reachable Verifier or an Action Relay. In the relay case, every authorized recipient can retrieve it, while the configured Verifier DID is recorded separately as the designated Verifier.
- Every Proposer-supplied recipient other than the designated Verifier is rejected unless relay-administrator policy supports its delivery purpose.
- An informational recipient cannot be counted as a Signer unless it is independently eligible under the existing approval rules.
- Two recipients independently retrieve one multi-recipient envelope.
- A lost poll response is safely retried.
- Existing Signer and Proposer arrays behave exactly as before.

## 8. Phase 5 — Reference Relay WebSocket Notification (#45)

### Deliverables

- RFC 9421-authenticated `POST /mpas/v1/relay/session`.
- Short-lived, single-use, DID-bound opaque tickets.
- `GET /mpas/v1/relay/ws` with the ticket in `Authorization: Bearer`.
- The client uses the returned WebSocket URL exactly, expects `101`, treats invalid, expired, or used tickets as `401`, and requests a new session after disconnecting.
- A connection registry keyed by authenticated DID.
- UTF-8 `RelayWorkAvailable` frames with no payload.
- A role-neutral client that opens any authenticated connection, receives a notification for outstanding work, polls, reconnects, and repeats the flow.
- Per-connection client context binding the Action Relay HTTPS origin, RFC 9421 audience, returned WebSocket URL, and poll cursor.

### Required Behavior

- Ticket creation follows signature verification and atomic nonce claim.
- Ticket consumption is atomic.
- Tickets never appear in URLs or logs and expire within five minutes.
- The relay checks for outstanding deliveries immediately after binding every authenticated connection, including the participant's first connection. Coordination notifications remain scoped to `approvalRequests` and `actionUpdates`.
- A transaction that creates any pollable work for a DID causes a notification when a connection is available.
- Notifications may be coalesced or duplicated.
- Socket state never removes or acknowledges a stored envelope.
- All payload retrieval still uses the normal signed poll.
- Notification handling selects the poll origin from the socket's retained session context, never by transforming the returned WSS URL.

### Exit Criteria

- Missing, expired, used, and unknown tickets fail.
- A ticket opens only the DID-bound session created by its signed request.
- Every authenticated connection with outstanding work produces a notification.
- Two socket contexts with different Action Relay origins select their own signed poll origin and cursor without adding a URL to the notification frame.
- Notification loss is recovered by the reconnect check or ordinary polling.
- The frame contains no envelope or authorization data.

## 9. Phase 6 — Verifier Response and Conformance

### Integration Scenario

1. The administrator configures the test Action Relay's designated Verifier DID, and the Proposer includes that DID among the envelope recipients without assigning it a role in `ActionRequest`.
2. The Proposer submits the canonical signed `DeliveryEnvelope<ActionRequest>` to `/mpas/v1/verifier/action` at a test Action Relay; the request remains pending while the relay durably stores the relayed Action and deliveries.
3. The Action Relay verifies the Proposer, envelope, package hashes, configured-Verifier membership, and recipient authorization, then atomically records the configured Verifier DID and creates delivery records for all authorized recipients. It creates no workflow.
4. The Verifier is notified on its authenticated relay WebSocket and polls the Action Relay for the initial package.
5. The Verifier submits an `additionalApprovalsRequired` `ActionResponse` through an RFC 9421-authenticated delivery whose sender equals both the recorded designated Verifier DID and `verifier.did` and whose requirements are bound to the Action Envelope hash.
6. The Action Relay stores that first qualifying response and completes the pending `/mpas/v1/verifier/action` call with the unchanged Verifier-authored `ActionResponse`; an equivalent retry receives the stored response if the original connection ended.
7. The Proposer retires A1, constructs A2 with a new Action ID and hash, authors A2-bound requirements, and explicitly submits `CoordinationActionRequest` for A2 to `/mpas/v1/coordination/workflow`. The Coordination Service applies its own authorization without trusting co-located relay state, then eligible Signers retrieve Approval Requests and submit sufficient Approvals.
8. The workflow reaches `readyForSubmission` and returns completed A2 to the Proposer through the existing action update without creating a relay delivery.
9. The Proposer explicitly submits completed A2 to the same logical Verifier endpoint for the first time. The Verifier reevaluates its current policy, verifies, and processes A2.
10. The Verifier creates the resulting `ActionResponse`, including the applicable signed `ExecutionReceipt`, and returns it directly or through the Action Relay according to the selected topology.
11. The Proposer receives the final Verifier-authored response through the same Action call contract.
12. Duplicate Action Package or response delivery is handled using existing action and receipt identities.
13. An independent Action fixture using the same canonical request shape is submitted to a directly reachable test Verifier, which unwraps it through the same Action interface and returns the existing `ActionResponse`.

### Conformance Cases

- Canonical `/mpas/v1/coordination/workflow` creation plus temporary `/coordination/action` alias equivalence, including shared authorization and DID-scoped idempotency behavior.
- Envelope structural and timestamp validation.
- Enveloped and bare Action submission at a Verifier, enveloped submission at an Action Relay, and bare rejection at an Action Relay.
- Direct Verifier configured-DID membership for the ordinary one-identity endpoint, plus coverage that a multiplexing implementation selects through trusted local routing configuration.
- The same Verifier-authored `ActionResponse` shape and semantics for direct and relayed Action submission.
- Relayed `/verifier/action` waiting, connection loss, idempotent retry, and stored-response completion, including `/action` alias equivalence.
- Rejection of a synthetic relay-authored `ActionResponse.result: pending` before the Verifier responds.
- The first returned Verifier response remains pollable as an addressed envelope and is safe to observe again.
- Sender/signature equality and mismatch.
- Authenticated poll scoping and cross-DID denial.
- Recipient authorization, rejection, and audit behavior.
- Initial designated-Verifier membership, multi-recipient acceptance, and recorded-designated-Verifier/response-sender equality.
- Non-Verifier recipient delivery without Verifier or Signer authority, and rejection of its attempted workflow response.
- Direct Verifier acceptance of additional recipients without assuming responsibility to forward to them.
- Verifier requirements hash, expiry, and expected-Verifier validation when the client explicitly creates a Coordination Service workflow.
- Verifier response copies to the Proposer and relay-administrator-authorized recipients, with rejection of unauthorized additional recipients.
- Authenticated response equality `signature keyid == DeliveryEnvelope.sender == ActionResponse.verifier.did`.
- Delivery authorization does not modify `eligibleSigners` or threshold calculations.
- A relayed `additionalApprovalsRequired` response creates no workflow until the client calls `/coordination/workflow`.
- `readyForSubmission` creates no relay delivery; completed A2 submission is a separate client-controlled Action mutation with A2's own Action ID, hash, and idempotency key.
- Relay and coordination polling, sessions, and notification types remain isolated, and relay delivery cursors never enter coordination responses, when the services use different origins and stores.
- Multi-recipient independent retrieval.
- Cursor retry and duplicate delivery.
- Expiration filtering.
- Session signature/DID equality.
- Ticket single use, expiry, secrecy, and DID binding.
- Notification for outstanding work on every authenticated connection, including the first.
- Notification-only frame schema.
- Routed `ActionResponse` and signed `ExecutionReceipt` preservation.
- Action and existing coordination-request body/header idempotency migration and concurrent mutation safety.
- Action idempotency extraction from bare or enveloped `ActionRequest` without adding the key to `ActionPackage` or `DeliveryEnvelope`.

### Exit Criteria

- SDK, demo, and conformance suites pass.
- The full request/result scenario is reproducible from a clean install.
- Existing coordination clients remain compatible.

## 10. Dependencies and Risks

| Dependency or risk | Mitigation |
| --- | --- |
| Current HTTP authentication profile supports `did:jwk` | Keep version 1 conformance within `did:jwk`; specify other DID methods separately. |
| WebSocket upgrade cannot directly use the current JSON-body signature profile | Authenticate a signed session POST and bind a single-use ticket to the proven DID. |
| Notification can be lost during connection failure | Check all outstanding pollable work after every authenticated connection and keep poll as the source of truth. |
| A relayed `/action` call waits for the Verifier's first poll and response | Use WebSocket notification for the ordinary fast path and durable idempotent retry after connection loss; reconsider a common direct-and-relayed acceptance response if observed latency frequently blocks clients. |
| Duplicate Action Packages could repeat effects | The Verifier performs normal verification and uses the existing durable action ledger. |
| A smart Action endpoint accepts two outer types | Use a strict discriminated union, normalize once, reject every other type, and share one Action processor after normalization. |
| Sender metadata is not end-to-end signed | Bind it at submission and require recipients to rely on payload signatures and receipts for authority. |
| An Action Relay or Coordination Service can read plaintext payloads it handles | Document TLS as hop protection; defer end-to-end encryption to a separate profile. |
| Proposer-relayed Authorization Requirements are not signed | Use them as authority only with authenticated Verifier provenance; otherwise require administrator confirmation of recipients. |
| No Authorization Requirements exist for initial Verifier routing | Resolve one designated Verifier from trusted deployment configuration, require that DID to occur in the envelope recipients, and record it independently of other recipients. |
| Administrator additions may be misconfigured | Keep them scoped by delivery purpose, audited, and distinct from Verifier-produced Signer eligibility. |
| Reusing coordination poll for relay deliveries would couple otherwise independent services and strict decoders | Keep relay delivery polling on `/relay/poll`; coordination poll remains workflow-only. |

## 11. Non-Goals

- A generic delivery-poll endpoint shared by relay and coordination.
- A requirement for Verifiers to expose an inbound relay response-delivery endpoint; Verifiers submit outbound responses to the Action Relay.
- Arbitrary generic payload submission through the Action Relay delivery endpoint; the initial use is Verifier `ActionResponse` return.
- Treating an authorized delivery recipient as an intrinsic or protocol-enforced Verifier role.
- Signer-harness or agent-framework integration.
- Webhooks or callback URLs.
- WebSocket payload delivery or acknowledgements.
- Exactly-once delivery.
- Participant or Coordination Service discovery.
- Cross-service aggregation or failover rules.
- End-to-end payload encryption.
- Production SignerSet infrastructure details.
- Standardized retry, concurrency, queue, retention, heartbeat, or environment-variable configuration.
