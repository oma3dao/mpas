# Credential Adapter operator guide

> **Complete signer account setup before starting this guide.**
> The deployment config requires the `did:jwk` of every proposer and maintainer.
> Those DIDs are only known after each signer has generated their key in their
> own account. Set up all signer accounts first, collect their DIDs, then return
> here. See the [macOS demo setup guide](setup-macos.md) §2.1 for the key
> generation command each signer runs.

The Credential Adapter is the trusted MPAS component that verifies Action
Packages, evaluates policy, holds downstream credentials, dispatches authorized
operations, and signs Execution Receipts. Agents and MCP bridges must not have
access to its credential stores or operator controls.

This guide covers everything an operator needs to set up the Credential Adapter
from a fresh account: creating the `~/.mpas` directory tree, sourcing
application artifacts from `mpas-applications`, building and wiring the
deployment config, storing credentials, and starting the daemon.

For the full single-machine demo walkthrough (agent harnesses, bridge configs,
demo scenarios), see the [macOS demo setup guide](setup-macos.md).

## Where to run the adapter

The adapter must run in a **separate account from the proposer** — it holds the
upstream credentials that the proposer must never be able to read directly. At
the same time, the proposer's bridge communicates with the adapter over HTTP, so
the adapter must be reachable from wherever the proposer runs.

Two deployment topologies work:

**Same machine, separate accounts (local demo)**
The adapter runs under a dedicated macOS user account (or Linux user). The
proposer runs under a different account on the same machine. Both accounts share
the loopback interface, so the proposer's bridge can reach the adapter at
`http://127.0.0.1:7544` without any network exposure. This is the topology used
in the demo.

**Remote (production)**
The adapter runs on a separate machine or cloud host — a VM, container, or
managed server. The proposer's bridge config points at the adapter's public or
private network address (e.g. `https://adapter.internal:7544`). The adapter
should be behind TLS and not directly reachable from the internet unless
intentionally exposed. The credential store and key files stay on that remote
host; the proposer account has no filesystem access to them.

In either topology, the proposer bridge connects **out** to the adapter over
HTTP — the adapter does not need to reach the proposer. The Coordination Service
follows the same rule: it must be reachable by both the proposer bridge and the
maintainer signer server, but it holds no secrets and can run anywhere.

---

## 1. The `~/.mpas` directory

The Credential Adapter reads from a home directory, conventionally `~/.mpas`,
set via the `MPAS_HOME` environment variable. Create it with all required
subdirectories:

```sh
export MPAS_HOME="$HOME/.mpas"
mkdir -p "$MPAS_HOME/config" \
         "$MPAS_HOME/plugins" \
         "$MPAS_HOME/credentials" \
         "$MPAS_HOME/keys" \
         "$MPAS_HOME/journal" \
         "$MPAS_HOME/mcp-server-configs" \
         "$MPAS_HOME/workflows"
```

| Subdirectory | Contents |
| :--- | :--- |
| `config/` | Deployment config files — one per application (`<name>-adapter-config.json`) |
| `plugins/` | Application plugin files referenced by deployment configs |
| `credentials/` | Credential files (file-based tokens). `chmod 600` every file here. |
| `keys/` | Adapter signing key (`adapter-key.json`). `chmod 600`. |
| `journal/` | Dispatch ledger (`dispatch-ledger.jsonl`) — private append-only lifecycle and terminal-response log |
| `mcp-server-configs/` | Bridge configs (proposer) and signer-server configs (maintainer) |
| `workflows/` | Persistent workflow state databases for proposer bridges |

---

## 2. Collect signer DIDs — set up the adapter last

The deployment config cannot be completed until every participant's DID is
known. **Set up the adapter account last**, after all proposers and maintainers
have generated their keys in their own accounts and sent you their DIDs.

Each participant generates their key in their own isolated account and sends
you only the `did:jwk:...` string. The private key never leaves their machine.
See the [macOS demo setup guide](setup-macos.md) §2.1 for the key generation
command each signer runs.

Once you have every participant's DID, proceed with the steps below.

> **DIDs are the identity primitive.** Policy evaluation, approval counting, and
> proposer gating all operate on DIDs. A DID absent from `signerGroups` is
> rejected before policy even runs. Getting every DID registered correctly is
> the most consequential part of the setup — validate (§7) before starting the
> daemon.

## 3. Generate the adapter key

The only key generated in this account is the adapter's signing key for
Execution Receipts:

```sh
cd "$HOME/Projects/mpas/examples/demo"
node dist/cli/index.js key generate adapter-key --key-dir "$MPAS_HOME/keys"
chmod 600 "$MPAS_HOME/keys/adapter-key.json"
```

This key does not go into `signerGroups`. It is passed directly to the daemon
via `--adapter-key` and plays no role in the approval workflow.

---

## 4. Source application artifacts from `mpas-applications`

**Repeat this section for every application you want to protect.** Each
application has its own folder under `applications/<name>/` in the
[`oma3dao/mpas-applications`](https://github.com/oma3dao/mpas-applications)
repository. You need two files from each:

| File | Where it goes | What it is |
| :--- | :--- | :--- |
| `plugin.json` | `$MPAS_HOME/plugins/<name>-plugin.json` | Governed operation surface and schemas |
| `adapter-config.example.json` | `$MPAS_HOME/config/<name>-adapter-config.json` | Deployment config template — **you fill this in** |

```sh
# Example for Netlify — repeat for each application
cp /path/to/mpas-applications/applications/netlify/plugin.json \
   "$MPAS_HOME/plugins/netlify-plugin.json"

cp /path/to/mpas-applications/applications/netlify/adapter-config.example.json \
   "$MPAS_HOME/config/netlify-adapter-config.json"
```

Also read the application's `README.md` before proceeding. It documents
credential type and setup, any provider-specific bypass risks, and notes on the
governed surface (including sub-operation-level policy guidance where the
upstream tool multiplexes multiple operations).

The `build-artifacts/classification.json` in each application folder is the
per-operation rationale record. Use it when deciding whether to tighten or
relax the default policy in your deployment config.

---

## 5. Fill in the deployment config

**Repeat this section for every application you want to protect.** Each
application has its own deployment config file in `$MPAS_HOME/config/` and
must be filled in separately. The adapter loads all config files in that
directory at startup, so adding a new application means copying its
`adapter-config.example.json`, filling it in, and restarting the daemon.

Open `$MPAS_HOME/config/<name>-adapter-config.json`. It is a template with
`REPLACE_WITH_*_DID` placeholders and an absolute plugin path to update.
Work through each section:

### 5.1 Plugin path

```json
"plugin": {
  "pluginDid": "did:web:wivity.com:plugins:netlify-mcp-server",
  "pluginVersion": "0.1.0",
  "artifactDid": "did:artifact:...",
  "path": "/absolute/path/to/mpas-applications/applications/netlify/plugin.json"
}
```

Replace `path` with the absolute path to the plugin file you copied into
`$MPAS_HOME/plugins/`:

```json
"path": "/Users/you/.mpas/plugins/netlify-plugin.json"
```

Do not change `pluginDid`, `pluginVersion`, or `artifactDid` — those are
publisher-set values the adapter uses for content verification.

### 5.2 Signer DIDs

The `signerGroups` inside `policy` control who may propose actions and who may
approve them. Replace every `REPLACE_WITH_*_DID` placeholder with the actual
`did:jwk:...` values collected from each participant in step 2:

```json
"signerGroups": {
  "all": [
    "<proposer did>",
    "<approver did>"
  ],
  "proposers": [
    "<proposer did>"
  ],
  "approvers": [
    "<approver did>"
  ]
}
```

A DID not listed in `all` is unknown to the adapter and will be rejected.
`proposers` restricts who may submit Action Packages. Any group referenced by
a policy requirement (e.g. `"humanApprovers"`) must also be defined here with
its members.

The `signerKeys` array at the bottom of the config is the Signer registry.
Add one entry per participant:

```json
"signerKeys": [
  {
    "did": "<proposer did>",
    "label": "Proposer"
  },
  {
    "did": "<approver did>",
    "label": "Approver"
  }
]
```

For `did:jwk` Signers the public key is encoded in the DID itself, so no
`publicJwk` field is required. If you use a different DID method that does not
embed the public key, add a `publicJwk` entry so the adapter can verify
signatures.

### 5.3 Policy

The template includes a `policy` block with a `defaultRequirement` and, for
applications like Netlify, pre-written match conditions for high-impact
sub-operations. Review and adjust:

- **`defaultRequirement`** — governs every operation in the plugin that has no
  matching policy entry. Production deployments should require at least one
  non-proposer approval. Change `eligibleSignerGroup` to match a group you
  defined in `signerGroups`.
- **`policies`** — per-operation (and per-sub-operation) overrides. See the
  application README for guidance on which operations warrant stricter rules.

Do not change `applicationDid`, `policyProfileUrl`, or `executionProfile` —
those are bound to the plugin and execution profile.

---

## 6. Store a credential

The adapter holds the real upstream credential. How you store it depends on
the application's authentication type.

### Option A — File-based token (API key, PAT, bearer token)

Create a JSON credential file and lock its permissions:

```sh
printf '%s\n' '{"value":"<your-token-here>"}' \
  > "$MPAS_HOME/credentials/<name>-token.json"
chmod 600 "$MPAS_HOME/credentials/<name>-token.json"
```

The deployment config's `credentialBindings` maps the handle name to this file:

```json
"credentialBindings": [
  {
    "credentialHandle": "<handle-name>",
    "provider": "file"
  }
]
```

The `executionTarget` then injects the credential at launch time using
`{{credential:<handle-name>}}` — for example, into an environment variable or
a `--header` argument. The token value is never exposed to proposer agents.

For GitHub-style fine-grained PATs, scope the token to the smallest set of
repositories and permissions the deployment actually needs. Never put the token
in `plugin.json`, `adapter-config.example.json`, bridge configs, source
control, or the proposer's environment.

### Option B — OAuth (hosted MCP endpoints)

Some upstream MCP servers (such as Netlify) authenticate via OAuth rather than
a static token. The adapter manages the OAuth session directly through the
`mpas oauth` commands. After loading your deployment config, authenticate as
the operator:

```sh
mpas oauth login --application-did <applicationDid>
```

Use `--no-browser` for headless environments:

```sh
mpas oauth login --application-did <applicationDid> --no-browser
```

The `applicationDid` is the exact `target.applicationDid` value in your
deployment config (e.g.
`did:web:wivity.com:applications:netlify-mcp-server`).

**Only an operator runs `mpas oauth login`.** Agents, proposer bridges,
automatic retries, and tool calls must never open the authorization URL or
initiate consent. The OAuth session is held by the adapter; the token is never
surfaced to the proposer.

Check session state or revoke with:

```sh
mpas oauth status --application-did <applicationDid>
mpas oauth logout --application-did <applicationDid>
```

When `provider` is `oauth` in the deployment config's `credentialBindings`,
the adapter resolves the credential from its managed OAuth session at dispatch
time instead of from a file.

---

## 7. Validate and start the adapter

### Validate the configuration

Before starting the daemon, run the config validator to catch DID paste errors,
missing credentials, and path problems:

```sh
cd "$HOME/Projects/mpas/examples/demo"
node dist/cli/index.js config validate <config-name> \
  --config-dir "$MPAS_HOME/config" \
  --credential-dir "$MPAS_HOME/credentials" \
  --bridge-dir "$MPAS_HOME/mcp-server-configs"
```

Where `<config-name>` is the filename without the `.json` extension (e.g.
`netlify-adapter-config`). The validator checks that:

- every `signerKeys` entry has a valid DID;
- any `publicJwk` present agrees with the DID;
- every group referenced in `policy.signerGroups` and requirement entries
  exists and is non-empty;
- referenced credential files exist (for file-based bindings);
- each bridge config's `agent.did` is listed in `signerKeys`.

Fix any errors before starting the daemon.

### Start the combined local daemon

In a dedicated terminal:

```sh
export MPAS_HOME="$HOME/.mpas"
cd "$HOME/Projects/mpas/examples/demo"
node dist/cli/index.js daemon start \
  --config-dir "$MPAS_HOME/config" \
  --credential-dir "$MPAS_HOME/credentials" \
  --adapter-key "$MPAS_HOME/keys/adapter-key.json" \
  --journal-path "$MPAS_HOME/journal/dispatch-ledger.jsonl" \
  --host 127.0.0.1 \
  --port 7544 \
  --coordination-port 7545
```

Expected output:

```json
{"status":"started","address":"http://127.0.0.1:7544","coordinationAddress":"http://127.0.0.1:7545","loadedConfigs":1}
```

Verify both services are healthy:

```sh
curl -s http://127.0.0.1:7544/mpas/v1/health | jq .
curl -s http://127.0.0.1:7545/mpas/v1/coordination/health | jq .
```

The adapter will prompt you to confirm each plugin on first start (OMATrust
plugin verification). Review the displayed provenance evidence and answer `y`
to proceed. If the OMATrust API is unreachable you will see a warning — this
means provenance evidence could not be loaded, not that the content hash
failed. Review the plugin carefully before answering `y`.

### Receive relayed Actions from a hosted Coordination Service

Add the hosted service URL when this Credential Adapter acts as its Verifier:

```sh
node dist/cli/index.js adapter start \
  --config-dir "$MPAS_HOME/config" \
  --credential-dir "$MPAS_HOME/credentials" \
  --adapter-key "$MPAS_HOME/keys/adapter-key.json" \
  --verifier-coordination-url https://api.signerset.com
```

The adapter uses its adapter key for RFC 9421 authentication. The WebSocket is notification-only: the adapter polls once when it connects, polls after each notification, and performs a 30-second recovery poll if no notification arrives. It processes addressed `DeliveryEnvelope<ActionRequest>` messages through the same Verifier path as direct submissions, then returns `DeliveryEnvelope<ActionResponse>` to the Proposer and any eligible Maintainers named by authenticated Authorization Requirements.

`adapter start` runs only the Credential Adapter. It does not bind the local
Coordination Service port. Use `coordination start` for that service alone or
`daemon start` when a local deployment intentionally needs both processes.

The durable cursor and cached response envelopes default to
`~/.mpas/journal/verifier-coordination.json`. Override that path with
`--verifier-coordination-state`; override the recovery interval with
`--verifier-poll-interval-ms`. The corresponding environment variables are
`MPAS_VERIFIER_COORDINATION_URL`, `MPAS_VERIFIER_COORDINATION_STATE`, and
`MPAS_VERIFIER_POLL_INTERVAL_MS`.

Malformed envelopes and payload types other than `ActionRequest` fail closed.
The adapter leaves the cursor on the invalid delivery, stops its recovery timer,
and logs a `fatal_error`; an operator must remove or quarantine that delivery at
the Coordination Service before restarting. This prevents silently discarding a
future message type that the installed Verifier does not understand.

---

## 8. OAuth command reference

These commands are only relevant for applications whose upstream MCP server
uses OAuth (credential binding `provider: "oauth"`). Skip this section for
file-based credentials.

```sh
mpas adapter start
mpas adapter status

mpas oauth login  --application-did <did>
mpas oauth status --application-did <did>
mpas oauth logout --application-did <did>
```

Use `--no-browser` for a print-only/headless login flow. The first
implementation manages one OAuth grant per Application DID. Its security
binding includes the exact MCP resource, issuer, client, and scopes resolved by
the secure provider.

OAuth authenticates the adapter to the downstream MCP server. It never counts
as an MPAS Approval and never bypasses Action verification or policy evaluation.

`status` output is deliberately redacted to issuer, exact resource, client
mode, scope names, expiry/refreshability, and reauthorization state. Tokens,
client secrets, authorization codes, PKCE material, cookies, and callback query
strings are never printed.

`logout` removes local credentials even when remote revocation is unavailable.

---

## 9. Security boundary

- Run the adapter in an operator-controlled OS account or equivalent isolated
  environment. Do not colocate its credentials or keys with proposer or
  maintainer agents.
- The adapter is the only component that holds upstream credentials. Bridges,
  agents, and the Coordination Service must not have access to `$MPAS_HOME/credentials/`
  or `$MPAS_HOME/keys/adapter-key.json`.
- Signer group membership comes from the deployment config, which is
  operator-owned. A proposer cannot modify its own group membership or the
  policy through Action Packages or Execution Payload parameters.
- Self-approval is enforced at the protocol level: a proposer DID cannot satisfy
  an approval threshold for its own actions regardless of signer group membership.

---

## Related documentation

- [macOS demo setup guide](setup-macos.md) — full single-machine walkthrough
- [proposer setup guide](proposer.md)
- [maintainer setup guide](maintainer.md)
- [Managed MCP OAuth specification](../../../docs/features/mcp-oauth/spec.md)
- [JSON Verifier Policy Profile](../../../specs/mpas-profile-policy-json.md) — policy match conditions, requirement types, signer groups
- [Application Plugin Profile](../../../specs/mpas-profile-application-plugin.md) — plugin schema reference
- [mpas-applications repository](https://github.com/oma3dao/mpas-applications) — contributed application plugins, bridges, and adapter-config templates
