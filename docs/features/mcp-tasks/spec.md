# MPAS Integration with the Official MCP Tasks Extension

**Status:** Draft

**Created:** 2026-08-14

**Issue:** #33

**Depends on:** [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks), [MCP Extensions Framework](https://modelcontextprotocol.io/extensions/overview)

**Normative output:** [MPAS MCP Proposer Bridge Profile v0.2](../../../specs/mpas-profile-mcp-proposer-bridge-client.md)
**Companion:** [plan.md](./plan.md)

---

## 1. Purpose

Replace the bridge's proprietary `mpas_wait_for_action_result` tool and the
`MpasBridgeDeferredResult` / `MpasBridgeActionOutcome` result objects with the
official MCP Tasks extension, `io.modelcontextprotocol/tasks`.

The bridge also advertises the `org.oma3/mpas` profile-extension capability.
MCP Tasks provides the asynchronous lifecycle; `org.oma3/mpas` identifies this
proposer-bridge profile and adds authorization state in namespaced result
metadata.

This specification targets the official Tasks extension built on MCP
2026-07-28. It does **not** target the experimental Tasks API included in the
2025-11-25 core specification. In particular, this specification does not use
the older request `task` field, `execution.taskSupport`, `tasks/result`, or
`tasks/list` constructs.

---

## 2. Problem

The current client profile defines a bespoke asynchronous mechanism:

1. A reserved `mpas_wait_for_action_result` tool.
2. MPAS-specific deferred and terminal result wrappers.
3. `anyOf` output-schema unions on application tools.
4. Description notices appended to application tools.

Every client must understand those MPAS-specific conventions, and the modified
tool definitions no longer match the upstream MCP server exactly. The official
Tasks extension provides durable handles, client polling, terminal results,
and cooperative cancellation without changing application tool schemas.

---

## 3. Design Decisions

1. **Official Tasks extension only.** The bridge uses
   `io.modelcontextprotocol/tasks`. The experimental 2025-11-25 Tasks API is
   not supported.

2. **No backward-compatibility shim.** `mpas_wait_for_action_result` and the
   MPAS-specific result wrappers are removed.

3. **Every accepted application call returns a task.** The bridge always
   returns a flat `CreateTaskResult`, including when the MPAS workflow reaches
   a terminal state during the original request. A client that does not
   declare the required extensions receives a missing-capability error.

4. **Task ID reuses Action ID.** `taskId` equals
   `actionEnvelope.actionId.value`. MPAS creates Action IDs with
   cryptographically random UUIDs, so they satisfy the Tasks uniqueness and
   entropy requirements. Clients MUST use the `taskId` field for task
   operations and MUST NOT rely on other MPAS fields as task handles.

5. **Server-directed creation.** Clients do not send a `task` request field.
   The bridge decides to return a task after verifying per-request extension
   capabilities.

6. **No application-tool modification.** Names, descriptions, input schemas,
   output schemas, annotations, and other upstream fields pass through
   unchanged. The bridge does not add `execution.taskSupport`.

7. **Transparent disclosure only.** Profile version 2 exposes approval
   requirements to the proposing client. Opaque and mixed disclosure modes are
   out of scope.

8. **MPAS data lives in `_meta`.** Authorization metadata appears at
   `_meta["org.oma3/mpas"]`, not as a top-level Task property.

9. **Polling is the initial notification model.** Clients use `tasks/get`.
   `notifications/tasks` and subscriptions are out of scope for profile
   version 2.

10. **No detailed approval progress.** The bridge reports coarse workflow
    state and approval requirements. It does not promise collected-versus-
    required approval counts.

11. **Cancellation is cooperative.** `tasks/cancel` stops future bridge work
    when possible and best-effort cancels Coordination. It cannot undo an
    already-dispatched application operation.

12. **MCP polling does not drive MPAS.** `tasks/get` only observes stored
    state. Existing background Coordination polling, verifier resubmission,
    reconciliation, and transient-operation retry continue independently.

---

## 4. Profile-Extension Negotiation

### 4.1 Capability Identifiers

- Official asynchronous execution: `io.modelcontextprotocol/tasks`
- MPAS proposer-bridge profile extension: `org.oma3/mpas`

The MPAS profile extension requires the Tasks extension.

### 4.2 Server Discovery

The bridge advertises the Tasks extension and MPAS profile extension in its
MCP 2026-07-28 `server/discover` result:

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

### 4.3 Per-Request Client Capabilities

The client MUST declare both capabilities in every application-tool request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "merge_pull_request",
    "arguments": {
      "owner": "oma3dao",
      "repo": "example",
      "pullNumber": 42
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": {
          "io.modelcontextprotocol/tasks": {},
          "org.oma3/mpas": {
            "version": "2"
          }
        }
      }
    }
  }
}
```

The same capability requirement applies to `tasks/get`, `tasks/update`, and
`tasks/cancel` requests served by the bridge.

If either capability is missing, the bridge MUST return `-32021` (Missing
Required Client Capability) with the missing entries in
`data.requiredCapabilities.extensions`.

---

## 5. Task Lifecycle Mapping

### 5.1 MCP Status Mapping

| MCP Task status | MPAS workflow state | Meaning |
|---|---|---|
| `working` | `created`, `awaitingApprovals`, `readyForResubmission`, `submittingToVerifier`, `awaitingVerifierResult` | MPAS processing continues. |
| `completed` | `resolved`, `unresolvable` | A `CallToolResult` is available in `tasks/get.result`; it may have `isError: true`. |
| `cancelled` | `cancelled` | The bridge accepted cancellation and stopped future work where possible. |
| `failed` | Reserved for a stored JSON-RPC execution error | `tasks/get.error` contains the JSON-RPC error. |

`input_required` is not used. The proposer bridge, acting for the Proposer (a
Signer), creates the initial `propose` Approval. If policy requires additional
Approvals, the bridge collects them from eligible Signers acting as Maintainers
through the Coordination Service rather than requesting them as MCP Task input
from the proposing client.

The official Tasks extension reserves `failed` for JSON-RPC execution errors.
MPAS outcomes such as `rejected`, `expired`, `malformed`, or
`policyUnavailable` are therefore represented as `completed` tasks whose
`result` is a `CallToolResult` with `isError: true`.

### 5.2 Initial `tools/call` Mapping

| Verifier or bridge result | Initial task status | MPAS authorization state |
|---|---|---|
| `executed` with `executionResult` | `completed` | — |
| `additionalApprovalsRequired` | `working` | `authorization_required` |
| `pending` | `working` | `pending` |
| Terminal MPAS outcome without a native result | `completed` | — |
| Transient adapter or Coordination failure | `working` | `submitted` or `authorization_required` |

Transient failures remain `working` only because the bridge retries the
failed internal operation in the background. Retries are bounded by the
Action Envelope expiration. Once the workflow can no longer produce a native
result, it completes with an error `CallToolResult`.

### 5.3 `CreateTaskResult`

The official extension uses a flat result with `resultType: "task"`:

```json
{
  "resultType": "task",
  "taskId": "urn:uuid:786512e2-9e0d-44bd-8f29-789f320fe840",
  "status": "working",
  "statusMessage": "Awaiting MPAS authorization.",
  "createdAt": "2026-08-14T10:00:00Z",
  "lastUpdatedAt": "2026-08-14T10:00:00Z",
  "ttlMs": 1800000,
  "pollIntervalMs": 5000,
  "_meta": {
    "org.oma3/mpas": {
      "version": "2",
      "actionId": "urn:uuid:786512e2-9e0d-44bd-8f29-789f320fe840",
      "actionEnvelopeHash": {
        "alg": "sha-256",
        "value": "base64url-encoded-digest"
      },
      "authorizationState": "authorization_required",
      "disclosure": "transparent",
      "requirements": {
        "anyOf": [
          {
            "type": "threshold",
            "threshold": 2,
            "eligibleSigners": [
              "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
              "did:key:z6Mkw1KSvGWNR7dyB3caY8jQh4RgfbS2QddShiCCfxUbLq7V"
            ],
            "decision": "approve",
            "description": "Requires 2 approvals from eligible Signers acting as Maintainers."
          }
        ]
      },
      "expiresAt": "2026-08-14T10:30:00Z"
    }
  }
}
```

No nested `task` property is used.

### 5.4 `tasks/get` While Working

All `tasks/get` responses use `resultType: "complete"` because that request
itself completed normally:

```json
{
  "resultType": "complete",
  "taskId": "urn:uuid:786512e2-9e0d-44bd-8f29-789f320fe840",
  "status": "working",
  "statusMessage": "Awaiting MPAS authorization.",
  "createdAt": "2026-08-14T10:00:00Z",
  "lastUpdatedAt": "2026-08-14T10:05:00Z",
  "ttlMs": 1800000,
  "pollIntervalMs": 5000,
  "_meta": {
    "org.oma3/mpas": {
      "version": "2",
      "actionId": "urn:uuid:786512e2-9e0d-44bd-8f29-789f320fe840",
      "actionEnvelopeHash": {
        "alg": "sha-256",
        "value": "base64url-encoded-digest"
      },
      "authorizationState": "authorization_required",
      "disclosure": "transparent",
      "requirements": {
        "anyOf": [
          {
            "type": "threshold",
            "threshold": 2,
            "eligibleSigners": [
              "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
              "did:key:z6Mkw1KSvGWNR7dyB3caY8jQh4RgfbS2QddShiCCfxUbLq7V"
            ]
          }
        ]
      },
      "expiresAt": "2026-08-14T10:30:00Z"
    }
  }
}
```

### 5.5 `tasks/get` When Completed Successfully

The native upstream `CallToolResult` is inlined in `result`:

```json
{
  "resultType": "complete",
  "taskId": "urn:uuid:786512e2-9e0d-44bd-8f29-789f320fe840",
  "status": "completed",
  "createdAt": "2026-08-14T10:00:00Z",
  "lastUpdatedAt": "2026-08-14T10:10:00Z",
  "ttlMs": 88200000,
  "pollIntervalMs": 5000,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Pull request #42 merged successfully."
      }
    ],
    "isError": false
  }
}
```

The bridge does not wrap or edit a native result.

### 5.6 `tasks/get` for a Terminal MPAS Outcome

If MPAS ends without a native application result, the bridge synthesizes the
same kind of MCP tool-level error that a synchronous bridge would return. The
Task remains `completed` because the result is a valid `CallToolResult`:

```json
{
  "resultType": "complete",
  "taskId": "urn:uuid:786512e2-9e0d-44bd-8f29-789f320fe840",
  "status": "completed",
  "statusMessage": "MPAS rejected the Action.",
  "createdAt": "2026-08-14T10:00:00Z",
  "lastUpdatedAt": "2026-08-14T10:10:00Z",
  "ttlMs": 88200000,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "MPAS Action rejected: policy denied the operation."
      }
    ],
    "structuredContent": {
      "version": "1",
      "type": "ActionResponse",
      "result": "rejected",
      "createdAt": "2026-08-14T10:10:00Z"
    },
    "isError": true
  }
}
```

There is no `tasks/result` request. The terminal result is returned by
`tasks/get`.

---

## 6. MPAS Task Metadata

The `_meta["org.oma3/mpas"]` value has this profile-version 2 shape:

```typescript
interface MpasTaskMeta {
  version: "2";
  actionId: string;
  actionEnvelopeHash: HashObject;
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

Rules:

- The block is present only while the Task is `working`.
- `requirements` is present when `authorizationState` is
  `authorization_required` and the Verifier supplied
  `authorizationRequirements.approvalRequirements`.
- The bridge reads the complete `actionEnvelopeHash` object from the stored
  signed Action Package. The database's existing digest-string representation
  remains unchanged.
- No approval-count progress is included.

### 6.1 Authorization State Mapping

| Workflow state | `authorizationState` |
|---|---|
| `created` before a usable Verifier response | `submitted` |
| `awaitingApprovals` | `authorization_required` |
| `readyForResubmission`, `submittingToVerifier` | `approvals_collected` |
| `awaitingVerifierResult` | `pending` |

---

## 7. Tool Surface

For every application tool exposed by the bridge:

1. `name` equals the upstream name.
2. `description` equals the upstream description.
3. `inputSchema` is semantically identical to the upstream schema.
4. `outputSchema` is the unmodified upstream schema.
5. Upstream annotations and other fields pass through unchanged.
6. The bridge does not add `execution.taskSupport`.

Removed from the surface:

- `mpas_wait_for_action_result`
- MPAS description notices
- MPAS `anyOf` output-schema unions

Clients detect the bridge through `org.oma3/mpas` in `server/discover`, not by
scanning tool names.

---

## 8. Task Operations

### 8.1 `tasks/get`

`tasks/get` reads the workflow store and never advances the workflow. It
returns a `DetailedTask` with `resultType: "complete"`.

Unknown or invisible task IDs return `-32602` (Invalid params).

### 8.2 `tasks/update`

Proposer-bridge profile version 2 never enters `input_required` and creates no
`inputRequests`.
For a known, visible Task, `tasks/update` ignores supplied unknown responses as
required by the Tasks extension and returns:

```json
{ "resultType": "complete" }
```

An unknown or invisible Task returns `-32602`.

### 8.3 `tasks/cancel`

For a known, visible Task, cancellation:

1. Atomically marks an active workflow `cancelled`, preventing later polling,
   resubmission, or retry by the bridge.
2. If Coordination started, best-effort calls the existing
   `/mpas/v1/coordination/action-cancel` endpoint.
3. Returns an empty acknowledgement:

```json
{ "resultType": "complete" }
```

Cancellation of an already-terminal Task is an acknowledged no-op. An unknown
or invisible Task returns `-32602`.

The observable Task may reach another terminal state if execution won the race
before cancellation was recorded. Cancellation never undoes an upstream
application operation.

There is no `tasks/list` operation in the official extension.

---

## 9. Background Workflow Behavior

MCP task polling and MPAS workflow progression are independent:

- `tasks/get` is read-only.
- The bridge background tick polls Coordination for updates.
- Completed approval packages are resubmitted to the Verifier.
- `pending` verifier work continues to be checked using the existing workflow
  mechanism.
- Transient adapter and Coordination failures are retried while the Action
  Envelope is valid.
- Expiration resolves the workflow to a terminal error `CallToolResult`.

A client MUST NOT call the original application tool again to check progress;
that creates a new MPAS Action and a new Task.

---

## 10. TTL and Retention

`ttlMs` is a duration measured from Task creation. It mirrors the workflow
store's actual retention boundary:

```text
keepUntil = max(actionEnvelope.expiresAt, resolvedAt + resultRetention)
ttlMs     = keepUntil - createdAt
```

For an active workflow without `resolvedAt`, the current retention boundary is
the Action Envelope expiration. The official extension permits `ttlMs` to
change, so terminal responses may extend it to cover post-resolution result
retention.

`pollIntervalMs` is only a client polling hint. It is distinct from the
bridge's internal background-tick interval.

---

## 11. Task Isolation

The current bridge is a dedicated stdio process for exactly one proposing MCP
client or agent. It holds exactly one private key and is configured for the
single proposer DID derived from that key. The key is the bridge identity and
the configured DID is the Task authorization context. A request cannot select
another key or supply a replacement proposer DID.

For `tasks/get`, `tasks/update`, and `tasks/cancel`, the bridge MUST verify that
the workflow's proposer DID, read from the stored signed Action Package,
matches the bridge's configured proposer DID. A mismatch is treated as an
invisible Task and returns `-32602`.

This model does not support multiplexing independent clients, tenants, or
agent identities through one bridge process. Deployments serving multiple
agents require one bridge, key, DID, and workflow authorization context per
agent. A future authenticated shared or multi-client component requires a
different service name and profile; it is not an MPAS proposer bridge under
this specification.

---

## 12. Error Handling

### 12.1 JSON-RPC Errors

| Condition | Code | Behavior |
|---|---:|---|
| Missing `io.modelcontextprotocol/tasks` or `org.oma3/mpas` | `-32021` | Include missing entries in `data.requiredCapabilities.extensions`. |
| Unknown or DID-invisible `taskId` | `-32602` | `Task not found`. |
| Invalid Tasks request parameters | `-32602` | Descriptive invalid-params message. |
| Bridge cannot read a consistent stored workflow | `-32603` | Internal error. |

### 12.2 Task Outcomes

- Native upstream result: `completed` with the native `CallToolResult`.
- MPAS terminal outcome without native result: `completed` with synthesized
  `CallToolResult { isError: true }`.
- Stored JSON-RPC execution error: `failed` with an `error` object.
- Client cancellation: `cancelled` when cancellation wins the terminal race.

---

## 13. Migration from Client Profile v0.1

| v0.1 concept | Replacement |
|---|---|
| `mpas_wait_for_action_result` | `tasks/get` |
| `MpasBridgeDeferredResult` | Flat `CreateTaskResult` with `resultType: "task"` |
| `MpasBridgeActionOutcome` | Completed Task with `result.isError: true` |
| `MpasBridgeError` after task creation | Completed error result or Task JSON-RPC error |
| Action reference as client handle | `taskId` (same value as Action ID) |
| Output-schema unions | Upstream schema unchanged |
| Tool description notices | Upstream description unchanged |
| `notificationRequired` | Human-readable `statusMessage` when needed |

---

## 14. SDK Compatibility

The bridge uses the published MCP SDK v2 packages for MCP 2026-07-28 and
stdio transport:

- `@modelcontextprotocol/server@2.0.0`
- `@modelcontextprotocol/core@2.0.0`

As of 2026-08-14, the official Tasks extension schemas are not published as an
installable package. MPAS therefore temporarily vendors the extension schemas
from `modelcontextprotocol/ext-tasks` commit
`2c1425d9a288b9b1f489430fe1e00bb392b47e48`.

The vendored schemas MUST be clearly attributed and isolated behind one module.
In addition, `@modelcontextprotocol/server@2.0.0` still reserves `tasks/*` for
the removed 2025 core API and rejects those method names in the 2026 protocol
era. MPAS therefore temporarily uses a narrow modern-only dispatcher around
the SDK v2 transport for discovery, tools, and the official extension methods.
It does not expose the old `tasks/list` or `tasks/result` interface.

The vendored schemas and dispatcher MUST be replaced with official SDK or
extension-package support once that becomes available. The implementation
plan includes a GitHub issue draft tracking that removal.

---

## 15. Initial Rollout Scope

The initial production rollout covers only:

- GitHub bridge
- Netlify bridge

Other generated bridges remain on the existing interface until they are
regenerated in a later rollout.

---

## Appendix A: Proposer Client Instructions

1. Include `io.modelcontextprotocol/tasks` and `org.oma3/mpas` in the
   per-request client capabilities for every bridge request.
2. Call the application tool normally; do not include a `task` field.
3. Read the flat `CreateTaskResult` and retain its `taskId`.
4. If its status is `working`, poll `tasks/get` no faster than
   `pollIntervalMs`.
5. When `tasks/get` returns `completed`, read the native `CallToolResult` from
   its `result` field.
6. Treat `result.isError: true` as a completed tool-level error.
7. Call `tasks/cancel` if the result is no longer needed.
8. Never repeat the original application tool call to check status; that
   creates a new Action.

```text
tools/call -> CreateTaskResult
  working   -> tasks/get -> ... -> completed.result
  completed -> tasks/get -> completed.result
  cancelled -> stop
  failed    -> tasks/get.error
```
