# MPAS Credential Adapter — MVP Specification

**Status:** Draft  
**Feature:** MVP (Minimum Viable Product)  
**Target Platform:** macOS (CLI daemon)  
**Depends on:** [MPAS Core Specification v0.2](../../specification/mpas-specification.md), [MPAS Application Plugin Profile v0.2](../../specification/mpas-profile-application-plugin.md), [MPAS JSON Verifier Policy Profile](../../specification/mpas-profile-policy-json.md)

---

## 1. Overview

The MVP is a macOS CLI daemon that acts as a Credential Adapter (per MPAS Core Section 6.6). It exposes a local HTTP endpoint that accepts MPAS Action Packages and returns either an Execution Receipt (per MPAS Core Section 5.9) or Authorization Requirements (per MPAS Core Section 5.8).

Action Packages are constructed and submitted by MPAS MCP Bridge servers (`@oma3/mpas-mcp-bridge`) running alongside agents. The bridge handles all MPAS artifact construction — agents themselves just call MCP tools as normal. The adapter never interacts with agents directly; it receives well-formed Action Packages from bridges or coordination services.

The daemon holds credentials in macOS Keychain or local files and never exposes them to bridges, agents, proposers, signers, or coordination services.

---

## 2. Goals

- Prove the Credential Adapter pattern end-to-end on macOS.
- Demonstrate MPAS-based agent governance using the MCP Bridge as the agent-facing component.
- Validate the MPAS Application Plugin Profile v0.2 in a working implementation.
- Validate the MPAS JSON Verifier Policy Profile in a working implementation.
- Keep credentials protected, never exposed to any external component.
- Produce verifiable Execution Receipts for every resolved action.
- Establish the deployment config pattern (plugin + config + credential handle).
- Provide a consistent interface (Action Package in → receipt or auth requirements out) that works whether the caller is an MCP bridge, a CLI tool, or a Coordination Service.

---

## 3. Non-Goals

- GUI or menu bar application (future feature).
- Windows, Linux, or cloud deployment.
- Multi-tenant or multi-user operation.
- Plugin marketplace or remote plugin discovery.
- Standing Authorization Grants (all actions require per-action approval for MVP).
- Production hardening (rate limiting, certificate pinning, process sandboxing).
- Signer notification or approval collection (that is the Coordination Service's responsibility).
- Building the Coordination Service itself (separate repository and spec).
- Defining how signers learn about pending reviews (out of scope for the adapter).
- Direct agent communication (agents interact through the MCP Bridge, not the adapter).

---

## 4. Architecture

### 4.1 Core Interface

The Credential Adapter has one core interface:

```
Input:  Action Package (Execution Payload + Action Envelope + Approval Bundle)
Output: Execution Receipt  OR  Authorization Requirements
```

The adapter does not care who submitted the Action Package — whether it's an MCP bridge, a CLI test command, or a Coordination Service forwarding on behalf of a remote proposer. Same endpoint, same behavior, same verification.

### 4.2 Governed vs. Pass-Through Operations

The adapter routes incoming operations along two paths based on whether the operation appears in the Application Plugin's `operations` object OR as a key in the deployment policy's `policies` object:

1. **Governed operations** (operation IS in the plugin's `operations` OR in `policy.policies`) — Full MPAS governance: verify proposer is in `signerGroups.proposers` (or `signerGroups.all` if no `proposers` group), validate Execution Payload against the plugin's schema (if available), evaluate policy, require approvals if the matched policy or `defaultRequirement` demands them, dispatch on success.

2. **Pass-through operations** (operation is in NEITHER the plugin NOR the policy) — The adapter acts as a credential proxy. It still verifies proposer identity (the proposer DID must be in `signerGroups.proposers` or `signerGroups.all`), still checks resource restrictions, but skips schema validation (there's no schema) and policy evaluation (there's no policy entry). It then forwards the tool call to the upstream MCP server with the credential. A dispatch ledger entry and receipt are still produced for auditability.

This distinction exists because MPAS MCP Bridges expose *all* upstream tools (e.g., 51 for GitHub), but plugins only declare the subset that the application developer considers high-impact and worthy of schema validation (e.g., 20 out of 51). The remaining tools are low-impact read operations or informational queries that should flow through without friction — the adapter's role for those is purely credential proxy, not policy gate.

**Design consequence:** The operator does not need to enumerate all possible tool names. They install a plugin, which declares the operations with payload schemas worth validating. They then author an `MpasApplicationPolicy` defining signer groups, approval thresholds, and match conditions for the operations they want to govern. An operation can be governed by policy even if the plugin doesn't include a schema for it — in that case, policy is evaluated but schema validation is skipped. Everything in neither the plugin nor the policy passes through with only proposer gating.

Operators can also add policy entries for operations beyond what the plugin declares. This allows site-specific governance without waiting for plugin updates. The operator defines which operations they consider high-risk for their deployment by adding keys to the `policies` object.

### 4.3 System Topology

```
┌─────────────────────────────────────────────────────────────┐
│  Mac Mini / Developer Machine                               │
│                                                             │
│  ┌──────────────┐     MCP tools/call   ┌────────────────┐  │
│  │  Agent       │ ──────────────────▶  │  MPAS MCP      │  │
│  │  (OpenClaw,  │ ◀──────────────────  │  Bridge        │  │
│  │   Claude,    │     MCP response     │  (Proposer/    │  │
│  │   etc.)      │                      │   Signer)      │  │
│  └──────────────┘                      └───────┬────────┘  │
│                                                │            │
│                                    Action Package / Receipt  │
│                                                │            │
│                                                ▼            │
│                           ┌───────────────────────────────┐ │
│                           │  Credential Adapter Daemon    │ │
│                           │  (localhost HTTP endpoint)    │ │
│                           │                               │ │
│                           │  • verify Action Package      │ │
│                           │  • validate against plugin    │ │
│                           │  • evaluate policy            │ │
│                           │  • dispatch via MCP           │ │
│                           │  • issue Execution Receipt    │ │
│                           └───────────────┬───────────────┘ │
│                                           │                 │
│  ┌──────────────┐            MCP tools/call                 │
│  │  Keychain /  │◀─credential─┤           │                 │
│  │  Credentials │             │           ▼                 │
│  └──────────────┘             │  ┌────────────────────┐     │
│                               │  │  Target MCP Server │     │
│                               │  │  (e.g., GitHub)    │     │
│                               │  └────────────────────┘     │
└───────────────────────────────│─────────────────────────────┘
                                │ HTTPS
                                ▼
                      ┌────────────────────┐
                      │  Target Application │
                      │  (e.g., GitHub API) │
                      └────────────────────┘
```

### 4.4 Callers: Proposers and Signers

The adapter accepts Action Packages from any caller. In practice, callers are either:

- **MPAS MCP Bridges acting as Proposers** — an MCP bridge constructs Action Packages on behalf of agents and submits them to the adapter. The agent calls tools on the bridge; the bridge handles all MPAS protocol work.
- **MPAS MCP Bridges acting as Signers** — a bridge may also re-submit packages with additional Approvals collected from signer agents.
- **Coordination Services** — a Coordination Service may forward packages to the adapter after assembling Approval Bundles from multiple signers.
- **CLI tools** — for development and testing, `mpas test submit` sends packages directly.

The adapter treats all callers identically. It verifies every package from scratch.

### 4.5 Approval Collection Flow

Per MPAS Core Section 6.2, when the adapter returns Authorization Requirements (insufficient approvals), the caller is responsible for collecting additional approvals:

1. MCP Bridge submits Action Package to the adapter on behalf of the agent.
2. Adapter verifies and evaluates policy → returns Authorization Requirements (per MPAS Core Section 5.8) describing what approvals are needed.
3. The caller (bridge, coordination service, or human operator) obtains the needed approvals — however it chooses (coordination service API, group chat, manual CLI signing, etc.).
4. Caller re-submits the Action Package with the updated Approval Bundle.
5. Adapter verifies again → if satisfied, executes and returns receipt.

The adapter does not participate in approval collection. It only answers the question: "Is this package authorized? If not, what's missing?"

### 4.6 Trust Boundaries

- **MCP Bridges are untrusted.** Their Action Packages are validated from scratch.
- **Agents never communicate with the adapter directly.** They go through bridges.
- **The Coordination Service is untrusted.** It's a message relay. The adapter verifies independently.
- **Signers are verified.** Their Approvals are cryptographically verified against signer keys configured in the deployment config, with eligibility determined by the policy's `signerGroups`.
- **The Adapter is the trust anchor** for execution decisions and credential custody.
- **Credential storage (Keychain or file) is trusted** within the operator's security model.

---

## 5. Component Ownership

### 5.1 OMA3 Standard Components

These components implement neutral MPAS protocol logic. Each maps to a separate package in `mpas-sdk`:

| Component | Package | Responsibility |
|---|---|---|
| MPAS Core verification pipeline | `@oma3/mpas-core-utils` | Action Package parsing, Action Envelope validation, hash binding, Approval Bundle verification, signature verification, expiration and replay checks. |
| Application Plugin validation | `@oma3/mpas-schemas` | Structural validation of `MpasApplicationPlugin` documents per the Application Plugin Profile v0.2. |
| Policy evaluation engine | `@oma3/mpas-core-utils` | Deterministic policy matching and evaluation per the MPAS JSON Verifier Policy Profile. |
| Execution Receipt construction | `@oma3/mpas-core-utils` | Receipt schema, hash binding, and signing per MPAS Core Section 5.9. |
| Authorization Requirements construction | `@oma3/mpas-core-utils` | Per MPAS Core Section 5.8. |
| Test vectors | `@oma3/mpas-test-vectors` | Conformance test fixtures for all of the above. |

### 5.2 Wivity Implementation Components

These components are Credential Adapter implementation choices, open source but not OMA3-standardized:

- **Deployment configuration** — `MpasAdapterDeploymentConfig` schema, config loading, validation, and management.
- **Credential provider integration** — macOS Keychain and file-based credential access.
- **CLI and daemon lifecycle** — `mpas` CLI commands, launchd integration, logging, reload.
- **Plugin execution dispatch** — forwarding verified Execution Payloads to target MCP servers.
- **Resource restriction enforcement** — allowed repositories, organizations, accounts.
- **Audit logging** — local append-only audit events.
- **Local HTTP endpoint** — the listener and request handling.

---

## 6. HTTP Interface

Per the MPAS HTTP Profile, the adapter exposes a local endpoint for Action Package submission.

### 6.1 Submit Action Package

```
POST /mpas/v1/action
Content-Type: application/mpas+json

Body: ActionRequest wrapping an MPAS Action Package (per MPAS HTTP Profile Section 6.3)
```

```json
{
  "version": "1",
  "type": "ActionRequest",
  "actionPackage": { "version": "1", "type": "ActionPackage" }
}
```

The adapter also accepts `application/json` for compatibility (HTTP Profile MAY). All protocol responses are `ActionResponse` objects (HTTP Profile Section 6.4) carrying a `result` field; the `verifier.did` is the adapter's DID.

**Executed successfully (200):**

```json
{
  "version": "1",
  "type": "ActionResponse",
  "verifier": { "did": "did:key:z6Mkadapter..." },
  "actionEnvelopeHash": { "alg": "sha-256", "value": "base64url-encoded-digest" },
  "result": "executed",
  "executionReceipt": {
    "version": "1",
    "type": "ExecutionReceipt",
    "format": "jws",
    "signature": "..."
  },
  "executionResult": { "content": [{ "type": "text", "text": "..." }] },
  "createdAt": "2026-06-05T18:15:00.000Z"
}
```

**Rejected by policy or verification (200):**

```json
{
  "version": "1",
  "type": "ActionResponse",
  "verifier": { "did": "did:key:z6Mkadapter..." },
  "actionEnvelopeHash": { "alg": "sha-256", "value": "base64url-encoded-digest" },
  "result": "rejected",
  "executionReceipt": { "version": "1", "type": "ExecutionReceipt", "format": "jws", "signature": "..." },
  "error": {
    "code": "POLICY_NOT_SATISFIED",
    "message": "Requires 2 approvals from signer group 'maintainers', found 0."
  },
  "createdAt": "2026-06-05T18:15:00.000Z"
}
```

**Additional approvals needed (200):**

```json
{
  "version": "1",
  "type": "ActionResponse",
  "verifier": { "did": "did:key:z6Mkadapter..." },
  "actionEnvelopeHash": { "alg": "sha-256", "value": "base64url-encoded-digest" },
  "result": "additionalApprovalsRequired",
  "authorizationRequirements": {
    "version": "1",
    "type": "AuthorizationRequirements",
    "actionEnvelopeHash": { "alg": "sha-256", "value": "base64url-encoded-digest" },
    "result": "additionalApprovalsRequired",
    "verifier": { "did": "did:key:z6Mkadapter..." },
    "approvalRequirements": {
      "anyOf": [
        {
          "type": "threshold",
          "threshold": 2,
          "eligibleSigners": ["did:key:z6Mkf5rG...", "did:key:z6Mkq9Bv..."],
          "decision": "approve",
          "description": "Requires 2 maintainer approvals."
        }
      ]
    }
  },
  "createdAt": "2026-06-05T18:15:00.000Z"
}
```

**Indeterminate dispatch (200):**

```json
{
  "version": "1",
  "type": "ActionResponse",
  "verifier": { "did": "did:key:z6Mkadapter..." },
  "result": "indeterminate",
  "executionReceipt": { "version": "1", "type": "ExecutionReceipt", "format": "jws", "signature": "..." },
  "createdAt": "2026-06-05T18:15:00.000Z"
}
```

**Unparseable request (400):**

The adapter returns the HTTP Profile `MpasHttpError` envelope (Section 4.8) only when it cannot parse the submission far enough to compute the Action Envelope hash:

```json
{
  "version": "1",
  "type": "MpasHttpError",
  "error": { "code": "artifact_malformed", "message": "Action Package could not be parsed." }
}
```

An artifact-level structural failure inside a hashable package (e.g. a defective Approval object) is instead a 200 `ActionResponse` with `result: "malformed"`.

### 6.2 Health Check

```
GET /mpas/v1/health
```

Returns adapter status, loaded configs, and connectivity state (without exposing secrets or credentials). Marked operational, like the Coordination Service health endpoint.

### 6.3 Response Design

All submissions the adapter can parse return HTTP 200 with an `ActionResponse` (even rejections). HTTP 400 with `MpasHttpError` is reserved for requests that cannot be parsed far enough to compute the Action Envelope hash. The `result` field carries the semantic meaning per the MPAS HTTP Profile Section 6.5, not the HTTP status.

---

## 7. Plugin and Configuration Model

### 7.1 Overview

The adapter uses a three-layer model to separate concerns:

| Layer | Object | Mutability | Owner | Purpose |
|---|---|---|---|---|
| **Application Plugin** | `MpasApplicationPlugin` | Immutable | Plugin publisher | Describes what operations an application exposes, their payload schemas, credential classes needed, and optional impact metadata. Published by the app vendor or community. Never modified by the operator. |
| **Deployment Config** | `MpasAdapterDeploymentConfig` | Operator-editable | Deployment operator | Binds a plugin to local decisions: which credentials are bound, what policy governs operations (as a full `MpasApplicationPolicy`), which signer keys are trusted, and what resource restrictions apply. |
| **Credentials** | Stored in Keychain or file | Operator-managed | Deployment operator | The actual secrets (tokens, keys). Referenced by handle in the deployment config. Never in plugins or Action Packages. |

**Relationship:** A deployment config references exactly one plugin. Multiple deployment configs can reference the same plugin (e.g., one for production repos, one for sandbox repos). The plugin defines what's *possible*; the config defines what's *permitted* in this deployment.

**Plugin trust:** A plugin is validated structurally against the MPAS Application Plugin Profile JSON Schema. Its integrity is verified by artifact hash on every load. Future versions may verify plugin trust via OMATrust attestations (signed publisher claims, reputation scores, community reviews). For the MVP, trust is established by the operator choosing to install and reference the plugin.

**File locations** are defined in Section 15.

### 7.2 Application Plugins

Application plugins follow the [MPAS Application Plugin Profile v0.2](../../specification/mpas-profile-application-plugin.md):
- Stored as immutable JSON files in `~/.mpas/plugins/`.
- Validated on install against the Application Plugin Profile JSON Schema.
- Never modified by the operator. If customization is needed, it goes in the deployment config's policy.
- Referenced by `pluginDid` and `pluginVersion` in deployment configs.
- Integrity verified by artifact hash on every load.
- The `operations` object is keyed by operation name; each entry provides a payload schema and optional impact metadata.

### 7.3 Deployment Configuration

Each deployment config binds a plugin to operator decisions:

```json
{
  "version": "1",
  "type": "MpasAdapterDeploymentConfig",
  "name": "github-production",
  "plugin": {
    "pluginDid": "did:web:plugins.example.com:github-repo",
    "pluginVersion": "1.0.0",
    "artifactDid": "did:artifact:bafkrei..."
  },
  "credentialBindings": [
    {
      "credentialHandle": "github-prod-token",
      "provider": "macos-keychain"
    }
  ],
  "executionTarget": {
    "type": "mcp.stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "{{credential:github-prod-token}}"
    }
  },
  "policy": {
    "version": "1",
    "type": "MpasApplicationPolicy",
    "policyProfileUrl": "https://oma3.org/specs/mpas/policy-json/v1",
    "applicationDid": "did:web:github.com",
    "executionProfile": {
      "id": "did:web:profiles.oma3.org:mcp",
      "format": "mcp.toolsCall"
    },
    "defaultRequirement": {
      "type": "threshold",
      "threshold": 1,
      "eligibleSignerGroup": "maintainers",
      "decision": "approve"
    },
    "signerGroups": {
      "all": [
        "did:web:alice.example",
        "did:web:bob.example",
        "did:web:agent.example"
      ],
      "proposers": [
        "did:web:agent.example"
      ],
      "maintainers": [
        "did:web:alice.example",
        "did:web:bob.example"
      ]
    },
    "policies": {
      "merge_pull_request": [
        {
          "description": "All merges into main require two maintainer approvals.",
          "match": {
            "conditions": [
              { "source": "executionPayload", "path": "/arguments/baseRef", "op": "eq", "value": "main" }
            ]
          },
          "requirements": {
            "type": "threshold",
            "threshold": 2,
            "eligibleSignerGroup": "maintainers",
            "decision": "approve"
          }
        }
      ]
    }
  },
  "signerKeys": [
    {
      "did": "did:web:alice.example",
      "label": "Alice",
      "publicJwk": { "kty": "OKP", "crv": "Ed25519", "x": "..." }
    },
    {
      "did": "did:web:bob.example",
      "label": "Bob",
      "publicJwk": { "kty": "OKP", "crv": "Ed25519", "x": "..." }
    },
    {
      "did": "did:web:agent.example",
      "label": "Agent Bridge",
      "publicJwk": { "kty": "OKP", "crv": "Ed25519", "x": "..." }
    }
  ]
}
```

The `policy` field is a complete `MpasApplicationPolicy` object per the MPAS JSON Verifier Policy Profile. It contains:

- **`signerGroups`** — defines who can interact with the system. `signerGroups.all` lists every recognized DID. `signerGroups.proposers` lists who can submit Action Packages. Custom groups (e.g., `maintainers`) are referenced by policy requirements.
- **`policies`** — keyed by operation name. Each key maps to an array of policy entries with optional match conditions and requirements. Operations here are governed regardless of whether they appear in the plugin.
- **`defaultRequirement`** — applies to governed operations (those in the plugin or in `policies`) when no policy entry matches.

The `signerKeys` array provides the key material needed for signature verification. It maps DIDs to public keys. This is the adapter's key registry — separate from the policy's `signerGroups` which define authorization rules. A DID must appear in both `signerKeys` (for verification) and `signerGroups.all` (for authorization) to be recognized.

The `policy` section determines which operations are governed and what approvals are needed. Operations in the plugin but NOT in `policy.policies` are still governed — the `defaultRequirement` applies. Operations in neither the plugin nor `policy.policies` are pass-through.

### 7.4 Credential Storage

Credentials are referenced by handle in deployment configs and stored separately:

| Provider | Storage | Use Case |
|---|---|---|
| `macos-keychain` | macOS Keychain Services | Production use on macOS. Secure, OS-managed. |
| `file` | `~/.mpas/credentials/<handle>.json` | Development, testing, Phase 0. Simple JSON files with restrictive file permissions (`chmod 600`). |

The `mpas credential set` command stores credentials in the configured provider. Credentials are never written to plugin files, deployment configs, Action Packages, logs, or responses.

The `credentialBindings` array in the deployment config specifies which provider to use:

```json
"credentialBindings": [
  {
    "credentialHandle": "github-prod-token",
    "provider": "file"
  }
]
```

---

## 8. Adapter Global Settings

```json
{
  "version": "1",
  "type": "MpasAdapterSettings",
  "adapterDid": "did:key:z6Mkp2w...",
  "listen": {
    "address": "127.0.0.1",
    "port": 7544
  },
  "receiptSigning": {
    "keyHandle": "adapter-signing-key",
    "provider": "file"
  },
  "audit": {
    "logDir": "~/.mpas/audit/",
    "format": "jsonl"
  }
}
```

Stored at `~/.mpas/adapter.json`.

---

## 9. Data Flow

### 9.1 Routing: Governed vs. Pass-Through

After parsing the Action Package and performing common verification steps (structural validation, ledger check, config lookup, expiry, signature verification, proposer gating), the adapter determines whether the operation is governed:

- **If the operation IS in the plugin's `operations` object OR as a key in `policy.policies`** → **Governed path** (Section 9.2): schema validation (if plugin has it), policy evaluation, approval requirements.
- **If the operation is in NEITHER the plugin NOR `policy.policies`** → **Pass-through path** (Section 9.3): skip schema validation and policy, forward directly with credential.

Both paths share the same common verification prefix (including proposer gating via `signerGroups`) and produce receipts for auditability.

### 9.2 Governed Execution (Happy Path)

1. Agent calls a tool (e.g., `merge_pull_request`) on the MPAS MCP Bridge.
2. Bridge constructs an Execution Payload, Action Envelope, and Proposer Approval. Assembles an Action Package.
3. Bridge POSTs an ActionRequest (wrapping the Action Package) to the adapter's `/mpas/v1/action` endpoint.
4. Adapter parses and validates the Action Package structure.
5. Adapter verifies Action Envelope (fields, expiration, Action Lifecycle check per MPAS Core Section 6.2.2 Step 2a and Section 6.9).
6. Adapter verifies Execution Payload hash matches `actionEnvelope.executionPayloadHash`.
7. Adapter looks up deployment config by `actionEnvelope.target.applicationDid`.
8. Adapter verifies proposer DID is in `policy.signerGroups.proposers` (or `signerGroups.all` if no `proposers` group). Verifies Action Envelope signature against the proposer's key from `signerKeys`.
9. **Routing decision:** operation `merge_pull_request` IS in the plugin's `operations` or in `policy.policies` → governed path.
10. If the plugin has an `executionPayloadSchema` for this operation, adapter validates Execution Payload against it.
11. Adapter checks resource restrictions.
12. Adapter evaluates policy (per MPAS JSON Verifier Policy Profile) — looks up the operation in `policy.policies`, evaluates matching conditions, determines requirements.
13. Policy is satisfied → adapter resolves credential handle, retrieves credential.
14. Adapter dispatches a MCP `tools/call` to the configured execution target MCP server.
15. Adapter constructs and signs an Execution Receipt (per MPAS Core Section 5.9).
16. Adapter returns the receipt to the bridge.
17. Bridge returns the execution result to the agent as the tool call response.

### 9.3 Pass-Through Execution

1. Agent calls a tool (e.g., `get_file_contents`) on the MPAS MCP Bridge.
2. Bridge constructs an Action Package as normal and POSTs it to the adapter.
3. Adapter parses, validates structure, checks ledger, looks up config, checks expiry.
4. Adapter verifies proposer DID is in `policy.signerGroups.proposers` (or `signerGroups.all`). Verifies Action Envelope signature against the proposer's key from `signerKeys`.
5. **Routing decision:** operation `get_file_contents` is NOT in the plugin's `operations` and NOT in `policy.policies` → pass-through path.
6. Adapter checks resource restrictions (still enforced for pass-through).
7. Adapter resolves credential handle, retrieves credential.
8. Adapter dispatches the MCP `tools/call` to the configured execution target MCP server.
9. Adapter writes a dispatch ledger entry and constructs an Execution Receipt.
10. Adapter returns the receipt and execution result to the bridge.

Pass-through operations do NOT require additional approvals beyond the proposer's valid signature. The proposer's identity is verified (they must be in `signerGroups.proposers` or `signerGroups.all`), but no policy rules are evaluated.

### 9.4 Insufficient Approvals (Iterative Flow — Governed Only)

1. Bridge submits Action Package with only its Proposer Approval.
2. Adapter verifies structure and hashes (pass), evaluates policy → insufficient approvals.
3. Adapter returns Authorization Requirements (per MPAS Core Section 5.8): "need 2 approvals from maintainers." This is a stateless response — nothing is recorded and the `actionId` is NOT in the dispatch ledger.
4. Bridge reports the pending status to the agent. The bridge (or coordination service, or human) obtains the needed approvals via the coordination service, group chat, or any other method.
5. Bridge re-submits the Action Package with the updated Approval Bundle, using the SAME `actionId` and same Action Envelope. Per the Core Action Lifecycle (Section 6.9.2), the `actionId` is not in the ledger, so the adapter performs full stateless re-verification of the newly submitted package.
6. Policy satisfied → the adapter resolves credentials and launches the target, writes `executing`, then dispatches.

### 9.5 Rejection

If verification or policy fails definitively (malformed, invalid signature, expired, resource restricted), the adapter returns an Execution Receipt with result `rejected` and does not suggest re-submission.

---

## 10. Execution Dispatch

### 10.1 Execution via MCP

The Credential Adapter dispatches approved actions by acting as an MCP client to the target application's MCP server. This means the adapter speaks the same protocol (MCP JSON-RPC) on both its input side (receiving Action Packages that describe MCP tool calls) and its output side (forwarding those tool calls to the real MCP server).

This design simplifies the adapter: it doesn't need custom HTTP client logic for each application API. It just forwards a `tools/call` request to an MCP server that already knows how to talk to the application.

### 10.2 Execution Target

The `executionTarget` field in the deployment config tells the adapter *how to reach* the target application's MCP server. The plugin describes *what operations exist* and *what payloads look like*. The deployment config's `executionTarget` describes *where to send the request*.

The structure of `executionTarget` depends on the execution profile. Different profiles require different connection parameters:

| Execution Profile | `executionTarget.type` | Connection Parameters |
|---|---|---|
| `mcp.toolsCall` | `mcp.stdio` | `command`, `args`, `env` (launch a local MCP server process) |
| `mcp.toolsCall` | `mcp.http` | `url` (connect to HTTP/SSE MCP server) |
| `openapi.operations` (future) | `openapi.http` | `baseUrl`, `headers` |
| `evm.transactionIntent` (future) | `evm.jsonrpc` | `rpcUrl`, `chainId` |
| `graphql.operations` (future) | `graphql.http` | `url`, `headers` |

For the MVP, only `mcp.stdio` and `mcp.http` are implemented.

Examples:

```json
"executionTarget": {
  "type": "mcp.stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "{{credential:github-prod-token}}"
  }
}
```

```json
"executionTarget": {
  "type": "mcp.http",
  "url": "http://localhost:3000/mcp"
}
```

The `{{credential:handle}}` syntax in `env` tells the adapter to resolve the credential handle at server launch time and inject the value into the process environment. The credential is never written to disk or config.

### 10.3 MCP Tool Call Dispatch

For the `mcp.toolsCall` execution profile:

1. Read the operation `name` from the Execution Payload (this is the MCP tool name).
2. Extract `arguments` from the Execution Payload.
3. Resolve credential bindings (inject into MCP server environment or use as authentication, depending on the target's requirements).
4. Launch / connect the configured MCP server (stdio or HTTP). Steps 3–4 are fallible, side-effect-free preparation and occur BEFORE the dispatch-ledger `executing` write (Core 6.9.2 A); their failure is a stateless rejection with no receipt and no ledger entry.
5. Write the `executing` ledger entry (write-ahead, fsync), then forward a `tools/call` JSON-RPC request to the MCP server.
6. Capture the MCP response and resolve the ledger entry (`executed` / `failed` / `indeterminate`).

### 10.5 Dispatch Timeout

- Every MCP dispatch (stdio or HTTP) MUST enforce a configurable request timeout (default: 30 seconds).
- If the target MCP server does not respond within the timeout, the adapter MUST terminate the request and resolve the action as `indeterminate` (not `failed`). `failed` is reserved for definitive errors from the target application where the outcome is known.
- For stdio targets, the adapter MUST kill the child process if it exceeds the timeout.
- The timeout is configurable per deployment config via `executionTarget.timeoutMs`.
- The adapter issues an Execution Receipt with result `indeterminate` for timeout scenarios. Callers MUST NOT assume the action did not execute and MUST NOT automatically retry with the same `actionId`.

### 10.6 Optional Dispatch Retry

The adapter MAY retry connection-establishment failures (connection refused, DNS failure, TLS handshake failure) that occur during preparation — i.e. BEFORE the `executing` ledger write. Because preparation is pre-ledger and stateless, these retries occur before any ledger entry exists and cannot cause a double dispatch. Once `executing` is written and the request transmitted, there is no retry and no rollback (Core 6.9.2 B); exactly one dispatch receipt per `actionId` is ever issued.

Configuration (in deployment config):

```json
"dispatchRetry": {
  "operations": ["merge_pull_request", "create_issue"],
  "maxAttempts": 3,
  "timeoutMs": 5000
}
```

Default: retry disabled. Retry safety is a deployment decision — the adapter does NOT add any idempotency field to the Application Plugin Profile.

---

## 11. Execution Receipts

The adapter issues an Execution Receipt for every resolved action (per MPAS Core Section 5.9).

Requirements:
- Signed using the adapter's signing key (referenced by `receiptSigning.keyHandle` in adapter settings).
- Binds to `actionEnvelopeHash` and `executionPayloadHash`.
- Includes `result`, `issuedAt`, `issuerDid`, and optionally `executionRef`.
- Returned to the caller in the HTTP response.
- Archived locally in `~/.mpas/receipts/` (optional).

For the MVP, the adapter uses a `did:key` identity derived from a locally generated Ed25519 key pair.

---

## 12. CLI Interface

```
mpas init                           # Generate adapter identity, signing key, initial settings
mpas daemon start                   # Start adapter daemon (foreground)
mpas daemon stop                    # Stop daemon
mpas daemon status                  # Show status, loaded configs, endpoint info
mpas daemon reload                  # Reload config and plugins without restart

mpas plugin install <path-or-url>   # Install a plugin (validate, hash, store)
mpas plugin list                    # List installed plugins
mpas plugin inspect <plugin-did>    # Show plugin details
mpas plugin remove <plugin-did>     # Remove a plugin

mpas config generate --from-plugin <plugin-did>   # Generate starter config from plugin
mpas config validate [<name>]       # Validate config (plugin ref, credentials, schema)
mpas config list                    # List deployment configs

mpas credential set <handle>        # Store a credential (prompts securely)
mpas credential list                # List credential handles (never shows values)
mpas credential test <handle>       # Verify a handle resolves
mpas credential remove <handle>     # Remove a credential

mpas test submit <file>             # Submit a test Action Package (dev/testing)
mpas test dry-run <file>            # Verify + policy check without executing
```

---

## 13. Security Requirements

### 13.1 Credential Isolation

- Credentials MUST only be retrieved at the moment of dispatch, after all verification and policy checks pass.
- Credentials MUST NOT be exposed to bridges, agents, proposers, coordination services, signers, or any external process.
- Credential selection MUST come from trusted deployment config, never from Execution Payload fields or Proposer input.
- If a credential handle cannot be resolved, the adapter MUST reject the action.

### 13.2 Independent Verification

- The adapter MUST independently verify every Action Package regardless of who submitted it or what they claim about its authorization status.
- The adapter MUST implement the full MPAS Core verification procedure (Section 6.2.2).
- The adapter MUST reject `alg: none` JWS signatures.

### 13.3 Replay Protection — Dispatch Ledger

The adapter implements the Verifier dispatch ledger defined in MPAS Core Section 6.9. Verification is stateless and deterministic; rejections and `additionalApprovalsRequired` record nothing and are repeatable. The ledger's sole invariant is that an `actionId` is dispatched at most once. There is no replay cache of all seen `actionId`s and no `open`/pinning state.

**Ledger storage:** An append-only JSONL journal at `~/.mpas/journal/` with two event types — `executing` (written and fsync'd BEFORE transmission; this is the write-ahead point) and `resolved` (appended after dispatch completes). Entries are immutable: the only transition is `executing → resolved(executed | failed | indeterminate)`. There is no rollback (Core 6.9.2 rule B). The receipt is stored alongside as the resolution attestation.

**Maximum envelope validity window:** The adapter MUST enforce a configurable maximum envelope validity window (default: 24 hours). Action Packages whose Action Envelope `expiresAt` minus the current time exceeds this maximum MUST be rejected. This bounds ledger retention.

**Retention:** A journal segment is eligible for cleanup only once every entry in it is past `expiresAt` plus clock-skew tolerance.

**Restart recovery:** On restart, the adapter scans the journal for `executing` events with no matching `resolved` event. Such actions MUST NOT be re-dispatched; the adapter appends an `indeterminate` resolution (idempotent across restarts) and issues an Execution Receipt with result `indeterminate`.

**Decision logic per submission (Core 6.9.2):**

| Ledger state | Same envelope hash | Different envelope hash |
|---|---|---|
| not in ledger | Full stateless verification; if authorized, write `executing` and dispatch | Full stateless verification (independent envelope) |
| executing | Return `pending`; no second dispatch | Reject (`rejected`) |
| resolved | Reject as replay (`rejected`) | Reject as replay (`rejected`) |

The `executing` entry is written only at the authorize-for-dispatch moment, AFTER credential resolution and target launch/connection succeed (those are stateless pre-ledger steps; their failure records nothing).

### 13.4 Plugin Integrity

- On install, the adapter computes a `did:artifact` (CIDv1 of the SHA-256 hash of the canonicalized plugin JSON).
- On load, the adapter verifies the plugin matches the `artifactDid` in the deployment config.
- If verification fails, the adapter MUST NOT use the plugin.
- Future: plugin trust may be verified via OMATrust attestations (publisher signatures, community reviews).

### 13.5 Network Security

- The local HTTP endpoint MUST bind to `127.0.0.1` by default (loopback only).
- For multi-user macOS systems, the operator SHOULD use additional authentication (local bearer token) on the endpoint, since localhost TCP is accessible to all local processes regardless of user.
- Outbound connections to target applications MUST use HTTPS.

### 13.6 Audit Logging

- The adapter MUST log every action received, verification outcome, policy result, execution attempt, and receipt issuance.
- Audit logs MUST NOT contain credential values.
- Logs are written to `~/.mpas/audit/` in JSONL format.

---

## 14. Error Handling

All responses use the HTTP profile's `result` field (not a separate `outcome` field). The `result` carries the semantic meaning per MPAS HTTP Profile Section 6.5.

| Condition | HTTP | Response `result` | Receipt result | Notes |
|---|---|---|---|---|
| Unparseable package (cannot compute envelope hash) | 400 | `MpasHttpError` (`artifact_malformed`) | — | No receipt; no ledger entry |
| Artifact-level structural failure in hashable package | 200 | `malformed` | — | No receipt; no ledger entry |
| Invalid signature | 200 | `rejected` | `rejected` | Stateless deterministic rejection; repeatable |
| Expired Action Envelope | 200 | `expired` | `expired` | Stateless deterministic rejection |
| Replay: same actionId, different envelope hash | 200 | `rejected` | `rejected` | Ledger holds a different hash |
| Replay: actionId resolved (any hash) | 200 | `rejected` | `rejected` | Already dispatched; no new receipt |
| actionId not in ledger (incl. resubmission with more approvals) | 200 | (full stateless verification) | — | No pinning; re-verify the submitted package |
| Resubmission while actionId is `executing` (same hash) | 200 | `pending` | — | No second dispatch; dedup |
| No matching deployment config | 200 | `rejected` | `rejected` | Unknown application |
| Governed operation, payload schema validation failed | 200 | `rejected` | `rejected` | Governed path; stateless deterministic rejection |
| Governed operation, policy not satisfied (can be remedied) | 200 | `additionalApprovalsRequired` | — | Governed path; stateless; nothing recorded |
| Governed operation, no schema in plugin | — | (evaluate policy only) | varies | Policy evaluated; schema validation skipped |
| Pass-through operation (not in plugin or policy) | — | (pass-through) | `executed` / `failed` / `indeterminate` | Pass-through path; no schema validation or policy evaluation |
| Proposer DID not in signerGroups | 200 | `rejected` | `rejected` | Proposer gating; applies to both paths |
| Resource restriction violated | 200 | `rejected` | `rejected` | Stateless deterministic rejection; applies to both paths |
| Credential handle not found | 200 | `rejected` | — | Pre-ledger preparation failure (Core 6.9.2 A): no receipt, no ledger entry |
| Target launch / connection failed | 200 | `rejected` | — | Pre-ledger preparation failure: no receipt, no ledger entry |
| Target application error (definitive, incl. tool `isError: true`) | 200 | `failed` | `failed` | Post-ledger; `executionResult` present for tool-level failures |
| Target timeout / crash / outcome unconfirmed | 200 | `indeterminate` | `indeterminate` | Post-ledger; caller must not auto-retry |
| Envelope exceeds max validity window | 200 | `rejected` | — | No receipt; no ledger entry |

---

## 15. File System Layout

```
~/.mpas/
  adapter.json              # Adapter identity, listen address, global settings
  plugins/                  # Immutable plugin JSON files (never modified)
    github-repo.json
  config/                   # Deployment configs (operator-authored and edited)
    github-production.json
    github-sandbox.json
  credentials/              # File-based credential store (dev/testing)
    github-prod-token.json
    adapter-signing-key.json
  audit/                    # Audit logs (JSONL, append-only)
    2026-06-04.jsonl
  receipts/                 # Local receipt archive (optional)
    <action-id>.json
```

Plugins are installed to `~/.mpas/plugins/` and never modified. Deployment configs are authored and edited by the operator in `~/.mpas/config/`. Credentials reside in the Keychain (production) or `~/.mpas/credentials/` (development). The adapter's own identity and settings are in `~/.mpas/adapter.json`.

---

## 16. Agent Integration via MCP Bridge

### 16.1 Integration Model

Agents do not communicate with the Credential Adapter directly. Instead:

1. The operator removes the real application MCP server from the agent's configuration.
2. The operator adds an MPAS MCP Bridge server (from `@oma3/mpas-mcp-bridge`) in its place.
3. The bridge exposes the same tool names and schemas as the original MCP server.
4. When the agent calls a tool, the bridge constructs an Action Package and submits it to the adapter.
5. The adapter verifies, evaluates policy, and (if authorized) dispatches to the real MCP server.

From the agent's perspective, nothing changes — same tools, same arguments, same responses. The governance layer is invisible.

### 16.2 Bridge Responsibilities

The MPAS MCP Bridge (defined in `mpas-sdk/packages/mcp-bridge`) handles:
- Constructing Execution Payloads and Action Envelopes from tool call arguments.
- Signing the Proposer Approval with the agent's key.
- Submitting Action Packages to the adapter.
- Handling Authorization Requirements responses (reporting pending status, coordinating approval collection).
- Returning execution results to the agent.

### 16.3 Signer Agents

An MCP Bridge can also act as a Signer, allowing agents to review and approve other agents' proposed actions. The bridge exposes additional tools (`mpas_list_pending`, `mpas_approve`, `mpas_reject`) for this purpose. See the MCP Bridge spec for details.

### 16.4 Trust Assumptions

- The bridge's DID must be configured in the deployment config's `signerKeys` (for signature verification) and in `policy.signerGroups.proposers` or `policy.signerGroups.all` (for proposer authorization).
- The bridge's Proposer Approval alone may or may not be sufficient — that depends on the policy's `defaultRequirement` and any matching policy entries.
- The adapter verifies all bridge-submitted packages identically to any other caller.

---

## 17. Future Work

### 17.1 External Communication Socket

The adapter currently only exposes a local HTTP endpoint (bound to `127.0.0.1`). Future versions should support an outbound persistent connection (WebSocket or SSE) to a cloud Coordination Service, allowing the adapter to receive forwarded Action Packages from remote proposers and signers without requiring inbound port access.

This enables:
- Mobile signer apps approving actions on adapters behind firewalls.
- Cloud coordination services forwarding packages to on-premise adapters.
- Cross-organization approval flows where signers and adapters are on different networks.

### 17.2 Additional Execution Profiles

- OpenAPI operation dispatch (direct HTTP calls to REST APIs)
- EVM transaction signing and submission
- GraphQL mutation dispatch
- CLI command execution

### 17.3 Platform Expansion

- Windows (Windows Credential Manager for credential storage)
- Linux (Secret Service / keyring)
- Cloud (KMS/HSM for credential storage, containerized deployment)

### 17.4 Plugin Trust via OMATrust

- Verify plugin publisher signatures
- Check community attestations and reputation scores
- Support plugin revocation

### 17.5 Pass-Through Operation Filtering (`enabledOperations`)

For operators who want tighter control over which non-governed operations can pass through, a future version could add an optional `enabledOperations` allowlist to the deployment config. If present, only operations explicitly listed (either in the plugin, in the policy's `policies` keys, or in `enabledOperations`) would be forwarded — all others would be rejected. This is useful in scenarios where:

- The MCP bridge gets updated with new tools that the operator hasn't reviewed yet.
- The operator wants to lock down the adapter to a known set of operations regardless of governance level.
- Compliance requires explicit enumeration of all permitted actions.

For the MVP, this is unnecessary complexity. The plugin + policy already define the security boundary: if an operation is important enough to gate, the operator adds a key to `policy.policies`.

---

## 18. Open Questions

1. **Multi-config routing:** If multiple deployment configs cover different Application DIDs, does the adapter load all of them and route by `target.applicationDid`? (Likely yes.)

2. **Adapter DID provisioning:** Should `mpas init` generate the adapter's DID and signing key automatically, or require manual setup?

3. **MCP server lifecycle:** For `mcp.stdio` execution targets, does the adapter manage the MCP server process lifecycle (start/stop with the daemon), or expect it to be running independently?

4. **Signer key resolution:** For the MVP, is it sufficient to configure signer public keys directly in the deployment config's `signerKeys` array (using `did:key`), or do we need DID document resolution?

5. **Authorization Requirements vs. Receipt for policy failure:** When policy is not satisfied but *could* be satisfied with more approvals, we return auth requirements. When policy is definitively unsatisfiable (e.g., resource restricted), we return a rejection receipt. Is this the right distinction?
