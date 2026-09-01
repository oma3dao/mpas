# mpas-demo

Local MPAS (Multi-Party Action Security) services — Credential Adapter daemon, Coordination Service, and Signer Server.

MPAS is a protocol for multi-party approval of AI agent actions. Instead of giving agents direct access to privileged APIs (GitHub, cloud providers, databases), MPAS routes actions through a Credential Adapter that enforces policy-based approval workflows before execution.

Credential Adapter operators should start with the
[Credential Adapter operator guide](guides/credential-adapter.md), which
covers the adapter trust boundary, commands, and managed OAuth status.
Proposers and maintainers should start with their respective guides:
[proposer setup guide](guides/proposer.md) and
[maintainer setup guide](guides/maintainer.md).

## Specifications

For the full protocol design, start with the base specification:

- [mpas-specification.md](../../specs/mpas-specification.md) — **Core protocol: Action Lifecycle, dispatch ledger, artifact model, trust architecture**
- [mpas-profile-http.md](../../specs/mpas-profile-http.md) — HTTP Profile: wire format, ActionRequest/Response, coordination
- [mpas-profile-mcp.md](../../specs/mpas-profile-mcp.md) — MCP Profile: execution payload format for MCP tool calls
- [mpas-profile-application-plugin.md](../../specs/mpas-profile-application-plugin.md) — Application Plugin Profile: plugin schema and operation defs
- [mpas-profile-policy-json.md](../../specs/mpas-profile-policy-json.md) — JSON Verifier Policy Profile: policy matching and evaluation

## Related Packages

| Location                                                                 | Description                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| [`sdk/protocol`](../../sdk/protocol)                                     | @oma3/mpas protocol SDK                               |

## Architecture

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│  Proposer Agent  │       │  MCP Bridge      │       │  Credential Adapter  │       │  Target         │
│                  │──MCP─▶│  (proposer mode) │─HTTP─▶│  (port 7544)         │──API─▶│  (GitHub)       │
│  Sees normal MCP │       │  Signs envelopes │       │  Verifies signatures │       │                 │
│  tools           │       │  Waits for       │       │  Evaluates policy    │       │                 │
│                  │       │  approval        │       │  Dispatches action   │       │                 │
└──────────────────┘       └────────┬─────────┘       └──────────────────────┘       └─────────────────┘
                                    │
                                    │ HTTP (submit/poll)
                                    ▼
                           ┌──────────────────┐
                           │  Coordination    │
                           │  Service         │
                           │  (port 7545)     │
                           │  Approval queue  │
                           └────────▲─────────┘
                                    │
                                    │ HTTP (list/approve/reject)
                                    │
┌──────────────────┐       ┌──────────────────┐
│  Maintainer Agent│       │  Signer Server   │
│                  │──MCP─▶│  (MCP server)    │
│  Sees approval   │       │  Signs approvals │
│  tools           │       │                  │
└──────────────────┘       └──────────────────┘
```

### How it works

**The agent sees a normal MCP server.** The MCP Bridge abstracts the entire MPAS protocol — signing, envelope construction, replacement Actions, and coordination polling — away from the agent. From the agent's perspective, it calls tools like `create_issue_mirror` or `delete_branch_mirror` and receives an MCP Task; it observes that stable Task with `tasks/get` even if the bridge replaces the underlying MPAS Action.

**Proposer flow:**

1. Agent calls an MCP tool (e.g., `delete_branch_mirror`)
2. MCP Bridge (proposer mode) constructs and signs an Action Package, submits it to the Credential Adapter
3. Credential Adapter verifies the signature, evaluates policy:
   - If auto-approved: dispatches immediately to the target (GitHub) and returns the result
   - If approval required: returns `additionalApprovalsRequired`
4. Bridge submits the pending action to the Coordination Service and polls for resolution
5. Once a maintainer approves the replacement Action, the bridge submits its completed Action Package to the adapter
6. Adapter verifies the full policy is met (correct signatures, threshold reached, no self-approval), then dispatches
7. The agent's `tasks/get` on that Task returns the execution result

**Maintainer flow:**

1. Agent calls `mpas_list_pending` → Signer Server queries the Coordination Service
2. Agent calls `mpas_review_action` → Server fetches full action details and verifies integrity
3. Agent calls `mpas_approve` → Server signs an approval and submits it to the Coordination Service
4. The proposer's bridge detects the approval on its next poll and submits the completed replacement Action

**Key security properties:**

- Agents hold no privileged credentials — all writes route through the adapter
- The adapter verifies cryptographic signatures and evaluates policy before dispatching
- Self-approval is prevented at both coordination (rejects matching DIDs) and policy engine (excludes proposer from threshold counts) levels
- The MCP Bridge and Signer Server are the trust boundaries — they hold the agent's signing key and perform all protocol operations

### Why workspace separation matters

MPAS guarantees that no single agent can both propose and approve the same action. But that guarantee is only as strong as the isolation between keys. If a proposer agent can read the maintainer's key file, it can forge approvals. Workspace separation (separate macOS user accounts, containers, or machines) prevents this by making each agent's key unreachable to the others.

### Production topology

```
┌─────────────────────────────────────────────────────────────┐
│  Operator Workspace (dedicated account/machine)             │
│  • Credential Adapter (holds the privileged credential)     │
│  • Coordination Service                                     │
│  • Adapter signing key                                      │
│  • No agent runs here                                       │
└─────────────────────────────────────────────────────────────┘

┌───────────────────────────────┐  ┌───────────────────────────────┐
│  Agent A Workspace            │  │  Agent B Workspace            │
│  (separate account/machine)   │  │  (separate account/machine)   │
│  • Proposer bridge            │  │  • Maintainer signer server   │
│  • Own signing key only       │  │  • Own signing key only       │
│  • Proposes actions           │  │  • Reviews and approves       │
│                               │  │    others' actions            │
└───────────────────────────────┘  └───────────────────────────────┘
```

Give each agent exactly one role. A proposer’s prime directive is to submit governed writes through the bridge and notify maintainers. A maintainer’s prime directive is to review the exact Action and approve or reject it. Combining both roles in one agent blurs that boundary. The protocol still prevents self-approval if a DID appears in both signer groups, but LLM agents work better with one job.

Self-approval is enforced at two levels regardless of group membership:
1. **Coordination service** — rejects any approval submission where `signerDid` matches the action's `proposer.did`
2. **Policy engine (defense in depth)** — excludes the proposer's DID when counting approvals toward thresholds on the completed replacement Action

## Signer Server

The MPAS Signer Server (`src/signer-server/`) is a standalone MCP server that enables agents to act as Signers. One instance per agent, handling approvals across all applications.

It imports protocol primitives from `@oma3/mpas` (`KeyManager`, `CoordinationServiceClient`, `ApprovalBuilder`, and JSON hash utilities) and exposes four MCP tools:

| Tool | Description |
|------|-------------|
| `mpas_list_pending` | Poll the Coordination Service for actions awaiting this agent's approval |
| `mpas_review_action` | Fetch and integrity-check the review set for a pending action |
| `mpas_approve` | Sign and submit an approval for a pending action |
| `mpas_reject` | Sign and submit a rejection for a pending action |

### Running

```sh
npx tsx src/signer-server/index.ts --config <path-to-config.json>
```

### Configuration

```json
{
  "agent": {
    "did": "did:jwk:eyJjcnYiOiJFZDI1NTE5...",
    "keyFile": "./keys/maintainer-a.json"
  },
  "coordination": {
    "url": "http://localhost:7545"
  }
}
```

The signer server is application-agnostic — it handles approval requests for any application routed through the configured Coordination Service. There is no background polling; it queries on demand when the agent calls `mpas_list_pending`.

### MCP Client Configuration

```json
{
  "mcpServers": {
    "mpas-signer": {
      "command": "npx",
      "args": ["tsx", "examples/demo/src/signer-server/index.ts", "--config", "./signer-config.json"]
    }
  }
}
```

## How Credentials Work with MPAS

Most agent setups authenticate to GitHub with a single credential — an SSH key or a broad PAT. The agent has full access to everything.

MPAS splits this into separate credentials with different scopes:

| Credential             | Held by        | Scope                          | Purpose                                                  |
| ---------------------- | -------------- | ------------------------------ | -------------------------------------------------------- |
| Broad GitHub PAT       | Adapter only   | `repo` or fine-grained write   | Full write capability, gated by approval policy          |
| Narrow GitHub PAT      | Agent          | `contents:read` only           | Agent can read code but all writes go through MPAS       |
| Proposer signing key   | Proposer agent | Signs Action Envelopes         | Proves identity when proposing actions                   |
| Maintainer signing key | Maintainer agent | Signs Approvals              | Proves identity when approving/rejecting                 |
| Adapter signing key    | Adapter        | Signs Execution Receipts       | Proves the adapter authorized a dispatch                 |

Proposers and Maintainers can switch roles — any Maintainer can be a Proposer for a different action.

## Configuration Model

MPAS uses three types of configuration files:

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Application Plugin (published by vendor or ecosystem participant)        │
│  Declares: operations, payload schemas, credential requirements.          │
│            Often audited by trusted parties.                              │
│  File: $MPAS_HOME/plugins/github-mirror-plugin.json                         │
└───────────────────────────────────────┬───────────────────────────────────┘
                                        │ referenced by (path + hash)
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Deployment Config (authored by the operator who runs the adapter)         │
│  Declares: policy (signerGroups, approval thresholds, action-keyed         │
│            policies), signer keys, execution target, credential bindings,  │
│            resource restrictions                                           │
│  File: $MPAS_HOME/config/github-mirror-adapter-config.json                                │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │ loaded at startup
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Credential Adapter (daemon)                                               │
│  At startup: loads all configs, resolves each referenced plugin,           │
│  verifies hashes, validates schemas. Refuses to start if anything fails.   │
└────────────────────────────────────────────────────────────────────────────┘
```

The plugin is a stable, published artifact that describes what an MCP server can do. Its integrity is verified via `artifactDid` (a content-addressable identifier) at adapter startup. The deployment config is what the operator edits to customize behavior. The adapter binds them together at runtime.

### Application Plugin

| Field                    | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `pluginDid`              | Unique identity of this plugin (a DID)                                     |
| `pluginVersion`          | Release version of this particular plugin document                         |
| `applicationDid`         | The application this plugin describes (e.g., `did:web:github-mirror.example`)     |
| `executionProfile`       | Declares how execution payloads are formatted (`mcp.toolsCall`)            |
| `credentialRequirements` | What credential the adapter needs to authenticate to the target            |
| `operations`             | Object keyed by operation name: description, optional impact, JSON Schema  |

You do not edit the plugin directly. Its integrity is verified via `artifactDid` at startup — any modification invalidates the DID.

### OMATrust Plugin Verification

The `did:artifact` check proves **content integrity**: the plugin bytes loaded by
the adapter match the content-addressed identifier in deployment configuration.
It does not by itself prove that the publisher is legitimate, that the plugin
is associated with its claimed target application, or that a trusted party has
reviewed it.

After the local integrity check, the adapter automatically calls the public
Artifact Trust API at
`https://api.omatrust.org/v1/artifact-trust`. MPAS binds this production URL to
OMAChain mainnet (chain ID 6623) and its deployed EAS contract, rejecting
evidence returned for another network. That API returns only
verified evidence, including:

- verified responsibility claims identifying an accountable party;
- cybersecurity assessments from approved issuers;
- other recognized informational artifact evidence; and
- verified linked identifiers for operator review.

A responsibility claim or cybersecurity assessment from an approved issuer
is sufficient to suppress the warning; both are not required. A responsibility
claim names the separate responsible-party DID; the artifact DID identifies
the artifact and does not authorize the attester. A verified claim proves its
authenticity, not that the responsible party is legitimate or trustworthy.
The adapter always displays that DID and asks the operator to decide whether
to trust it. Linked identifiers do not produce a pass/fail result: the adapter
lists every verified link and leaves its relevance and trustworthiness to the
operator. User reviews are excluded because their schema cannot prove a
`did:artifact` binding. The prompt also points operators to
https://app.omatrust.org/verify so they can re-check the same `did:artifact`
independently. The prompt contains a warning only when neither primary
signal exists or when OMATrust is unavailable.
Non-interactive startup declines by default.

No OMATrust configuration is required. MPAS does not expose endpoint or API-key
configuration in v1. Support for authenticated premium endpoints can be added
later as a separate configuration contract.

For evaluation semantics and the internal endpoint context, see the
[OMATrust plugin verification feature specification](../../docs/features/omatrust/spec.md).

### Deployment Config

| Field                  | Purpose                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `name`                 | Human-readable label (e.g., `github-mirror`, `github-live-demo`)            |
| `target.applicationDid`| Must match the plugin's `applicationDid`                                    |
| `plugin`               | Reference to the plugin file: DID, version, path, and `artifactDid`         |
| `credentialBindings`   | Maps credential handles to providers (`"github-mirror-token"` → `file`)       |
| `executionTarget`      | How to call the real MCP server (`mcp.stdio` spawns a child process)        |
| `policy`               | Full `MpasApplicationPolicy` object: signerGroups, policies (keyed by action name), defaultRequirement |
| `signerKeys`           | Key registry: DID + label (+ publicJwk for non-did:jwk methods) for each participant |
| `passThrough`          | Routing for ungoverned operations: `"allow"` (default) or `"deny"`          |

**Relationship between plugin and policy:** The plugin describes what operations exist and their payload schemas. The `policy` object (an embedded `MpasApplicationPolicy`) defines who can propose, who can approve, and what thresholds apply. An operation is governed if it's in the plugin's `operations` OR has an entry in `policy.policies`.

**The governance boundary:** anything outside the governed set is routed as pass-through — after proposer gating and signature verification it executes with the adapter's credential on the proposer's signature alone, and `defaultRequirement` does not apply. This is the plugin-anchored trust model: the plugin publisher decides which operations need governance, and the operator accepts that boundary after reviewing available OMATrust attestations and linked-identifier evidence. The demo exposes `create_issue_mirror` this way on purpose to demonstrate the boundary. If you care about an operation, put it in the plugin or give it a policy entry; power users can refuse ungoverned operations entirely with `passThrough: "deny"`.

**Safe default-policy setup:** Use a positive threshold with a maintainer group
for `policy.defaultRequirement`; this covers every plugin operation unless an
operation-specific policy is different. The Adapter checks at startup that the
requirement is satisfiable for every configured proposer after excluding
self-approval. A deliberate single-party default is explicitly authored as
`{ "type": "proposerOnly" }`.

### Bridge Config

The bridge config lives on the agent side and tells the MCP Bridge how to connect to the adapter. The adapter never reads bridge configs. One bridge serves exactly one MCP client or agent identity and holds one private key for the proposer DID derived from that key. Do not share a bridge or key across independent clients; run a separate bridge instance and key for each agent.

| Field                    | Purpose                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `mode`                   | `"proposer"` (can call operations) or `"maintainer"` (can approve/reject)      |
| `plugin`                 | Path to the plugin file (bridge uses it for application identity/profile)      |
| `adapter.url`            | Where to submit action packages                                                |
| `agent.did`              | Legacy informational field; bridge identity is always derived from `agent.keyFile` |
| `agent.keyFile`          | Path to the bridge's single Ed25519 proposer key                               |
| `target.applicationDid`  | Which application DID to target                                                |
| `coordination.url`       | The coordination service endpoint                                              |
| `workflow.dbPath`        | SQLite path for the durable workflow store. Relative paths resolve against the config file's directory. Omit only for ephemeral use — without it, active Actions do not survive a bridge restart |
| `workflow.resultRetentionSeconds` | Minimum seconds a resolved result stays retrievable (default `86400`) |
| `workflow.pollIntervalMs` | Background workflow tick interval (default `2000`)                            |
| `workflow.taskPollIntervalMs` | Client-facing `tasks/get` polling hint (default `5000`)                   |

The bridge speaks MCP `2026-07-28` and advertises
`io.modelcontextprotocol/tasks` plus `org.oma3/mpas` through
`server/discover`. Every accepted application `tools/call` returns a flat
official Task whose stable `taskId` is distinct from every MPAS Action ID. Clients observe progress
and retrieve the terminal native result with read-only `tasks/get`; Task
polling does not drive the background MPAS workflow.

`approvalStrategy` and `approvalTimeoutMs` are deprecated and ignored. There
is no synchronous approval wait and no MPAS result tool. Hosts should honor
the Task's `pollIntervalMs` hint instead of extending individual request
timeouts.

### Key Files

Each participant has an Ed25519 signing key (`$MPAS_HOME/keys/*.json`):

| Field        | Purpose                                                        |
| ------------ | -------------------------------------------------------------- |
| `label`      | Human-readable name (e.g., `proposer`, `maintainer-a`)         |
| `did`        | The `did:jwk` derived from the public key                      |
| `kid`        | Key ID (DID + fragment)                                        |
| `privateJwk` | Private key in JWK format — used to sign                       |
| `publicJwk`  | Public key in JWK format — shared in `signerKeys`          |

### Credential Files

Simple JSON files with a `value` field (`$MPAS_HOME/credentials/*.json`):

```json
{"value":"github_pat_..."}
```

The filename (minus `.json`) is the credential handle. At dispatch time, the adapter reads the file and injects the value via `{{credential:handle}}` templates.

## Policy (Demo Configuration)

| Action                             | Approval requirement                        |
| ---------------------------------- | ------------------------------------------- |
| `create_issue_mirror`                     | Pass-through (not governed; proposer signature only — see governance boundary note) |
| `delete_branch_mirror`                    | 1 maintainer approval                       |
| `merge_pull_request_mirror` into `main`   | 1 maintainer approval                       |

## Local Services

Default ports:

- Credential Adapter: `7544`
- Coordination Service: `7545`

Useful commands:

```sh
mpas adapter start
mpas coordination start --port 7545 \
  --designated-verifier-did did:jwk:...verifier... \
  --notification-origin http://127.0.0.1:7545
mpas daemon start # combined Adapter + local Coordination Service
npm run test:e2e:mcp-bridge
```

Action Relay endpoints:

- `POST /mpas/v1/verifier/action` — canonical Action submission; waits for the Verifier-authored `ActionResponse` up to the demo's bounded interval, then returns retryable `503 timeout` without discarding relay state
- `POST /mpas/v1/action` — compatibility alias for `/mpas/v1/verifier/action`
- `POST /mpas/v1/relay/poll`
- `POST /mpas/v1/relay/delivery` — Verifier `DeliveryEnvelope<ActionResponse>` return path
- `POST /mpas/v1/relay/session` and `GET /mpas/v1/relay/ws` — relay-only notification WebSocket

Coordination Service endpoints:

- `GET /mpas/v1/coordination/health`
- `POST /mpas/v1/coordination/workflow` — create an approval workflow after direct Verifier evaluation
- `POST /mpas/v1/coordination/action` — deprecated temporary alias for `/coordination/workflow`
- `POST /mpas/v1/coordination/poll`
- `POST /mpas/v1/coordination/approval`
- `POST /mpas/v1/coordination/workflow-cancel`
- `POST /mpas/v1/coordination/action-cancel` — compatibility alias for `/coordination/workflow-cancel`
- `POST /mpas/v1/coordination/delivery` — compatibility alias for `/relay/delivery`
- `POST /mpas/v1/coordination/session` and `GET /mpas/v1/coordination/ws` — notification-only WebSocket

Repeat `--authorized-recipient-did` to permit informational relay recipients in addition to the configured Verifier. Relay and coordination WebSockets contain no work payload and wake only their corresponding signed poll. A relayed `additionalApprovalsRequired` response does not create a workflow; the proposer bridge explicitly calls `/coordination/workflow`. A `readyForSubmission` update likewise does not route the completed package; the bridge explicitly submits it to the Action endpoint.

### Run the Credential Adapter as a hosted Verifier

Set the hosted Action Relay URL when this Credential Adapter should receive relayed Actions:

```sh
mpas adapter start \
  --verifier-relay-url https://api.signerset.com
```

`adapter start` does not bind a local Coordination Service port. The combined `daemon start` command is reserved for local deployments that intentionally run both services and rejects hosted-Verifier options.

The adapter authenticates as its configured Verifier DID, opens the relay notification WebSocket, and performs an authenticated relay poll on connection and after every work-available notification. It also polls every 30 seconds as recovery for a lost notification. Cursor and response-retry state are stored in `~/.mpas/journal/verifier-relay.json` by default. If the former `verifier-coordination.json` file already exists, the adapter loads it and migrates its legacy state shape when next saved. That cache preserves exact response bytes across delivery retries; the dispatch ledger independently prevents Action re-execution.

The Verifier fails closed if a delivery is malformed or its payload is not an `ActionRequest`. It does not advance the affected cursor, stops background polling, and emits a `fatal_error` event. Restarting alone will encounter the same delivery; the Action Relay operator must remove or quarantine the invalid delivery before restarting the adapter.

Equivalent environment variables are `MPAS_VERIFIER_RELAY_URL`, `MPAS_VERIFIER_RELAY_STATE`, and `MPAS_VERIFIER_POLL_INTERVAL_MS`. The matching command-line options are `--verifier-relay-url`, `--verifier-relay-state`, and `--verifier-poll-interval-ms`. The former `COORDINATION` environment names and `--verifier-coordination-*` flags remain compatibility aliases.

## Getting Started

See [guides/setup-macos.md](guides/setup-macos.md) for the full demo setup guide covering:

- Part 1: Environment setup (every account)
- Part 2: Single-user demo configuration
- Part 3: Agent harness configuration (Codex CLI, OpenClaw, Claude Desktop)
- Part 4: Running the demo + live GitHub dispatch
- Part 5: Multi-user hardening (optional workspace separation)

## Testing

See [tests/README.md](tests/README.md) for the full test guide, including focused test commands and the cross-repo E2E setup.
