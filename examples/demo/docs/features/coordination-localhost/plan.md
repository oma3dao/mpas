# MPAS Local Coordination Service — Implementation Plan

**Status:** Draft  
**Spec:** `docs/features/coordination-localhost/spec.md`  
**Target:** macOS local development, separate process from the Credential Adapter  
**Language:** TypeScript (Node.js, ESM)  
**Approach:** Test-fixture-first, phased delivery, each task completable by a coding agent  

---

## 1. Scope

This plan covers the localhost coordination service inside `mpas-local`.

It produces:

1. In-memory coordination storage and state machine.
2. Fastify HTTP endpoints per the coordination service spec.
3. Approval collection, progress tracking, and non-authoritative readiness detection.
4. Completed Action Package assembly for proposer retrieval.
5. A standalone coordination service process with its own entry point.
6. Integration with `mpas daemon start` which launches both adapter and coordination as separate processes.

It does not produce:

- A hosted coordination service.
- Persistent storage.
- Authentication or tenant authorization.
- Verifier/adapter forwarding.
- Execution receipt production.
- WebSocket, SSE, or webhook delivery.

The proposer always submits Action Packages directly to the Credential Adapter. After an initial Action receives advisory requirements, the proposer constructs a replacement Action. The coordination service stores that replacement workflow, collects its Approvals, and assembles its completed Action Package for the proposer to fetch and submit.

---

## 2. Phases

| Phase | Deliverable |
|---|---|
| Phase 0 | Types and coordination test fixtures |
| Phase 1 | Core in-memory store and state machine |
| Phase 2 | Fastify HTTP endpoints |
| Phase 3 | Daemon and CLI integration |

---

## 3. Phase 0: Types and Test Fixtures

### 3.1 Tasks

#### Task 0.1: Coordination type definitions

Add coordination types under `src/coordination/types.ts`:

- `CoordinationState` — `awaitingApprovals | readyForSubmission | cancelled`
- `ActionRef` — `{ actionId, actionEnvelopeHash }`
- `CoordinationActionRequest` — contains `actionPackage` and `authorizationRequirements`
- `CoordinationActionResponse` — contains `actionRef`, `state`, `createdAt`
- `CoordinationPollRequest` — contains `did`
- `CoordinationPollResponse` — contains `approvalRequests[]` and `actionUpdates[]`
- `ApprovalRequest` — contains `actionRef`, `signerReviewSet`, `requestedDecision`
- `ActionUpdate` — contains `actionRef`, `state`, `progress`, optional `actionPackage`, `updatedAt`, optional `cancelledAt`
- `Progress` — contains `approvalsCollected`, `approvalsRequired`, `approved`, `rejected`, `pending`
- `CoordinationApprovalSubmission` — contains `actionRef` and `approval`
- `CoordinationApprovalSubmissionResponse` — contains `accepted`
- `CoordinationActionCancelRequest` — contains `actionRef` and `did`
- `CoordinationActionCancelResponse` — contains `actionRef`, `state`, `cancelledAt`
- `CoordinationRecord` — internal store record

Reuse existing MPAS core types from `src/core/types.ts` for `ActionPackage`, `AuthorizationRequirements`, `Approval`, `ApprovalBundle`, and hash objects.

**Done when:** Types compile and a sample coordination workflow can be constructed in TypeScript with full type checking.

#### Task 0.2: Coordination fixture directory

Create fixture files under `tests/fixtures/coordination/`:

| Fixture | Description |
|---|---|
| `coordination-action-request.json` | Full `CoordinationActionRequest` using `insufficient-approvals.json` Action Package and its Authorization Requirements. |
| `coordination-action-response.json` | Response after storing a pending action (`awaitingApprovals`). |
| `coordination-poll-request.json` | Poll request with a signer DID. |
| `coordination-poll-response-signer.json` | Poll response containing an Approval Request with Signer Review Set. |
| `coordination-poll-response-proposer-awaiting.json` | Proposer poll response with progress (1 of 2 approvals). |
| `coordination-poll-response-proposer-ready.json` | Proposer poll response with completed Action Package. |
| `coordination-approval-submission.json` | Signer submits one valid Approval with all fields. |
| `coordination-approval-response.json` | Simple `{ "accepted": true }` response. |
| `coordination-cancel-request.json` | Proposer cancels an action. |
| `coordination-cancel-response.json` | Cancel response with `cancelled` state. |

Use existing keys and Action Package fixtures from `tests/fixtures/`.

**Done when:** Fixtures are valid JSON and reference existing action IDs, hashes, DIDs, and approvals consistently.

#### Task 0.3: Fixture generation support

Update `scripts/generate-fixtures.ts` to generate coordination fixtures from existing Action Package/key fixtures.

Generated fixtures should include:

- computed Action Envelope hashes;
- Authorization Requirements with threshold and eligible signer DIDs;
- one or more real Approval signatures;
- an assembled Approval Bundle;
- a completed Action Package (original payload + envelope + updated bundle).

**Done when:** Running the fixture generator regenerates coordination fixtures and fixture validation tests pass.

#### Task 0.4: Fixture validation tests

Add Vitest tests under `tests/coordination/fixtures.test.ts` that:

- verify coordination fixtures are structurally valid;
- verify stored `actionEnvelopeHash` values match the referenced Action Envelope;
- verify Approval signatures in coordination fixtures use existing signer keys;
- verify the assembled Approval Bundle binds to the same Action Envelope hash;
- verify the completed Action Package contains the Proposer's original Approval plus collected Approvals.

**Done when:** `npm test -- --grep coordination` passes for fixture tests.

---

## 4. Phase 1: Core Storage and State Machine

### 4.1 Tasks

#### Task 1.1: In-memory coordination store

Implement `src/coordination/store.ts`:

```typescript
class CoordinationStore {
  submitAction(request: CoordinationActionRequest): CoordinationActionResponse;
  submitApproval(request: CoordinationApprovalSubmission): CoordinationApprovalSubmissionResponse;
  poll(did: string): CoordinationPollResponse;
  cancelAction(request: CoordinationActionCancelRequest): CoordinationActionCancelResponse;
}
```

Storage uses:

- `Map<string, CoordinationRecord>` indexed by `actionId.value`;
- `Map<string, CoordinationRecord>` indexed by `actionEnvelopeHash.value`.

**Done when:** A pending action can be stored and retrieved by action ID and Action Envelope hash.

#### Task 1.2: Action hash and conflict detection

On action submission:

- compute Action Envelope hash using JCS SHA-256;
- reject same `actionId.value` with different Action Envelope hash;
- treat same `actionId.value` and same Action Envelope hash as idempotent;
- action enters `awaitingApprovals` immediately (no separate `submitted` state).

Return a typed conflict result that the HTTP layer maps to `409 Conflict`.

**Done when:** Unit tests cover first submit, idempotent re-submit, and conflicting re-submit.

#### Task 1.3: Signer Review Set construction

For signer poll responses, construct a Signer Review Set from:

- stored Action Envelope;
- stored Execution Payload;
- stored Authorization Requirements.

The service must not mutate the stored Execution Payload or Action Envelope.

**Done when:** Polling as an eligible signer returns an Approval Request with a Signer Review Set whose payload hash matches the Action Envelope.

#### Task 1.4: Approval submission and duplicate handling

On approval submission:

- locate workflow by `actionRef.actionEnvelopeHash`;
- ensure Approval `actionEnvelopeHash` matches the workflow;
- reject if action is `cancelled` (return `404`);
- store Approval objects unmodified;
- decode signed Approval payload enough to identify signer DID and decision;
- accept a duplicate of the same Signer decision idempotently without double-counting;
- reject a different later decision from the same Signer for the same Action Envelope with `409`.

Signature verification is optional pre-validation only; final verification remains adapter responsibility.

**Done when:** Tests show valid approvals are stored, hash mismatches are rejected, cancelled actions reject submissions, and duplicate approvals do not inflate readiness counts.

#### Task 1.5: Readiness heuristic and progress tracking

Implement simple threshold readiness:

- evaluate `authorizationRequirements.approvalRequirements.anyOf`;
- evaluate `authorizationRequirements.approvalRequirements.allOf`;
- default required decision to `approve`;
- count unique eligible signer DIDs whose Approval decision matches;
- track `approved`, `rejected`, and `pending` DIDs for progress reporting;
- transition to `readyForSubmission` when thresholds appear satisfied.
- transition the non-authoritative workflow to `rejected` when immutable decisions make every required path unreachable.

This is a hint only.

**Done when:** Tests cover awaiting, ready, and unreachable states. Progress correctly excludes every Signer who has made a final decision from `pending`.

#### Task 1.6: Action Package assembly

Implement assembly of a completed Action Package from stored data:

- take original `executionPayload` and `actionEnvelope` from stored Action Package;
- build an updated `ApprovalBundle` containing the Proposer's original Approval (from the stored Action Package's bundle) plus all collected signer Approvals;
- set `approvalBundle.actionEnvelopeHash` from the workflow;
- set `approvalBundle.createdAt` to assembly time;
- wrap in a complete `ActionPackage` object.

Do not modify original Approval objects.

**Done when:** When state is `readyForSubmission`, the store can produce a completed Action Package whose Approval Bundle contains the Proposer's original Approval plus all collected Approvals, and whose payload/envelope match the originals.

#### Task 1.7: Cancel action

Implement cancellation:

- verify the requesting DID matches `actionPackage.actionEnvelope.proposer.did`;
- reject if action is already `readyForSubmission` (`409`);
- reject if action ref is unknown (`404`);
- transition to `cancelled`;
- set `cancelledAt`.

**Done when:** Tests cover successful cancel, cancel by non-proposer rejected, cancel of ready action rejected, cancel of unknown action returns 404.

#### Task 1.8: Poll logic

Implement the unified poll:

- accept a DID;
- find all actions in `awaitingApprovals` where the DID is in `eligibleSigners` → build `approvalRequests`;
- find all actions where the DID matches the proposer → build `actionUpdates` with progress and state;
- include completed `actionPackage` in updates where state is `readyForSubmission`;
- include `cancelledAt` in updates where state is `cancelled`;
- return both arrays (either may be empty).

**Done when:** Tests cover signer getting approval requests, proposer getting progress updates, proposer getting completed package, proposer seeing cancelled state, DID with no relevant actions getting empty arrays.

---

## 5. Phase 2: Fastify HTTP Endpoints

### 5.1 Tasks

#### Task 2.1: Coordination Fastify module

Create `src/coordination/http-endpoint.ts`:

```typescript
function createCoordinationHttpEndpoint(options?: {
  store?: CoordinationStore;
}): FastifyInstance;
```

Follow the pattern from `src/adapter/http-endpoint.ts`: create a Fastify instance, register routes, and return the app for tests and daemon use.

**Done when:** The endpoint module can be instantiated in tests without binding a TCP port.

#### Task 2.2: Health endpoint

Implement:

```http
GET /mpas/v1/coordination/health
```

Return status and basic in-memory counters:

- total actions;
- awaiting approvals;
- ready for submission.

**Done when:** Fastify `inject()` test returns `200` and expected counters.

#### Task 2.3: Create workflow endpoint

Implement:

```http
POST /mpas/v1/coordination/workflow
```

Behavior:

- temporarily register `/mpas/v1/coordination/action` as a deprecated alias of the same handler and idempotency scope;
- parse `CoordinationActionRequest` (validate `actionPackage` and `authorizationRequirements` are present);
- call `CoordinationStore.createWorkflow`;
- return `201 Created` for new workflows;
- return `200 OK` for idempotent re-submission;
- return `409 Conflict` for same action ID with different Action Envelope hash;
- return profile-style JSON errors for malformed requests.

**Done when:** Fastify `inject()` tests cover new submit, idempotent submit, conflict, and malformed request.

#### Task 2.4: Poll endpoint

Implement:

```http
POST /mpas/v1/coordination/poll
```

Behavior:

- parse `CoordinationPollRequest` (validate `did` is present);
- call `CoordinationStore.poll(did)`;
- return `approvalRequests` and `actionUpdates` arrays;
- both arrays may be empty.

**Done when:** Fastify `inject()` tests cover: signer receiving approval requests, proposer receiving progress, proposer receiving completed package, cancelled action in updates, unknown DID getting empty arrays.

#### Task 2.5: Approval submission endpoint

Implement:

```http
POST /mpas/v1/coordination/approval
```

Behavior:

- parse `CoordinationApprovalSubmission`;
- call `CoordinationStore.submitApproval`;
- return `{ "accepted": true }` on success;
- return `404` for unknown action ref or cancelled action;
- return `422` for hash mismatch.

**Done when:** Fastify `inject()` tests cover accepted approval, unknown action, cancelled action, and hash mismatch.

#### Task 2.6: Cancel action endpoint

Implement:

```http
POST /mpas/v1/coordination/action-cancel
```

Behavior:

- parse `CoordinationActionCancelRequest`;
- call `CoordinationStore.cancelAction`;
- return cancel response on success;
- return `404` for unknown action ref;
- return `403` if DID does not match proposer;
- return `409` if action is already `readyForSubmission`.

**Done when:** Fastify `inject()` tests cover successful cancel, non-proposer rejected, ready action rejected, unknown action.

#### Task 2.7: Boundary test: no adapter calls

Add a test that verifies the coordination endpoint has no dependency on adapter configs, credential provider, dispatch, or receipt builder.

This can be a structural import test or a behavioral test that runs all coordination endpoints without constructing adapter dependencies.

**Done when:** Coordination endpoint tests pass with only a `CoordinationStore` and Fastify `inject()`.

---

## 6. Phase 3: Daemon and CLI Integration

### 6.1 Tasks

#### Task 3.1: Coordination service entry point

Create `src/coordination/index.ts` as a standalone entry point that:

- instantiates the Fastify coordination HTTP endpoint;
- binds to the configured port (default `7545`);
- accepts `--port <port>` argument;
- logs the listening URL on startup;
- handles graceful shutdown on SIGINT/SIGTERM.

**Done when:** Running `npx tsx src/coordination/index.ts` starts the coordination service on port 7545 and responds to the health endpoint.

#### Task 3.2: CLI commands

Add CLI commands in `src/cli/index.ts`:

- `mpas coordination start` — starts the coordination service as a foreground process.
- `mpas daemon start` — starts both the adapter and coordination service as separate child processes, manages their lifecycle together (stop both on SIGINT).

**Done when:** `mpas coordination start` starts the coordination service independently. `mpas daemon start` starts both processes and shuts them both down cleanly.

#### Task 3.3: Integration test: full local approval collection

Create an integration test using Fastify `inject()` and existing fixtures:

1. Submit `insufficient-approvals.json` to adapter and receive `additionalApprovalsRequired` with Authorization Requirements.
2. Submit the original Action Package + Authorization Requirements to the coordination service via `POST /action`.
3. Poll as an eligible signer and receive an Approval Request with Signer Review Set.
4. Submit a valid maintainer Approval via `POST /approval`.
5. Poll as a second eligible signer and submit a second Approval.
6. Poll as proposer and see `readyForSubmission` with a completed Action Package.
7. Take the completed Action Package from the poll response and submit it directly to the adapter.
8. Verify the adapter returns an Execution Receipt.

The coordination service must not call the adapter in this flow; the test orchestrates both services as the proposer would.

**Done when:** Integration test proves the full approval collection and direct replacement-Action submission flow.

#### Task 3.4: Integration test: cancellation flow

Create an integration test:

1. Submit an action to coordination.
2. Submit one approval (not enough for threshold).
3. Cancel the action as the proposer.
4. Verify signer poll no longer returns the cancelled action.
5. Verify approval submission for the cancelled action returns `404`.
6. Verify proposer poll shows `cancelled` state with `cancelledAt`.

**Done when:** Integration test proves cancellation behavior.

#### Task 3.5: Documentation and README updates

Update `README.md` or daemon docs with:

- local coordination service purpose;
- default port `7545`;
- endpoint list (health, action, poll, approval, action-cancel);
- explicit statement that proposers submit to adapter directly;
- example local development flow.

**Done when:** Documentation reflects the implemented local coordination behavior.

---

## 7. Acceptance Criteria

- [ ] `npm run build` passes with zero TypeScript errors.
- [ ] `npm test` passes with zero failures.
- [ ] Coordination fixtures are generated and validate structurally.
- [ ] Store rejects same action ID with different Action Envelope hash using `409 Conflict`.
- [ ] Signer poll returns Approval Requests only for eligible signers on non-cancelled actions.
- [ ] Approval submissions are stored unmodified and do not double-count duplicates.
- [ ] State transitions from `awaitingApprovals` to `readyForSubmission` when threshold count appears satisfied.
- [ ] Proposer poll returns progress (approved/rejected/pending DIDs and counts).
- [ ] Proposer poll returns a completed Action Package when `readyForSubmission`.
- [ ] Completed Action Package contains original payload, envelope, and updated bundle with Proposer's original Approval + all collected Approvals.
- [ ] Proposer can cancel an action in `awaitingApprovals` state.
- [ ] Cancelled actions are not served to signers.
- [ ] Cancel returns `409` for actions already in `readyForSubmission`.
- [ ] Coordination service never calls the Credential Adapter or any Verifier.
- [ ] Coordination service runs as a separate process from the adapter.
- [ ] `mpas coordination start` starts the coordination service independently.
- [ ] `mpas daemon start` starts both adapter and coordination as separate processes and shuts them down together.

---

## 8. Implementation Notes

- Use Fastify `inject()` for HTTP endpoint tests; do not bind real ports in tests.
- Use existing fixtures in `tests/fixtures/core`, `tests/fixtures/test-keys`, and `tests/fixtures/configs`.
- Keep coordination logic separate under `src/coordination/`.
- Keep readiness evaluation intentionally simple and non-authoritative.
- Preserve stored MPAS artifacts exactly as received.
- Prefer small pure functions for Action Ref extraction, hash computation, threshold counting, progress computation, and Action Package assembly.
- The poll response should be efficient: do not re-assemble the Action Package on every poll. Cache the assembled package when the state transitions to `readyForSubmission`.
