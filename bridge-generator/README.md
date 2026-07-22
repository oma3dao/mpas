# bridge-generator

Development-time generator that turns an existing MCP server into an MPAS-protected drop-in replacement. It spawns the upstream server, captures its tool surface over the MCP handshake, and emits a static TypeScript bridge, an Application Plugin, and (in `generate` mode) a complete reviewable application package.

Contracts for everything emitted are specified in [`docs/features/bridge-generator/spec.md`](../docs/features/bridge-generator/spec.md); the roadmap is in [`plan.md`](../docs/features/bridge-generator/plan.md).

## Prerequisites

- Node.js >= 22
- The upstream MCP server runnable from your shell (any command: `node`, `npx`, `docker run -i`, a binary)
- For building generated bridges: the `@oma3/mpas` SDK built locally (see "Building a generated bridge" below)

## Setup

```sh
cd bridge-generator
npm install
npm run build
npm test          # 50 tests; all should pass
```

## Two modes

### 1. `generate` — full application package (recommended)

One discovery pass, complete `applications/<name>/` layout:

```sh
node dist/index.js generate \
  --app my-app \
  --out ../../mpas-applications/applications \
  --application-did did:web:my-app.example \
  [--prompt-secret UPSTREAM_API_TOKEN] \
  [--org-config ./my-org.json] \
  -- /path/to/upstream-mcp-server
```

Everything after `--` is the upstream command (binary, `npx …`, `docker run -i …`, etc.), executed with your current environment. If the upstream needs credentials via an environment variable, either export that variable yourself or pass `--prompt-secret <ENV_VAR>` (repeatable): the generator prompts on the TTY with echo disabled when the variable is unset, then exports it for the spawn. The env var **name** is whatever that upstream documents — the generator does not assume a particular auth scheme. The upstream only needs to survive `initialize` + `tools/list`; it is terminated after discovery.

Output:

```text
applications/my-app/
  plugin.json                     MpasApplicationPlugin — THE governed set; edit this (membership, DIDs, impacts)
  registry-entry.json             Application Registry draft (PLACEHOLDERs unless --org-config given)
  harness-config.json             Input for the compat/approval harnesses
  build-artifacts/                Advisory/debug artifacts — not governance controls
    tools-list.snapshot.json      Verbatim tool surface + toolSurface hash (regen uses it to remember your removals)
    metadata.json                 Server info, protocol version, capture timestamp
    classification.json           Heuristic impact suggestions to consult while editing plugin.json
  bridge/
    src/index.ts                  The generated bridge MCP server
    package.json / tsconfig.json / README.md
  CHANGELOG.md                    Yours; never overwritten
```

`--org-config` fills publisher/application identity in the registry entry:

```json
{
  "publisher": { "name": "Example Org", "githubOrg": "example-org", "publisherDid": "did:web:example.org" },
  "application": {
    "name": "My App",
    "description": "MPAS-protected bridge for the upstream MCP server.",
    "applicationDid": "did:web:my-app.example",
    "website": "https://example.org"
  }
}
```

### 2. Low-level — just the bridge and/or plugin

```sh
node dist/index.js \
  --output-bridge ./my-app-bridge.ts \
  --output-plugin ./my-app-plugin.json \
  [--prompt-secret UPSTREAM_API_TOKEN] \
  -- /path/to/upstream-mcp-server
```

## The review workflow (do this before publishing anything)

`plugin.json` is the source of truth for governance: an operation is governed iff it appears in the plugin's `operations` (per the MPAS Application Plugin profile). Everything under `build-artifacts/` is advisory — inputs to *your* judgment, not controls the generator or harnesses enforce.

1. **`plugin.json`** — this is the file you edit.
   - **Membership:** delete any operation that should route as pass-through instead of being governed. Regeneration remembers your removals (see below) and won't re-add them.
   - **Impacts:** each operation's `impact` starts from upstream MCP metadata when available (`annotations.destructiveHint: true` → critical), then falls back to a name-based heuristic (`delete|remove|destroy|drop|purge` → critical, `merge|deploy|release|transfer|revoke` → high, everything else medium). Annotations are untrusted hints, so generated classifications remain drafts and `destructiveHint: false` never downgrades a name-based warning. Fix wrong values; your edits survive regeneration. Consult `build-artifacts/classification.json` for the rationale per tool.
   - **Identity:** replace the `did:web:PLACEHOLDER` values (pluginDid, publisherDid, applicationDid) with real DIDs, and fill `credentialRequirements`. These also survive regeneration.
2. **`registry-entry.json`** — replace PLACEHOLDERs (or use `--org-config`), set `plugin.repository` to where the plugin will actually be published, then submit as a PR to `oma3/mpas/application-registry/{application}-{org}.json`. The entry already pins `plugin.artifactDid` and `upstream.toolSurface` for you.
3. **`harness-config.json`** — if you intentionally rename tools, wrap schemas, or edit descriptions in the bridge, record it under `intentionalDeviations` so the compat harness allowlists it. Every tool you reference must exist in the snapshot.
4. Log your decisions in `CHANGELOG.md`.

## Regeneration

Re-running `generate` over an existing folder is safe and diff-friendly:

- Generated files are overwritten; against an unchanged upstream, **only `metadata.json` changes** (its capture timestamp). Any other diff means the upstream actually drifted — read it.
- `CHANGELOG.md` is never touched. Files listed in `.generator-keep` (one relative path per line, `#` comments allowed) are never touched.
- **`plugin.json` is merged, and your membership edits stick.** The previous snapshot minus the previous plugin is remembered as intentional pass-through: a tool you deleted from the plugin is not re-added on regen. Genuinely new upstream tools (absent from the previous snapshot) *are* added as governed candidates so they can't slip in unnoticed — delete them if they shouldn't be governed. Tools the upstream dropped disappear. DIDs, `credentialRequirements`, and per-operation `impact` values are preserved from your existing plugin; operation descriptions and payload schemas refresh from discovery. (You do **not** need to list `plugin.json` in `.generator-keep` — doing so would also block new-tool surfacing; remove it if you added it under older generator versions.)
- `classification.json` is merged: your reviewed entries survive verbatim, new upstream tools are added as `name-heuristic` drafts (re-flagging `draft: true`), removed tools are dropped. It never drives plugin membership.
- `harness-config.json` is merged: the upstream command is refreshed, your `intentionalDeviations` and `env` survive.

## Building a generated bridge

Generated bridges import `@oma3/mpas`, which is not yet published to npm. On a machine with the `mpas` repo checked out:

```sh
cd sdk/protocol && npm install && npm run build      # once

cd applications/my-app/bridge
# point the dependency at your local SDK checkout:
#   "@oma3/mpas": "file:/path/to/mpas/sdk/protocol"
npm install
npm run build
```

Run it like the demo proposer bridge — the config format is identical:

```sh
node dist/index.js --config ./bridge-config.json
```

```json
{
  "mode": "proposer",
  "plugin": "/path/to/applications/my-app/plugin.json",
  "adapter": { "url": "http://127.0.0.1:7544" },
  "coordination": { "url": "http://127.0.0.1:7545" },
  "agent": { "did": "<did:jwk from key generate>", "keyFile": "/path/to/keys/proposer-key.json" },
  "target": { "applicationDid": "did:web:my-app.example" },
  "approvalStrategy": "wait"
}
```

Keys come from the demo CLI (`mpas key generate`, which mints did:jwk identities); the Credential Adapter and Coordination Service come from `examples/demo`. See `examples/demo/guides/setup-macos.md` for the full local stack walkthrough.

## Behavior notes

- **Deterministic output.** Same upstream, same input → byte-identical artifacts (timestamps live only in `metadata.json`). This is load-bearing: it's how drift shows up as a meaningful git diff.
- **Verbatim capture.** Complete MCP Tool objects are copied exactly — including output schemas, annotations, icons, `_meta`, and extension fields — never summarized or renamed. Paginated `tools/list` responses are collected into one static surface. Disambiguation between applications is the job of `target.applicationDid`, never tool-name prefixes.
- **Mirror responses.** Successful upstream MCP `CallToolResult` objects returned by the adapter are relayed without reshaping, preserving structured content, resource content, `_meta`, and future fields.
- **Injection-safe codegen.** Hostile tool names/descriptions cannot break out of the generated code (tested).
- **Exit codes:** `0` success · `2` upstream spawn failure · `3` MCP handshake failure · `4` tools/list failure (including zero tools or malformed tool definitions) · `5` generate-phase validation error (bad `--app` name, bad org config, incomplete registry entry). Progress goes to stderr.

## What this tool does not do

It does not deploy anything, hold credentials, set policy, or talk to any network endpoint other than spawning the upstream command you give it. Policy (who approves what) is the operator's job via the Credential Adapter deployment config; trust in the plugin is the publisher's job via OMATrust attestation.
