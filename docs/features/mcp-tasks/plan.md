# Implementation Plan: Official MCP Tasks Extension Integration

**Spec:** [spec.md](./spec.md)

**Issue:** #33
**Created:** 2026-08-14

---

## Scope and Constraints

This plan migrates the MPAS proposer bridge from its proprietary wait tool to
the official `io.modelcontextprotocol/tasks` extension on MCP 2026-07-28.

The implementation MUST NOT use the experimental 2025-11-25 Tasks wire
format. Specifically, it does not implement a request `task` field,
`execution.taskSupport`, a nested `CreateTaskResult.task`, `tasks/result`, or
`tasks/list`.

Initial production rollout is limited to the GitHub and Netlify bridges. Other
generated bridges will be regenerated separately.

---

## Phase 0: SDK v2 and Temporary Tasks Schema Pin

### 0.1 Adopt the MCP SDK v2 packages

Use the published MCP 2026-07-28 SDK packages in bridge-facing code:

```json
{
  "@modelcontextprotocol/core": "2.0.0",
  "@modelcontextprotocol/server": "2.0.0"
}
```

The generated proposer bridge must use a narrow modern-protocol dispatcher for
discovery and per-request metadata over the SDK v2 stdio transport. Do not
import Tasks types or register `tasks/*` through the SDK v2 package: those
paths currently describe and enforce the older Tasks API. Keep the dispatcher
isolated so it can be removed when SDK v2 supports the official extension.

Other demo components that do not participate in the proposer bridge may
remain on the legacy monolithic SDK during this feature unless compilation or
integration requires their migration.

### 0.2 Vendor the official extension schemas temporarily

Create `sdk/protocol/src/lib/mcp-tasks-extension.ts` containing only the types
and Standard Schema-compatible validators needed for:

- flat `CreateTaskResult`
- `DetailedTask` variants
- `tasks/get`
- `tasks/update`
- `tasks/cancel`
- `io.modelcontextprotocol/tasks` extension capability

Source the definitions from:

```text
Repository: https://github.com/modelcontextprotocol/ext-tasks
Commit:     2c1425d9a288b9b1f489430fe1e00bb392b47e48
Source:     schema/draft/schema.ts
License:    Apache-2.0
```

Requirements:

- Preserve an attribution comment and pinned commit in the module.
- Keep the module independent from MPAS workflow logic.
- Add schema conformance tests using official example messages.
- Make replacement with official imports a one-module change.
- Do not take a runtime Git dependency on the upstream repository.

### 0.3 Track removal of the pin

Open the GitHub issue drafted in Appendix A before publishing the MPAS SDK
release. Link that issue from the vendored module's source comment.

---

## Phase 1: Workflow Model and Engine

### 1.1 Modify `sdk/protocol/src/lib/workflow-store.ts`

Task IDs reuse existing Action IDs, so no new task-ID column or lookup is
needed. `getWorkflow(taskId)` remains the lookup operation.

Changes:

- Add `cancelled` to `BridgeWorkflowState` and terminal-state detection.
- Add a cancelled `WorkflowResolution` variant if terminal details are needed.
- Add an atomic `cancelWorkflow(actionId)` operation. It succeeds only while
  the workflow is nonterminal and preserves first-terminal-write-wins behavior.
- Include cancelled workflows in retention purging.
- Keep `actionEnvelopeHash` stored as its existing digest string.
- Do not add pagination; the official extension has no `tasks/list`.

Update `MemoryWorkflowStore` and its contract tests for cancellation races,
terminal immutability, lookup by Action/Task ID, and purging.

### 1.2 Modify SQLite workflow stores

Update both:

- `examples/demo/src/bridge/sqlite-workflow-store.ts`
- the SQLite source emitted by `bridge-generator/src/bridge-codegen.ts`

The current schema can store `state: "cancelled"` and a JSON resolution in
existing columns, so no column migration is expected. Update queries and
terminal-state checks to include `cancelled`. Increment `SCHEMA_VERSION` only
if implementation changes require a physical schema change.

Add or update SQLite tests for:

- atomic cancellation
- cancellation versus resolution races
- cancelled retention purging
- reopening a store containing cancelled workflows

### 1.3 Modify `sdk/protocol/src/lib/workflow-engine.ts`

Extend `WorkflowCoordination` with the existing Coordination operation:

```typescript
cancelAction(actionId: ActionId, did: Did): Promise<CoordinationCancelResponse>;
```

Add engine cancellation behavior:

1. Load the workflow by Task/Action ID.
2. Verify it belongs to the configured proposer DID.
3. Atomically mark it cancelled if still active.
4. Best-effort call Coordination cancellation when Coordination was started.
5. Never advance a workflow after cancellation wins the terminal race.

Preserve current background workflow behavior and make the intended transient
retry behavior explicit:

- `tasks/get` must never call engine advancement methods.
- Normal ticks retry workflows left in `created` by a transient adapter or
  Coordination failure.
- A Coordination polling failure must not prevent independent retry or
  advancement of other claimable workflows.
- Retry ends when the Action expires or another terminal state wins.
- Ready packages and pending verifier work continue through the existing
  resubmission path.

No detailed approval-progress persistence is added.

Add engine tests for:

- retrying `created` after adapter failure
- retrying `created` after Coordination submission failure
- advancement continuing when Coordination polling is unavailable
- no advancement after cancellation
- cancellation versus verifier completion race
- expiry after repeated transient failures

---

## Phase 2: SDK Task Result Builders

The SDK remains versioned as `@oma3/mpas`. This phase produces
`0.1.0-alpha.5`.

### 2.1 Create `src/lib/mpas-task-meta.ts`

Exports:

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

function buildMpasTaskMeta(record: WorkflowRecord): MpasTaskMeta;
```

Implementation rules:

- Map only active workflow states.
- Extract `requirements` from
  `authorizationRequirements.approvalRequirements`.
- Read the complete `actionEnvelopeHash` from the stored signed Action Package.
- Optionally verify its `value` matches the stored digest string and fail
  closed on inconsistency.
- Do not modify the database hash representation.
- Do not implement opaque/both modes or approval counts.

### 2.2 Create `src/lib/bridge-tasks.ts`

Build official extension results:

```typescript
function buildCreateTaskResult(
  record: WorkflowRecord,
  config: TaskResultConfig,
): CreateTaskResult;

function buildGetTaskResult(
  record: WorkflowRecord,
  config: TaskResultConfig,
): GetTaskResult;

function buildUpdateTaskResult(): UpdateTaskResult;
function buildCancelTaskResult(): CancelTaskResult;
```

Rules:

- `CreateTaskResult` is flat and has `resultType: "task"`.
- `GetTaskResult` has `resultType: "complete"`.
- Use `taskId: record.actionId`.
- Use `ttlMs` and `pollIntervalMs` field names.
- Put MPAS metadata at `_meta["org.oma3/mpas"]` for working Tasks.
- Completed workflows inline their `CallToolResult` in `result`.
- Preserve native upstream results verbatim inside `result`.
- Terminal MPAS outcomes without a native result synthesize a
  `CallToolResult` with `isError: true` and the ActionResponse in
  `structuredContent`.
- Use Task `failed` only when the stored underlying outcome is a JSON-RPC
  execution error; include that error in `error`.
- Cancelled Tasks carry no `result` or `error`.

Compute `ttlMs` from the workflow's actual retention boundary:

```text
max(expiresAt, resolvedAt + resultRetention) - createdAt
```

While active, use the envelope expiration as the current boundary. The value
may increase when the workflow resolves.

### 2.3 Modify `src/lib/bridge-runtime.ts`

Remove:

- wait-tool routing and `handleWait()`
- description notices
- output-schema union generation
- disclosure-mode options
- timeout options specific to the wait tool

Change:

- `getToolDefinitions()` returns exact upstream definitions.
- `handleToolCall()` always returns a flat `CreateTaskResult` after the Action
  is durably stored.
- Existing workflow background `pollIntervalMs` continues to control internal
  engine ticks.
- Add `taskPollIntervalMs` for the client-facing polling hint, default 5000.

Add:

```typescript
handleTasksGet(taskId: string): GetTaskResult
handleTasksUpdate(taskId: string, inputResponses: InputResponses): UpdateTaskResult
handleTasksCancel(taskId: string): Promise<CancelTaskResult>
```

For all task operations, verify that the proposer DID inside the stored signed
Action Package equals the bridge's configured proposer DID. Treat mismatches
as not found.

Unknown Tasks produce an invalid-params exception suitable for conversion to
JSON-RPC `-32602`. Store inconsistencies produce an internal-error exception.
Do not return JSON-RPC error objects as successful handler results.

### 2.4 Modify `src/lib/bridge-results.ts`

Remove:

- `MPAS_WAIT_TOOL_NAME`
- wait-tool definitions and validation
- deferred/action-outcome builders
- output-schema union generation
- description notice helpers
- `toolResultForRecord()`

Keep or relocate:

- minimal `CallToolResult` helpers used to synthesize terminal MPAS errors
- interface/version constants still used by published MPAS payloads

### 2.5 Public exports and dependencies

Modify `src/index.ts` and `sdk/protocol/package.json`:

- export `bridge-tasks.ts`, `mpas-task-meta.ts`, and the isolated official
  Tasks extension types/schemas
- remove wait-tool and deferred-result exports
- add a `./bridge-tasks` subpath export
- bump `@oma3/mpas` to `0.1.0-alpha.5`
- use SDK v2 types where needed
- add the validation dependency selected for the vendored Standard Schemas

### 2.6 SDK tests

Add `tests/lib/mcp-tasks-extension.test.ts`:

- official flat CreateTaskResult example validates
- working/completed/failed/cancelled DetailedTask examples validate
- `tasks/get`, `tasks/update`, and `tasks/cancel` requests validate
- older nested `{ task: ... }` format is rejected
- `ttl`/`pollInterval` spellings are rejected

Add `tests/lib/bridge-tasks.test.ts`:

- immediate native execution -> completed CreateTaskResult
- authorization required -> working with transparent MPAS metadata
- adapter unavailable -> working/submitted
- pending -> working/pending
- terminal MPAS rejection -> completed Task with `result.isError: true`
- native result -> completed Task with exact result passthrough
- cancelled -> cancelled Task
- metadata hash comes from the signed Action Package
- stored digest representation remains unchanged
- active and terminal TTL calculations match store retention

Update `tests/lib/bridge-runtime.test.ts`:

- no wait tool
- exact upstream descriptions and schemas
- no `execution.taskSupport` injection
- every application call returns a flat task result
- working/completed task reads
- unknown and cross-DID Tasks are not found
- update acknowledgement for a known Task
- cooperative cancellation acknowledgement
- terminal cancellation is an acknowledged no-op

Update/remove obsolete `bridge-results.test.ts` cases.

Run:

```bash
cd mpas/sdk/protocol
npm run build
npm test
```

---

## Phase 3: Bridge Generator and MCP Server Wiring

### 3.1 Modify `bridge-generator/src/bridge-codegen.ts`

Generated code must use MCP SDK v2 and MCP 2026-07-28.

Remove:

- proprietary wait-tool assumptions
- old Tasks capability declarations
- `task` request-field checks
- `execution.taskSupport`
- `tasks/result` and `tasks/list`

Add:

- `server/discover` support through the isolated MCP 2026 dispatcher
- server extension capabilities:

  ```json
  {
    "io.modelcontextprotocol/tasks": {},
    "org.oma3/mpas": {
      "version": "2",
      "disclosure": "transparent"
    }
  }
  ```

- per-request checks for both extension declarations
- `-32021` `MissingRequiredClientCapabilityError` responses with structured
  `requiredCapabilities`
- validated dispatch for `tasks/get`, `tasks/update`, and `tasks/cancel`
- invalid-params exceptions for unknown or cross-DID Task IDs
- exact upstream tool definitions

Update `unconfiguredCoordination()` with `cancelAction()` returning a rejected
Promise so cancellation remains explicitly best effort when Coordination is
not configured.

### 3.2 Generated package dependencies

Change generated `bridge/package.json` dependencies to include:

- `@modelcontextprotocol/server@2.0.0`
- `@oma3/mpas@^0.1.0-alpha.5`

Remove the generated bridge's dependency on the monolithic
`@modelcontextprotocol/sdk` unless another generated component still imports
it.

### 3.3 Generator tests

Update `bridge-generator/tests/codegen.test.ts` to assert:

- no `mpas_wait_for_action_result`
- no schema unions or description notices
- no `execution.taskSupport`
- no request `task` requirement
- no `tasks/result` or `tasks/list`
- `tasks/get`, `tasks/update`, and `tasks/cancel` handlers
- both extension identifiers in discovery capabilities
- transparent-only MPAS settings
- SDK v2 imports and package dependencies
- generated SQLite store includes cancelled terminal handling

Run:

```bash
cd mpas/bridge-generator
npm run build
npm test
```

---

## Phase 4: Local Demo and Conformance Testing

### 4.1 Update demo proposer bridge wiring

Update the proposer bridge portions of `examples/demo/src/bridge/` to match
the generated SDK v2 wiring. Other signer and adapter MCP clients may remain on
their current SDK where they do not participate in the 2026 Tasks interface.

### 4.2 Update direct integration tests

Replace wait-tool cases in
`examples/demo/tests/e2e/mcp-bridge-stack.test.ts` with:

1. immediate execution -> flat completed CreateTaskResult
2. governed execution -> working CreateTaskResult with transparent metadata
3. `tasks/get` polling while awaiting authorization
4. approval collection -> completed `tasks/get.result`
5. rejection -> completed `tasks/get.result.isError: true`
6. transient adapter failure -> later retry and completion
7. cancellation -> empty acknowledgement and observable cancelled state
8. terminal cancellation -> empty acknowledgement
9. cross-DID lookup -> not found

### 4.3 Update stdio protocol tests

Update `examples/demo/tests/e2e/mcp-bridge-stdio.test.ts` or replace it with a
2026-capable raw/v2 client test covering:

- `server/discover`
- both advertised extensions
- missing per-request extensions -> `-32021`
- application call without a `task` request field
- flat `resultType: "task"` response
- `tasks/get` terminal result inlining
- `tasks/update` acknowledgement
- `tasks/cancel` acknowledgement
- absence of `tasks/result`, `tasks/list`, and wait tool

Validate response bodies against the temporarily vendored official schemas.

### 4.4 Run demo tests

```bash
cd mpas/examples/demo
npm run build
npm test
```

---

## Phase 5: Local Generator Integration

### 5.1 Link the SDK

```bash
cd mpas/sdk/protocol
npm run build
npm link

cd ../../bridge-generator
npm run build
```

### 5.2 Regenerate a temporary GitHub bridge

Use the sibling `mpas-applications/applications/github/harness-config.json`
and the actual generator CLI syntax. Do not use placeholder paths in the
checked-in instructions.

Generate into a temporary directory, link `@oma3/mpas`, build it, and run a
2026 Tasks smoke test. Repeat for Netlify if its upstream configuration differs
materially.

The smoke test must exercise discovery, missing-capability rejection, task
creation, task polling, terminal result inlining, and cancellation.

---

## Phase 6: Publish MPAS SDK

Before publishing:

- all SDK tests pass
- generator tests pass
- demo integration tests pass
- the temporary schema-pin GitHub issue exists and is linked from source
- the vendored extension files contain license attribution and the pinned SHA

Publish:

```bash
cd mpas/sdk/protocol
npm run build
npm test
npm publish --tag alpha
```

Published version: `0.1.0-alpha.5`.

---

## Phase 7: GitHub and Netlify Production Bridges

### 7.1 Update dependencies

Update only:

- `mpas-applications/applications/github/bridge/package.json`
- `mpas-applications/applications/netlify/bridge/package.json`

Use `@oma3/mpas@^0.1.0-alpha.5` and the SDK v2 server/node packages emitted by
the generator.

### 7.2 Regenerate

Regenerate only the GitHub and Netlify bridges for this rollout. Other
applications intentionally remain out of scope and will be regenerated later.

### 7.3 Harness configuration

Remove intentional deviations for:

- added wait tool
- output-schema unions
- modified descriptions

Record the two extension capabilities and exact upstream tool preservation.
Do not add `taskSupportOverride`; the official extension does not use it.

Suggested note:

```json
{
  "intentionalDeviations": {
    "renamedTools": {},
    "wrappedSchemas": [],
    "modifiedDescriptions": [],
    "addedTools": [],
    "extensionCapabilities": [
      "io.modelcontextprotocol/tasks",
      "org.oma3/mpas"
    ],
    "note": "The bridge uses the official MCP Tasks extension and exposes MPAS authorization metadata through org.oma3/mpas. Upstream tool definitions are unchanged."
  }
}
```

### 7.4 Production tests

For both GitHub and Netlify, test:

1. immediate native result
2. authorization required
3. approval then completion
4. MPAS rejection as completed `isError` result
5. expiration after transient/background processing
6. cooperative cancellation
7. missing Tasks extension capability
8. missing MPAS profile-extension capability
9. no request `task` field required
10. exact upstream tool definitions

Production environment credentials, policies, and signer setup are deployment
prerequisites and are not created by this feature.

---

## Phase 8: Normative Documentation

### 8.1 Revise the proposer bridge profile in place

Update `specs/mpas-profile-mcp-proposer-bridge-client.md` in place so its Git
history and existing links show the transition from version 1 to version 2:

- identify the contract as the MPAS MCP Proposer Bridge Profile
- bump the draft to v0.2 and the profile/interface version to `2`
- identify the official Tasks extension path as the replacement interface
- deprecate the wait tool, tool-presence discovery, description notices, and
  output-schema unions
- make clear that the old 2025-11-25 Tasks API is not the target
- define the `org.oma3/mpas` profile-extension capability and Task metadata

### 8.2 Consolidate the normative contract

Keep the normative client-facing contract in the proposer-bridge profile. Do
not create a standalone MPAS extension specification. The profile must define:

- dependency on `io.modelcontextprotocol/tasks`
- transparent-only settings
- per-request negotiation
- `_meta["org.oma3/mpas"]` schema
- DID-scoped visibility
- MCP-to-MPAS state mapping
- cooperative cancellation limitations

---

## Files Changed

### `mpas`

| Path | Action |
|---|---|
| `sdk/protocol/src/lib/mcp-tasks-extension.ts` | Create temporary pinned extension schemas |
| `sdk/protocol/src/lib/mpas-task-meta.ts` | Create |
| `sdk/protocol/src/lib/bridge-tasks.ts` | Create |
| `sdk/protocol/src/lib/bridge-runtime.ts` | Modify |
| `sdk/protocol/src/lib/bridge-results.ts` | Remove proprietary surface helpers |
| `sdk/protocol/src/lib/workflow-store.ts` | Add cancellation terminal behavior |
| `sdk/protocol/src/lib/workflow-engine.ts` | Add cancellation and correct transient retries |
| `sdk/protocol/src/index.ts` | Modify exports |
| `sdk/protocol/package.json` | SDK v2 dependencies and version bump |
| `sdk/protocol/tests/lib/mcp-tasks-extension.test.ts` | Create |
| `sdk/protocol/tests/lib/bridge-tasks.test.ts` | Create |
| `sdk/protocol/tests/lib/bridge-runtime.test.ts` | Modify |
| `sdk/protocol/tests/lib/workflow-store.test.ts` | Modify |
| `sdk/protocol/tests/lib/workflow-engine.test.ts` | Modify |
| `bridge-generator/src/bridge-codegen.ts` | SDK v2 and official Tasks handlers |
| `bridge-generator/src/generate.ts` | Generated dependency changes |
| `bridge-generator/tests/codegen.test.ts` | Modify |
| `examples/demo/src/bridge/` | Update proposer bridge wiring/store |
| `examples/demo/tests/e2e/mcp-bridge-stack.test.ts` | Modify |
| `examples/demo/tests/e2e/mcp-bridge-stdio.test.ts` | Modify or replace |
| `specs/mpas-profile-mcp-proposer-bridge-client.md` | Revise in place as the normative v0.2 proposer-bridge profile using official Tasks |

### `mpas-applications` initial rollout

| Path | Action |
|---|---|
| `applications/github/bridge/` | Regenerate |
| `applications/github/harness-config.json` | Update deviations |
| `applications/netlify/bridge/` | Regenerate |
| `applications/netlify/harness-config.json` | Update deviations |

---

## Acceptance Criteria

- The wait tool and MPAS result wrappers are absent.
- Tool definitions match upstream exactly.
- The server speaks MCP 2026-07-28 through SDK v2.
- Discovery advertises the official Tasks extension and MPAS profile extension.
- Missing capabilities return structured `-32021` errors.
- Application calls return flat official `CreateTaskResult` objects.
- `tasks/get` inlines terminal results and errors.
- `tasks/update` and `tasks/cancel` return empty complete acknowledgements.
- No `tasks/result`, `tasks/list`, request `task`, or `taskSupport` behavior is
  present.
- Task/Action IDs are the same random UUID URN.
- Task visibility is scoped to the configured proposer DID.
- Transparent MPAS metadata appears only under `_meta["org.oma3/mpas"]`.
- The database hash string remains unchanged.
- Background MPAS workflow progression and transient retries continue without
  client requests.
- GitHub and Netlify builds and tests pass.
- The temporary upstream schema pin is documented and tracked for removal.

---

## Appendix A: GitHub Issue Draft

**Title:** Replace pinned MCP Tasks schemas and dispatcher with official SDK support

```markdown
## Summary

MPAS temporarily vendors the MCP Tasks extension types and schemas from the
official `modelcontextprotocol/ext-tasks` repository because they are not yet
available through a published official SDK or extension package.

The base MCP 2026-07-28 protocol support comes from:

- `@modelcontextprotocol/server@2.0.0`
- `@modelcontextprotocol/core@2.0.0`

The Tasks extension schema is pinned to:

- Repository: https://github.com/modelcontextprotocol/ext-tasks
- Commit: `2c1425d9a288b9b1f489430fe1e00bb392b47e48`
- Source: `schema/draft/schema.ts`

## Why this is temporary

The published SDK v2 supports the 2026-07-28 extension framework and
stdio transport, but its exported task types and server routing still describe
the older 2025-11-25 core Tasks API. In the modern protocol era the server
rejects `tasks/*` before extension handlers can process those methods.

The official `@modelcontextprotocol/ext-tasks` package is currently marked
private and is not published to npm. MPAS therefore cannot consume the
official Tasks extension schemas as a normal versioned dependency.

MPAS consequently also carries a narrow MCP 2026 dispatcher around the SDK v2
transport. The dispatcher handles `server/discover`, `tools/list`,
`tools/call`, `tasks/get`, `tasks/update`, and `tasks/cancel` only.

## Follow-up

Once the official TypeScript SDK or a published official Tasks extension
package exposes the new extension schemas:

- [ ] Replace the vendored MPAS task schemas with official imports.
- [ ] Remove the pinned upstream schema copy and attribution notice.
- [ ] Replace the temporary MPAS Tasks dispatcher with official SDK extension
      registration and routing.
- [ ] Run SDK, bridge-generator, and GitHub/Netlify integration tests.
- [ ] Compare the published schemas with the pinned commit for wire changes.
- [ ] Update the MPAS SDK dependency and release notes.
- [ ] Close this issue after the initial generated bridges use the official dependency.

## Compatibility warning

Do not replace the vendored schemas with SDK exports named `CreateTaskResult`,
`GetTaskResult`, or related task types without checking their wire format.
Those currently represent the older API, including nested `task`,
`tasks/result`, and `tasks/list` semantics. Also confirm that the SDK routes
official extension `tasks/*` methods in the MCP 2026 protocol era before
removing the MPAS dispatcher.
```
