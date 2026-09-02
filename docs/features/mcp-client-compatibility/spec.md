# MCP Client Compatibility for MPAS Proposer Bridges

**Status:** Draft

**Created:** 2026-08-23

**Depends on:** [Official MCP Tasks integration](../mcp-tasks/spec.md), [MPAS MCP Proposer Bridge Profile](../../../specs/mpas-profile-mcp-proposer-bridge-client.md)

**Companion:** [plan.md](./plan.md)

---

## 1. Purpose

Define a temporary compatibility path that lets an MPAS proposer bridge serve
both:

1. MCP clients that implement MCP 2026-07-28 and the
   `io.modelcontextprotocol/tasks` extension; and
2. conventional MCP clients that initialize with `initialize` and cannot
   consume the Tasks extension.

The bridge detects the client's protocol from the wire handshake. The user is
not required to choose a bridge command, know a harness version, or configure a
protocol mode. Once selected, the mode is fixed for the connection.

This feature restores the legacy `mpas_wait_for_action_result` client surface
only as a compatibility adapter. It does not revert the Tasks implementation,
change the MPAS workflow, or create an alternate path to an application.

This feature amends the “No backward-compatibility shim” decision in
[`mcp-tasks/spec.md`](../mcp-tasks/spec.md) for the duration of the compatibility
period. The Tasks profile remains the primary MPAS proposer-bridge interface.

---

## 2. Problem and Confirmed Boundary

The pre-Tasks bridge used the conventional MCP server lifecycle. A client sent
`initialize`, received a normal MCP initialization result, then used
`tools/list` and `tools/call`. Long-running MPAS Actions were represented by
`MpasBridgeDeferredResult` and observed through the reserved
`mpas_wait_for_action_result` tool.

The Tasks bridge replaced that server with `MpasTasksServer`, a narrow MCP
2026-07-28 dispatcher. It recognizes `server/discover`, `tools/list`,
`tools/call`, and the supported `tasks/*` methods, and it requires the Tasks and
MPAS extension capabilities on task-bearing requests. It does not recognize
the conventional `initialize` request.

A conventional harness therefore fails during MCP initialization. This occurs
before an application tool call and consequently before:

- an Action Package is created;
- Coordination is contacted;
- the Credential Adapter receives a request;
- OAuth refresh or credential substitution runs; or
- the upstream application is contacted.

The compatibility boundary is the client-facing MCP protocol and result
presentation. MPAS governance and application execution are not part of the
fallback boundary.

---

## 3. Goals

1. Detect Tasks-capable and conventional MCP clients from their actual
   handshake, not from a product name or version table.
2. Preserve the current Tasks behavior for Tasks-capable clients.
3. Provide the legacy deferred-result and wait-tool behavior to clients that
   use conventional MCP initialization.
4. Use one bridge command and one bridge configuration.
5. Use one shared MPAS workflow implementation in both modes.
6. Use one proposer skill whose instructions adapt to the exposed tool
   surface.
7. Fail closed on unknown, ambiguous, or mixed-protocol behavior.
8. Keep the compatibility implementation isolated and removable.
9. Roll the compatibility-capable SDK and generated runtime through every
   maintained MPAS application bridge before the feature is considered
   complete.

## 4. Non-goals

This feature does not:

- infer support from OpenClaw, Hermes, or another harness version;
- require a user or agent to select a different MCP server executable;
- emulate Tasks inside a harness that does not support Tasks;
- add the experimental 2025-11-25 core Tasks API;
- add `tasks/list`, `tasks/result`, a request `task` field, or
  `execution.taskSupport`;
- change MPAS policy, approval, signing, Coordination, Adapter, or execution
  semantics;
- add a direct Netlify or other application path;
- expose application credentials to the proposer bridge or agent;
- change an application's upstream tool inventory, policy classification,
  credential requirements, or execution profile; only client-facing harness
  deviation metadata changes to describe the two protocol surfaces; or
- promise permanent support for the legacy client surface.

---

## 5. Terminology

**Undetermined mode** is the state after the stdio transport starts but before
the bridge has observed a protocol-selecting request.

**Tasks mode** is the existing MCP 2026-07-28 interface using
`server/discover`, `io.modelcontextprotocol/tasks`, and `org.oma3/mpas`.

**Compatibility mode** is the conventional MCP interface using `initialize`,
ordinary MCP tools, `MpasBridgeDeferredResult`, and
`mpas_wait_for_action_result`.

**Protocol selector** is the connection-local dispatcher that chooses exactly
one of those modes from the client's messages.

---

## 6. Protocol Selection

### 6.1 Selection Rules

Each bridge process serves one MCP client and begins in undetermined mode. The
selector MUST apply these rules in order:

| First protocol-defining request | Selected mode |
|---|---|
| `initialize` | Compatibility |
| `server/discover` | Tasks |
| A request carrying the MCP 2026-07-28 protocol-version metadata | Tasks |
| `tools/list` before either handshake | Tasks, preserving the current Tasks dispatcher behavior |

`ping` MAY be answered while leaving the mode undetermined. Notifications that
do not define a protocol MUST NOT select a mode.

A conventional MCP client is expected to send `initialize` before
`tools/list` or `tools/call`. A nonconforming client that sends an ambiguous
operation before initialization does not cause a legacy downgrade.

The selector MUST NOT inspect `clientInfo.name`, `clientInfo.version`, command
paths, user-agent strings, or process names to choose a mode.

### 6.2 Mode Locking

After selection, the mode MUST remain fixed for the lifetime of the connection.
The bridge MUST NOT switch modes because a request fails, lacks a capability,
times out, or uses an unknown method.

Cross-protocol requests after selection MUST fail without changing mode:

- `initialize` in Tasks mode is rejected as an incompatible method;
- `server/discover` and `tasks/*` in compatibility mode are rejected; and
- a missing Tasks capability in Tasks mode returns the existing structured
  missing-capability error and MUST NOT trigger compatibility mode.

This prevents protocol confusion and silent downgrade after an Action exists.

### 6.3 Unsupported Handshakes

An unsupported protocol-defining request MUST receive a clear JSON-RPC error.
The error MAY identify the two supported handshakes but MUST NOT claim support
for an arbitrary protocol version.

The list of conventional MCP protocol versions accepted by compatibility mode
MUST be explicit in code and tests. Unsupported versions MUST be rejected using
normal MCP version-negotiation behavior rather than echoed back as supported.

### 6.4 Diagnostic Override

An implementation MAY provide an internal or CLI diagnostic override that
forces Tasks or compatibility mode. The default production behavior MUST be
automatic handshake detection. Agent instructions and normal harness setup
MUST NOT depend on the override.

---

## 7. Tasks Mode

Tasks mode is the interface specified by
[`mcp-tasks/spec.md`](../mcp-tasks/spec.md) and the MPAS MCP Proposer Bridge
Profile. In particular:

- `server/discover` advertises `io.modelcontextprotocol/tasks` and
  `org.oma3/mpas`;
- application tool definitions match the upstream definitions;
- `mpas_wait_for_action_result` is absent;
- a fast terminal application call returns a normal complete MCP result, while
  a deferred call returns a flat `CreateTaskResult`;
- `tasks/get`, `tasks/update`, and `tasks/cancel` retain their current behavior;
- required per-request extension metadata is enforced; and
- missing capability errors do not select compatibility mode.

The compatibility feature MUST add regression tests demonstrating that these
behaviors and wire shapes have not changed.

---

## 8. Compatibility Mode

### 8.1 Initialization

Compatibility mode MUST implement the conventional MCP initialization
lifecycle expected by the target harnesses:

1. accept a supported `initialize` request;
2. return the negotiated protocol version, server information, and `tools`
   capability;
3. accept the corresponding initialized notification; and
4. serve ordinary `ping`, `tools/list`, and `tools/call` requests.

Initialization MUST NOT load, request, log, or expose an application
credential. It MAY load the configured proposer key through the same current
bridge startup path used by Tasks mode.

### 8.2 Tool Surface

Compatibility mode exposes:

1. every upstream application tool;
2. the reserved `mpas_wait_for_action_result` tool; and
3. no `tasks/*` operations.

Application tool names and input schemas MUST remain compatible with the
upstream server. As in the previous MPAS client profile, compatibility mode MAY
append the standard MPAS deferred-result notice to descriptions and MUST add
the legacy result alternatives to an existing output schema. Those changes
MUST be deterministic and limited to compatibility mode.

The presence of `mpas_wait_for_action_result` is the agent-visible signal that
the harness is using compatibility mode.

### 8.3 Application Calls

Every accepted application tool call MUST create a new signed MPAS Action
through the current shared workflow. Compatibility mode MUST NOT proxy the
operation directly to the upstream application.

The result is presented using the legacy interface:

- an immediately available native upstream `CallToolResult` is returned
  verbatim;
- an active workflow returns `MpasBridgeDeferredResult`;
- a terminal workflow without a native application result returns
  `MpasBridgeActionOutcome` or the corresponding legacy terminal error; and
- a bridge operation error returns `MpasBridgeError`.

`MpasBridgeDeferredResult.actionRef.actionId.value` MUST equal the Action ID
and the Task ID that Tasks mode would use for the same stored workflow.

A repeated application call always proposes a new Action. It MUST NOT be used
as a status check.

### 8.4 Reserved Wait Tool

`mpas_wait_for_action_result` accepts the legacy input:

```json
{
  "actionId": "urn:uuid:786512e2-9e0d-44bd-8f29-789f320fe840",
  "timeoutSeconds": 30
}
```

The tool:

- MUST be read-only and scoped to the bridge's configured proposer DID;
- MUST NOT create, advance, resubmit, approve, reject, or cancel an Action;
- MAY wait only up to the configured maximum;
- MUST return promptly for `timeoutSeconds: 0`;
- returns another deferred result while the Action remains active;
- returns the native result verbatim when available; and
- returns a terminal compatibility result when no native result can become
  available.

Unknown Actions and Actions belonging to another proposer identity MUST be
indistinguishable to the caller.

### 8.5 Cancellation and Cross-mode Records

Compatibility mode does not add a cancellation tool. If it observes a workflow
already recorded as cancelled, it MUST return a terminal, non-retryable legacy
error or outcome. It MUST NOT represent a cancelled workflow as active.

The exact cancellation mapping MUST be stable and covered by tests.

---

## 9. Shared Workflow and Restart Behavior

Protocol selection changes only the MCP presentation layer. Both modes MUST
use the same current implementations of:

- Action Package construction and proposer signing;
- `WorkflowStore` and workflow state transitions;
- background reconciliation and retry;
- Coordination submission, polling, and request signing;
- authorization-requirement handling;
- Credential Adapter submission;
- result retention and proposer-DID isolation; and
- OAuth credential substitution inside the Credential Adapter.

The compatibility implementation MUST NOT restore an old snapshot of these
components. Pre-Tasks code may be used only as a reference for the legacy wire
contract and result shapes.

Workflow records MUST remain protocol-neutral. After a process restart, a
workflow created through either mode MAY be observed through the other mode if
the same bridge identity and workflow store are used. The Action ID remains
the common handle.

MCP observation does not drive workflow progression in either mode. Tasks
`tasks/get` and compatibility `mpas_wait_for_action_result` observe stored
state; the background engine advances it.

---

## 10. Agent Instructions

There is one logical MPAS proposer skill, not separate Tasks and compatibility
variants. The canonical and ClawHub-packaged copies MUST contain the same
protocol-selection guidance and keep their published versions synchronized.

The skill MUST include these two sentences:

> If `mpas_wait_for_action_result` is present in the available tools, treat
> application calls as deferred and use that tool to retrieve their results.
> If it is absent, do not attempt to call it; the harness manages MCP Tasks.

Other proposer instructions MUST not contradict this guidance. In particular,
the skill MUST no longer tell a non-Tasks client to report incompatibility when
the bridge has successfully selected compatibility mode.

The skill MUST continue to instruct the agent that:

- the application tool is called only once per proposed Action;
- the returned Action or Task ID and originating bridge are retained;
- additional authorization is reported to an eligible Maintainer;
- the proposer cannot approve its own Action;
- a nonterminal response is not successful execution; and
- no direct API, CLI, UI, alternate MCP server, or credential path may bypass
  the MPAS bridge.

---

## 11. Security Requirements

Protocol mode is not an authorization decision. Selecting compatibility mode
MUST NOT weaken or skip any MPAS control.

Both modes MUST preserve:

1. **Governance:** every governed application operation becomes an MPAS Action.
2. **Action binding:** the proposer signs the exact Action Envelope and payload.
3. **Independent authorization:** required Approvals come from eligible
   Signers through Coordination; the proposer cannot self-approve.
4. **Authenticated Coordination:** the bridge signs Coordination requests with
   its configured proposer key.
5. **Credential custody:** application OAuth credentials remain in the
   Credential Adapter and are substituted only during authorized execution.
6. **No direct path:** the proposer bridge does not call Netlify or another
   protected upstream directly.
7. **Identity isolation:** task and wait lookups are restricted to workflows
   belonging to the configured proposer DID.
8. **Fail-closed negotiation:** unknown or mixed protocols do not bypass
   capability checks or select a weaker execution path.
9. **Safe logging:** initialization metadata, tool arguments, results, and
   errors are logged without credentials or private key material.

The implementation MUST include negative tests showing that compatibility mode
still submits through the Adapter and cannot execute through a direct upstream
transport.

---

## 12. Observability

The bridge SHOULD emit a structured stderr event when mode is selected:

```json
{
  "msg": "mcp_protocol_mode_selected",
  "mode": "compatibility",
  "selector": "initialize"
}
```

The event MUST NOT contain credentials, private key material, authorization
headers, or complete tool arguments. Mode selection SHOULD be logged exactly
once per connection.

Initialization failures SHOULD identify whether the failure occurred before
mode selection, during Tasks discovery, or during conventional MCP
initialization.

---

## 13. Compatibility and Conformance Tests

At minimum, conformance requires:

| Client behavior | Expected result |
|---|---|
| `server/discover` first | Tasks mode selected and existing extensions advertised |
| `initialize` first with a supported version | Compatibility mode selected and tools capability returned |
| `ping` before handshake | Successful ping without mode selection |
| `tools/list` before handshake | Tasks surface, preserving current behavior |
| Legacy `tools/list` after initialization | Application tools plus `mpas_wait_for_action_result` |
| Tasks `tools/list` after discovery | Exact upstream application tools and no wait tool |
| Missing Tasks capabilities after Tasks selection | Existing `-32021`; no fallback |
| `initialize` after Tasks selection | Error; mode unchanged |
| `server/discover` or `tasks/get` after compatibility selection | Error; mode unchanged |
| Compatibility application call | Signed Action submitted through the Adapter path |
| Compatibility wait on active Action | Deferred result without workflow advancement |
| Compatibility wait on completed Action | Native or terminal result |
| Lookup for another proposer DID | Not found/invisible |
| Restart into the other mode | Existing workflow remains observable by Action ID |

The target OpenClaw and Hermes versions MUST also be probed as real subprocess
clients or with captured, credential-free protocol transcripts. Product-version
probes supplement wire conformance tests; they do not become selection logic.

---

## 14. Application Rollout

Rollout is staged but fleet-wide:

1. The Netlify proposer bridge is the first canary because it reproduces the
   reported initialization failure and exercises Adapter-managed OAuth.
2. After the canary passes both protocol modes, every maintained generated
   application bridge MUST be regenerated or updated to consume the same
   compatibility-capable SDK and protocol selector.
3. Every bridge MUST pass initialization and tool-list probes in both modes.
4. Bridges with credential substitution or OAuth behavior require the
   additional checks in Section 11 and the implementation plan.

The existing bridge command and configuration remain the same for every
application. Prosper and other users should not need an MCP command change;
the harness's handshake selects the mode automatically.

Rollout MUST preserve each application's existing upstream command, tool
surface, classifications, DIDs, execution profile, credential requirements,
and Adapter configuration. The rollout is incomplete if any maintained bridge
still initializes only through the Tasks interface.

---

## 15. Removal Criteria

The compatibility adapter is temporary. Removal requires evidence that all
supported production harnesses can initialize the Tasks bridge and manage the
official Tasks lifecycle.

Before removal:

1. announce deprecation in release notes and the proposer skill;
2. retain telemetry or operator-visible mode logs long enough to identify
   remaining compatibility use without collecting sensitive data;
3. update supported-harness probes;
4. remove the legacy result helpers, wait tool, and selector branch together;
   and
5. restore Tasks-only instructions only after the compatibility path is no
   longer shipped.
