# MPAS MCP Proposer Bridge Profile

**Status:** Draft v0.2

**Profile version:** `2`

**MCP profile-extension identifier:** `org.oma3/mpas`

**MCP protocol version:** `2026-07-28`

**Depends on:** [MPAS Core Specification v0.2](./mpas-specification.md), [MPAS MCP Execution Profile](./mpas-profile-mcp.md), and the official MCP extension `io.modelcontextprotocol/tasks`

**Feature record:** [Official MCP Tasks integration](../docs/features/mcp-tasks/spec.md)

---

## 1. Purpose and Scope

This profile defines what a proposing MCP client can expect when it connects
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

Profile version 2 supports transparent disclosure only. It does not define
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
        "version": "2",
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
declare MCP `2026-07-28`, the official Tasks extension, and version 2 of this
profile extension:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    "extensions": {
      "io.modelcontextprotocol/tasks": {},
      "org.oma3/mpas": { "version": "2" }
    }
  }
}
```

These values appear in the request's `params._meta`. Missing capabilities
return JSON-RPC `-32021` with the missing entries under
`data.requiredCapabilities.extensions`. A missing or unsupported protocol
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

Every accepted application `tools/call` creates a new MPAS Action and returns
a flat official `CreateTaskResult`. The Task ID MUST equal the MPAS Action ID.

## 5. MPAS Task Metadata

While a Task is `working`, its top-level `_meta` MUST contain:

```typescript
interface MpasTaskMeta {
  version: "2";
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
}
```

The value is stored at `_meta["org.oma3/mpas"]`.

The bridge MUST read the complete `actionEnvelopeHash` object from the stored
Action Package and MUST verify that its digest equals the workflow store's
existing digest string. It MUST NOT reconstruct the object by splitting or
rewriting the stored signed package.

`requirements` is present only for `authorization_required` when the Verifier
supplied `authorizationRequirements.approvalRequirements`. Profile version 2
MUST NOT expose collected-versus-required approval counts.

| Bridge workflow state | Task status | Authorization state |
|---|---|---|
| `created` | `working` | `submitted` |
| `awaitingApprovals` | `working` | `authorization_required` |
| `readyForResubmission`, `submittingToVerifier` | `working` | `approvals_collected` |
| `awaitingVerifierResult` | `working` | `pending` |
| `resolved`, `unresolvable` | `completed` | Metadata omitted |
| `cancelled` | `cancelled` | Metadata omitted |

## 6. Task Results

`tasks/get` is read-only and MUST NOT advance an MPAS workflow.

- A native upstream `CallToolResult` is returned unchanged in a completed
  Task's `result`.
- A terminal MPAS outcome without a native application result is a completed
  Task whose `result` is a valid `CallToolResult` with `isError: true`.
- `failed` is reserved for a stored JSON-RPC execution error.
- `input_required` is not used by profile version 2; MPAS Approvals are
  collected from Signers through Coordination, not from the proposing MCP
  client.

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
ignores it because profile version 2 never enters `input_required`, and returns
`{ "resultType": "complete" }`.

Cancellation is cooperative:

1. `tasks/cancel` atomically marks an active workflow `cancelled` when it wins
   the terminal-state race.
2. The bridge stops future local polling, retry, and resubmission for it.
3. If Coordination started, the bridge best-effort requests Coordination
   cancellation.
4. Cancellation cannot undo an operation already dispatched upstream.

Cancellation of an already-terminal visible Task is an acknowledged no-op.

## 9. Background Progress and Retention

Task observation and MPAS progression are independent. The bridge MUST
continue background Coordination polling, completed-package resubmission,
startup reconciliation, and retry of transient adapter or Coordination
failures until the Action expires or reaches a terminal state.

`ttlMs` is measured from Task creation and mirrors actual retention:

```text
keepUntil = max(actionEnvelope.expiresAt, resolvedAt + resultRetention)
ttlMs     = keepUntil - createdAt
```

`pollIntervalMs` is a client hint and is independent of the bridge's internal
background interval.

## 10. Versioning and Compatibility

Profile version 2 replaces the incompatible version 1 client interface, which
used the proprietary `mpas_wait_for_action_result` tool, tool-presence
discovery, description notices, output-schema unions, and MPAS-specific result
wrappers. New and regenerated bridges MUST NOT implement those mechanisms.

This profile targets the official `io.modelcontextprotocol/tasks` extension on
MCP `2026-07-28`. It MUST NOT be implemented with the removed 2025-11-25 core
Tasks API.

The profile version identifies this client-facing proposer-bridge contract. It
does not identify the MPAS Core version, HTTP Profile version, MCP Execution
Profile version, or negotiated MCP protocol version. A breaking change to the
Task metadata schema, result interpretation, discovery requirements, or
client-visible workflow responsibilities requires a new profile version.
