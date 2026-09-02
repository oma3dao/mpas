# GitHub MCP Proposer Bridge — Asynchronous Client Flow

**Status:** Draft
**Created:** 2026-07-26
**Implementation scope:** OMA3 GitHub MCP Bridge Server and the OMA3 generator/runtime used to build it
**Companion:** [plan.md](./plan.md)
**Current normative interface:** [MPAS MCP Proposer Bridge Profile v0.2](../../../specs/mpas-profile-mcp-proposer-bridge-client.md)
**Related:** [MCP Execution Profile](../../../specs/mpas-profile-mcp.md), [HTTP Profile](../../../specs/mpas-profile-http.md), [MPAS Core](../../../specs/mpas-specification.md)

---

## 1. Purpose

This feature redesigns OMA3's GitHub MCP proposer bridge so approval-gated tool
calls do not keep the original MCP `tools/call` request open for the full
approval window.

The bridge returns control to the proposing MCP client when an action needs
additional approvals, continues the MPAS workflow independently of that client
request, and exposes one generic MCP operation for bounded result retrieval.

The implementation work spans the generated GitHub bridge, OMA3's shared bridge
runtime and generator, the demo, and the GitHub application tests in
`mpas-applications`.

This feature also introduces a separate normative client-facing contract for
MPAS MCP proposer bridges. That client-interface profile applies to any
conforming implementation. The storage, polling, process, recovery, and
deployment mechanisms in this feature document apply only to the OMA3 GitHub
bridge implementation and do not constrain third-party bridges.

This document records the feature rationale, reference architecture,
implementation decisions, repository boundaries, and acceptance history. The
companion profile defines only the black-box MCP contract visible to a
proposing client. Its requirements do not prescribe the implementation
mechanisms described here.

---

## 2. Problem

The generated proposer bridge currently performs the whole coordinated
approval workflow inside the handler for the original upstream tool call:

```text
MCP client
    |
    | tools/call
    v
Proposer bridge
    |
    | create and submit initial Action Package
    | receive additionalApprovalsRequired
    | submit to Coordination Service
    | poll for Approvals
    | retrieve completed Action Package
    | resubmit to Credential Adapter
    | wait for upstream execution
    v
Native MCP result
```

The default wait is currently several minutes. MCP hosts that serialize work
within a session cannot perform another action while that call remains active.
In particular, a proposing agent cannot reliably notify a maintainer after the
Action Package and Action ID exist.

The current generated bridge also has no bridge-owned durable workflow store.
The Action Package, polling deadline, and result correlation live in the
active process and call stack. If the bridge exits, it cannot autonomously
resume that workflow or serve the terminal result to a restarted client.

Multi-party approval is inherently asynchronous. Preserving upstream tool
names and argument schemas remains useful, but an approval-gated bridge cannot
promise identical temporal or output behavior to the upstream MCP server.

---

## 3. Goals

1. Return control promptly when the proposing client must participate in the
   approval workflow.
2. Preserve upstream tool names and input schemas.
3. Define a separate common, machine-readable deferred-result contract for
   conforming MPAS MCP proposer bridges.
4. Continue approval collection, completed-package submission, and result
   storage without another client request.
5. Add one generic bounded wait operation for terminal-result retrieval.
6. Make active workflows and terminal results recoverable across bridge
   process restarts.
7. Preserve at-most-once target dispatch while providing best-effort terminal
   result retrieval (Section 11).
8. Keep bridge workflow state distinct from the authoritative Verifier
   dispatch lifecycle.
9. Define black-box client-interface conformance tests that can run against any
   proposer bridge.
10. Retain application-specific compatibility and approval tests in
    `oma3/mpas-applications`.

---

## 4. Non-Goals

This feature does not:

- require other MCP proposer bridge implementations to use OMA3's storage,
  polling, process, or recovery mechanisms;
- make out-of-band messages into MPAS Approvals;
- require the proposing MCP client to assemble Approval Bundles or resubmit
  completed Action Packages;
- define the maintainer/signer MCP server interface;
- replace the generic MPAS HTTP Profile;
- define automatic Slack, email, A2A, or webhook notification delivery;
- depend on MCP Tasks;
- add a separate status tool for the initial version;
- require a particular database product;
- make the Coordination Service authoritative for authorization or dispatch;
- attest to native MCP response content beyond the guarantees already defined
  by the MCP Execution Profile and Execution Receipt.

---

## 5. Actors and Responsibilities

### 5.1 Proposing MCP client

The proposing MCP client invokes an application tool exposed by the bridge. It
understands that the call may produce either a native result or an MPAS bridge
result.

When the bridge reports that notification is required, the client may notify
maintainers through an out-of-band channel. It later calls the generic result
operation using the returned stable Task ID.

The client does not collect Approvals, assemble Approval Bundles, construct a
completed Action Package, or trigger final submission.

### 5.2 OMA3 GitHub proposer bridge

The OMA3 GitHub proposer bridge implements the MPAS Proposer role on behalf of
the MCP client. Its reference implementation:

- creates and signs the initial Action Package;
- durably queues it on that Task's outbound dispatcher lane;
- waits for the initial Credential Adapter response;
- submits approval-gated actions to the Coordination Service;
- returns the native result when the initial Action settles quickly, otherwise
  returns a durable deferred Task to the MCP client;
- monitors approval progress;
- retrieves the completed Action Package;
- submits it to the Credential Adapter immediately;
- stores the terminal response, native result, and Execution Receipt; and
- serves the stored result through its generic result operation.

### 5.3 Coordination Service

The Coordination Service stores and routes approval workflow artifacts,
receives signed Approvals, and assembles a completed Action Package. Its states
are non-authoritative workflow observations.

### 5.4 Credential Adapter / Verifier

The Credential Adapter verifies the Action Package, evaluates policy, owns the
protected credential, enforces at-most-once dispatch, calls the upstream MCP
server, and returns the authoritative MPAS `ActionResponse`.

### 5.5 Maintainer / signer

A maintainer reviews the Signer Review Set and relevant context, then produces
a signed MPAS Approval. Conversation with the proposing client provides
context only and is never authorization.

---

## 6. Target Workflow

The workflow runs on two independent tracks. The bridge track advances on its
own; the client track is asynchronous relative to it and may be empty.

**Bridge track** — proceeds without any further client request:

```text
1. Client calls an upstream-named tool on the proposer bridge.
2. Bridge creates and durably records the stable Task, initial Action Package,
   and queued submission.
3. The request handler enqueues that Task's outbound dispatcher lane and waits
   for its initial result. The lane submits A1 for this Task; neither the
   request handler nor the Coordination poller submits Actions. Distinct Tasks
   keep independent lanes and may submit concurrently.

   If the adapter answers immediately with a native terminal result, the
   bridge stores it and returns the normal native MCP result. If processing is
   deferred, the bridge returns the stable Task to the client.

4. Adapter returns additionalApprovalsRequired:
     Bridge submits the action and requirements to Coordination Service.
     Bridge durably records awaitingApprovals.
5. A bridge-owned Coordination poller continues polling or reconciliation.
6. Maintainers submit signed Approvals.
7. Coordination Service exposes the completed Action Package.
8. The poller durably queues the completed package on that Task's outbound
   dispatcher lane, which submits it to the adapter.
9. Adapter verifies, dispatches, and returns the terminal ActionResponse.
10. Bridge durably stores the complete terminal result.
```

**Client track** — at any time after receiving the deferred result, in any
session, as often as it likes, or never:

```text
a. Client notifies maintainers if notificationRequired is true (meaningful
   only once a Verifier response is present).
b. Tasks clients observe with tasks/get using the stable Task ID.
   Compatibility clients call mpas_wait_for_action_result with the current
   Action ID.
c. Bridge returns the stored terminal result if one exists, otherwise an
   updated deferred result when the wait elapses.
d. Client repeats (b) as needed.
```

The result operation is an observation mechanism. Calling it, timing out, or
disconnecting MUST NOT advance, cancel, or otherwise alter the workflow. A
client that never calls it does not stall the bridge track.

---

## 7. Client-Facing Compatibility Boundary

An MPAS proposer bridge is **tool-input compatible**, not fully transparent.

For each upstream tool, the bridge preserves:

- the exact tool name;
- the exact input schema;
- the semantic meaning of its arguments; and
- the native result when one is available before the bridge returns.

The bridge may differ from the upstream server by:

- adding a standard MPAS notice to tool descriptions;
- adding the reserved `mpas_wait_for_action_result` tool;
- advertising an output schema that also permits the MPAS deferred result;
- returning a deferred MPAS result instead of a native result;
- returning a structured MPAS terminal result when no native result exists;
- requiring the client to retrieve an asynchronously produced result later.

Compatibility harnesses must therefore stop asserting byte-identical tool
definitions. They should continue to require exact upstream names and input
schemas while allowing the profile-defined description and output-schema
differences.

---

## 8. Bridge Workflow State

Bridge state is a local, non-authoritative workflow view. To prevent accidental
conflation with Verifier lifecycle states, the bridge uses the following
phases:

| Bridge state | Meaning |
| :--- | :--- |
| `created` | Initial package exists and has been durably recorded. |
| `submittingToCoordination` | The bridge has replaced the previous Action and is creating the replacement Action's coordination workflow. |
| `awaitingApprovals` | Coordination workflow exists and more signed Approvals are needed. |
| `readyForSubmission` | Coordination Service has supplied a completed replacement Action Package; that Action has not yet been submitted to the Verifier. |
| `submittingToVerifier` | Bridge is submitting or recovering submission of the completed package. |
| `awaitingVerifierResult` | Verifier accepted dispatch but no terminal response is yet recoverable. |
| `resolved` | Bridge has durably stored a terminal `ActionResponse`. |
| `unresolvable` | Bridge can no longer obtain a terminal `ActionResponse` — for example, the Action Envelope expired without one. |

The terminal MPAS outcome remains `actionResponse.result`. The bridge does not
reuse `executed`, `failed`, `pending`, or `indeterminate` as bridge phases.

In particular:

- `awaitingApprovals` is not MPAS HTTP `pending`;
- `readyForSubmission` is not authorization;
- `awaitingVerifierResult` corresponds to observing Verifier work and does not
  permit another dispatch; and
- a result-wait timeout is not a workflow state or terminal outcome.

Only `resolved` produces `MpasBridgeActionOutcome`. An `unresolvable` record
produces `MpasBridgeError` — under the client profile a bridge error is a
per-request failure, not an Action outcome, so the bridge never presents its
own inability to obtain a response as the Action's result.

---

## 9. Durability Model

### 9.1 Minimum conformance level

The minimum target for the OMA3 GitHub bridge is crash-durable, single-node
workflow persistence. High availability and replicated storage are deployment
options for that implementation.

The normative client profile specifies only the observable cross-request
guarantee. SQLite, an append-only journal, a remote transactional database, or
another mechanism may satisfy it.

The OMA3 implementation uses SQLite (plan.md §5.3). The store contract needs
atomic state transitions, exclusive worker claims, and per-record deletion for
retention; SQLite provides transactions, cross-process WAL concurrency for the
worker-plus-frontend deployments in §9.5, and `DELETE` without a compaction
step. An append-only journal would require building compaction, indexing, and
torn-write detection to reach the same place.

### 9.2 Commit points

The bridge must durably record:

1. the initial workflow and stable Task ID before the first Action submission;
2. every replacement Action and its Coordination Service reference before returning a deferred result;
3. the completed Action Package before attempting final submission;
4. every transition that changes recovery behavior; and
5. the complete terminal result before reporting the action as resolved.

If the bridge cannot commit the deferred workflow record, it must not return a
deferred result that promises later retrieval.

### 9.3 Required stored material

At minimum, an active workflow contains:

```text
stable Task ID
current actionId
current actionEnvelopeHash
original tool name
Execution Payload or initial Action Package
Authorization Requirements
Coordination Service ActionRef
Action Envelope expiration
bridge state
completed Action Package, when available
adapter submission and recovery metadata
created and updated timestamps
last sanitized diagnostic
```

A resolved workflow additionally contains:

```text
terminal ActionResponse
native MCP executionResult, when present
Execution Receipt, when present
resolution timestamp
```

An unresolvable workflow instead records why no terminal `ActionResponse` is
obtainable, as sanitized material for the client-facing `MpasBridgeError`.

### 9.4 Restart recovery

On startup, the bridge reconciles all unresolved records:

- `created`: determine whether initial submission must be retried or recovered;
- `submittingToCoordination`: retry creation of the current replacement Action's workflow;
- `awaitingApprovals`: resume Coordination Service polling;
- `readyForSubmission`: submit the stored completed replacement Action Package;
- `submittingToVerifier`: recover or repeat the identical submission safely;
- `awaitingVerifierResult`: attempt to obtain the terminal response without
  redispatch; if none is obtainable, mark the workflow `unresolvable`
  (Section 11);
- `resolved` and `unresolvable`: serve the stored record without additional
  network activity.

Recovery must be idempotent. Multiple workers must not independently advance
the same workflow without a lease, compare-and-swap transition, transactional
claim, or equivalent exclusion mechanism.

Within a bridge process, each Task has a serialized outbound dispatcher lane
that owns that Task's initial, replacement, Coordination, and completed Action
submissions. Distinct Task IDs run concurrently; one Task's A1, replacement,
handoff, completed submission, and retries stay ordered. Request handlers and
Coordination polling enqueue that Task's lane after durable state is committed.
Expiry sweeps and Coordination state updates enqueue that same lane; they MUST
NOT mark a Task terminal while that Task's outbound submit is in flight. A
periodic scan is a recovery mechanism for lost wakeups, not a second
submission path.

The periodic worker MUST inspect durable local workflow state before making a
remote Coordination poll. It polls Coordination only while at least one local
workflow is awaiting Approvals; expiry and outbound recovery scans continue
locally even when the remote poll is skipped.

The worker claim lease MUST outlive every claimed outbound wait. That wait is
the Action endpoint client timeout, or the Coordination client timeout when a
Coordination submit is claimed. The HTTP profile does not fix relay wait
duration; a deployment that lengthens the relay wait and matching client
timeout MUST lengthen the claim lease so it still expires only after that
submit returns. An expired lease during an in-flight submit lets another
bridge process claim the same workflow and write local resolution state. The
Verifier dispatch ledger still prevents duplicate target execution.

### 9.5 Availability

Durability does not make a stopped process available. A stdio bridge that
shares the MCP host's lifecycle can resume after restart but cannot monitor
approvals while both processes are down.

The OMA3 GitHub deployment must run its workflow engine independently of the
client session to provide continued progress during client-session outages.
Candidate implementations include:

- a long-lived bridge daemon exposed over Streamable HTTP;
- a persistent worker plus a thin stdio MCP frontend; or
- another durable proposer service that implements the same profile.

The implementation plan must select and document the GitHub bridge deployment
model. The client-interface profile remains independent of that choice.

### 9.6 Retention

Active records are retained until they resolve or can no longer advance.
Terminal client-facing results are retained until at least:

```text
max(actionEnvelope.expiresAt, resolvedAt + 24 hours)
```

Deployments may configure a longer period. The bridge must document its
retention policy and return a stable result-unavailable error after a record is
removed. Audit retention may be longer than client-result retention.

Stored arguments and native results may be sensitive. Implementations must
apply restrictive filesystem or database permissions, redact diagnostics, and
support appropriate encryption-at-rest controls for their deployment.

---

## 10. Returning Control

The bridge waits for the initial Action submission's result before returning
from the application tool call. If that attempt settles with a native terminal
result, the bridge returns the normal native MCP result. If processing is
deferred — additional Approvals, pending, an unreachable adapter, or another
non-terminal outcome — it returns a durable Task (or a compatibility deferred
result). It does not hold the application tool call open hoping that Approvals
arrive quickly.

An earlier draft of this feature defined a configurable synchronous window
(default 5 seconds) for that purpose. It was removed. The client already has
a bounded observation call (`tasks/get` or `mpas_wait_for_action_result`)
with a caller-chosen timeout, and the client is the only party that knows
whether it can afford to block. A bridge-side window duplicates that choice,
makes it for the client, and conflicts with the profile's requirement to
return promptly.

The bridge still awaits the adapter's response to the *initial* submission
where that response is immediate — a single HTTP round trip is not an approval
window. When the adapter answers with a native terminal result before the
bridge has returned, the bridge relays it directly.

The explicit observation call may block for its caller-chosen bounded timeout
because the client invoked that operation specifically to wait.

---

## 11. Dispatch Idempotency and Result Recovery

The asynchronous workflow involves two guarantees with very different stakes:

- **target dispatch is at most once** — a hard invariant, owned by the
  Verifier's dispatch ledger (Core Section 6.9), unchanged by this feature;
  and
- **terminal result retrieval is best effort** — the bridge stores and serves
  the terminal response when it obtains one, but does not guarantee recovery
  in every crash window.

Best effort applies to result recovery only. Dispatch remains at-most-once
per the Core ledger regardless of what the bridge does.

The unrecoverable crash window is:

```text
bridge submits completed Action Package
adapter dispatches and creates terminal response
bridge loses connection or crashes before storing response
```

On restart the bridge resubmits the identical package. The Core rule rejects
any submission against a `resolved` ledger entry, so the bridge cannot learn
the outcome. It marks the workflow `unresolvable` and the client receives
`MpasBridgeError`.

That is the intended resolution, not a defect. The client profile already
requires a proposing client to check application state before proposing a new
Action after an unconfirmed outcome (profile Section 9). A proposing agent
that cannot retrieve the stored result asks the application directly — did
the pull request merge? — and decides. At-most-once dispatch guarantees the
worst case is a missing answer, never a duplicate execution.

This feature therefore requires **no Core or HTTP Profile changes for
recovery**. Two mechanisms remain future options, to be adopted only if usage
shows agent-side reconciliation is insufficient (for example, `unresolvable`
records proving common in practice):

- a read-only terminal-result endpoint on the Verifier; or
- identical resolved replay, in which an identical resubmission after
  resolution returns the stored terminal response. This is the more invasive
  option: it amends the resolved-rejection rule everywhere Core states it and
  makes the `(actionId, actionEnvelopeHash)` comparison the sole guard
  between returning stored results and rejecting.

---

## 12. Notification and Context

`notificationRequired` tells the proposing client whether the deployment
expects it to notify maintainers after the action exists.

The boolean does not state that notification occurred and does not identify an
Approval. Messages sent through Slack, email, A2A, issue comments, or verbal
channels are non-authoritative context.

Once the Verifier has reported `additionalApprovalsRequired`, the safe default
is `true`. A bridge returns `false` only when deployment configuration assigns
notification elsewhere or explicitly says no client notification is required.

The flag is meaningful only alongside a Verifier response. If the initial
attempt did not produce a Verifier `ActionResponse` (`lastActionResponse` is
absent), there is no verdict to notify about and the client ignores the flag.
That includes an unreachable adapter after the initial attempt completes. The
GitHub bridge returns `false` in that case, and the client learns that
Approvals are needed from a later deferred result.

Maintainers may use those channels to ask why an action was proposed or whether
it is still desired. They must still issue a signed MPAS Approval bound to the
Action Envelope hash.

Automatic notifications remain future work. A future notifier may change
`notificationRequired` to `false`, but it does not change the Action Package or
Verifier policy.

### 12.1 Temporary migration stopgap

Until a deployed bridge implements the deferred-result profile, a proposing
client should notify maintainers immediately before invoking an
approval-gated application tool:

1. state that an MPAS-protected action is about to be submitted;
2. ask the maintainer to watch the approval queue;
3. invoke the tool immediately afterward; and
4. avoid claiming that an Action ID already exists.

Suggested message:

> I am about to submit a new MPAS-protected action. Please watch the approval
> queue for the new signing request and contact me if you need additional
> context.

This stopgap does not solve the blocking-call architecture and must be removed
after the client can receive a durable deferred Action reference.

---

## 13. Specification Changes

### 13.1 New normative profile

This feature originally introduced version 1 of the profile now maintained at
`specs/mpas-profile-mcp-proposer-bridge-client.md`, defining:

- upstream-compatible tool exposure;
- reserved bridge operation names;
- deferred, wait, terminal, and error result schemas;
- proposing-client responsibilities;
- cross-request and cross-session guarantees;
- result retention disclosure;
- client-visible status terminology;
- security;
- black-box MCP conformance requirements.

Storage, polling, worker topology, adapter submission, and crash-recovery
mechanisms remain implementation details in this feature record and plan. They
are not part of the normative client-interface profile.

### 13.2 MCP Execution Profile

Clarify that it defines the signed `mcp.toolsCall` execution binding and
Verifier dispatch behavior, not the client-facing proposer-bridge MCP API.

Remove or qualify claims that a bridge is an end-to-end transparent drop-in
replacement. Preserve the requirement that the adapter carry the upstream MCP
result verbatim when one exists.

### 13.3 HTTP Profile

Clarify the lower-layer distinction among:

- `additionalApprovalsRequired`;
- Coordination Service `awaitingApprovals`;
- Verifier `pending`.

No terminal-result recovery operation is added in this feature; result
recovery is best effort (Section 11). The HTTP Profile remains unaware of the
GitHub bridge and the MCP client-interface profile.

### 13.4 MPAS Core

No changes. The resolved-rejection rule and the at-most-once dispatch
invariant stand as written. The future recovery options in Section 11 would
require Core amendments if ever adopted.

Core remains unaware of MCP clients, MCP tool names, bridge wait operations,
and notification behavior.

### 13.5 Historical feature documents

Earlier feature documents remain unchanged historical records. Their Created
and Implemented dates establish chronology. This feature document records the
later design without adding supersession notes or revised requirements to the
earlier feature folders.

---

## 14. Repository Boundaries

### `oma3/mpas`

Owns for this feature:

- this feature specification and plan;
- the normative proposer-bridge client-interface profile;
- Core, HTTP, and MCP profile amendments;
- the SDK workflow-store abstractions and OMA3 shared bridge runtime used by
  the GitHub implementation;
- bridge-generator changes needed to emit the OMA3 implementation;
- reference/demo implementation;
- implementation-independent bridge conformance tests.

### `oma3/mpas-applications`

Owns:

- the regenerated GitHub application bridge;
- deployable storage and process configuration;
- compatibility harness changes;
- application-level approval workflow tests;
- upgrade notes for concrete bridges.

The GitHub application implementation links to the normative client profile
and this feature. It does not duplicate their normative text.

---

## 15. Known Limitation: Lost Initial Client Response

There is a separate ambiguity if the bridge durably creates a Task and Action
but the MCP connection fails before the client receives either the native
result or the deferred Task ID. Retrying the upstream-named tool may express a
second legitimate intent, so the bridge cannot safely deduplicate solely by
payload hash and time.

The initial version:

- preserves the action for operator and bridge recovery;
- prohibits clients from blindly retrying an indeterminate original call; and
- does not add a recent-actions listing tool.

A future feature may define a client-supplied idempotency key in MCP `_meta`, a
recent-action recovery operation, or an MCP Tasks mapping. This limitation does
not weaken at-most-once dispatch for any individual Action ID.

---

## 16. Acceptance Criteria

- [ ] GitHub upstream-named calls do not block for the approval window.
- [ ] The request handler durably records A1, enqueues that Task's outbound
      dispatcher lane, and never submits an Action itself.
- [ ] Distinct Tasks may submit concurrently; one Task's submissions remain
      serialized.
- [ ] The worker claim lease exceeds the Action and Coordination client
      timeouts so a submit cannot outlive cross-process ownership.
- [ ] A terminal initial response returns the normal native MCP result without
      exposing a Task.
- [ ] Approval-required, pending, or failed initial processing returns a
      durable deferred Task after the initial attempt completes.
- [ ] A durable deferred Task exposes its stable Task ID and current Action ID
      and envelope hash as distinct values.
- [ ] The result states whether client notification is required.
- [ ] The bridge continues without a result-wait request.
- [ ] Approval arrival triggers completed-package submission promptly.
- [ ] `mpas_wait_for_action_result` supports bounded waits and a nonblocking check.
- [ ] The wait tool is callable at any time, from any session, and never
      required for the workflow to advance.
- [ ] Wait timeout does not change workflow state.
- [ ] Active GitHub workflows survive bridge process restart.
- [ ] Terminal results and receipts survive bridge and client restart.
- [ ] Repeated resolved waits return the same stored terminal material.
- [ ] Identical final resubmission cannot cause duplicate target dispatch.
- [ ] A lost terminal adapter response resolves to `unresolvable`, and the
      client is directed to reconcile against the application.
- [ ] Bridge phases are not represented as Verifier lifecycle states.
- [ ] `awaitingApprovals` is never represented as HTTP `pending`.
- [ ] An unresolvable workflow produces `MpasBridgeError`, not an Action outcome.
- [ ] Upstream tool names and input schemas remain unchanged.
- [ ] Profile-defined tool description and output-schema differences are advertised.
- [ ] The new client-interface profile has implementation-independent black-box tests.
- [ ] The GitHub bridge runs compatibility and approval tests in `mpas-applications`.
- [ ] Historical drop-in claims are marked as superseded where appropriate.
- [ ] The temporary notify-before-submit guidance remains documented until rollout completes.
