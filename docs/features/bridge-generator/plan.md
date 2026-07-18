# MPAS Bridge and Application Builder

## Purpose

This document describes a toolchain for generating MPAS-compatible bridge servers, application plugins, and registry entries from existing MCP servers.

The goal is to scale MPAS adoption by turning existing MCP servers into MPAS-aware drop-in replacements.

Contracts for the remaining work — CLI surface, artifact schemas, determinism rules, folder layout, harness behaviors — are specified in [spec.md](./spec.md). This document covers what and when; spec.md covers exactly what gets built.

---

## Status

### Done (implemented in `oma3/mpas/bridge-generator`)

| Step | Description | Status |
|------|-------------|--------|
| 1. MCP Server Intake | Spawn upstream MCP server from CLI args | ✅ Done |
| 2. Tool Discovery | MCP handshake + `tools/list` capture | ✅ Done |
| 3. Risk Classification | Heuristic impact inference from tool names (`critical`/`high`/`medium`) | ✅ Done |
| 4. Application Plugin Generation | Full `MpasApplicationPlugin` JSON with all operations | ✅ Done |
| 5. Bridge Scaffold Generation | Complete TypeScript MPAS bridge with approval flow, coordination, wait/poll | ✅ Done |

The generator is a CLI:

```sh
npx bridge-generator \
  --output-bridge <path> \
  [--output-plugin <path>] \
  -- <upstream-command> [upstream-args...]
```

Generated bridges import `@oma3/mpas` for protocol operations and `@modelcontextprotocol/sdk` for the MCP server. They implement the full approval flow (adapter submission, coordination service, wait/poll loop, all terminal response types). See `oma3/mpas/docs/features/reorg2/spec.md` for the detailed specification.

### Remaining (to be built in `oma3/mpas-applications`)

| Step | Milestone | Description | Status |
|------|-----------|-------------|--------|
| — | M0 | Generator test foundation: own devDependencies, discovery tests against mock MCP fixtures, compile-check and golden-file tests of generated output | ❌ Not started |
| 8. Discovery Snapshot | M1 | Persist `tools-list.snapshot.json`, `metadata.json`, `classification.json` for review; compute the `toolSurface` hash | ❌ Not started |
| 10. Structured Output | M2 | `generate --app` orchestrator; per-application folder layout under `applications/<name>/` with regeneration semantics | ❌ Not started |
| 6. Compatibility Test Harness | M3 | Shared harness comparing upstream vs. bridge tool surfaces (config-driven, not generated per app) | ❌ Not started |
| 7. Approval Test Harness | M4 | Shared harness exercising the four approval scenarios through the generated bridge (extracted from the demo e2e stack) | ❌ Not started |
| 9. Registry Entry Generation | M5 | Generate `application-registry/*.json` entries, validated against the registry schema | ❌ Not started |
| — | — | Reconcile the existing `application-registry/github-demo-oma3dao.json` (stale plugin path and DIDs) | ❌ Not started |

Build order is M0 → M1 → M2 → M3 → M4 → M5: the snapshot (M1) is the keystone artifact the folder layout (M2) packages and both harnesses (M3/M4) consume; the registry entry (M5) is generated last so it attests to a tested artifact. M0 comes first because every later milestone teaches the generator new outputs, and the generator currently has no tests of its own.

---

## Repository Layout

The toolchain spans two repositories:

```text
oma3/mpas/                          ← protocol spec, SDK, generator, registry
  bridge-generator/                 ← the code generator (done)
  application-registry/             ← JSON entries pointing to implementations
    github-wivity.json
    slack-acme.json
    ...

oma3/mpas-applications/             ← reference bridge implementations
  docs/
    features/
      v1-bridge-builder/
        plan.md                     (this file)
  applications/
    github/
      plugin.json
      registry-entry.json
      build-artifacts/
        tools-list.snapshot.json
        metadata.json
        classification.json
      bridge/
        README.md
        package.json
        tsconfig.json
        src/
        tests/
    slack/
      ...
```

The bridge-generator stays in `oma3/mpas` — it's a general-purpose protocol tool alongside the SDK. Other tools will live there in the future as well.

The application-registry in `oma3/mpas/application-registry` is a lightweight index. Entries reference implementations wherever they live — `oma3/mpas-applications`, third-party repos, vendor repos.

This split also draws a testing boundary: `oma3/mpas/conformance/` holds official, implementation-agnostic protocol conformance tests (specs-level, any implementation), while the compat/approval harnesses in `oma3/mpas-applications` are application-level QA for specific generated bridges. When conformance tools exist, application CI runs the relevant conformance suite as one additional pipeline stage (Phase 6); the two layers never merge. See spec.md §1.2.

---

## Core Idea

For each MCP server, the toolchain should:

1. ✅ Start or connect to the existing upstream MCP server.
2. ✅ Call MCP tool discovery.
3. ✅ Capture the upstream tool list and tool schemas.
4. ✅ Classify tools by impact level.
5. ✅ Generate an MPAS Application Plugin.
6. ✅ Generate an MPAS bridge server (drop-in replacement for the upstream).
7. Generate compatibility tests proving the bridge exposes compatible tools.
8. Generate approval-interception tests for high-impact actions.
9. Generate a Registry Entry for submission to `oma3/mpas/application-registry`.
10. Write output to `applications/<name>/` for human review.

The bridge is not a universal MPAS server. Each bridge is an application-specific drop-in replacement for an existing MCP server.

Example:

```text
Agent
  -> GitHub MPAS Bridge
  -> Official GitHub MCP Server
  -> github.com APIs
```

From the agent's perspective, the bridge should look like the GitHub MCP server. The difference is that all actions are routed through the MPAS protocol.

---

## Terminology

### Discovery

Steps 1–2 in the status table (MCP Server Intake + Tool Discovery): spawning the upstream MCP server, performing the MCP handshake, and capturing `tools/list`. The generator already performs discovery during generation; the Discovery Snapshot (step 8 / M1) persists its results as reviewable artifacts instead of using them once and discarding them.

### Upstream MCP Server

The existing MCP server that already exposes tools for an application.

Examples:

- Official GitHub MCP server
- Slack MCP server
- Jira MCP server
- Linear MCP server
- Kubernetes MCP server

### MPAS Bridge Server

A drop-in replacement MCP server that exposes the same or compatible tools as the upstream MCP server, but routes all actions through the MPAS protocol.

The bridge flow:

1. Agent calls a tool on the bridge.
2. Bridge constructs an Action Package (using `@oma3/mpas`) and sends it to the Credential Adapter (localhost).
3. Credential Adapter evaluates policy:
   - If auto-approved: dispatches to the upstream server and returns the result.
   - If approvals needed: returns to the bridge that additional approvals are required.
4. Bridge submits the pending action to the Coordination Service (localhost).
5. Coordination Service solicits approvals from configured approvers.
6. Once sufficient approvals are collected, Coordination Service returns them to the bridge.
7. Bridge constructs a new Action Package with the approvals and resubmits to the Credential Adapter.
8. Credential Adapter verifies the approvals meet policy, then dispatches to the upstream server.
9. Bridge returns the result to the agent.

Generated bridges import `@oma3/mpas` for all MPAS protocol operations (Action Package construction, signing, adapter submission, coordination polling), following the same pattern as the reference implementation in `oma3/mpas/examples/demo`. The builder generates the application-specific glue: which tools to expose, how to connect to the upstream, and the input/output mapping.

### Application Plugin

A JSON document conforming to the MPAS Application Plugin Profile. This is the primary machine-readable artifact that the Credential Adapter loads at startup.

It declares:

- operations (object keyed by operation name — what the application can do)
- payload schemas (JSON Schema for each operation's input)
- credential requirements (what auth the adapter needs to reach the target)
- optional impact metadata (informational, does not prescribe policy)

The plugin is immutable once published. Its integrity is verified via `artifactDid` (a content-addressable identifier).

All high-impact tool names appear as operation keys in the plugin, giving operators visibility into which actions are candidates for approval policy. The plugin does not set policy — that is the operator's responsibility via the deployment configuration's embedded `MpasApplicationPolicy`.

### Registry Entry

A JSON file submitted to `oma3/mpas/application-registry`. Each entry describes one MPAS-compatible implementation — a bridge, native MCP server, or native application — that users can install to get MPAS protection for a particular application.

The entry identifies the application, the upstream being wrapped (for bridges), where to find the plugin, and who publishes it. The registry is a discovery and identity document; runtime configuration belongs in the implementation's own repository.

File naming follows `{application}-{publisher-org}.json`.

### Deployment Policy

The local operator-specific policy that defines approvers, keys, thresholds, protected resources, and policy-engine behavior. In the current spec, this is an embedded `MpasApplicationPolicy` object within the deployment config, containing `signerGroups`, action-keyed `policies`, and a `defaultRequirement`.

This tool should not assume one mandatory MPAS policy language. Enterprises may use their own policy engines.

---

## Remaining Work

### 6. Compatibility Test Harness

The test harness should compare the upstream server and generated bridge.

It should verify:

- same tool names, unless intentionally renamed
- same input schemas, unless intentionally wrapped
- same descriptions, unless intentionally modified
- no accidental tool omissions
- high-impact tools are still visible to the agent
- high-impact tools are routed through the Credential Adapter

For MCP drop-in replacement behavior, tool compatibility is critical.

---

### 7. Approval Test Harness

The approval test harness should simulate MPAS approval flows. The tests in `oma3/mpas/examples/demo/tests` are a good reference.

Test cases:

```text
action with proposerOnly defaultRequirement:
  adapter approves immediately, bridge returns result

high-impact action without approval:
  adapter requires approval, bridge waits or returns pending

high-impact action with insufficient approval:
  adapter blocks

high-impact action with valid approvals meeting threshold:
  adapter dispatches to upstream, bridge returns result
```

---

### 8. Discovery Snapshot

When generating an application, persist intermediate artifacts for human review:

```text
applications/<name>/build-artifacts/
  tools-list.snapshot.json    ← raw tools/list response
  metadata.json               ← server info, version, generation timestamp
  classification.json         ← tool-to-impact mapping (draft for review)
```

The snapshot captures what the upstream exposes at a point in time, enabling detection of upstream changes when the MCP server is updated.

---

### 9. Registry Entry Generation

After the bridge and plugin are generated and tested, generate a registry entry conforming to the OMA3 application registry schema.

Example output:

```json
{
  "version":     "1",
  "application": {
    "name":           "GitHub",
    "description":    "MPAS-protected GitHub repository management via the official GitHub MCP server.",
    "applicationDid": "did:web:github.example",
    "website":        "https://github.com"
  },
  "native":   false,
  "protocol": "mcp",
  "upstream": {
    "name":       "Official GitHub MCP Server",
    "repository": "https://github.com/github/github-mcp-server",
    "package":    "ghcr.io/github/github-mcp-server"
  },
  "plugin": {
    "repository": "https://github.com/oma3dao/mpas-applications/blob/main/applications/github/plugin.json"
  },
  "publisher": {
    "name":       "Wivity",
    "githubOrg":  "wivity",
    "repository": "https://github.com/oma3dao/mpas-applications"
  },
  "status": "beta"
}
```

For bridges generated by this tool:

- `native` is always `false` (the tool generates bridges, not native integrations)
- `protocol` is always `"mcp"` (the tool wraps MCP servers)
- `status` is always `"beta"` for newly generated entries

The generated entry targets `oma3/mpas/application-registry/{application}-{publisher-org}.json` and can be submitted as a PR to the OMA3 repo.

---

### 10. Structured Output

The builder writes all generated artifacts to `applications/<name>/` in this repository.

Each application folder contains:

```text
applications/github/
  plugin.json
  registry-entry.json
  build-artifacts/
    tools-list.snapshot.json
    metadata.json
    classification.json
  bridge/
    README.md
    package.json
    tsconfig.json
    src/
    tests/
  CHANGELOG.md
```

---

## Dependency on @oma3/mpas

Generated bridges depend on `@oma3/mpas` for all MPAS protocol operations. The SDK provides:

| Export | Used by generated bridges for |
|--------|-------------------------------|
| `ActionPackageBuilder` | Constructing Execution Payloads, Action Envelopes, hashing, signing |
| `AdapterClient` | Submitting Action Packages to the Credential Adapter, parsing responses |
| `CoordinationClient` | Submitting pending actions, polling for state updates |
| `KeyManager` | Loading Ed25519 signing keys, deriving DIDs |
| `ApprovalBuilder` | Constructing and signing Approval objects (for signer-capable bridges) |
| `PluginValidator` | Optional pre-validation of payloads against plugin schemas |
| Types | All MPAS artifact interfaces (ActionPackage, ActionEnvelope, etc.) |

The SDK is protocol-generic — not MCP-specific. It handles MPAS artifact construction and verification for any execution profile. The MCP-specific layer (tool discovery, stdio transport, tool-to-payload mapping) is generated by the builder and lives in the application bridge code.

---

## MVP

The first MVP should target one upstream MCP server.

Recommended target:

```text
Official GitHub MCP server
```

MVP deliverables:

```text
1. ✅ Run official GitHub MCP server locally.
2. ✅ Capture tools/list snapshot.
3. ✅ Classify tools as low-impact or high-impact.
4. ✅ Generate GitHub Application Plugin draft.
5. ✅ Generate GitHub MPAS bridge scaffold (TypeScript, using @oma3/mpas).
6. ✅ Verify bridge exposes compatible tool list.
7. ✅ All actions route through the Credential Adapter.
8. ✅ Produce audit logs verifying protocol correctness.
9. Generate GitHub Registry Entry.
10. Write output to applications/github/.
```

---

## Long-Term Roadmap

### Phase 1: Manual Builder ✅

Human runs the bridge-generator against one MCP server. Implemented in `oma3/mpas/bridge-generator`.

### Phase 2: Application Packaging

Wrap generated bridges into structured `applications/<name>/` folders with build-artifacts, tests, and registry entries. This is the current phase.

### Phase 3: Risk Classification Assistant

Agent helps classify high-impact actions and required context. The generator currently uses name heuristics; a future pass could use LLM-assisted classification.

### Phase 4: Compatibility Test Automation

Bridge must pass tool compatibility tests against the upstream MCP server.

### Phase 5: OMA3 Registry Integration

Generated registry entries produce PRs to `oma3/mpas/application-registry/`.

### Phase 6: Conformance and Certification

When OMA3 conformance tests exist, bridge generation includes certification pre-checks.

---

## Open Questions

1. Should bridge scaffolds preserve upstream tool descriptions exactly, or summarize them?
   - **Current answer:** Preserve exactly. The generator copies verbatim.
2. How should the bridge handle upstream MCP server version upgrades?
   - **Current approach:** Pin a version, regenerate when needed. Discovery snapshots will enable diff detection.
3. What level of review is required before merging a generated bridge?
   - Could be human, agent, or security auditor — up to the developer.
4. Should the compatibility and approval test harnesses be generated per-application, or be a shared test runner that takes a bridge config as input?
   - **Resolved: shared runner, generated config.** Per-application generated test suites drift from the harness that runs them and multiply review burden. The generator emits only a small `harness-config.json` (upstream launch command, intentional deviations); the high-impact tool set is derived at run time from `classification.json` so review flows through automatically. The two harnesses live once in `oma3/mpas-applications` and take an application folder as input. A harness fix benefits every application at once. See spec.md §6.
