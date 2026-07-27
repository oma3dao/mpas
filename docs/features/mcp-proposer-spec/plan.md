# GitHub MCP Proposer Bridge — Asynchronous Client Flow Implementation Plan

**Status:** Draft
**Created:** 2026-07-26
**Implementation scope:** OMA3 GitHub MCP Bridge Server and the OMA3 generator/runtime used to build it
**Feature specification:** [spec.md](./spec.md)
**Normative interface:** [MPAS MCP Proposer Bridge Client Interface Profile v0.1](../../../specs/mpas-profile-mcp-proposer-bridge-client.md)

---

## 1. Purpose

This plan sequences the specification, runtime, generator, GitHub bridge,
application rollout, and test work for OMA3's asynchronous GitHub MCP proposer
bridge.

The feature specification records the OMA3 GitHub implementation design. The
normative profile defines only what every conforming proposer bridge exposes to
an MCP client. This plan records implementation mechanisms for the OMA3 GitHub
bridge, what must change in each repository, and how the work will be verified.
Other conforming bridges may use different internal mechanisms.

---

## 2. Delivery Order

| Phase | Deliverable | Repository | Status |
| :--- | :--- | :--- | :--- |
| 0 | Feature specification and initial proposer-bridge profile | `mpas` | In progress |
| 1 | Core, HTTP, and MCP profile deltas | `mpas` | Not started |
| 2 | Durable workflow store and recovery engine | `mpas` | Not started |
| 3 | Client-facing bridge tools and response schemas | `mpas` | Not started |
| 4 | Generator and demo bridge integration | `mpas` | Not started |
| 5 | Client-interface conformance tests | `mpas` | Not started |
| 6 | GitHub application bridge rollout and application harness updates | `mpas-applications` | Not started |
| 7 | Migration, deployment, and temporary-stopgap documentation | Both | Not started |

Phase 1 defines bridge-independent lower-layer behavior where required. Phases
2–4 implement OMA3's chosen mechanism and prove the generator can emit it.
Phase 5 tests the implementation-neutral client interface. Phase 6 validates
the GitHub bridge against its real upstream contract. Phase 7 removes the
temporary notify-before-submit guidance only after the deployed GitHub bridge
is verified.

---

## 3. Phase 0 — Documentation

### Deliverables

- `docs/features/mcp-proposer-spec/spec.md`
- `docs/features/mcp-proposer-spec/plan.md`
- `specs/mpas-profile-mcp-proposer-bridge-client.md`

### Review decisions

- Confirm the profile name and reserved tool name.
- Confirm that the bridge returns as soon as the workflow record is durable,
  with no synchronous approval window.
- Confirm the minimum terminal retention rule.
- Decided: result recovery is best effort; no Core or HTTP recovery mechanism
  in this feature. A read-only result endpoint or identical resolved replay
  remains a future option (feature spec Section 11).
- Confirm that signer-server behavior remains outside this profile.
- Confirm that the lost-initial-response limitation is deferred.

### Exit criteria

- Feature-internal states are explicitly mapped to the client profile's coarse
  statuses without making the internal states normative.
- Every feature acceptance criterion maps to a client-interface requirement,
  an OMA3 GitHub implementation requirement, or an explicitly identified
  future/deployment concern.
- No bridge workflow state is described as Verifier `pending`.

---

## 4. Phase 1 — Normative Profile Deltas

Result recovery is best effort (feature spec Section 11), so this phase makes
no dispatch-semantics changes. It is clarification editing only.

### MPAS Core

No changes. The resolved-rejection rule and at-most-once dispatch invariant
stand as written.

### HTTP Profile

- Clarify the distinctions among `additionalApprovalsRequired`,
  Coordination Service `awaitingApprovals`, and Verifier `pending`.
- Clarify that `executionResult` is verbatim native result material whose
  upper-layer delivery is outside the HTTP Profile.

### MCP Execution Profile

- State generically that client-facing bridge and application interfaces are
  outside its scope.
- Remove end-to-end temporal or client-interface claims.
- Preserve native tool dispatch and result mapping requirements.

### Historical documents

Do not modify earlier feature specifications or plans. Their Created and
Implemented dates establish chronology; this feature records the later design.

### Tests

Existing Core behavior is relied on, not changed, so Phase 1 adds
verification rather than new semantics:

- same-ID/same-hash executing resubmission returns `pending` without
  dispatch;
- same-ID resubmission against a resolved entry is rejected, for both same
  and different hashes;
- the rejection carries no terminal result material.

Bridge-side handling of these responses (`unresolvable`, client
reconciliation) is Phase 2 work.

---

## 5. Phase 2 — Durable Workflow Runtime

### 5.1 Shared runtime

Implement the GitHub bridge's asynchronous workflow engine as OMA3 shared
runtime code so OMA3-generated bridges may reuse it. Reuse by the generator is
an OMA3 implementation choice, not a client-profile requirement.

Responsibilities:

- create and persist workflow records;
- submit initial Action Packages;
- create Coordination Service workflows;
- claim background work;
- poll with bounded backoff;
- persist completed packages;
- submit or recover adapter requests;
- store terminal results;
- notify local waiters;
- reconcile unfinished records at startup;
- expire and retain records according to policy.

For the GitHub bridge, the generator emits the application-specific tool
definitions and configuration around this runtime.

### 5.2 Store abstraction

Define an internal store contract with operations equivalent to:

```text
createWorkflow
getWorkflow
claimWorkflow
compareAndSetState
saveCoordinationReference
saveCompletedPackage
saveAdapterAttempt
resolveWorkflow
listRecoverableWorkflows
purgeExpiredResults
```

The contract must support atomic state transitions and exclusive worker claims.

### 5.3 Reference store

Use SQLite for the OMA3 GitHub implementation:

- one configured database path per bridge deployment;
- transactional workflow transitions;
- write-ahead logging where supported;
- restrictive file permissions;
- schema versioning and migrations;
- no credentials or adapter secrets stored;
- stored diagnostics sanitized before persistence.

The normative client profile does not require SQLite or another persistence
mechanism.

### 5.4 Process model

Select and document one GitHub bridge deployment:

1. preferred: long-lived bridge runtime with Streamable HTTP MCP transport;
2. acceptable: persistent worker plus thin stdio frontend;
3. compatibility-only: stdio process that resumes when the MCP host restarts.

Only the first two continue advancing actions while the client host is down.

### Tests

- kill during every persisted state and restart;
- simultaneous workers contend for the same workflow;
- Coordination Service unavailable and later restored;
- adapter unavailable before dispatch and later restored;
- action expires while awaiting approvals;
- result retention and purge;
- corrupt or incompatible store schema fails safely.

---

## 6. Phase 3 — MCP Client Interface

### Tool surface

- Preserve upstream tool names and input schemas.
- Add `mpas_wait_for_action_result`.
- Fail generation or startup on a reserved-name collision.
- Add the standard MPAS behavior notice to upstream tool descriptions.
- Compose or relax upstream output schemas as required by the normative
  deferred-result contract.

### Original tool calls

Implement:

- verbatim native result for synchronous native success;
- verbatim native result for a definitive upstream `isError: true` result;
- `MpasBridgeDeferredResult` after durable coordination;
- `MpasBridgeTerminalResult` for MPAS terminal outcomes with no native result;
- `MpasBridgeErrorResult` for bridge failures.

### Result operation

Implement:

- immediate return for a stored terminal result;
- bounded wait for an unresolved action;
- nonblocking check;
- nonterminal timeout response with current bridge state;
- stable not-found/result-unavailable behavior;
- multiple concurrent waiters;
- no workflow mutation caused by timeout or disconnection.

### Tests

- approval arrives before the first wait;
- approval arrives during a wait;
- wait times out before approval;
- nonblocking wait;
- client disconnects during wait;
- multiple waiters receive the same terminal result;
- repeated waits return identical terminal material;
- unauthorized cross-client result access is rejected.

---

## 7. Phase 4 — Generator and Demo Integration

### Bridge generator

- Emit imports and configuration for the shared asynchronous runtime.
- Emit the reserved result tool.
- Preserve exact upstream input schemas.
- Apply the profile-defined description suffix.
- Emit compatible output schemas.
- Add durable-store configuration.
- Remove the five-minute synchronous wait default.
- Generate migration guidance in bridge `README.md`.

### Demo bridge

- Regenerate or update the checked-in demo bridge.
- Run the bridge using the process model selected for the OMA3 GitHub
  implementation.
- Update setup instructions.
- Update proposer-agent instructions to recognize deferred results and call the
  result tool.
- Keep the temporary notify-before-submit instruction until end-to-end
  verification passes.

### Generator tests

- golden output contains the result tool and runtime wiring;
- reserved-name collision fails clearly;
- unchanged upstream generation remains deterministic;
- input schemas remain exact;
- output-schema transformation is deterministic;
- generated code compiles.

---

## 8. Phase 5 — Client-Interface Conformance Tests

Create an implementation-independent proposer-bridge client-interface
conformance role under `conformance/`.

The harness interacts with the bridge under test only through MCP. A test
deployment may provide controlled application outcomes, but the harness does
not inspect or require its downstream services or internal mechanisms.

Required scenarios:

1. immediate native success;
2. immediate native tool failure;
3. additional approvals and prompt deferred return;
4. client notification required;
5. client notification not required;
6. approval before result wait;
7. approval during result wait;
8. wait timeout without cancellation;
9. nonblocking result check;
10. repeated and concurrent result requests;
11. action expiration or result unavailability;
12. bridge-local client-facing error;
13. client-status and `pending` non-conflation;
14. retention disclosure and stable terminal result;
15. retrieval from a later authorized MCP session;
16. cross-client isolation.

The conformance harness does not depend on GitHub or another real application.
Bridge-process restart, worker concurrency, adapter resubmission, and
crash-window tests remain OMA3 GitHub implementation tests in Phases 1 and 2.

---

## 9. Phase 6 — `mpas-applications` Rollout

### GitHub bridge

- Regenerate or update `applications/github/bridge`.
- Configure durable storage.
- Configure the reference process model.
- Update bridge package and operational README.
- Update the application changelog.

### Compatibility harness

Continue checking:

- upstream tool names;
- exact input schemas;
- tool presence;
- governed operation presence.

Allow only profile-defined differences:

- reserved MPAS tools;
- standard description suffix;
- output-schema union or relaxation;
- declared MCP annotations associated with MPAS workflow behavior.

### Approval harness

Add:

- prompt deferred response assertions;
- background resubmission with no result call;
- stored result retrieval;
- process restart cases;
- lost adapter response recovery;
- native result equivalence after deferred execution.

---

## 10. Phase 7 — Migration and Operations

Document:

- clients must understand MPAS bridge result types;
- the bridge is no longer a fully transparent drop-in replacement;
- database path, permissions, backup, retention, and migration;
- process supervision and restart behavior;
- synchronous-window configuration;
- notification responsibility;
- result retrieval examples;
- recovery diagnostics;
- upgrade path for existing generated bridges.

Remove the temporary notify-before-submit guidance only when the deployed bridge
can return a durable Action ID and the proposing client is configured to react
to it.

---

## 11. Traceability Matrix

| Feature acceptance criterion | Normative profile area | Implementation area | Primary test layer |
| :--- | :--- | :--- | :--- |
| Prompt deferred return | Client Profile §§4–5 | bridge request handler | client-interface conformance |
| Action ID and envelope hash | Client Profile §5 | result serializer | client-interface conformance |
| Client notification signal | Client Profile §5 | bridge configuration | client-interface + application |
| Action progresses without result call | Client Profile §7 | background worker | black-box client-interface test |
| Durable restart recovery | Feature Spec §9 | workflow store | reference implementation |
| Immediate completed-package submission | Feature Spec §6 | workflow engine | reference implementation |
| Generic bounded wait | Client Profile §6 | MCP result tool | client-interface conformance |
| Timeout does not cancel | Client Profile §6 | waiter implementation | client-interface conformance |
| Stable terminal result | Client Profile §7 | result store | client-interface conformance |
| Duplicate dispatch prevention | MPAS Core | adapter ledger | protocol conformance |
| Lost-response recovery | Feature Spec §11 + HTTP | adapter response cache | protocol + reference implementation |
| Tool-input compatibility | Client Profile §3 | generator | application compatibility |
| Client-status separation | Client Profile §§2, 8 | result serializer | client-interface conformance |
| GitHub native-result equivalence | Client Profile §4 | generated GitHub bridge | application approval harness |

Section numbers refer to the initial proposer-bridge client-interface profile
and should be updated if that document is reorganized.

---

## 12. Completion Definition

The feature is complete when:

- the normative profile and dependent Core/HTTP/MCP amendments are merged;
- the reusable runtime passes restart and crash-window tests;
- the generator emits the conforming GitHub bridge;
- client-interface conformance tests pass against the demo and GitHub bridges;
- the GitHub application compatibility and approval harnesses pass;
- migration and deployment documentation is complete; and
- the temporary notify-before-submit stopgap has been removed from active
  proposer instructions.
