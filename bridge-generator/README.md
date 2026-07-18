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
npm test          # 39 tests; all should pass
```

## Two modes

### 1. `generate` — full application package (recommended)

One discovery pass, complete `applications/<name>/` layout:

```sh
node dist/index.js generate \
  --app github \
  --out ../../mpas-applications/applications \
  --application-did did:web:github.example \
  [--org-config ./my-org.json] \
  -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
```

Everything after `--` is the upstream command, executed verbatim with your current environment (so env vars like tokens pass through). The upstream only needs to survive `initialize` + `tools/list`; it is terminated after discovery.

Output:

```text
applications/github/
  plugin.json                     MpasApplicationPlugin — review DIDs before publishing
  registry-entry.json             Application Registry draft (PLACEHOLDERs unless --org-config given)
  harness-config.json             Input for the compat/approval harnesses
  build-artifacts/
    tools-list.snapshot.json      Verbatim tool surface + toolSurface hash
    metadata.json                 Server info, protocol version, capture timestamp
    classification.json           Draft impact classification — REVIEW THIS
  bridge/
    src/index.ts                  The generated bridge MCP server
    package.json / tsconfig.json / README.md
  CHANGELOG.md                    Yours; never overwritten
```

`--org-config` fills publisher/application identity in the registry entry:

```json
{
  "publisher": { "name": "Wivity", "githubOrg": "wivity", "publisherDid": "did:web:wivity.example" },
  "application": {
    "name": "GitHub",
    "description": "MPAS-protected GitHub via the official GitHub MCP server.",
    "applicationDid": "did:web:github.example",
    "website": "https://github.com"
  }
}
```

### 2. Low-level — just the bridge and/or plugin

```sh
node dist/index.js \
  --output-bridge ./github-bridge.ts \
  --output-plugin ./github-plugin.json \
  -- npx -y @modelcontextprotocol/server-github
```

## The review workflow (do this before publishing anything)

1. **`build-artifacts/classification.json`** — the impact levels are a name-based heuristic (`delete|remove|destroy|drop|purge` → critical, `merge|deploy|release|transfer|revoke` → high, everything else medium). Review every operation: fix wrong impacts, change each `rationale` from `"name-heuristic"` to a short justification, and flip `"draft": true` to `false` when done. Reviewed impacts flow into `plugin.json` on the next regeneration; the harnesses warn while `draft` is `true`.
2. **`plugin.json`** — replace the `did:web:PLACEHOLDER` values (pluginDid, publisherDid, applicationDid) with real DIDs. The plugin's declared operations are the *governed set*; anything the upstream exposes that you leave out of the plugin routes as pass-through at deployments that allow it.
3. **`registry-entry.json`** — replace PLACEHOLDERs (or use `--org-config`), set `plugin.repository` to where the plugin will actually be published, then submit as a PR to `oma3/mpas/application-registry/{application}-{org}.json`. The entry already pins `plugin.artifactDid` and `upstream.toolSurface` for you.
4. **`harness-config.json`** — if you intentionally rename tools, wrap schemas, or edit descriptions in the bridge, record it under `intentionalDeviations` so the compat harness allowlists it. Every tool you reference must exist in the snapshot.
5. Log your decisions in `CHANGELOG.md`.

## Regeneration

Re-running `generate` over an existing folder is safe and diff-friendly:

- Generated files are overwritten; against an unchanged upstream, **only `metadata.json` changes** (its capture timestamp). Any other diff means the upstream actually drifted — read it.
- `CHANGELOG.md` is never touched. Files listed in `.generator-keep` (one relative path per line, `#` comments allowed) are never touched.
- `classification.json` is merged: your reviewed entries survive verbatim, new upstream tools are added as `name-heuristic` drafts (re-flagging `draft: true`), removed tools are dropped.
- `harness-config.json` is merged: the upstream command is refreshed, your `intentionalDeviations` and `env` survive.

## Building a generated bridge

Generated bridges import `@oma3/mpas`, which is not yet published to npm. On a machine with the `mpas` repo checked out:

```sh
cd sdk/protocol && npm install && npm run build      # once

cd applications/github/bridge
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
  "plugin": "/path/to/applications/github/plugin.json",
  "adapter": { "url": "http://127.0.0.1:7544" },
  "coordination": { "url": "http://127.0.0.1:7545" },
  "agent": { "did": "<did:jwk from key generate>", "keyFile": "/path/to/keys/proposer-key.json" },
  "target": { "applicationDid": "did:web:github.example" },
  "approvalStrategy": "wait"
}
```

Keys come from the demo CLI (`mpas key generate`, which mints did:jwk identities); the Credential Adapter and Coordination Service come from `examples/demo`. See `examples/demo/guides/setup-macos.md` for the full local stack walkthrough.

## Behavior notes

- **Deterministic output.** Same upstream, same input → byte-identical artifacts (timestamps live only in `metadata.json`). This is load-bearing: it's how drift shows up as a meaningful git diff.
- **Verbatim capture.** Tool names, descriptions, and schemas are copied exactly — never summarized or renamed. Disambiguation between applications is the job of `target.applicationDid`, never tool-name prefixes.
- **Injection-safe codegen.** Hostile tool names/descriptions cannot break out of the generated code (tested).
- **Exit codes:** `0` success · `2` upstream spawn failure · `3` MCP handshake failure · `4` tools/list failure (including zero tools or malformed tool definitions) · `5` generate-phase validation error (bad `--app` name, bad org config, incomplete registry entry). Progress goes to stderr.

## What this tool does not do

It does not deploy anything, hold credentials, set policy, or talk to any network endpoint other than spawning the upstream command you give it. Policy (who approves what) is the operator's job via the Credential Adapter deployment config; trust in the plugin is the publisher's job via OMATrust attestation.
