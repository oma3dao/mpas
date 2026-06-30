# mpas-demo

Local MPAS (Multi-Party Action Security) services — Credential Adapter daemon and Coordination Service.

MPAS is a protocol for multi-party approval of AI agent actions. Instead of giving agents direct access to privileged APIs (GitHub, cloud providers, databases), MPAS routes actions through a Credential Adapter that enforces policy-based approval workflows before execution.

## Specifications

For the full protocol design, start with the base specification:

- [mpas-specification.md](https://github.com/oma3dao/mpas-docs/blob/main/specification/mpas-specification.md) — **Core protocol: Action Lifecycle, dispatch ledger, artifact model, trust architecture**
- [mpas-profile-http.md](https://github.com/oma3dao/mpas-docs/blob/main/specification/mpas-profile-http.md) — HTTP Profile: wire format, ActionRequest/Response, coordination
- [mpas-profile-mcp.md](https://github.com/oma3dao/mpas-docs/blob/main/specification/mpas-profile-mcp.md) — MCP Profile: execution payload format for MCP tool calls
- [mpas-profile-application-plugin.md](https://github.com/oma3dao/mpas-docs/blob/main/specification/mpas-profile-application-plugin.md) — Application Plugin Profile: plugin schema and operation defs
- [mpas-profile-policy-json.md](https://github.com/oma3dao/mpas-docs/blob/main/specification/mpas-profile-policy-json.md) — JSON Verifier Policy Profile: policy matching and evaluation

## Related Packages

| Location                                                                 | Description                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| [mpas-docs](https://github.com/oma3dao/mpas-docs)                        | MPAS specification documents                          |
| [`sdk/mcp-bridge`](../../sdk/mcp-bridge)                                 | MCP Bridge package (in this repo)                     |
| [mpas-demo-repository](https://github.com/alftom/mpas-demo-repository)   | Demo GitHub repo with expendable branches for testing |

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
┌──────────────────┐       ┌────────┴─────────┐
│  Maintainer Agent│       │  MCP Bridge      │
│                  │──MCP─▶│ (maintainer mode)│
│  Sees approval   │       │  Signs approvals │
│  tools           │       │                  │
└──────────────────┘       └──────────────────┘
```

### How it works

**The agent sees a normal MCP server.** The MCP Bridge abstracts the entire MPAS protocol — signing, envelope construction, coordination polling, resubmission — away from the agent. From the agent's perspective, it just calls tools like `create_issue` or `delete_branch` and gets results back.

**Proposer flow:**

1. Agent calls an MCP tool (e.g., `delete_branch`)
2. MCP Bridge (proposer mode) constructs and signs an Action Package, submits it to the Credential Adapter
3. Credential Adapter verifies the signature, evaluates policy:
   - If auto-approved: dispatches immediately to the target (GitHub) and returns the result
   - If approval required: returns `additionalApprovalsRequired`
4. Bridge submits the pending action to the Coordination Service and polls for resolution
5. Once a maintainer approves, the bridge resubmits the completed Action Package to the adapter
6. Adapter verifies the full policy is met (correct signatures, threshold reached, no self-approval), then dispatches
7. Bridge returns the execution result to the agent as a normal MCP tool response

**Maintainer flow:**

1. Agent calls `mpas_list_pending` → MCP Bridge (maintainer mode) queries the Coordination Service
2. Agent calls `mpas_review_action` → Bridge fetches full action details
3. Agent calls `mpas_approve` → Bridge signs an approval and submits it to the Coordination Service
4. The proposer's bridge detects the approval on its next poll and resubmits

**Key security properties:**

- Agents hold no privileged credentials — all writes route through the adapter
- The adapter verifies cryptographic signatures and evaluates policy before dispatching
- Self-approval is prevented at both coordination (rejects matching DIDs) and policy engine (excludes proposer from threshold counts) levels
- The MCP Bridge is the trust boundary — it holds the agent's signing key and performs all protocol operations

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

For a dual-role agent, register both a proposer bridge and a maintainer bridge pointing at the same key file (one DID per agent for auditability). The harness registers two MCP servers — one proposer bridge process and one maintainer bridge process. The agent sees GitHub operation tools from the proposer bridge and approval tools from the maintainer bridge.

Self-approval is enforced at two levels regardless of role assignment:
1. **Coordination service** — rejects any approval submission where `signerDid` matches the action's `proposer.did`
2. **Policy engine (defense in depth)** — excludes the proposer's DID when counting approvals toward thresholds on resubmission

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
│  Declares: operations, payload schemas, credential requirements,          │
│            policy suggestions. Often audited by trusted parties.          │
│  File: $MPAS_HOME/plugins/github-repo.json                                │
└───────────────────────────────────────┬───────────────────────────────────┘
                                        │ referenced by (path + hash)
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Deployment Config (authored by the operator who runs the adapter)         │
│  Declares: which operations to enable, policy rules, trusted signers,      │
│            execution target, credential bindings, resource restrictions    │
│  File: $MPAS_HOME/config/github-strict.json                                │
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
| `pluginVersion`          | Semver version of the plugin schema                                        |
| `applicationDid`         | The application this plugin describes (e.g., `did:web:github.example`)     |
| `executionProfile`       | Declares how execution payloads are formatted (`mcp.toolsCall`)            |
| `credentialRequirements` | What credential the adapter needs to authenticate to the target            |
| `operations`             | Array of operations: name, description, and a JSON Schema for the payload  |
| `policySuggestions`      | Advisory hints for the deployer — not enforced                             |

You do not edit the plugin directly. Its integrity is verified via `artifactDid` at startup — any modification invalidates the DID.

### Deployment Config

| Field                  | Purpose                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `name`                 | Human-readable label (e.g., `github-strict`)                                |
| `target.applicationDid`| Must match the plugin's `applicationDid`                                    |
| `plugin`               | Reference to the plugin file: DID, version, path, and `artifactDid`         |
| `enabledOperations`    | Subset of plugin operations this deployment allows                          |
| `credentialBindings`   | Maps credential handles to providers (`"github-test-token"` → `file`)       |
| `resourceRestrictions` | Limits which repos/orgs can be targeted                                     |
| `executionTarget`      | How to call the real MCP server (`mcp.stdio` spawns a child process)        |
| `policy`               | Approval rules: default policy + per-operation threshold requirements       |
| `trustedSigners`       | Authorized DIDs with roles, labels, and public keys                         |

**Relationship between `policySuggestions` and `policy.rules`:** The plugin's suggestions are advisory. The operator decides what rules to actually enforce.

### Bridge Config

The bridge config lives on the agent side and tells the MCP Bridge how to connect to the adapter. The adapter never reads bridge configs.

| Field                    | Purpose                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `mode`                   | `"proposer"` (can call operations) or `"maintainer"` (can approve/reject)      |
| `plugin`                 | Path to the plugin file (bridge reads it to know what tools to expose)         |
| `adapter.url`            | Where to submit action packages                                                |
| `agent.did`              | This agent's DID — must be in the deployment config's `trustedSigners`         |
| `agent.keyFile`          | Path to the Ed25519 key file for signing                                       |
| `target.applicationDid`  | Which application DID to target                                                |
| `approvalStrategy`       | `"wait"` (polls until resolved) or `"return"` (returns immediately)            |
| `coordination.url`       | The coordination service endpoint                                              |

### Key Files

Each participant has an Ed25519 signing key (`$MPAS_HOME/keys/*.json`):

| Field        | Purpose                                                        |
| ------------ | -------------------------------------------------------------- |
| `label`      | Human-readable name (e.g., `proposer`, `maintainer-a`)         |
| `did`        | The `did:key` derived from the public key                      |
| `kid`        | Key ID (DID + fragment)                                        |
| `privateJwk` | Private key in JWK format — used to sign                       |
| `publicJwk`  | Public key in JWK format — shared in `trustedSigners`          |

### Credential Files

Simple JSON files with a `value` field (`$MPAS_HOME/credentials/*.json`):

```json
{"value":"github_pat_..."}
```

The filename (minus `.json`) is the credential handle. At dispatch time, the adapter reads the file and injects the value via `{{credential:handle}}` templates.

## Policy (Demo Configuration)

| Action                             | Approval requirement                 |
| ---------------------------------- | ------------------------------------ |
| `create_issue`                     | Auto-approved (no maintainer needed) |
| `delete_branch`                    | 1 maintainer approval                |
| `merge_pull_request` into `main`   | 1 maintainer approval                |

## Local Services

Default ports:

- Credential Adapter: `7544`
- Coordination Service: `7545`

Useful commands:

```sh
mpas daemon start
mpas coordination start --port 7545
npm run test:e2e:mcp-bridge -- --mcp-bridge-dir ../../sdk/mcp-bridge
```

Coordination endpoints:

- `GET /mpas/v1/coordination/health`
- `POST /mpas/v1/coordination/action`
- `POST /mpas/v1/coordination/poll`
- `POST /mpas/v1/coordination/approval`
- `POST /mpas/v1/coordination/action-cancel`

## Getting Started

See [docs/setup/macos.md](docs/setup/macos.md) for the full demo setup guide covering:

- Part 1: Environment setup (every account)
- Part 2: Single-user demo configuration
- Part 3: Agent harness configuration (Codex CLI, OpenClaw, Claude Desktop)
- Part 4: Running the demo + live GitHub dispatch
- Part 5: Multi-user hardening (optional workspace separation)

## Testing

See [tests/README.md](tests/README.md) for the full test guide, including focused test commands and the cross-repo E2E setup.
