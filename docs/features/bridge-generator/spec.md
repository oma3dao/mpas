# Bridge Generator v2 — Application Packaging Specification

**Status:** Draft v0.1
**Companion:** [plan.md](./plan.md) (what and when; this document defines the contracts)
**Depends on:** MPAS Application Plugin Profile, MCP Execution Profile, Application Registry schema (`application-registry/README.md`)

---

## 1. Scope

This document specifies the contracts for the remaining bridge-generator work (plan.md steps 6–10): the CLI surface, the schema of every emitted artifact, the determinism rules, the `applications/<name>/` folder layout and regeneration semantics, the two shared test harnesses, and the boundary between application-level CI and OMA3 protocol conformance.

Terminology note: **discovery** in this document means plan.md steps 1–2 (MCP Server Intake + Tool Discovery) — spawning the upstream server, performing the MCP handshake, and capturing `tools/list`. The generator already performs discovery; v2 makes its results durable and reviewable.

### 1.1 Two-repository split

| Repository | Role |
| :--- | :--- |
| `oma3/mpas` | Normative home: specs, SDK, **bridge-generator** (the emitter), conformance model, application registry (the index). `examples/` exist to teach the protocol. |
| `oma3/mpas-applications` | Production home: assembled `applications/<name>/` folders, the shared **compat** and **approval harnesses**, and the CI that runs them. Implementations people actually deploy. |

The generator *emits* artifacts; mpas-applications *hosts and validates* them. The registry in `oma3/mpas/application-registry/` is the hinge: entries live in `mpas`, implementations live wherever the entry points.

### 1.2 Application CI vs. OMA3 conformance

These are different layers and must not be conflated:

- **Conformance** (`oma3/mpas/conformance/`, planned): official, implementation-agnostic tests that any MPAS implementation must pass to claim protocol conformance. Tests against the *spec* (hash binding, duplicate-key rejection, lifecycle semantics, result codes). Knows nothing about any particular application.
- **Application CI** (mpas-applications): per-application QA for one generated bridge. Tests against a specific *upstream* (is this bridge a faithful GitHub drop-in? do its high-impact tools route through MPAS?). Not normative.

When conformance tools exist, application CI adds the relevant conformance suite as one pipeline stage (plan.md Phase 6). Conformance never absorbs the application harnesses, and the harnesses never claim conformance.

---

## 2. CLI Contract

The existing low-level mode is unchanged:

```sh
bridge-generator --output-bridge <path> [--output-plugin <path>] -- <upstream-command> [args...]
```

v2 adds an orchestrating command that runs discovery once and writes the full application layout:

```sh
bridge-generator generate \
  --app <name> \                      # lowercase, hyphenated application name
  --out <dir> \                       # parent dir; artifacts land in <dir>/<name>/
  [--org-config <path>] \             # publisher identity JSON (see 3.6)
  [--application-did <did>] \         # target application DID for the plugin
  -- <upstream-command> [args...]
```

Behavior:

1. Spawn the upstream, perform the MCP handshake, capture `tools/list` (existing discovery code, one pass).
2. Write the artifacts of Section 3 into `<out>/<name>/`.
3. Never overwrite preserved files (Section 5).
4. Exit codes: `0` success; `2` spawn failure; `3` handshake failure; `4` tools/list failure (all existing); `5` output-directory conflict that regeneration rules cannot resolve.

All human-facing progress goes to stderr; stdout is reserved for machine-readable output (future `--json` mode).

---

## 3. Emitted Artifacts

### 3.1 Folder layout

```text
applications/<name>/
  plugin.json                     # MpasApplicationPlugin (generated; DIDs require manual review before publishing)
  registry-entry.json             # Application Registry entry draft (Section 3.6)
  harness-config.json             # Input to both shared harnesses (Section 3.5)
  build-artifacts/
    tools-list.snapshot.json      # Raw discovered tool surface (Section 3.2)
    metadata.json                 # Point-in-time capture record (Section 3.3)
    classification.json           # Draft impact classification (Section 3.4)
  bridge/
    README.md                     # Generated usage doc
    package.json                  # Depends on @oma3/mpas + @modelcontextprotocol/sdk
    tsconfig.json
    src/index.ts                  # The generated bridge (current bridge-codegen output)
  CHANGELOG.md                    # Created once, never overwritten
```

### 3.2 `tools-list.snapshot.json`

The authoritative record of the upstream tool surface at generation time.

```json
{
  "version": "1",
  "type": "McpToolsListSnapshot",
  "toolSurface": { "alg": "sha-256", "value": "<base64url, no padding>" },
  "tools": [ { "name": "...", "description": "...", "inputSchema": { } } ]
}
```

- `tools` MUST be sorted by `name` (code-unit order) and contain the validated tool definitions exactly as discovered (verbatim descriptions and schemas — no summarization, per plan.md open question 1).
- `toolSurface.value` = base64url(sha-256(JCS(`tools` array))) — the JCS (RFC 8785) canonicalization of the sorted array of full tool definitions. Hashing full definitions (not names only) makes schema drift on existing tools detectable, which is the harder half of MCP profile §6.2.
- This is the same hash construction proposed for the plugin `toolSurface` field in the drift-prevention issue ("Bind Application Plugins to attested upstream tool surfaces"). One definition, shared by the snapshot, the plugin field, the compat harness, and the registry entry. Normative test vectors are generated from the mock MCP server fixture and land with the implementation.
- No timestamps. Regenerating against an unchanged upstream MUST produce a byte-identical file.

### 3.3 `metadata.json`

The one artifact where a wall-clock timestamp is correct — point-in-time capture is its purpose.

```json
{
  "version": "1",
  "type": "McpDiscoveryMetadata",
  "serverInfo": { "name": "...", "version": "..." },
  "protocolVersion": "2024-11-05",
  "upstreamCommand": ["node", "server.js"],
  "generatorVersion": "<bridge-generator package version>",
  "capturedAt": "2026-07-18T00:00:00.000Z"
}
```

### 3.4 `classification.json`

The impact heuristic's output — a **human advisory artifact** to consult while editing `plugin.json`, not a governance control. Per the Application Plugin profile, an operation is governed iff it appears in `plugin.json` `operations` (or is named in deployment policy); the optional per-operation `impact` is informational. The generator's name-regex classification (delete/remove/destroy → critical, merge/deploy/transfer → high, else medium) is a starting point for the reviewer's judgment, and it plays no role in deciding which operations the regenerated plugin contains (Section 5).

```json
{
  "version": "1",
  "type": "ImpactClassificationDraft",
  "draft": true,
  "operations": {
    "delete_branch": { "impact": "critical", "rationale": "name-heuristic" }
  }
}
```

- `rationale` is `"name-heuristic"` for generated entries; manual review SHOULD change it (e.g. `"reviewed"`), which also documents review state per operation. When every operation has been reviewed, `draft` flips to `false` — the file-level signal the harnesses and registry gating read.
- Classification does NOT feed into `plugin.json` on regeneration — neither membership nor impacts of existing operations (Section 5). It seeds the heuristic `impact` of operations *newly added* to the plugin; everything else is for the reviewer's eyes.
- No timestamps.

### 3.5 `harness-config.json`

The application-specific input consumed by both shared harnesses (Section 6). Generated tests are deliberately NOT emitted — per-application test code drifts from the harness that runs it and multiplies review burden (resolves plan.md open question 4: shared runner, generated config).

```json
{
  "version": "1",
  "type": "HarnessConfig",
  "upstream": { "command": "node", "args": ["server.js"], "env": {} },
  "intentionalDeviations": {
    "renamedTools": {},
    "wrappedSchemas": [],
    "modifiedDescriptions": []
  }
}
```

- `intentionalDeviations` is empty when generated; reviewers populate it to allowlist deliberate differences (the "unless intentionally renamed/wrapped/modified" clauses in plan.md §6).
- The high-impact tool set is deliberately NOT stored here. It is derived by the harnesses at run time from `plugin.json` (operations with `impact` of `high` or `critical`), so there is exactly one source of truth — the governed set the reviewer actually edits — and no second file to keep in sync. `classification.json` is advisory input to that editing, never a harness input.
- **Anti-drift rule:** every tool name referenced anywhere in `intentionalDeviations` MUST exist in `tools-list.snapshot.json`. Harnesses FAIL on dangling references — a deviation entry for a tool that no longer exists means the config is stale relative to the snapshot.

### 3.6 `registry-entry.json`

A draft Application Registry entry conforming to `application-registry/README.md` (schema v1), destined for `oma3/mpas/application-registry/{application}-{publisher-org}.json` via PR.

Generator-fixed values: `native: false`, `protocol: "mcp"`, `status: "beta"`. Publisher and application identity come from `--org-config`:

```json
{
  "publisher": { "name": "...", "githubOrg": "...", "publisherDid": "...", "repository": "..." },
  "application": { "name": "...", "description": "...", "applicationDid": "...", "website": "..." }
}
```

Additions beyond the current registry schema (proposed as optional schema-v1 fields, to tie versions together):

- `plugin.artifactDid` — content hash of the exact plugin the entry describes.
- `upstream.toolSurface` — the Section 3.2 hash, pinning which upstream surface the plugin was built from.

The generator MUST validate the emitted entry against the registry schema before writing; invalid publisher config is a generation error, not a silently-wrong file.

---

## 4. Determinism Rules

1. `metadata.json` is the only artifact that may contain a timestamp.
2. All other artifacts MUST be byte-stable: regenerating against an unchanged upstream with unchanged inputs produces zero diff. (This is what makes upstream drift visible as a *meaningful* git diff and enables golden-file testing of the generator itself.)
3. All JSON artifacts are written with 2-space indentation, trailing newline, keys in generation order as specified per artifact (sorted where the artifact says sorted).
4. Generated code carries no generation timestamp (established in the v1 cleanup); provenance is expressed via `metadata.json` and, in future, the `toolSurface` hash in generated headers.

---

## 5. Regeneration Semantics

Running `generate` over an existing `applications/<name>/` folder:

| File | Behavior |
| :--- | :--- |
| `build-artifacts/*` (except merged `classification.json`), `bridge/src/index.ts`, `bridge/README.md`, `registry-entry.json` | Overwritten (generated surface) |
| `CHANGELOG.md` | Created if absent; never overwritten |
| `plugin.json` | Merged (membership rules below): reviewer-removed operations stay removed, new upstream tools are added, identity fields and impacts preserved, descriptions/schemas refreshed |
| `harness-config.json` | Merged: generated fields refreshed, `intentionalDeviations` and other manual edits preserved |
| Files listed in `.generator-keep` (one path per line, optional) | Never overwritten |
| `classification.json` | Merged: new tools added with heuristic impact + `"name-heuristic"` rationale; existing entries (human-reviewed) preserved. Advisory only — never consulted for plugin membership |

### 5.1 `plugin.json` membership on regeneration

The plugin is the governance control, so the reviewer's membership edits are the state to preserve. The previous `tools-list.snapshot.json` records the full upstream surface the reviewer last saw; the previous `plugin.json` records what they chose to govern. Their difference — **old snapshot − old plugin — is intentional pass-through** and is remembered without any extra bookkeeping file.

A newly discovered tool is included in the regenerated plugin's `operations` iff:

- there is no previous `plugin.json` (first generate → all discovered tools included), or
- it appears in the previous plugin's `operations` (still governed), or
- it is absent from the previous snapshot (genuinely new upstream tool — included as a governed candidate so reviewers can't silently miss it; delete it to make it pass-through).

Consequences: a tool in the old snapshot but not the old plugin is NOT re-added; a tool the upstream dropped disappears from the plugin. If a previous plugin exists but the previous snapshot is missing, new and reviewed-out tools are indistinguishable — the previous plugin's membership is treated as authoritative and the skipped tools are logged for manual review (the regen writes a fresh snapshot, so the ambiguity is one-time).

For operations that survive the merge, `pluginDid`, `pluginVersion`, `publisherDid`, `applicationDid` (unless `--application-did`/`--org-config` overrides it), `credentialRequirements`, and per-operation `impact` are carried over from the previous plugin; `description` and `executionPayloadSchema` always refresh from discovery. Operations newly added take their heuristic `impact` (seeded via `classification.json`, which preserves reviewed entries).

This is how "generated then checked in, edit freely" survives regeneration: the generator owns the generated surface, reviewers own review state — including plugin membership — and the boundary is explicit.

---

## 6. Shared Harnesses

Both live once in mpas-applications and take an `applications/<name>/` folder as input.

### 6.1 Compatibility harness (plan.md step 6)

Spawns the upstream (from `harness-config.json`) and the generated bridge (with a stub adapter, or the bridge's compat mode), calls `tools/list` on both, and checks:

| Check | On mismatch |
| :--- | :--- |
| Tool names equal (modulo `renamedTools`) | FAIL |
| Input schemas deep-equal (modulo `wrappedSchemas`) | FAIL |
| Descriptions equal (modulo `modifiedDescriptions`) | FAIL |
| No tool present upstream but missing from the bridge | FAIL |
| Every governed operation (`plugin.json` operations, which by definition include the high-impact set via their `impact` fields) present in bridge `TOOLS` | FAIL |
| Any `intentionalDeviations` reference to a tool absent from the snapshot | FAIL (stale config) |
| Live upstream `tools/list` vs. stored snapshot (`toolSurface` hash) | **WARN** + emit diff artifact |
| `classification.json` still has `draft: true` | **WARN** (impact assignments unreviewed) |

The last row is deliberately a warning, not a failure: drift means "regenerate and re-review," and per MCP profile §6.2 drift detection is diagnostic — it must not be conflated with the bridge being broken. CI surfaces the warning; a reviewer decides.

High-impact routing is verified structurally: generated bridges route every tool through `handleToolCall` → `ActionPackageBuilder` → adapter submission, so the check reduces to tool-list and plugin membership plus one runtime probe of a single high-impact tool against the stub adapter.

### 6.2 Approval harness (plan.md step 7)

Runs the four canonical scenarios end-to-end through the *actual generated bridge*, a real adapter, and a real coordination service (the scaffolding is extracted from `examples/demo/tests/e2e/mcp-bridge-stack.test.ts`, which already proves out all four):

1. `proposerOnly` default → adapter auto-approves → bridge returns the result.
2. High-impact action, no approvals → `additionalApprovalsRequired` → bridge waits or returns pending.
3. High-impact action, insufficient approvals → adapter blocks.
4. High-impact action, threshold met → adapter dispatches upstream → bridge returns the result.

Setup is generated per run, not per application: ephemeral did:jwk keys, a deployment config assembled from the app's `plugin.json`, and a template policy that threshold-gates one tool drawn from the plugin's `high`/`critical` `impact` operations (falling back to any governed operation if none are marked high-impact). If `classification.json` is still `draft: true`, the harness runs anyway but emits the same unreviewed-classification warning as the compat harness — the scenarios are still valid, but the impact assignments informing the choice of gated tool have not been signed off. Nothing application-specific is committed beyond `harness-config.json`.

---

## 7. Registry Maintenance

- Every mpas-applications implementation has exactly one entry in `oma3/mpas/application-registry/`, named `{application}-{publisher-org}.json`.
- Entries are updated whenever the referenced plugin's `artifactDid` (or location) changes — the entry pins what it describes.
- The existing demo entry (`github-demo-oma3dao.json`) predates the current demo layout and is reconciled as part of this work (correct plugin path/DIDs; see plan.md task list).

---

## 8. Open Questions

1. Should `upstream.toolSurface` and `plugin.artifactDid` become required registry fields once the drift-prevention spec work (plugin `toolSurface`) lands, or stay optional? (Leaning: optional in v1, required for entries claiming `status: "active"` — alongside requiring `classification.json` `draft: false`, so no implementation is promoted to active with unreviewed impact assignments.)
2. Does the bridge need a first-class "compat mode" (bypass MPAS, proxy directly) for harness use, or is a stub adapter sufficient? A compat mode is a dangerous flag to ship in production bridges; a stub adapter keeps the bridge honest. (Leaning: stub adapter.)
3. `--org-config` location convention: per-publisher file in mpas-applications root vs. flag-only. (Leaning: `publishers/<org>.json` in mpas-applications.)
