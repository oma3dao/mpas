# MPAS MCP Proposer Bridge Profile

**Status:** Draft v0.3

**Profile version:** `3`

**MCP profile-extension identifier:** `org.oma3/mpas`

**MCP protocol version:** `2026-07-28`

**Depends on:** [MPAS Core Specification v0.3](./mpas-specification.md), [MPAS HTTP Profile](./mpas-profile-http.md), [MPAS MCP Execution Profile](./mpas-profile-mcp.md), and the official MCP extension `io.modelcontextprotocol/tasks`

**Feature records:** [Official MCP Tasks integration](../docs/features/mcp-tasks/spec.md), [temporary conventional-client compatibility](../docs/features/mcp-client-compatibility/spec.md), [reduced proposer-bridge polling](../docs/features/reduce-polling/spec.md)

---

## 1. Purpose and Scope

This profile primarily defines what a Tasks-capable proposing MCP client can expect when it connects
to and calls an MPAS MCP proposer bridge. It defines the client-facing MCP
contract: bridge identity, tool exposure, asynchronous Action lifecycle,
result retrieval, task visibility, and the MPAS authorization metadata carried
with official MCP Tasks.

The MPAS MCP Execution Profile separately defines how an MCP `tools/call`
operation is represented as an MPAS Execution Payload and how its native result
is classified. MPAS Core and the HTTP Profile separately define MPAS artifacts,
Verifier results, and service-to-service interfaces. This profile does not
restate those lower-layer contracts or prescribe bridge storage and process
topology beyond the client-visible guarantees defined here.

Profile version 3 supports transparent disclosure only. It does not define
opaque authorization metadata, approval-count progress, task subscriptions,
or a multi-tenant bridge service.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in RFC 2119.

### 1.1 Profile extension namespace

This profile uses the MCP Extensions Framework to advertise the
`org.oma3/mpas` profile-extension capability and to carry namespaced MPAS Task
metadata. The capability is part of this proposer-bridge profile; it is not a
separate MPAS extension specification. The official
`io.modelcontextprotocol/tasks` extension supplies the asynchronous Task
lifecycle on which this profile depends.

The `version` member of `org.oma3/mpas` identifies the version of this MPAS
proposer-bridge profile. It does not version the official
`io.modelcontextprotocol/tasks` extension, whose capability value remains `{}`.

### 1.2 Signer terminology

This profile uses the MPAS Core definition of **Signer**: any entity that signs
an Action Envelope. Within this profile, a Signer may act in either or both of
these roles:

- A **Proposer** initiates a specific Action and produces its initial
  `propose` Approval.
- A **Maintainer** reviews Actions proposed by others and may produce an
  additional Approval when eligible under policy.

Maintainer is not a synonym for Signer; it is one role a Signer may perform. A
participant may be a Proposer for one Action and a Maintainer for another. The
[MPAS JSON Verifier Policy Profile](./mpas-profile-policy-json.md) reserves the
`proposers` and `maintainers` signer-group names for these roles. Eligibility
and Approval-counting rules come from the applicable Verifier policy.

## 2. Bridge Identity and Client Cardinality

An MPAS proposer bridge is a dedicated MCP server for exactly one proposing
client or agent identity.

1. A bridge MUST hold exactly one proposer private key and MUST have exactly
   one configured proposer DID derived from that key.
2. The private key is the bridge's MPAS identity. The bridge MUST NOT select a
   proposer key from request parameters or accept a caller-supplied proposer
   DID as an identity override.
3. A bridge MUST be assigned to one proposing MCP client or agent. It MUST NOT
   multiplex independent clients, tenants, or agent identities through the
   same key or workflow store.
4. Reconnection by the same assigned client does not create a new identity;
   Tasks remain scoped to the configured proposer DID and retention rules.
5. Deployments serving multiple agents MUST run a distinct bridge instance,
   private key, DID, and workflow authorization context for each agent.

A future authenticated multi-client or multi-tenant component is outside this
profile and MUST NOT be described as an MPAS proposer bridge. Such a component
requires a separate service name, trust model, and profile.

## 3. Profile Discovery and Negotiation

### 3.1 Server discovery

`server/discover` MUST be callable before protocol-version or profile-extension
negotiation. A conforming bridge advertises:

```json
{
  "resultType": "complete",
  "supportedVersions": ["2026-07-28"],
  "capabilities": {
    "tools": {},
    "extensions": {
      "io.modelcontextprotocol/tasks": {},
      "org.oma3/mpas": {
        "version": "3",
        "disclosure": "transparent"
      }
    }
  },
  "ttlMs": 3600000,
  "cacheScope": "public"
}
```

The bridge MUST also allow `ping` and `tools/list` before profile-extension
negotiation. Listing tools does not propose an MPAS Action.

### 3.2 Protected requests

Every `tools/call`, `tasks/get`, `tasks/update`, and `tasks/cancel` request MUST
declare MCP `2026-07-28`, the official Tasks extension, and version 3 of this
profile extension:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    "extensions": {
      "io.modelcontextprotocol/tasks": {},
      "org.oma3/mpas": { "version": "3" }
    }
  }
}
```

These values appear in the request's `params._meta`. Missing capabilities
return JSON-RPC `-32021` with the missing entries under
`data.requiredCapabilities.extensions`. The profile version is matched
exactly: a bridge implementing version 3 MUST reject every other declared
version, older or newer, with `-32021`, naming version `"3"` in
`data.requiredCapabilities.extensions["org.oma3/mpas"]`. A missing or unsupported protocol
envelope returns `-32602`.

## 4. Tool Surface

A bridge MUST expose the exact discovered upstream application tools:

- names, descriptions, input schemas, output schemas, annotations, and other
  upstream fields remain unchanged;
- the bridge MUST NOT add `execution.taskSupport`;
- the bridge MUST NOT add a result or wait tool;
- the bridge MUST NOT add MPAS notices or output-schema unions.

Clients discover MPAS through the `org.oma3/mpas` profile-extension capability
in `server/discover`, not through tool names or description text.

Every accepted application `tools/call` durably creates a stable internal Task
and a first MPAS Action (A1). A terminal A1 outcome available during the
original request MUST be returned as a normal complete MCP tool result. The
bridge MUST expose a flat official `CreateTaskResult` only when processing is
deferred by required Approvals, `pending`, or a retryable failure. Once
exposed, the Task ID MUST remain stable if the bridge later replaces A1 with
A2 or A3. The bridge MUST generate it independently, and it MUST NOT equal or
be treated as any MPAS Action ID.

## 5. MPAS Task Metadata

While a Task is `working`, its top-level `_meta` MUST contain:

```typescript
interface MpasTaskMeta {
  version: "3";
  actionId: string;
  actionEnvelopeHash: {
    alg: "sha-256";
    value: string;
  };
  authorizationState:
    | "submitted"
    | "authorization_required"
    | "pending"
    | "approvals_collected";
  disclosure: "transparent";
  requirements?: ApprovalRequirements;
  expiresAt: string;
  coordinationCheckedAt?: string | null;
}
```

The value is stored at `_meta["org.oma3/mpas"]`.

`coordinationCheckedAt` MAY be present only for `authorization_required`. It is
the time this bridge process last completed a Coordination poll, or `null` if
it has not polled since it started. It tells the client how fresh the
authorization state is (Section 9).

`actionId`, `actionEnvelopeHash`, and `expiresAt` identify the Task's current
MPAS Action. They change together when the bridge retires an Action and
constructs its replacement; the MCP Task ID does not change. A client MUST NOT
use the Task ID as an Action-processing or Coordination correlation key.

The bridge MUST read the complete `actionEnvelopeHash` object from the stored
Action Package and MUST verify that its digest equals the workflow store's
existing digest string. It MUST NOT reconstruct the object by splitting or
rewriting the stored signed package.

`requirements` is present only for `authorization_required` when A2's
Proposer-authored `authorizationRequirements.approvalRequirements` is present.
These conditions normally derive from the Verifier's advisory A1 response.
Profile version 3 MUST NOT expose collected-versus-required approval counts.

| Bridge workflow state | Task status | Authorization state |
|---|---|---|
| `created` | `working` | `submitted` |
| `awaitingApprovals` | `working` | `authorization_required` |
| `readyForSubmission`, `submittingToVerifier` | `working` | `approvals_collected` |
| `awaitingVerifierResult` | `working` | `pending` |
| `resolved`, `unresolvable` | `completed` | Metadata omitted |
| `cancelled` | `cancelled` | Metadata omitted |

The bridge MUST use `readyForSubmission` in Task metadata and persisted workflow state.

## 6. Task Results

A `tools/call` for an application tool returns promptly. The bridge durably
records the workflow and its Task ID, begins the initial submission, and waits
at most one second. If the Action reaches a terminal outcome in that time, the
bridge returns the result directly, as a native `CallToolResult` or a
`CallToolResult` with `isError: true`. Otherwise, or as soon as the Action is
known to be deferred (the Verifier required approvals and the replacement
Action is stored), it returns a `CreateTaskResult`. Returning the Task MUST
NOT abort or repeat the submission in flight: it continues under the same Task
ID and idempotency key. A bridge MUST NOT send a `CreateTaskResult` to a client
that has not declared the Tasks extension.

A Task's `statusMessage` MUST NOT imply authorization or execution merely
because a request was sent. While the initial submission awaits the Verifier,
the Task is `working` with authorization state `submitted`.

A `tasks/get` response reflects the bridge's local workflow state and MUST NOT
wait on any remote service. It MAY start the Task's next step in the background
(Section 9): a rate-limited Coordination poll while approvals are awaited,
otherwise a due retry. Results appear in later responses.

- A native upstream `CallToolResult` is returned unchanged in a completed
  Task's `result`.
- A terminal MPAS outcome without a native application result is a completed
  Task whose `result` is a valid `CallToolResult` with `isError: true`.
- `failed` is reserved for a stored JSON-RPC execution error.
- `input_required` is not used by profile version 3. The proposer bridge,
  acting for the Proposer (a Signer), creates the initial `propose` Approval.
  If policy requires additional Approvals, the bridge collects them from
  eligible Signers acting as Maintainers through Coordination rather than
  requesting them as MCP Task input from the proposing client.

There is no `tasks/result` or `tasks/list` operation in this profile.

## 7. Task Visibility and Isolation

For every Task operation, the bridge MUST read the proposer DID from the
stored Action Package and compare it to its one configured proposer DID.

An unknown Task or DID mismatch is invisible and MUST return JSON-RPC
`-32602` with `Task not found`. Possession of a Task ID alone does not change
the bridge's identity scope.

This DID comparison is process-level isolation for the dedicated bridge model;
it is not an authentication mechanism for a shared service. Shared transports
or multi-client services require a separate authenticated design and are out
of scope.

## 8. Update and Cancellation

For a known visible Task, `tasks/update` accepts an `inputResponses` object,
ignores it because profile version 3 never enters `input_required`, and returns
`{ "resultType": "complete" }`.

Cancellation is cooperative:

1. `tasks/cancel` atomically marks an active workflow `cancelled` when it wins
   the terminal-state race.
2. The bridge stops future local polling, retry, and Action submission for it.
3. If Coordination started, the bridge best-effort requests Coordination
   cancellation.
4. Cancellation cannot undo an operation already dispatched upstream.

Cancellation of an already-terminal visible Task is an acknowledged no-op.

## 9. Progress and Retention

The bridge progresses a Task only in response to client requests. A tool call
records the workflow and begins its initial submission. Observing a Task
(`tasks/get` or the compatibility wait tool) may start that Task's next step.
When an in-flight request completes, the bridge persists its result and
performs directly dependent work: it MUST submit a completed Action Package
once a Coordination poll reports it.

A retryable failure or a Verifier `pending` MUST record a durable backoff,
honoring `Retry-After`. The bridge MUST NOT retry before that time and retries
only on a later observation of the Task itself. A permanent failure
(authentication, authorization, a non-retryable rejection, a protocol or
validation error, or a malformed success response) MUST be surfaced and MUST
NOT be retried. A definitive Action outcome, including an executed application
error or a rejection, MUST NOT be resubmitted. A failure that cannot be
classified has an unknown outcome and MAY be retried. Every retry MUST reuse
the Action's idempotency key and identical request. Only an approval newly
collected by a Coordination poll may trigger a submission for a Task other than
the one observed. The bridge MUST NOT run remote work on a timer. Startup
reconciliation is local: an unfinished workflow resumes on the next
observation of its Task. An operation for a Task MUST NOT start while another
is in flight for it.

On disconnect or shutdown the bridge MUST stop accepting requests and starting
remote calls, including a submission a late Coordination response would
trigger. It SHOULD let calls already sent finish within a bounded grace period
and persist their outcomes. It MUST NOT record an interrupted call as failed or
cancelled; its outcome is unknown, and the workflow keeps its Task ID and
idempotency key.

The bridge MUST poll Coordination only in response to a client observing a
Task whose workflow awaits approvals. It MUST NOT poll Coordination at startup.
It MUST NOT have more than one Coordination poll in flight at a time, and it
MUST rate-limit polls; a request within the limit receives the last known
state. Task observation MUST NOT wait on any remote service. An Action that no
client observes MAY expire without its approvals being collected, and a failed
submission that no client observes MAY expire without being retried. A Task
read after its Action expired MUST be reported as expired.

A stdio bridge MUST exit when its input stream ends or closes, including while
requests are in flight.

The bridge configures a logical Verifier Action endpoint independently from an
optional Coordination Service. The Verifier endpoint may be direct or hosted
by an Action Relay; that topology MUST NOT change the MCP client-facing Task
contract or the bridge's interpretation of `ActionResponse`.

After receiving `additionalApprovalsRequired` for A1, the bridge MUST NOT
submit any subsequent Action Package that reuses A1's Action ID. It MUST
construct A2 with a new Action ID, Action Envelope hash, expiration, and
Proposer Approval. It MAY reuse the same profile-native Execution Payload.
It then authors A2-bound Authorization Requirements, normally by deriving the
approval conditions, policy reference, and intended `verifier.did` from the
Verifier's A1-bound advisory response. The H2-bound object is Proposer-authored
and MUST NOT be represented as Verifier-authored.

The bridge explicitly calls `/mpas/v1/coordination/workflow` with A2 when
Coordination is configured. It MUST NOT assume that an Action Relay created
that workflow. When Coordination returns a completed A2 Action Package in
`readyForSubmission`, the bridge explicitly submits A2 to the same logical
Verifier endpoint used for A1. This is A2's first Verifier submission, not a
retry of A1. The Coordination Service does not perform that submission on the
bridge's behalf.

If A2 receives `additionalApprovalsRequired`, the bridge repeats the rule by
retiring A2 and constructing A3 with fresh hash-bound Approvals. Before any
protocol response is received, transport failure or retryable `503 timeout`
instead causes an exact retry of the current Action with the same Action ID
and idempotency key.

`ttlMs` is measured from Task creation and mirrors actual retention:

```text
keepUntil = max(currentActionEnvelope.expiresAt, resolvedAt + resultRetention)
ttlMs     = keepUntil - createdAt
```

`pollIntervalMs` is a client hint and is independent of the bridge's
Coordination rate limit and its retry backoff. It reflects the Task's state:
a long interval (default 60 seconds) while approvals are awaited and a short
one (default 2 seconds) while the bridge itself has work to do. After a failed
remote call, it is never shorter than the time until the retry is allowed.
Each check of a working Task can start its next step, so hosts that follow the
hint drive retries without polling more often than useful.

## 10. Versioning and Compatibility

Profile version 2 replaced the incompatible version 1 client interface as the
primary interface. Version 1 did not advertise `org.oma3/mpas` and used the
proprietary `mpas_wait_for_action_result` tool, tool-presence discovery,
description notices, output-schema unions, and MPAS-specific result wrappers.
New and regenerated bridges MUST use the Tasks behavior in Sections 3 through
9 for Tasks-capable clients.

This profile targets the official `io.modelcontextprotocol/tasks` extension on
MCP `2026-07-28`. It MUST NOT be implemented with the removed 2025-11-25 core
Tasks API.

The profile version identifies this client-facing proposer-bridge contract. It
does not identify the MPAS Core version, HTTP Profile version, MCP Execution
Profile version, or negotiated MCP protocol version. A breaking change to the
Task metadata schema, result interpretation, discovery requirements, or
client-visible workflow responsibilities requires a new profile version.

Profile version 3, from the
[reduced proposer-bridge polling](../docs/features/reduce-polling/spec.md)
feature, replaces version 2. It changes client-visible workflow
responsibilities: the bridge progresses a Task only when a client calls a tool
or observes the Task (Section 9), a tool call returns a Task within about one
second (Section 6), and Task metadata gains `coordinationCheckedAt`. Version 2
is not supported by version 3 bridges; bridges and the clients that declare
the profile are upgraded together.

### 10.1 Temporary conventional-client compatibility annex

Until maintained agent harnesses can consume the official Tasks extension, a
bridge MAY also implement the temporary compatibility adapter defined by the
[MCP Client Compatibility feature](../docs/features/mcp-client-compatibility/spec.md).
This annex does not make the legacy surface part of profile version 3.

The bridge MUST select one connection-local surface from the wire handshake:
`server/discover` selects the Tasks profile, while conventional `initialize`
selects compatibility mode. It MUST NOT select by client name or version, and
it MUST NOT switch modes during a connection.

In compatibility mode only, the bridge:

- uses the negotiated conventional MCP protocol version;
- exposes the application tools plus exactly one
  `mpas_wait_for_action_result` tool;
- may add the deterministic legacy description notice and output-schema union;
- returns legacy deferred and terminal result wrappers; and
- does not advertise or dispatch `tasks/*` or the profile extensions.

Both surfaces MUST create and observe the same durable MPAS workflow. The
compatibility adapter MUST NOT alter Action construction, proposer signing,
policy evaluation, Coordination, Credential Adapter custody, authorization,
credential substitution, or upstream execution. It MUST NOT add a direct
application transport. An Action remains visible only through a bridge whose
configured proposer DID matches the stored signed Action Package.
