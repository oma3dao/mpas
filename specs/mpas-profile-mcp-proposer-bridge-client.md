# MPAS MCP Proposer Bridge Client Interface Profile

**Status:** Draft v0.1
**Drafted:** 2026-07-26
**Interface Version:** `1`
**Depends on:** [MPAS Core Specification v0.2](./mpas-specification.md), [MPAS HTTP Profile](./mpas-profile-http.md), [MPAS MCP Execution Profile](./mpas-profile-mcp.md)
**Feature record:** [Asynchronous MCP Proposer Bridge](../docs/features/mcp-proposer-spec/spec.md)

---

## 1. Purpose

This profile defines what a proposing MCP client can expect when it connects
to and calls an MPAS MCP proposer bridge.

It defines only the client-facing MCP contract:

- which application tools the bridge exposes;
- which MPAS-specific tool the bridge adds;
- which result shapes an application tool may return;
- how a client recognizes an Action that is still in progress;
- how a client waits for or checks the final result; and
- which guarantees apply across MCP requests and client sessions.

The MPAS MCP Execution Profile separately defines how an MCP `tools/call`
operation is represented as an MPAS Execution Payload and how its native result
is classified. MPAS Core and the HTTP Profile separately define MPAS artifacts,
Verifier results, and service-to-service interfaces.

This profile does not restate those lower-layer contracts and does not specify
how a bridge implements them.

### 1.1 Scope

This profile applies to the MCP interface exposed by an application-specific
MPAS proposer bridge to a proposing MCP client.

The client may be an agent host, IDE, command-line tool, or another MCP-capable
system. The bridge may use any MCP transport supported by the client and
deployment.

### 1.2 Non-goals

This profile does not define:

- bridge storage, databases, journals, or persistence mechanisms;
- background workers, polling, webhooks, scheduling, or process topology;
- how a bridge communicates with a Credential Adapter, Verifier, or
  Coordination Service;
- adapter submission order, retry algorithms, or dispatch-ledger behavior;
- the Signer or maintainer MCP server interface;
- automatic Slack, email, A2A, or other notification delivery;
- MCP Tasks integration;
- administrative action listing or cancellation tools; or
- the internal architecture of a conforming bridge.

Those concerns belong to lower-layer MPAS specifications, implementation
documentation, deployment documentation, or later client-interface profiles as
appropriate.

### 1.3 Conformance language

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in RFC 2119.

---

## 2. Client Model

### 2.1 Tool-input compatibility

An MPAS proposer bridge preserves the upstream MCP server's application tool
names and inputs. It does not necessarily preserve the upstream server's
timing or result shapes.

A client that already understands the upstream server therefore still needs
this profile to interpret bridge results.

### 2.2 Client-visible results

The result shape tells the client where the Action stands:

- a **native upstream MCP result** — the upstream application ran and produced
  its own result;
- **`MpasBridgeDeferredResult`** (Section 5.1) — the Action is still active;
- **`MpasBridgeActionOutcome`** (Section 5.2) — the Action is no longer
  active, the bridge will produce no further result for it, and there is no
  native result to relay; or
- **`MpasBridgeError`** (Section 5.3) or an MCP transport error — the bridge
  could not perform the requested client operation. The Action may still be
  progressing; the error reports only that this request could not be answered.

This profile defines no Action-result enum of its own. Where a Verifier
`ActionResponse` is available, the bridge passes it through exactly, including
these nonterminal results:

| Verifier result               | Meaning to the client                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `additionalApprovalsRequired` | The submitted Action Package requires additional signed MPAS Approvals.                                                                          |
| `pending`                     | The Verifier has an `executing` dispatch-ledger entry. The Action is already dispatched or awaiting execution; the client waits for the result rather than resubmitting the application tool. |

The bridge does not always hold a Verifier response — before the first one
arrives, and between responses while it submits a completed Action Package. A
deferred result simply omits `lastActionResponse` in that case. This profile
version defines no bridge-owned intermediate state.

### 2.3 Action reference

Once an application tool returns an MPAS result, the client identifies the
Action through the HTTP Profile's `ActionRef`, containing:

- `actionId`; and
- `actionEnvelopeHash`.

The Action reference remains stable across subsequent result calls.

---

## 3. MCP Tool Surface

### 3.1 Application tools

For every upstream application tool exposed by the bridge:

1. `name` MUST equal the upstream tool name exactly, except an upstream
   operation superseded by the reserved result tool (Section 3.3).
2. `inputSchema` MUST be semantically identical to the upstream input schema.
3. The bridge MUST NOT add MPAS workflow arguments to the upstream
   `inputSchema`.
4. Upstream MCP annotations SHOULD be preserved unless this profile requires a
   more conservative value.
5. The description SHOULD preserve the upstream description and append a
   standard notice that the tool may return an MPAS deferred result.

The recommended notice is:

> This tool is mediated by MPAS and may return a deferred Action reference.
> Use `mpas_wait_for_action_result` to retrieve an asynchronous result.

### 3.2 Output schemas

For each application tool with an upstream `outputSchema`, the bridge MUST
advertise a deterministically generated `anyOf` union accepting:

1. the upstream tool's structured result;
2. `MpasBridgeDeferredResult`;
3. `MpasBridgeActionOutcome`; and
4. `MpasBridgeError`.

The bridge is specific to its upstream server and therefore has the schemas
needed to generate this union. It MUST preserve the upstream schema as one
branch without weakening or rewriting it.

If an upstream tool does not advertise an `outputSchema`, the bridge MUST omit
`outputSchema` for that application tool. It MUST NOT advertise only the
profile-defined branches because that would exclude an otherwise valid native
upstream result.

The reserved result tool (Section 3.3) covers Actions created by every
application tool in the bridge. Its `outputSchema` MUST union the
profile-defined result objects with every available upstream tool output
schema. If any reachable
native structured result has no schema, the result tool MUST omit its
`outputSchema`.

### 3.3 Reserved result tool

Every conforming bridge MUST expose:

```text
mpas_wait_for_action_result
```

The reserved result tool supersedes any upstream operation with the same name.
If the upstream server exposes `mpas_wait_for_action_result`, the bridge MUST
expose the profile-defined result tool and MUST NOT expose, rename, or merge
the upstream operation.

### 3.4 Profile discovery

The presence of `mpas_wait_for_action_result` with the schema in Section 6.1 is
the REQUIRED discovery signal for this interface version.

### 3.5 Result tool annotations

Where the negotiated MCP protocol supports tool annotations,
`mpas_wait_for_action_result` SHOULD advertise:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Calling the result tool does not propose a new Action.

---

## 4. Application Tool Call Behavior

Every application tool call proposes a new Action, even when its `name` and
`arguments` are identical to an earlier call. Tool arguments are not an
idempotency key, and the bridge MUST NOT associate a new application tool call
with an existing Action. A client that wants the status or result of an
existing Action uses `mpas_wait_for_action_result` (Section 6).

### 4.1 Native result

If the Action does not require additional Approvals and execution produces a
native MCP result, the bridge MUST return that result verbatim. It MUST NOT
wrap the native result in a profile-defined result object.

This applies to:

- a successful upstream MCP result; and
- a definitive upstream MCP tool result with `isError: true`.

The meaning of the native result and its relationship to the MPAS
`ActionResponse` are defined by the MCP Execution Profile (Section 6.1,
Outcome Mapping) and the HTTP Profile (Section 6.4.1, `executionResult`).

### 4.2 Deferred result

A bridge MAY return `MpasBridgeDeferredResult` as soon as the Action is
durably recorded, without waiting for a Verifier response. It MUST return one
no later than a Verifier `additionalApprovalsRequired`, and MUST NOT hold the
application tool call open while Approvals are collected.

Returning the deferred result completes the original MCP request; no further
response arrives on that request.

The deferred result promises only the client-visible behavior defined here:

- the Action reference is valid for later result retrieval;
- the Action may resolve independently of any result call;
- the client may perform unrelated work in the meantime; and
- the client may later use `mpas_wait_for_action_result`.

This profile does not prescribe how the bridge fulfills that promise.

### 4.3 Terminal Action without a native result

An Action is terminal, for the purposes of this client interface, when the
bridge will produce no further result for it. Retrying a terminal Action means
proposing a new Action.

When a terminal Action has no native upstream MCP result to relay, the bridge
MUST return `MpasBridgeActionOutcome` carrying the exact final
`ActionResponse` known to the bridge. The rule, not a fixed list, determines
what is returned this way: any final `ActionResponse` whose `executionResult`
is absent — for example `rejected`, `expired`, `failed` without
`executionResult`, `malformed`, `notSupported`, `indeterminate`, or
`policyUnavailable`.

`policyUnavailable` is a Verifier verdict, not a bridge failure, and is passed
through like any other final result. Because a `policyUnavailable` response is
stateless and creates no dispatch-ledger entry, a bridge MAY first retry
submission of the same Action Package while the Action Envelope remains valid;
whether and how long it retries is implementation freedom. Returning
`MpasBridgeActionOutcome` commits the bridge: it MUST NOT perform further work
on that Action, so that repeated result calls return the same outcome
(Section 7.3).

After a `rejected`, `expired`, `malformed`, `notSupported`, or
`policyUnavailable` outcome, nothing was executed and proposing a new Action
is safe. After a `failed` outcome, execution was attempted and definitively
failed; whether to propose a new Action is the Proposer's decision. After an
`indeterminate` outcome, execution was dispatched and the result is
unconfirmed; the Proposer checks application state before proposing a new
Action (Section 9).

`MpasBridgeActionOutcome` exists only because there is no native upstream result
to return. A bridge MUST NOT use it to wrap a native success or a definitive
native tool result, and MUST NOT use it to report a failure of the bridge
itself (Section 5.3).

---

## 5. Client Result Objects

This section defines the three profile-defined objects introduced in Section
2.2. The fourth payload a bridge can return, the native upstream result, has
whatever shape the upstream server gives it and is not defined here.

Profile-defined objects appear in MCP `structuredContent`. When one is
returned, the MCP `content` array SHOULD contain a concise human-readable
summary and MUST NOT contradict `structuredContent`.

Clients MUST ignore unknown optional members in a supported interface version.

### 5.1 `MpasBridgeDeferredResult`

```json
{
  "version": "1",
  "type": "MpasBridgeDeferredResult",
  "actionRef": {
    "version": "1",
    "type": "ActionRef",
    "actionId": {
      "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
    },
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    }
  },
  "lastActionResponse": {
    "version": "1",
    "type": "ActionResponse",
    "result": "additionalApprovalsRequired",
    "authorizationRequirements": {
      "version": "1",
      "type": "AuthorizationRequirements"
    },
    "createdAt": "2026-07-26T18:00:00.000Z"
  },
  "notificationRequired": true,
  "expiresAt": "2026-07-26T19:00:00.000Z",
  "resultRetentionSeconds": 86400,
  "createdAt": "2026-07-26T18:00:00.000Z"
}
```

Fields:

| Field                    |   Required  | Meaning                                                                                                            |
| ------------------------ | :---------: | ------------------------------------------------------------------------------------------------------------------ |
| `version`                |     Yes     | MUST be `"1"`.                                                                                                     |
| `type`                   |     Yes     | MUST be `MpasBridgeDeferredResult`.                                                                                |
| `actionRef`              |     Yes     | Stable Action ID and Action Envelope hash.                                                                         |
| `lastActionResponse`     |      No     | Exact last nonterminal Verifier `ActionResponse` known to the bridge. Absent when the bridge holds none yet.       |
| `notificationRequired`   |     Yes     | Whether the client is responsible for notifying maintainers (Signers). Meaningful only when `lastActionResponse` is present. |
| `expiresAt`              |     Yes     | The Action Envelope's expiration time.                                                                             |
| `resultRetentionSeconds` |     Yes     | Minimum number of seconds after resolution during which the result remains retrievable.                            |
| `createdAt`              |     Yes     | The time at which the bridge produced this deferred result.                                                        |

`lastActionResponse` is absent when the bridge holds no Verifier response for
the Action — before the first response arrives, or while it submits a
completed Action Package. Its absence means only that; it is not a state.

When present, the bridge MUST preserve it exactly: it MUST NOT change the
result, authoritative fields, Authorization Requirements, Execution Receipt,
or execution result, though JSON reserialization is permitted. Its `result`
MUST be nonterminal — this profile version recognizes
`additionalApprovalsRequired` and `pending`.

Deployments differ in who tells maintainers that an Action needs their
Approvals. Some bridges or coordination services notify Signers themselves —
over Slack, email, a WebSocket push, or similar. Others have no notification
machinery, and the proposing client (often the agent that initiated the call)
is the only party positioned to tell a maintainer that Approvals are needed.
`notificationRequired` tells the client which case applies:

- when `lastActionResponse.result` is `additionalApprovalsRequired`, it MUST
  be `true`, unless the deployment assigns notification to the bridge or
  another component, in which case it MAY be `false`; and
- when `lastActionResponse.result` is `pending`, it MUST be `false`.

When `lastActionResponse` is absent, `notificationRequired` carries no
meaning and clients MUST ignore it: there is no Verifier verdict to notify
about yet. A client learns that Approvals are required from a later deferred
result carrying `additionalApprovalsRequired`. Bridges SHOULD set the field
to `false` in this case.

`notificationRequired` does not indicate that notification occurred and does
not alter authorization requirements.

An `MpasBridgeDeferredResult` is nonterminal and SHOULD be returned with MCP
`isError` absent or `false`.

### 5.2 `MpasBridgeActionOutcome`

```json
{
  "version": "1",
  "type": "MpasBridgeActionOutcome",
  "actionRef": {
    "version": "1",
    "type": "ActionRef",
    "actionId": {
      "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
    },
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    }
  },
  "actionResponse": {
    "version": "1",
    "type": "ActionResponse",
    "result": "expired",
    "createdAt": "2026-07-26T19:00:00.000Z"
  },
  "resolvedAt": "2026-07-26T19:00:00.000Z"
}
```

Fields:

| Field            |   Required  | Meaning                                                                                                            |
| ---------------- | :---------: | ------------------------------------------------------------------------------------------------------------------ |
| `version`        |     Yes     | MUST be `"1"`.                                                                                                     |
| `type`           |     Yes     | MUST be `MpasBridgeActionOutcome`.                                                                                 |
| `actionRef`      |     Yes     | Stable Action reference.                                                                                           |
| `actionResponse` |     Yes     | Exact final HTTP Profile `ActionResponse` known to the bridge. Its `executionResult` is absent.                    |
| `resolvedAt`     |     Yes     | Time at which the bridge finalized the Action outcome.                                                             |

An `ActionResponse` that carries `executionResult` is returned as the native
result (Section 6.2), never wrapped in this object.

If the bridge holds no final `ActionResponse` for a known Action — for
example, the Action Envelope expired without any Verifier response — the
bridge returns `MpasBridgeError` (for example,
`ACTION_EXPIRED_BEFORE_RESOLUTION`) rather than `MpasBridgeActionOutcome`.

`MpasBridgeActionOutcome` SHOULD be returned with MCP `isError: true`.

### 5.3 `MpasBridgeError`

A bridge reports a failure of the requested client operation — not an Action
outcome — with a standalone `MpasBridgeError`:

```json
{
  "version": "1",
  "type": "MpasBridgeError",
  "code": "RESULT_UNAVAILABLE",
  "message": "The requested Action result is no longer available.",
  "retryable": false
}
```

Fields:

| Field       | Required | Meaning                                                      |
| ----------- | :------: | ------------------------------------------------------------ |
| `version`   |   Yes    | MUST be `"1"`.                                               |
| `type`      |   Yes    | MUST be `MpasBridgeError`.                                   |
| `code`      |   Yes    | Stable machine-readable code.                                |
| `message`   |   Yes    | Sanitized human-readable description.                        |
| `retryable` |   Yes    | Whether repeating the same client request may succeed later. |

`retryable` describes the client request only. It never means "propose a new
Action"; proposing a new Action is always the Proposer's decision (Sections
4.3 and 9).

An `MpasBridgeError` is returned as an MCP tool result with `isError: true`
and the error object in `structuredContent`. JSON-RPC and MCP transport errors
are reserved for requests the bridge cannot answer with a tool result at all,
such as a malformed MCP request.

An `MpasBridgeError` is not an Action outcome and is not covered by the
stable-result guarantee (Section 7.3). A later identical request may return a
different error, a deferred result, a native result, or an
`MpasBridgeActionOutcome`.

Recommended client-visible codes:

| Code                               | Meaning                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `ACTION_NOT_FOUND`                 | No Action visible to the caller matches the supplied Action ID.                  |
| `RESULT_UNAVAILABLE`               | A known Action's result is no longer retained.                                   |
| `BRIDGE_UNAVAILABLE`               | The bridge cannot currently provide the requested client operation.              |
| `INVALID_WAIT_TIMEOUT`             | `timeoutSeconds` is outside the advertised schema.                               |
| `ACTION_EXPIRED_BEFORE_RESOLUTION` | The Action expired without a terminal Verifier response available to the client. |

`MpasBridgeError` content MUST be sanitized. It MUST NOT contain credentials,
authorization headers, private keys, tokens, environment values, or
unsanitized process output.

---

## 6. `mpas_wait_for_action_result`

### 6.1 Input

The reserved operation MUST use this input schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "actionId",
    "timeoutSeconds"
  ],
  "properties": {
    "actionId": {
      "type": "string",
      "minLength": 1,
      "description": "The actionRef.actionId.value string returned by an MPAS bridge result."
    },
    "timeoutSeconds": {
      "type": "integer",
      "minimum": 0,
      "maximum": 300,
      "description": "Maximum number of seconds to wait in this call."
    }
  }
}
```

`actionId` is the `actionRef.actionId.value` string disclosed by a previous
`MpasBridgeDeferredResult` or `MpasBridgeActionOutcome`.

A bridge MAY advertise a lower `timeoutSeconds` maximum. A low advertised
maximum — even one that makes the tool effectively a nonblocking status check
— is the intended path for a bridge that cannot hold requests open. Whatever
maximum the bridge advertises, it MUST honor the waits it accepts
(Section 6.3) and MUST NOT wait longer than the caller's requested timeout.

### 6.2 Available result

If execution produced a native upstream MCP result, the result tool MUST return
that result verbatim. It MUST NOT wrap the native result in
`MpasBridgeActionOutcome` or another profile-defined object.

If the Action terminated without a native upstream result, the result tool MUST
return `MpasBridgeActionOutcome`.

The stable-result guarantee in Section 7.3 applies to these results.

### 6.3 Unresolved Action

If the Action is unresolved, the call waits until either:

- the Action resolves; or
- `timeoutSeconds` elapses.

If the Action resolves first, the result tool MUST return the result defined
in Section 6.2.

If `timeoutSeconds` elapses first, the result tool MUST return an updated
`MpasBridgeDeferredResult`. The deferred result remains nonterminal and SHOULD
be returned with MCP `isError` absent or `false`.

`timeoutSeconds: 0` performs a nonblocking result check. A separate status tool
is not required by this profile version.

### 6.4 Effect of waiting

Calling, timing out, cancelling, or disconnecting from
`mpas_wait_for_action_result`:

- MUST NOT request a new application execution;
- MUST NOT cancel or reject the existing Action;
- MUST NOT change its expiration or authorization state; and
- MUST NOT be required for the Action to make progress.

The result tool observes the Action. It does not trigger the Action.

### 6.5 Unknown or unavailable Action

If the Action ID is not visible to the caller, the result tool MUST return an
`MpasBridgeError` with code `ACTION_NOT_FOUND` (Section 5.3).

If the bridge can distinguish a known Action whose result is no longer
retained without disclosing cross-client information, it MAY return
`RESULT_UNAVAILABLE`. Otherwise it SHOULD return `ACTION_NOT_FOUND`.

---

## 7. Cross-Request Guarantees

These guarantees describe the client-visible contract. They do not prescribe
an implementation mechanism.

### 7.1 Independent progress

After returning `MpasBridgeDeferredResult`, the Action may progress and resolve
without another request from the proposing client.

The bridge MUST NOT require a result-tool call merely to advance an accepted
Action.

### 7.2 Session independence

An authorized client MUST be able to retrieve the result from a later MCP
request and, where the deployment supports persistent client identity, a later
MCP session.

This profile does not specify how the bridge provides that behavior.

### 7.3 Stable result

Once the bridge returns a native upstream result or
`MpasBridgeActionOutcome`, subsequent authorized result calls during the
disclosed retention period MUST return the same result.

### 7.4 Retention disclosure

The deferred result discloses the minimum post-resolution retention period in
`resultRetentionSeconds`.

A bridge SHOULD advertise at least 24 hours of post-resolution availability.
The retention promise applies equally to a stored native upstream result and
an `MpasBridgeActionOutcome`.

### 7.5 Service unavailability

If the bridge cannot honor a result request temporarily, it MUST return an
`MpasBridgeError` (typically `BRIDGE_UNAVAILABLE` with `retryable: true`) or
an MCP transport error rather than claiming that the Action was rejected,
failed, or indeterminate.

Service availability errors are not MPAS Action outcomes.

---

## 8. Relationship to Lower-Layer Results

This profile reuses lower-layer objects without redefining them:

- `ActionRef` and `ActionResponse` come from the HTTP Profile.
- `Execution Receipt` comes from MPAS Core.
- native `executionResult` material follows the MCP Execution Profile.

A conforming bridge MUST NOT:

- expose the HTTP Profile's `pending` as a synonym for
  `additionalApprovalsRequired`; or
- synthesize a Verifier result from bridge-local activity. When it holds no
  Verifier response, it omits `lastActionResponse` (Section 5.1).

---

## 9. Client Requirements

A conforming proposing-client integration:

1. recognizes `MpasBridgeDeferredResult` and `MpasBridgeActionOutcome`;
2. retains the returned Action ID while it may still need the result;
3. notifies maintainers when `notificationRequired` is `true` and
   `lastActionResponse` is present, and ignores the flag otherwise;
4. treats that notification and related conversation as context, not an MPAS
   Approval;
5. uses `mpas_wait_for_action_result` rather than repeating the application
   tool to check progress, because a repeated application tool call proposes
   a new Action (Section 4);
6. treats a deferred result returned after waiting as nonterminal;
7. does not assemble Approval Bundles or submit completed Action Packages; and
8. after an `indeterminate` outcome, checks application state before proposing
   a new Action and never replays automatically.

A client MAY perform unrelated work between receiving a deferred result and
requesting the eventual result.

---

## 10. Security Considerations

### 10.1 Result access

A bridge serving more than one user, tenant, agent identity, or security domain
MUST authorize result access. Knowledge of an Action ID alone MUST NOT bypass
the deployment's isolation boundary.

### 10.2 Sensitive result material

Tool arguments, native results, receipts, and diagnostics may contain sensitive
information. Client-facing errors and summaries MUST be sanitized and
resource-bounded.

### 10.3 Notification is not approval

`notificationRequired`, delivery confirmation, chat messages, issue comments,
and human discussion MUST NOT be interpreted as an MPAS Approval.

### 10.4 Result integrity

A native MCP result remains informative unless another MPAS profile binds it
into an Execution Receipt. Returning the same stored result repeatedly does not
make that result a cryptographic attestation.

---

## 11. Client-Interface Conformance

A bridge claiming conformance to interface version `1` MUST pass black-box MCP
tests covering:

### 11.1 Tool discovery

- exact upstream application tool names, except an upstream operation
  superseded by the reserved result tool;
- semantically identical upstream input schemas;
- required reserved result tool;
- the Section 6.1 result-tool input schema, allowing only a documented lower
  deployment maximum for `timeoutSeconds`;
- reserved result tool supersedes an upstream operation with the same name;
- generated application-tool output-schema unions; and
- generated result-tool output-schema union or permitted omission when a
  reachable native structured result has no schema.

### 11.2 Application call results

- immediate native success;
- immediate definitive native tool failure;
- deferred exact `additionalApprovalsRequired` response;
- deferred result returned before any Verifier response, with
  `lastActionResponse` absent;
- native results are never wrapped;
- `MpasBridgeActionOutcome` is used only when no native result exists;
- a repeated identical application call proposes a new Action;
- a final `policyUnavailable` is passed through as `MpasBridgeActionOutcome`;
  and
- an approval-gated application call returns without waiting for Approvals.

### 11.3 Result retrieval

- result already resolved;
- result resolves during the wait;
- wait ends unresolved and returns an updated deferred result;
- updated deferred result with exact `pending`;
- nonblocking (`timeoutSeconds: 0`) result check;
- wait cancellation or disconnect does not change the Action;
- repeated result calls return the same native result or Action outcome;
- retrieval from a later authorized client session.

### 11.4 State and error separation

- `additionalApprovalsRequired` is preserved and not reported as `pending`;
- a deferred result returned after waiting is not terminal;
- bridge service unavailability is not reported as an Action outcome;
- `MpasBridgeError` is returned as a tool result with `isError: true` and a
  `version`/`type`-tagged `structuredContent` object;
- unknown and unavailable Action behavior is correctly scoped.

### 11.5 Security

- cross-client result access is rejected;
- errors and summaries do not expose prohibited sensitive material;
- malformed result-tool inputs fail safely.

Conformance tests interact only through the MCP client interface. They MUST NOT
require a particular database, worker model, polling algorithm, process
topology, or downstream service implementation.

Application-specific compatibility with a real upstream server belongs in that
bridge's application CI.

---

## 12. Versioning

The result-object `version`, together with the discovery signal in Section
3.4, identifies this MCP client interface. It does not identify the MPAS Core
version, HTTP Profile version, MCP Execution Profile version, or negotiated
MCP protocol version.

A backward-compatible revision may add optional members. A revision that
changes required fields, tool names, Verifier-result handling, or client
responsibilities requires a new interface version.

A client MUST reject an unsupported required interface version rather than
guessing its semantics.

---

## Appendix A — Worked Example

An approval-gated call, from proposal to result. The `structuredContent`
objects are abbreviated here; Section 5 gives them in full.

**1. Client calls an application tool.**

```json
{
  "name": "merge_pull_request",
  "arguments": {
    "owner": "oma3dao",
    "repo": "mpas",
    "pull_number": 42,
    "merge_method": "squash"
  }
}
```

**2. Bridge returns a deferred result**, ending the request. The client may now
notify a maintainer and do unrelated work.

```json
{
  "content": [
    {
      "type": "text",
      "text": "Additional MPAS approvals are required. Action urn:uuid:3f82f6e1-... remains active."
    }
  ],
  "structuredContent": {
    "version": "1",
    "type": "MpasBridgeDeferredResult",
    "actionRef": { "…": "actionId and actionEnvelopeHash" },
    "lastActionResponse": {
      "version": "1",
      "type": "ActionResponse",
      "result": "additionalApprovalsRequired",
      "authorizationRequirements": { "…": "" },
      "createdAt": "2026-07-26T18:00:00.000Z"
    },
    "notificationRequired": true,
    "expiresAt": "2026-07-26T19:00:00.000Z",
    "resultRetentionSeconds": 86400,
    "createdAt": "2026-07-26T18:00:00.000Z"
  }
}
```

**3. Client waits**, at any time and as often as it likes.

```json
{
  "name": "mpas_wait_for_action_result",
  "arguments": {
    "actionId": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1",
    "timeoutSeconds": 30
  }
}
```

**4a. The wait ends before the Action resolves** — an updated deferred result,
identical in shape to step 2 with a later `createdAt`. The Action remains
active; the client may wait again.

**4b. The Action resolved** — the native upstream result, verbatim:

```json
{
  "content": [{ "type": "text", "text": "Pull request merged." }]
}
```

**4c. The Action ended without a native result** — `MpasBridgeActionOutcome`
carrying the final `ActionResponse` (Section 5.2).

---

## Appendix B — Initial Review Decisions

The following client-interface decisions are normative as drafted and require
explicit review before the profile advances:

1. The standard result operation is named
   `mpas_wait_for_action_result`.
2. The result operation accepts a bounded wait of at most 300 seconds.
3. Native MCP results are returned verbatim by both application tools and the
   result tool.
4. Only the deferred result, the Action outcome, and the bridge error
   introduce profile-defined `structuredContent`.
5. The client receives exact Verifier results; this version defines no
   bridge-owned intermediate state. A bridge with no Verifier response omits
   `lastActionResponse` and may free the client immediately.
6. Deferred responses disclose a minimum result-retention interval.
7. The reserved result tool supersedes an upstream operation with the same
   name.
8. Generated output schemas union native and profile-defined result schemas.
9. The Signer / maintainer MCP client interface is outside this profile.
10. Conformance is black-box MCP testing and cannot require implementation
    mechanisms.
11. Every application tool call proposes a new Action; tool arguments are not
    an idempotency key.
12. `MpasBridgeActionOutcome` is terminal at the client interface: the bridge
    performs no further work on the Action after returning it, and a final
    `policyUnavailable` is passed through as such an outcome.
13. Proposer-initiated Action cancellation is deferred to a future interface
    version, pending Core and HTTP Profile support. Cancelling or abandoning
    a wait never cancels the Action (Section 6.4).
