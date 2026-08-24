# Implementation Plan: MCP Client Compatibility

**Status:** Draft

**Created:** 2026-08-23

**Spec:** [spec.md](./spec.md)

---

## Scope and Constraints

Add automatic client-protocol detection to MPAS proposer bridges while keeping
the official MCP Tasks implementation primary. Netlify is the first production
canary, followed by a mandatory rollout to every maintained bridge in
`oma3dao/mpas-applications`.

The implementation must be a presentation-layer compatibility adapter over the
current MPAS workflow. Do not restore the pre-Tasks bridge wholesale. Do not
change application tool inventories, policies, DIDs, execution profiles, or
credential requirements as part of the mechanical fleet regeneration.

No production application or OAuth credential is needed to implement or probe
initialization and tool listing. Do not request, copy, print, or expose one.

---

## Phase 0: Confirm Baselines and Capture the Failure

### 0.1 Synchronize canonical repositories

Before implementation:

- synchronize the canonical `oma3dao/mpas` clone;
- synchronize the canonical `oma3dao/mpas-applications` clone;
- preserve unrelated local changes;
- branch from each repository's `origin/main` according to local repository
  and approval rules; and
- record the exact starting commits in the final report.

The current historical comparison points are:

- pre-Tasks Netlify: `mpas-applications` commit `21e216d`, the parent of PR 46;
- Netlify Tasks migration: commit `6705add`, PR 46; and
- Tasks SDK migration: `mpas` commit `749c0aa`, PR 40.

Reconfirm those relationships after synchronization rather than assuming local
references are current.

### 0.2 Capture a credential-free protocol trace

Reproduce initialization using the affected OpenClaw release and the current
Hermes release without invoking an application tool. Capture only the JSON-RPC
method sequence and sanitized errors:

```text
conventional client -> initialize
current Tasks server -> method not found / initialization failure
```

Confirm that no Action, Coordination request, Adapter request, OAuth refresh,
or upstream Netlify request occurs.

Do not include environment variables, authorization headers, key material,
tool arguments, or complete configuration files in the trace.

### 0.3 Record supported conventional protocol versions

Inspect the actual `initialize.params.protocolVersion` values sent by the
target OpenClaw and Hermes versions. Define an explicit compatibility list from
the protocol versions required by those harnesses and supported by the chosen
implementation dependency.

Do not use the harness product name or version at runtime.

---

## Phase 1: Protocol-neutral Legacy Result Mapping

### 1.1 Restore only the client result helpers

Use the pre-Tasks `bridge-results.ts` and proposer-profile v0.1 as references
for:

- `MpasBridgeDeferredResult`;
- `MpasBridgeActionOutcome`;
- `MpasBridgeError`;
- the `mpas_wait_for_action_result` definition;
- wait-input validation;
- deterministic compatibility descriptions; and
- compatibility output-schema unions.

Place the restored behavior behind names that clearly identify it as legacy or
compatibility functionality. Do not make it the default Tasks result builder.

Update the mapping for current workflow states, especially `cancelled`, so no
terminal record can be rendered as indefinitely active.

### 1.2 Expose minimal protocol-neutral workflow operations

Refactor or extend the current proposer bridge only as much as required for
both presentation adapters to:

- propose a new application call;
- retrieve a proposer-visible workflow by Action ID;
- wait for a stored workflow change without advancing it; and
- map the stored result into the selected wire format.

Tasks mode must continue to return its existing Task shapes. Compatibility
mode must not translate a Task response after the fact if doing so would lose
the underlying workflow or native `CallToolResult` semantics.

The shared path must continue to use the current `ActionPackageBuilder`,
`BridgeWorkflowEngine`, `WorkflowStore`, `AdapterClient`, and authenticated
`CoordinationClient`.

### 1.3 Unit tests

Add tests for:

- active, resolved, unresolvable, expired, and cancelled records;
- native results returned verbatim;
- stable Action references and hashes;
- wait input bounds;
- nonblocking and bounded waits;
- proposer-DID isolation;
- no workflow advancement from observation; and
- result retention across both presentation modes.

---

## Phase 2: Conventional MCP Adapter

### 2.1 Implement an isolated adapter

Add a conventional MCP adapter that supports only the client methods required
by the compatibility profile:

- `initialize`;
- the initialized notification;
- `ping`;
- `tools/list`; and
- `tools/call`.

Prefer a single stdio transport owner with testable request dispatchers for the
two modes. Do not connect two server instances to the same transport or allow
both to consume messages concurrently.

If the legacy MCP SDK is used, pin its exact version and isolate it from the MCP
2026 Tasks types. If a narrow dispatcher is used instead, validate its
initialization response against captured OpenClaw and Hermes behavior. Do not
copy an entire old server implementation merely to obtain initialization.

### 2.2 Tool listing

The compatibility adapter must list:

- all upstream application tools with the deterministic legacy presentation;
  and
- exactly one `mpas_wait_for_action_result` tool.

It must not advertise Tasks extensions or `tasks/*` operations.

Add a collision test proving that an upstream tool named
`mpas_wait_for_action_result` cannot replace or merge with the reserved tool.

### 2.3 Tool calls

Route application calls into the shared current MPAS workflow. Route the
reserved tool only to proposer-visible workflow observation.

Add negative tests proving that:

- the proposer bridge does not construct a direct Netlify client;
- compatibility calls still pass through `AdapterClient`;
- approval-gated calls still pass through signed Coordination requests;
- a missing Adapter or Coordination service leaves the Action safely deferred;
  and
- no credential appears in responses or logs.

---

## Phase 3: Connection-local Protocol Selector

### 3.1 Add the selector state machine

Implement an explicit state machine:

```text
undetermined --initialize------> compatibility
undetermined --server/discover-> tasks
undetermined --modern metadata-> tasks
undetermined --tools/list------> tasks
undetermined --ping------------> undetermined
tasks --------legacy method----> error, remain tasks
compatibility-modern method----> error, remain compatibility
```

The selector owns the transport and delegates to exactly one adapter after
selection. Add a one-time, sanitized mode-selection log event.

### 3.2 Preserve Tasks behavior

Use the existing `MpasTasksServer` dispatcher and tests as the regression
oracle. The following must remain unchanged:

- `server/discover` response;
- extension identifiers and MPAS profile version;
- per-request metadata enforcement;
- exact upstream tool definitions;
- flat Task creation results;
- `tasks/get`, `tasks/update`, and `tasks/cancel` behavior; and
- `-32021` missing-capability responses.

In particular, a missing Tasks capability after Tasks mode is selected must
not activate compatibility mode.

### 3.3 Lock and error tests

Test:

- every valid selector;
- `ping` before selection;
- unknown initial methods;
- repeated initialization;
- cross-protocol requests in both directions;
- concurrent or back-to-back messages around selection;
- no double response and no lost response;
- transport close before and after selection; and
- exactly one background workflow loop per bridge process.

---

## Phase 4: Demo and End-to-end Verification

### 4.1 Update the demo bridge

Wire the protocol-selecting server into the demo proposer bridge without
changing its Adapter, Coordination, signing, or store configuration.

Keep a direct Tasks-server constructor available to unit tests if useful, but
the normal demo executable must exercise automatic selection.

### 4.2 Raw stdio tests

Extend the subprocess MCP bridge tests with two independent sessions:

1. Tasks session:
   `server/discover` -> `tools/list` -> `tools/call` -> `tasks/get`.
2. Compatibility session:
   `initialize` -> initialized notification -> `tools/list` -> `tools/call`
   -> `mpas_wait_for_action_result`.

Use fake local Adapter and Coordination services. Do not use production
credentials or the hosted Netlify endpoint.

Add restart coverage in which an Action created in one mode is observed in the
other mode using the same proposer identity and workflow store.

### 4.3 Harness probes

Probe pinned target versions of OpenClaw and Hermes against the built bridge.
For the initialization-only probe, success means:

- the existing bridge command starts;
- the harness initializes without timeout;
- tools are listed;
- compatibility mode includes `mpas_wait_for_action_result`; and
- no Action or external application request is created.

Also probe a Tasks-capable client and confirm it receives the unchanged Tasks
surface without the wait tool.

---

## Phase 5: Bridge Generator

Update the generator template so generated proposer bridges can use the
protocol-selecting server without duplicating detection logic.

Generator tests must assert:

- one normal bridge executable;
- automatic protocol selection by default;
- no client product/version checks;
- no direct upstream application connection;
- the current authenticated Coordination signer wiring;
- the current Adapter path; and
- unchanged Tasks configuration and workflow options.

Do not regenerate application repositories during this phase. Fleet
regeneration occurs only after the generator, SDK, demo, and Netlify canary
pass both protocol paths.

---

## Phase 6: Single Adaptive Proposer Skill

### 6.1 Update the canonical skill

Update `integrations/skills/mpas-proposer/SKILL.md`. Do not create separate
Tasks and compatibility skill variants.

Include these exact two sentences:

> If `mpas_wait_for_action_result` is present in the available tools, treat
> application calls as deferred and use that tool to retrieve their results.
> If it is absent, do not attempt to call it; the harness manages MCP Tasks.

Revise the surrounding Tasks-only instructions so they do not conflict with
the compatibility behavior. At minimum:

- replace the instruction to reject clients without Tasks support;
- describe Action ID retrieval from `MpasBridgeDeferredResult`;
- make status observation conditional on the available surface;
- retain the prohibition on repeating the application call;
- retain Maintainer notification and no-self-approval rules; and
- retain the prohibition on direct application or credential access.

The always-on preamble must refer to an MPAS Action in a way that is correct in
both modes rather than assuming the harness exposes a Task.

### 6.2 Update the ClawHub packaging copy

Apply the same behavioral instructions to
`integrations/clawhub/mpas-proposer/SKILL.md` while retaining its
ClawHub-specific frontmatter and presentation copy.

Keep the canonical and ClawHub skill versions synchronized. Bump the patch
version from the value current at implementation time; `1.0.3` is the expected
next version if `1.0.2` remains current.

Do not publish during implementation unless explicitly authorized. The pull
request workflow should perform only its configured dry run.

### 6.3 Instruction tests and review

Search the proposer skill and setup guides for unconditional Tasks-only
statements. Update only those required for the compatibility behavior. Confirm
that the maintainer skill remains unchanged unless a factual cross-reference
requires correction.

Review the final skill as two scenarios:

- tool list contains `mpas_wait_for_action_result`; and
- tool list does not contain it and the harness manages Tasks.

---

## Phase 7: Netlify Canary

In the canonical `oma3dao/mpas-applications` repository:

1. branch from the synchronized `origin/main`;
2. update only the Netlify bridge and the minimum shared validation metadata
   required to describe its two conditional surfaces;
3. consume a released compatibility-capable `@oma3/mpas` version, using a local
   dependency only during development;
4. retain the existing Netlify bridge command and configuration shape;
5. retain the current plugin, application DID, execution profile, agent key,
   Adapter URL, Coordination URL, and workflow-store behavior; and
6. do not modify or regenerate another application bridge until the canary
   passes the full Tasks, compatibility, workflow, and credential tests.

If `harness-config.json` cannot express conditional protocol surfaces, extend
its schema narrowly so Netlify can record:

- Tasks mode extension capabilities with no added tool; and
- compatibility mode with the reserved wait tool and legacy schema/description
  transformations.

Do not falsely describe the union of both surfaces as a surface exposed to one
client.

Prosper's existing MCP server command/configuration should remain unchanged.
The final report must state that the compatibility mode is selected by the
harness's `initialize` handshake, not by a user configuration change.

---

## Phase 8: Fleet-wide Bridge Rollout

### 8.1 Regenerate every maintained bridge

After the Netlify canary passes, regenerate or mechanically update every
maintained bridge using the reviewed compatibility-capable generator and SDK.
The current inventory is:

- `alpaca`
- `bigquery`
- `coinbase-advanced-trade`
- `coinbase`
- `fastly`
- `firebase`
- `github`
- `kraken-cli`
- `kubernetes`
- `mongodb`
- `n8n`
- `neon`
- `netlify`
- `outlook`
- `plain`
- `planetscale`
- `postgres`
- `railway`
- `slack`
- `stripe`
- `supabase`
- `upstash`
- `vercel`
- `x-twitter`

Recompute this inventory from `applications/*/bridge` immediately before
regeneration so newly added maintained bridges are not omitted.

For each bridge:

1. update the generated runtime to use automatic protocol selection;
2. update to the same exact compatibility-capable `@oma3/mpas` prerelease;
3. update and commit its lockfile reproducibly;
4. preserve the existing executable name and configuration shape;
5. preserve its upstream command, pin, tool snapshot, plugin, classification,
   DIDs, and execution profile;
6. update its harness metadata to describe the conditional Tasks and
   compatibility surfaces;
7. add a changelog entry; and
8. build and probe the packaged JavaScript artifact.

Generated application source should be mechanically identical except for
application-specific constants and existing intentional deviations. Review a
cross-application diff to detect generator drift or one-off edits.

### 8.2 Per-bridge protocol smoke tests

Run two credential-free stdio sessions against every built bridge:

1. a Tasks handshake that reaches `server/discover` and `tools/list`; and
2. a conventional handshake that reaches `initialize`, the initialized
   notification, and `tools/list`.

The Tasks list must not contain `mpas_wait_for_action_result`. The compatibility
list must contain exactly one reserved wait tool. Apart from documented
compatibility description/output-schema transformations, the application tool
names and inputs must match the checked-in upstream snapshot.

Initialization/listing probes must not call an application tool and therefore
must not require a real credential, Adapter, Coordination service, or upstream
application connection.

### 8.3 Fleet validation

Extend `validate-applications.py` and its tests so a bridge cannot remain on a
Tasks-only generated runtime unnoticed. Validation must check:

- the expected SDK version;
- the protocol selector wiring;
- authenticated Coordination signer wiring;
- Adapter-only execution wiring;
- conditional harness deviations; and
- absence of application-specific credential handling in the proposer.

The feature is not release-complete while any maintained bridge fails either
protocol smoke test or still depends on the prior Tasks-only SDK version.

---

## Phase 9: Credential and OAuth Regression Audit

### 9.1 Credential-bearing application inventory

At the current baseline, these harness configurations contain explicit
Credential Adapter substitution placeholders:

- `alpaca`
- `bigquery`
- `firebase`
- `mongodb`
- `n8n`
- `neon`
- `netlify`
- `plain`
- `planetscale`
- `postgres`
- `railway`
- `slack`
- `stripe`
- `supabase`
- `upstash`
- `vercel`
- `x-twitter`

Recompute the inventory from `harness-config.json`, plugin credential
requirements, and Adapter configuration before implementation. A bridge
without a checked-in placeholder may still use an Adapter-held credential and
must not be excluded solely on that basis.

For every credential-bearing bridge, verify in both protocol modes that:

- initialization and tool listing do not resolve or expose credentials;
- only the Credential Adapter substitutes the credential into the upstream
  command, environment, or header;
- the proposer receives no credential value, authorization header, refresh
  token, or credential cache path;
- sanitized logs do not contain substituted values;
- approval-gated calls cannot reach the upstream before authorization; and
- the generated compatibility code contains no direct upstream transport.

### 9.2 Explicit OAuth applications

The current plugin metadata declares explicit OAuth semantics for at least:

- `netlify` — hosted MCP OAuth access token with Adapter-managed OAuth login
  and refresh;
- `outlook` — delegated Microsoft Graph credential with access, refresh, and
  `offline_access` semantics;
- `planetscale` — OAuth access-token substitution;
- `vercel` — hosted MCP OAuth access-token substitution; and
- `x-twitter` — OAuth 2.0 user access token among its credential set.

Recompute this list before implementation and include any newly added OAuth
application.

For OAuth applications, additionally verify:

1. protocol detection completes without reading or refreshing the OAuth grant;
2. the Adapter remains the sole owner of access and refresh tokens;
3. the current OAuth provider registration and requested scopes are preserved;
4. refresh requests retain the corrected scope behavior from `mpas` PR 59;
5. refresh and grant failures remain visible as sanitized Adapter errors and
   are not converted into false bridge success;
6. a refreshed access token is substituted only into the authorized upstream
   execution attempt; and
7. neither Tasks nor compatibility results include token material.

Use fake OAuth and upstream endpoints for automated tests. Real OAuth login,
refresh grants, or production tokens are not required and must not be requested
for this feature.

### 9.3 Credential configuration review

Review application-specific Adapter configuration examples and documentation
only where they already exist or are needed to keep the current credential path
accurate. Do not invent a generic OAuth refresh configuration for applications
that currently accept a static access token. Record the distinction between:

- Adapter-managed OAuth grants with refresh behavior;
- Adapter-substituted OAuth access tokens; and
- non-OAuth API keys, secrets, connection strings, and service credentials.

---

## Phase 10: Documentation and Release

### 10.1 Normative documentation

Update the MPAS MCP Proposer Bridge Profile with a clearly marked temporary
compatibility annex. Keep the Tasks profile and version 2 behavior primary.
Do not redefine the compatibility adapter as the official Tasks extension.

Update the existing Tasks feature documentation where it currently says no
backward-compatibility shim, linking to this feature record.

### 10.2 SDK release

If public SDK exports or generated application dependencies change:

- bump `@oma3/mpas` from the version current at implementation time;
- update and lock dependencies reproducibly;
- build the package tarball and inspect its contents;
- publish only with explicit authorization; and
- update every maintained bridge in `mpas-applications` to the released exact
  prerelease used by the reviewed fleet build.

### 10.3 Application and skill release ordering

Release in dependency order:

1. publish the reviewed `@oma3/mpas` prerelease;
2. update, rebuild, and review the complete `mpas-applications` fleet against
   that exact version;
3. merge or publish application artifacts only after all bridge checks pass;
4. publish the updated proposer skill after its compatibility instructions
   match the deployed bridge behavior.

Do not leave a mixed production fleet without explicitly reporting which
bridges remain Tasks-only and blocking feature completion on their upgrade.

### 10.4 Temporary-feature tracking

Open or update a tracking issue for removal after supported harnesses implement
the official Tasks lifecycle. Record which sanitized mode-selection evidence
will be used to decide removal.

---

## Expected Files

Exact names may change during implementation, but the intended scope is:

### `oma3dao/mpas`

| Area | Expected action |
|---|---|
| `sdk/protocol/src/lib/` | Add isolated legacy result/dispatcher and protocol selector; minimally expose shared workflow observation |
| `sdk/protocol/tests/lib/` | Add legacy, selector, mode-lock, security, and Tasks-regression tests |
| `bridge-generator/` | Emit the protocol-selecting proposer bridge and test its invariants |
| `examples/demo/src/bridge/` | Wire automatic detection into the demo bridge |
| `examples/demo/tests/e2e/` | Add Tasks and compatibility stdio sessions |
| `integrations/skills/mpas-proposer/SKILL.md` | Make the one canonical skill adaptive |
| `integrations/clawhub/mpas-proposer/SKILL.md` | Synchronize behavior and bump publish version |
| `specs/mpas-profile-mcp-proposer-bridge-client.md` | Add temporary compatibility annex |
| `docs/features/mcp-tasks/` | Link and reconcile the compatibility amendment |

### `oma3dao/mpas-applications`

| Area | Expected action |
|---|---|
| `applications/*/bridge/` | Regenerate every maintained bridge with automatic protocol selection and the exact new SDK version |
| `applications/*/harness-config.json` | Describe the two conditional surfaces without changing upstream configuration |
| `applications/*/CHANGELOG.md` | Document compatibility behavior and SDK version |
| OAuth/credential application docs and Adapter examples | Verify and update only where needed to preserve existing custody and refresh behavior |
| shared validation scripts/tests | Require selector wiring, SDK consistency, conditional surfaces, signing, and Adapter-only execution across the fleet |

---

## Verification Commands

Run at least the checks below, plus any repository-level checks required by
local instructions.

### `oma3dao/mpas`

```sh
cd sdk/protocol
npm ci
npm run typecheck
npm run build
npm test

cd ../../bridge-generator
npm ci
npm run build
npm test

cd ../examples/demo
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e:mcp-bridge
```

### `oma3dao/mpas-applications`

```sh
python3 -m unittest scripts/test_validate_applications.py
python3 scripts/validate-applications.py

cd applications/netlify/bridge
npm ci
npm run build
```

After the Netlify canary, run `npm ci` and `npm run build` in every maintained
`applications/*/bridge` package, and run both protocol-list probes against each
built artifact. Add the fleet probes to the repository's automated checks
where practical. Run probes against built artifacts rather than TypeScript
source.

---

## Acceptance Criteria

- Every maintained bridge keeps its existing command and works with both
  target harness classes.
- `initialize` selects compatibility mode.
- `server/discover` selects Tasks mode.
- Selection is based on wire behavior, never harness product/version.
- Mode is immutable after selection.
- Tasks discovery, tools, Task results, and errors remain unchanged.
- Compatibility initialization succeeds and lists application tools plus
  `mpas_wait_for_action_result`.
- Compatibility calls create signed MPAS Actions and use the shared workflow.
- The wait tool observes but never advances or duplicates an Action.
- Both modes preserve signed Coordination, authorization requirements,
  Credential Adapter custody, and OAuth substitution.
- No direct application/upstream path or credential handling is added to a
  proposer bridge.
- The one proposer skill correctly instructs agents in either mode.
- The canonical and ClawHub skill versions are synchronized.
- Every bridge consumes the same reviewed compatibility-capable SDK version.
- Every bridge passes Tasks and compatibility initialization/list probes.
- Every credential-bearing bridge preserves Adapter-only substitution.
- Every OAuth bridge preserves its existing custody, scope, refresh, and
  sanitized failure behavior, including the PR 59 fixes.
- All SDK, generator, demo, validation, fleet build, credential/OAuth, and
  protocol-probe checks pass.

---

## Pre-publish Report

Before any SDK, skill, or application publication, report:

1. the root cause and sanitized handshake evidence;
2. starting commits and files changed in each repository;
3. tests, builds, harness probes, and results;
4. the exact supported conventional protocol versions;
5. confirmation that Prosper's bridge command/configuration does not change;
6. how the harness handshake selects the compatibility surface;
7. the proposer skill version change and publication status;
8. every bridge upgraded and the exact SDK version used;
9. credential-bearing and OAuth applications audited, including PR 59 refresh
   behavior;
10. security properties preserved;
11. remaining compatibility, downgrade, mixed-fleet, and removal risks; and
12. any action that still requires approval, including publishing or pushing.
