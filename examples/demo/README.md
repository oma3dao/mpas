# mpas-demo

Local MPAS (Multi-Party Action Security) services — Credential Adapter daemon, Coordination Service, and Signer Server.

MPAS is a protocol for multi-party approval of AI agent actions. Instead of giving agents direct access to privileged APIs (GitHub, cloud providers, databases), MPAS routes actions through a Credential Adapter that enforces policy-based approval workflows before execution.

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

**The agent sees a normal MCP server.** The MCP Bridge abstracts the entire MPAS protocol — signing, envelope construction, coordination polling, resubmission — away from the agent. From the agent's perspective, it just calls tools like `create_issue_demo` or `delete_branch_demo` and gets results back.

**Proposer flow:**

1. Agent calls an MCP tool (e.g., `delete_branch_demo`)
2. MCP Bridge (proposer mode) constructs and signs an Action Package, submits it to the Credential Adapter
3. Credential Adapter verifies the signature, evaluates policy:
   - If auto-approved: dispatches immediately to the target (GitHub) and returns the result
   - If approval required: returns `additionalApprovalsRequired`
4. Bridge submits the pending action to the Coordination Service and polls for resolution
5. Once a maintainer approves, the bridge resubmits the completed Action Package to the adapter
6. Adapter verifies the full policy is met (correct signatures, threshold reached, no self-approval), then dispatches
7. Bridge returns the execution result to the agent as a normal MCP tool response

**Maintainer flow:**

1. Agent calls `mpas_list_pending` → Signer Server queries the Coordination Service
2. Agent calls `mpas_review_action` → Server fetches full action details and verifies integrity
3. Agent calls `mpas_approve` → Server signs an approval and submits it to the Coordination Service
4. The proposer's bridge detects the approval on its next poll and resubmits

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

┌───────────────────────────────┐  ┌─────────────────────────────--──┐
│  Agent A Workspace            │  │  Agent B Workspace              │
│  (separate account/machine)   │  │  (separate account/machine)     │
│  • Proposer/Maintainer bridges│  │  • Proposer + Maintainer bridges│
│  • Own signing key only       │  │  • Own signing key only         │
│  • Can propose actions        │  │  • Can propose actions          │
│  • Can approve other agents'  │  │  • Can approve other agents'    │
│    actions (not its own)      │  │    actions (not its own)        │
└───────────────────────────────┘  └─────────────────────────────--──┘
```

In production, every participant typically acts as both proposer and maintainer — they can propose their own actions and approve other agents' actions. Self-approval is prevented at the protocol level. Each agent has a single DID for auditability.

### Dual-role agents

Some deployments assign agents a single role — a large foundation model might only propose actions, while a smaller specialized model trained for security review might only approve. Other deployments allow agents to act as both proposer and maintainer — they can propose their own actions and approve other agents' actions, but never their own.

For a dual-role agent, register both a proposer bridge and a signer server pointing at the same key file (one DID per agent for auditability). The harness registers two MCP servers — one proposer bridge process and one signer server process. The agent sees GitHub operation tools from the proposer bridge and approval tools from the signer server.

Self-approval is enforced at two levels regardless of role assignment:
1. **Coordination service** — rejects any approval submission where `signerDid` matches the action's `proposer.did`
2. **Policy engine (defense in depth)** — excludes the proposer's DID when counting approvals toward thresholds on resubmission

## Signer Server

The MPAS Signer Server (`src/signer-server/`) is a standalone MCP server that enables agents to act as Signers. One instance per agent, handling approvals across all applications.

It imports protocol primitives from `@oma3/mpas` (KeyManager, CoordinationClient, ApprovalBuilder, hash utilities) and exposes four MCP tools:

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
│  File: $MPAS_HOME/plugins/github-demo-plugin.json                         │
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
| `applicationDid`         | The application this plugin describes (e.g., `did:web:github.example`)     |
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

When an OMATrust configuration is provided, the adapter also queries for:

- attestations from approved issuers, including their schema and current status;
- linkage between the plugin artifact and its declared target application; and
- controller evidence such as linked-identifier attestations, controller
  witnesses, DNS TXT records, or a well-known DID document.

The adapter displays all evidence it finds and asks the operator whether to use
the plugin. It prompts even when trusted evidence is present. If no OMATrust
configuration is provided—or OMATrust is unavailable—the adapter reports that
the `did:artifact` integrity check succeeded, warns that legitimacy and
provenance were not checked, and asks for confirmation. Non-interactive startup
declines by default.

Operators provide an `OmaTrustConfig` JSON file; they do not construct the
internal `TrustContext` directly. The adapter builds `TrustContext` by loading
the configured chain information and fetching current trust anchors.

```json
{
  "rpcUrl": "https://YOUR_CHAIN_RPC_URL",
  "easContractAddress": "0xYOUR_EAS_CONTRACT_ADDRESS",
  "backendUrl": "https://YOUR_OMATRUST_BACKEND",
  "schemas": {
    "securityAssessment": "0xSECURITY_ASSESSMENT_SCHEMA_UID",
    "certification": "0xCERTIFICATION_SCHEMA_UID",
    "userReview": "0xUSER_REVIEW_SCHEMA_UID",
    "linkedIdentifier": "0xLINKED_IDENTIFIER_SCHEMA_UID",
    "controllerWitness": "0xCONTROLLER_WITNESS_SCHEMA_UID"
  }
}
```

The RPC endpoint, EAS contract, and schema UIDs must describe the same OMATrust
chain deployment. Start the daemon with either:

```sh
mpas daemon start --omatrust-config /path/to/omatrust.json
```

or:

```sh
export MPAS_OMATRUST_CONFIG=/path/to/omatrust.json
mpas daemon start
```

For evaluation semantics and the derived `TrustContext` structure, see the
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

**The governance boundary:** anything outside the governed set is routed as pass-through — after proposer gating and signature verification it executes with the adapter's credential on the proposer's signature alone, and `defaultRequirement` does not apply. This is the plugin-anchored trust model: the plugin publisher decides which operations need governance, and the operator accepts that boundary after reviewing available OMATrust attestation and target-linkage evidence. The demo exposes `create_issue_demo` this way on purpose to demonstrate the boundary. If you care about an operation, put it in the plugin or give it a policy entry; power users can refuse ungoverned operations entirely with `passThrough: "deny"`.

### Bridge Config

The bridge config lives on the agent side and tells the MCP Bridge how to connect to the adapter. The adapter never reads bridge configs.

| Field                    | Purpose                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `mode`                   | `"proposer"` (can call operations) or `"maintainer"` (can approve/reject)      |
| `plugin`                 | Path to the plugin file (bridge uses it for application identity/profile)      |
| `adapter.url`            | Where to submit action packages                                                |
| `agent.did`              | This agent's DID — must be in the deployment config's `signerKeys`         |
| `agent.keyFile`          | Path to the Ed25519 key file for signing                                       |
| `target.applicationDid`  | Which application DID to target                                                |
| `coordination.url`       | The coordination service endpoint                                              |
| `workflow.dbPath`        | SQLite path for the durable workflow store. Relative paths resolve against the config file's directory. Omit only for ephemeral use — without it, active Actions do not survive a bridge restart |
| `workflow.resultRetentionSeconds` | Minimum seconds a resolved result stays retrievable (default `86400`) |
| `workflow.pollIntervalMs` | Background workflow tick interval (default `2000`)                            |
| `workflow.maxTimeoutSeconds` | Advertised maximum for `mpas_wait_for_action_result` (default `300`)       |

> **Removed in `@oma3/mpas@0.1.0-alpha.2`:** `approvalStrategy` and `approvalTimeoutMs`. Approval-gated calls no longer block — the bridge returns a deferred Action reference immediately and the client retrieves the result with `mpas_wait_for_action_result`. Both fields are still accepted and ignored, with a warning, so existing configs keep working.

**Host request timeout:** whatever agent harness launches the bridge must allow a request to run at least as long as `workflow.maxTimeoutSeconds`, since the wait tool blocks by design. With the default 300 s ceiling, a host timeout of 360 000 ms is a reasonable margin. Lower both together or neither.

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
| `create_issue_demo`                     | Pass-through (not governed; proposer signature only — see governance boundary note) |
| `delete_branch_demo`                    | 1 maintainer approval                       |
| `merge_pull_request_demo` into `main`   | 1 maintainer approval                       |

## Local Services

Default ports:

- Credential Adapter: `7544`
- Coordination Service: `7545`

Useful commands:

```sh
mpas daemon start
mpas coordination start --port 7545
npm run test:e2e:mcp-bridge
```

Coordination endpoints:

- `GET /mpas/v1/coordination/health`
- `POST /mpas/v1/coordination/action`
- `POST /mpas/v1/coordination/poll`
- `POST /mpas/v1/coordination/approval`
- `POST /mpas/v1/coordination/action-cancel`

## Getting Started

See [guides/setup-macos.md](guides/setup-macos.md) for the full demo setup guide covering:

- Part 1: Environment setup (every account)
- Part 2: Single-user demo configuration
- Part 3: Agent harness configuration (Codex CLI, OpenClaw, Claude Desktop)
- Part 4: Running the demo + live GitHub dispatch
- Part 5: Multi-user hardening (optional workspace separation)

## Testing

See [tests/README.md](tests/README.md) for the full test guide, including focused test commands and the cross-repo E2E setup.
