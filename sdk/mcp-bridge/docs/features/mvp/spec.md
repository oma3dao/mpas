# MPAS MCP Bridge — Specification

**Status:** Draft  
**Package:** `@oma3/mpas-mcp-bridge`  
**Repository:** `mpas-sdk/packages/mcp-bridge`  
**Depends on:** MPAS Core Specification v0.2, MPAS Application Plugin Profile v0.2, MCP Protocol (JSON-RPC over stdio/HTTP)

---

## 1. Overview

The MPAS MCP Bridge is a library and set of MCP server implementations that enable agents to participate in the MPAS protocol as Proposers or Signers. It bridges the MCP tool-call interface (what agents speak) to the MPAS artifact model (what Credential Adapters verify).

The package provides:

- **A library** for building ProposerBridge MCP servers — drop-in replacements for real application MCP servers. Agents call the same tools with the same arguments, but instead of executing directly, the bridge wraps the call in MPAS artifacts and routes it through a Credential Adapter for verification and execution.
- **An MPAS Signer MCP Server** — a standalone MCP server that enables agents to act as Signers. It polls the Coordination Service for pending approval requests and exposes review/approve/reject tools. One instance per agent, handling approvals across all applications.

---

## 2. Goals

- Provide a library that any developer can use to build an MPAS-aware MCP server for any application.
- Enable zero-change adoption for agents: same tool names, same arguments, same MCP protocol.
- Support the Proposer role: construct Action Packages from tool calls, submit to Credential Adapter, handle auth-requirements responses, return results.
- Support the Signer role: expose review/approve/reject tools so agents can participate in multi-party approval flows.
- Generate MCP tool definitions from MPAS Application Plugin JSON (auto-registration of tools from plugin schemas).
- Remain neutral to agent framework (works with OpenClaw, Claude Desktop, Cursor, any MCP client).
- Remain neutral to Credential Adapter implementation (works with any adapter that speaks the `/mpas/v1/action` interface).

---

## 3. Non-Goals

- Implementing the Credential Adapter or Coordination Service (that's `mpas-local`).
- Defining MPAS protocol semantics (that's `mpas-docs`).
- Managing credentials or executing actions against target applications.
- Requiring agents to understand MPAS protocol details or communicate directly with the Coordination Service.

---

## 4. Architecture

### 4.1 Role in the MPAS Ecosystem

```
┌─────────────────┐     MCP Protocol       ┌──────────────────────┐
│   Agent         │ ──────────────────────▶│  ProposerBridge      │
│  (MCP Client)   │ ◀──────────────────-───│  (MCP Server,        │
│                 │                        │  one per application)│
│                 │                        └──┬────────────┬──────┘
│                 │                           │            │
│                 │               Action Package /    submit action /
│                 │               Receipt     │    poll own state
│                 │                           │            │
│                 │                           ▼            ▼
│                 │               ┌───────────────┐  ┌───────────────┐
│                 │               │  Credential   │  │ Coordination  │
│                 │               │  Adapter      │  │ Service       │
│                 │               └───────────────┘  └───────────────┘
│                 │                                         ▲
│                 │     MCP Protocol       ┌────────────────┘─────────┐
│                 │ ──────────────────────▶│  MPAS Signer MCP Server  │
│                 │ ◀──────────────────────│  (MCP Server,            │
└─────────────────┘                        │   one per agent)         │
                                           └──────────────────────────┘
                                          query / submit approval
```

The package produces two types of MCP servers:

- **ProposerBridge** — Exposes application tools to agents (one instance per application plugin). Constructs MPAS artifacts and communicates with the Credential Adapter directly. Submits to the Coordination Service when additional approvals are needed, and polls for its own actions' state.
- **MPAS Signer MCP Server** — Exposes MPAS approval tools to agents (one instance per agent, across all applications). Queries the Coordination Service on demand for pending approval requests and submits signed Approvals back. Agents never need to know about the Coordination Service's HTTP interface — the signer server abstracts it behind MCP tool calls.

### 4.2 Two Server Types

The bridge package provides two distinct MCP server types that are deployed independently:

| Server Type        | Deployment                           | What it does                                                                                            | Example tools exposed                                                        |
| :----------------- | :----------------------------------- | :------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------- |
| **ProposerBridge** | One per application                  | Wraps tool calls in Action Packages, submits to adapter, polls coordination for its own actions' state  | `merge_pull_request`, `delete_branch` (same as the real server)|
| **MaintainerBridge**    | One per agent (across all apps)      | Queries coordination on demand for pending approval requests for the agent's DID, lets agents approve   | `mpas_list_pending`, `mpas_review_action`, `mpas_approve`, `mpas_reject`     |

These are separate processes. An agent that is both a proposer and a signer runs:
- One or more ProposerBridge instances (one per application plugin)
- One MaintainerBridge instance (handles approvals across all applications)

The ProposerBridge submits Action Packages directly to the Credential Adapter and handles its responses. When the adapter returns `additionalApprovalsRequired`, the ProposerBridge submits the action to the Coordination Service and polls for its own proposed actions' state updates. It does not poll for signer work.

The MaintainerBridge is the single point of contact for all approval requests. When the agent calls `mpas_list_pending`, the server queries the coordination service with the agent's DID and returns all pending approval requests regardless of which application they target.

---

## 5. Library vs. Examples

### 5.1 Library (`@oma3/mpas-mcp-bridge`)

The published npm package. Provides:

- **`ProposerBridge`** — class/module that generates MCP tool handlers from a plugin, constructs Action Packages, manages submission.
- **`MaintainerBridge`** — class/module that exposes MPAS signer tools, fetches pending actions, produces Approvals.
- **`PluginToolGenerator`** — reads an `MpasApplicationPlugin` JSON and generates MCP tool definitions (names, descriptions, input schemas).
- **`ActionPackageBuilder`** — constructs Execution Payloads, Action Envelopes, computes hashes, signs Proposer Approvals.
- **`AdapterClient`** — HTTP client for submitting Action Packages to a Credential Adapter and parsing responses.
- **`CoordinationClient`** — HTTP client for interacting with a Coordination Service (fetch pending actions, submit approvals, fetch receipts).
- **`ApprovalBuilder`** — constructs and signs Approval objects for the Signer role.

### 5.2 Reusable Libraries

The package exports building blocks that other MPAS developers can compose independently of the bridge server classes:

| Export                 | Purpose                                                                    | Typical Consumer                                        |
| :--------------------- | :------------------------------------------------------------------------- | :------------------------------------------------------ |
| `ActionPackageBuilder` | Construct Execution Payloads, Action Envelopes, compute hashes, sign.      | Any TypeScript code that needs to produce Action Packages. |
| `ApprovalBuilder`      | Construct and sign Approval objects for the Signer role.                   | Any TypeScript code that needs to produce Approvals.    |
| `AdapterClient`        | HTTP client for submitting Action Packages to a Credential Adapter.        | Bridge servers, CLI tools, integration tests.           |
| `CoordinationClient`   | HTTP client for interacting with a Coordination Service.                   | Bridge servers, CLI tools, integration tests.           |
| `PluginToolGenerator`  | Generate MCP tool definitions from an `MpasApplicationPlugin` JSON.        | Bridge servers, code generators, documentation tools.   |
| `KeyManager`           | Load, validate, and use Ed25519 signing keys from file.                    | Any component that needs to sign MPAS artifacts.        |

These are usable without instantiating a `ProposerBridge` or `MaintainerBridge`. A developer building a custom workflow (e.g., a CLI proposer, a batch approval script, or a non-MCP integration) can import and compose these directly.

### 5.3 Examples (`packages/mcp-bridge/examples/`)

Runnable reference implementations built on the library:

- **`github/`** — Drop-in replacement for the official GitHub MCP server ([github.com/github/github-mcp-server](https://github.com/github/github-mcp-server)). Loads the `github-repo.json` application plugin and exposes the same tool names (`create_issue`, `merge_pull_request`, `delete_branch`, etc.) that the official server provides, but routes all calls through MPAS. Demonstrates ProposerBridge.
- **`signer-agent/`** — A standalone MCP server that lets an agent act as a Signer across all applications. Polls a coordination service for pending approval requests. Demonstrates MaintainerBridge.

---

## 6. Proposer Capability

### 6.1 Purpose

The Proposer capability turns MCP tool calls into MPAS Action Packages. The agent calls a tool (e.g., `merge_pull_request`), and the bridge:

1. Constructs an Execution Payload from the tool arguments.
2. Builds an Action Envelope (target DID, execution profile, hashes, expiration).
3. Signs a Proposer Approval with the agent's key.
4. Assembles an Action Package.
5. Submits to the Credential Adapter (or Coordination Service).
6. Returns the result to the agent.

### 6.2 Tool Generation from Plugin

Each ProposerBridge is a separate process that serves one application. At startup, it reads an `MpasApplicationPlugin` JSON and auto-generates MCP tool definitions from the plugin's operations:

```typescript
// Inside a ProposerBridge process (e.g., examples/github/index.ts)
import { ProposerBridge } from '@oma3/mpas-mcp-bridge';

const bridge = new ProposerBridge({
  plugin: './plugins/github-repo.json',
  adapterUrl: 'http://localhost:7544',
  agentKey: './keys/agent-key.json',
  applicationDid: 'did:web:github.com',
});

// Builds and starts the MCP server for this application
const server = bridge.buildMcpServer();
```

For each operation in the plugin's `operations` array, the bridge registers an MCP tool with:
- `name` = operation `name`
- `description` = operation `description`
- `inputSchema` = derived from `executionPayloadSchema.properties.arguments`

The agent sees the same tools it would see from the real application's MCP server. Each ProposerBridge process is configured as a separate MCP server entry in the agent's MCP configuration (see Section 8.3).

### 6.3 Action Package Construction

When a tool is called, the bridge constructs:

**Execution Payload** (MCP `toolsCall` format):
```json
{
  "name": "merge_pull_request",
  "arguments": {
    "owner": "oma3dao",
    "repo": "app-registry",
    "pullNumber": 42,
    "baseRef": "main",
    "expectedHeadSha": "abc123",
    "mergeMethod": "squash"
  }
}
```

**Action Envelope:**
```json
{
  "version": "1",
  "type": "ActionEnvelope",
  "actionId": { "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1" },
  "proposer": { "did": "did:key:z6Mk..." },
  "target": {
    "applicationDid": "did:web:github.com"
  },
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "executionPayloadHash": {
    "alg": "sha-256",
    "value": "<base64url SHA-256 of JCS-canonicalized payload>"
  },
  "createdAt": "2026-06-05T10:00:00.000Z",
  "expiresAt": "2026-06-05T10:30:00.000Z"
}
```

**Proposer Approval:** a JWS over the Canonical Approval Payload (which binds the Action Envelope hash), signed with the agent's key. The JWS protected header includes `alg` and `kid` per MPAS Core.

### 6.4 Submission and Response Handling

The bridge submits the Action Package (wrapped in an `ActionRequest`) to the adapter and handles every `ActionResponse.result`. The response is read at `executionReceipt` (the signed receipt) and `executionResult` (verbatim execution-profile-native output, present for `executed` and tool-level `failed`). The bridge relays `executionResult` to the agent untouched when present and synthesizes an MCP-shaped response otherwise. Unknown result values hit an explicit "unrecognized result" error path — there is no silent fallthrough.

| Adapter Response `result`         | Bridge Behavior                                                                                                        |
| :-------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `executed`                        | Relays `executionResult` (verbatim MCP tool result) to the agent as the tool call response.                            |
| `failed`                          | Tool-level failure (`isError: true`): relays `executionResult` verbatim. Protocol-level failure: returns a definitive error. |
| `rejected`                        | Returns an error to the agent with the rejection reason.                                                               |
| `additionalApprovalsRequired`     | Returns a pending status with details on the approvals needed. Optionally submits to Coordination.                     |
| `malformed`                       | Returns an error to the agent (likely a bridge bug).                                                                   |
| `indeterminate`                   | Returns an outcome-unconfirmed status. The bridge MUST NOT auto-resubmit or re-propose; reconciliation is out of band. |
| `pending`                         | The action is executing at the Verifier. The bridge polls or awaits rather than re-proposing; returns a pending status. |
| `expired`                         | Terminal. Returns an error; a new Action Envelope (new `actionId`, fresh approvals) is required to retry.               |
| `notSupported` / `policyUnavailable` | Returns a non-retryable configuration error to the agent.                                                           |
| `cancelled`                       | Reserved (verifier-side signed cancellation, Core 6.9.6). Terminal; treated as rejected. The bridge MUST NOT crash on it. |

A non-2xx `MpasHttpError` (e.g. an unparseable submission) is surfaced as a typed `AdapterRequestError`, distinct from the protocol results above.

### 6.5 Approval Collection Strategy

When the adapter returns `additionalApprovalsRequired`, the bridge can be configured to handle it in different ways:

| Strategy      | Behavior                                                                                                                                                                                                                    |
| :------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `return`      | Return the pending status to the agent. The agent (or human) handles approval collection externally.                                                                                                                        |
| `coordinate`  | Submit the original Action Package + Authorization Requirements to the Coordination Service. The ProposerBridge polls for its own action's state updates. When `readyForResubmission`, the bridge resubmits to the adapter.  |
| `wait`        | Same as `coordinate`, but blocks the tool call (with timeout) until the final result is available. Returns the execution result when resolved or times out.                                                                  |

The ProposerBridge only polls for state updates on actions it submitted. It does not poll for signer work — that is the MaintainerBridge's responsibility.

The strategy is configurable per bridge instance.

**Resubmission semantics:** When the bridge resubmits a completed Action Package after collecting approvals, it uses the SAME `actionId` and the same Action Envelope. Per the Core Action Lifecycle (Core Section 6.9.2), this is permitted because the `actionId` is `open` and the envelope hash matches the pinned hash. The adapter performs full re-verification of the newly submitted package.

---

## 7. Signer Capability

### 7.1 Purpose

The MPAS Signer MCP Server is a standalone MCP server — one per agent — that enables an agent to participate in MPAS approval flows as a Signer across all applications. When the agent calls `mpas_list_pending`, the server queries the Coordination Service with the agent's DID and returns pending approval requests. It exposes tools that allow the agent to:

- List all pending actions awaiting its approval (from any application).
- Review a specific action (see the Execution Payload, Action Envelope, and which application it targets).
- Approve or reject an action (produce a signed Approval).

Because it is a single server per agent, there is exactly one query to the Coordination Service per `mpas_list_pending` call, regardless of how many applications the agent interacts with.

### 7.2 Tools Exposed

| Tool                 | Description                                                             | Parameters                             |
| :------------------- | :---------------------------------------------------------------------- | :------------------------------------- |
| `mpas_list_pending`  | List actions pending the agent's approval.                              | `{}`                                   |
| `mpas_review_action` | Fetch full details of a pending action for review.                      | `{ "actionId": "..." }`               |
| `mpas_approve`       | Approve a pending action. Signs an Approval with the agent's key.       | `{ "actionId": "..." }`               |
| `mpas_reject`        | Reject a pending action. Signs a rejection Approval.                    | `{ "actionId": "..." }`               |

### 7.3 Review Data

When an agent calls `mpas_review_action`, the bridge returns a structured summary:

```json
{
  "actionId": "abc123",
  "proposer": "did:key:z6Mk...",
  "application": "did:web:github.com",
  "operation": "delete_branch",
  "arguments": {
    "owner": "oma3dao",
    "repo": "app-registry",
    "branch": "feature-experiment"
  },
  "createdAt": "2026-06-05T10:00:00Z",
  "expiresAt": "2026-06-05T10:30:00Z",
  "currentApprovals": 0,
  "requiredApprovals": 2,
  "eligibleSignerRoles": ["maintainer"]
}
```

The agent (LLM) can then decide whether to approve based on its instructions, policies, or by asking the human.

### 7.4 Approval Construction

When the agent calls `mpas_approve`, the bridge:

1. Fetches the Action Envelope from the Coordination Service (or local cache).
2. Computes the Action Envelope hash.
3. Constructs an Approval object with `decision: "approve"`.
4. Signs the Approval with the agent's signer key.
5. Submits the Approval to the Coordination Service.
6. Returns confirmation to the agent.

### 7.5 Signer Data Source

The MPAS Signer MCP Server queries the Coordination Service on demand — when the agent calls `mpas_list_pending`, the server hits `POST /mpas/v1/coordination/poll` with the agent's DID and returns the results.

There is no background polling. The agent (or its framework/system prompt) is responsible for calling `mpas_list_pending` at whatever cadence it chooses. The signer server is stateless between calls.

The MPAS Signer MCP Server does not need to know about application plugins or adapter URLs. It only needs:
- The agent's DID and signing key
- The Coordination Service URL

---

## 8. Configuration

Each bridge server reads its configuration from a JSON file passed via the `--config` CLI flag at startup. Config files are typically stored alongside the bridge code or in a central config directory.

### 8.1 Proposer Configuration

File: e.g., `~/Projects/mpas/bridge-configs/github-proposer.json`

```json
{
  "mode": "proposer",
  "plugin": "./plugins/github-repo.json",
  "adapter": {
    "url": "http://localhost:7544"
  },
  "agent": {
    "did": "did:key:z6Mk...",
    "keyFile": "./keys/agent-proposer.json"
  },
  "target": {
    "applicationDid": "did:web:github.com",
    "executionProfile": {
      "id": "did:web:profiles.oma3.org:mcp",
      "format": "mcp.toolsCall"
    }
  },
  "approvalStrategy": "coordinate",
  "coordination": {
    "url": "http://localhost:7545"
  },
  "envelope": {
    "defaultExpirationMinutes": 30
  }
}
```

Paths in the config (`plugin`, `keyFile`) are resolved relative to the config file's directory.

### 8.2 Signer Configuration

File: e.g., `~/Projects/mpas/bridge-configs/signer.json`

```json
{
  "mode": "signer",
  "agent": {
    "did": "did:key:z6Mq...",
    "keyFile": "./keys/agent-signer.json"
  },
  "coordination": {
    "url": "http://localhost:7545"
  }
}
```

Note: The signer configuration has no `plugin`, `adapter`, or `target` fields. The MPAS Signer MCP Server is application-agnostic — it handles approval requests for any application routed through the configured Coordination Service. There is no background polling; the server queries the Coordination Service on demand when the agent calls `mpas_list_pending`.

### 8.3 Agent Deployment

The agent platform (Claude Desktop, Cursor, Kiro, OpenClaw, etc.) launches each bridge as a separate MCP server process. The agent's MCP configuration specifies the command, arguments, and config file for each server:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["tsx", "/path/to/examples/github/index.ts", "--config", "./bridge-configs/github-proposer.json"]
    },
    "mpas-signer": {
      "command": "npx",
      "args": ["tsx", "/path/to/examples/signer-agent/index.ts", "--config", "./bridge-configs/signer.json"]
    }
  }
}
```

The agent uses `github.*` tools for proposing actions and `mpas_*` tools for reviewing and approving others' actions. These are separate OS processes — the agent platform spawns each one and communicates via MCP (stdio or HTTP).

---

## 9. API Surface (Library)

### 9.1 `ProposerBridge`

```typescript
class ProposerBridge {
  constructor(config: ProposerConfig);

  // Generate MCP tool definitions from the loaded plugin
  getToolDefinitions(): McpToolDefinition[];

  // Handle a tool call — constructs Action Package, submits, returns result
  handleToolCall(toolName: string, arguments: object): Promise<ToolCallResult>;

  // Build a complete MCP server with all tools registered
  buildMcpServer(): McpServer;
}
```

### 9.2 `MaintainerBridge`

```typescript
class MaintainerBridge {
  constructor(config: MaintainerConfig);

  // Get MCP tool definitions for signer tools
  getToolDefinitions(): McpToolDefinition[];

  // Handle signer tool calls
  handleToolCall(toolName: string, arguments: object): Promise<ToolCallResult>;

  // Build a complete MCP server with signer tools registered
  buildMcpServer(): McpServer;
}
```

### 9.3 `PluginToolGenerator`

```typescript
class PluginToolGenerator {
  constructor(plugin: MpasApplicationPlugin);

  // Generate MCP tool definitions from plugin operations
  generateTools(): McpToolDefinition[];

  // Get the input schema for a specific operation
  getInputSchema(operationName: string): JsonSchema;
}
```

### 9.4 `ActionPackageBuilder`

```typescript
class ActionPackageBuilder {
  constructor(config: BuilderConfig);

  // Build a complete Action Package from a tool call
  buildFromToolCall(toolName: string, args: object): ActionPackage;

  // Build just the Execution Payload
  buildPayload(toolName: string, args: object): ExecutionPayload;

  // Build the Action Envelope for a payload
  buildEnvelope(payload: ExecutionPayload): ActionEnvelope;

  // Sign and attach a Proposer Approval
  signProposerApproval(envelope: ActionEnvelope): Approval;
}
```

### 9.5 `AdapterClient`

```typescript
class AdapterClient {
  constructor(config: { url: string });

  // Submit an Action Package and parse the response
  submit(pkg: ActionPackage): Promise<AdapterResponse>;
}

type AdapterResponse =
  | { result: 'executed'; receipt: ExecutionReceipt; executionResult?: unknown }
  | { result: 'rejected'; receipt?: ExecutionReceipt; error: AdapterError }
  | { result: 'additionalApprovalsRequired'; authorizationRequirements: AuthorizationRequirements }
  | { result: 'malformed'; error: AdapterError }
  | { result: 'failed'; receipt: ExecutionReceipt; error?: AdapterError }
  | { result: 'indeterminate'; receipt: ExecutionReceipt }
  | { result: 'pending'; actionRequestId?: string; pollAfter?: string };
```

### 9.6 `CoordinationClient`

```typescript
class CoordinationClient {
  constructor(config: { url: string });

  // Submit an action for coordination (proposer use)
  submitAction(pkg: ActionPackage, authReqs: AuthorizationRequirements): Promise<CoordinationActionResponse>;

  // Poll the coordination service (used by both ProposerBridge and MaintainerBridge)
  poll(did: string): Promise<CoordinationPollResponse>;

  // Submit a signed Approval (signer use)
  submitApproval(actionEnvelopeHash: HashObject, approval: Approval): Promise<{ accepted: boolean }>;

  // Cancel a pending action (proposer use)
  cancelAction(actionId: string, did: string): Promise<CoordinationActionCancelResponse>;
}

interface CoordinationPollResponse {
  approvalRequests: ApprovalRequest[];  // Actions awaiting this DID's approval
  actionUpdates: ActionUpdate[];        // State updates for actions this DID proposed
}

interface ActionUpdate {
  actionRef: ActionRef;
  state: 'awaitingApprovals' | 'readyForResubmission' | 'cancelled';
  progress?: Progress;
  actionPackage?: ActionPackage;  // Present when readyForResubmission
  cancelledAt?: string;           // Present when cancelled
  updatedAt: string;
}

interface Progress {
  approvalsCollected: number;
  approvalsRequired: number;
  approved: string[];   // DIDs
  rejected: string[];   // DIDs
  pending: string[];    // DIDs
}
```

### 9.7 `ApprovalBuilder`

```typescript
class ApprovalBuilder {
  constructor(config: { signerDid: string; signingKey: JsonWebKey });

  // Build and sign an Approval for an Action Envelope
  buildApproval(envelope: ActionEnvelope, decision: 'approve' | 'reject'): Approval;
}
```

---

## 10. Security Requirements

### 10.1 Key Management

- The bridge holds signing keys for the agent (Proposer or Signer role).
- Keys MUST be stored in files with restrictive permissions (user-only read, `chmod 600`).
- Keys MUST NOT be logged or included in MCP responses.
- The bridge MUST NOT accept signing keys from tool call arguments or agent input.
- See Section 13 for key file format, loading, and DID derivation details.

### 10.2 No Credential Access

- The bridge MUST NOT hold or access application credentials (OAuth tokens, API keys, etc.).
- Application credentials are managed exclusively by the Credential Adapter.
- The bridge only signs MPAS artifacts — it never authenticates to target applications.

### 10.3 Envelope Validation

- The bridge SHOULD validate the Execution Payload against the plugin's schema before constructing the Action Package. This catches malformed requests early.
- The bridge MUST set reasonable expiration times on Action Envelopes.
- The bridge MUST generate unique action IDs (UUID v4 or similar).

### 10.4 Signer Review Integrity

- When presenting actions for signer review, the bridge MUST show the actual Execution Payload and Action Envelope data, not Proposer-supplied summaries.
- The bridge MUST verify that the Action Envelope hash matches the Execution Payload hash before presenting for review.
- The bridge MUST NOT approve actions automatically unless explicitly configured to do so (auto-signer mode for deterministic agents).

---

## 11. Transport

The bridge is an MCP server and supports standard MCP transports:

- **stdio** — agent spawns the bridge process, communicates via stdin/stdout JSON-RPC. Default for local development.
- **HTTP/SSE** — agent connects to the bridge over HTTP. Suitable for shared or remote deployments.

The transport choice is independent of the bridge's functionality.

---

## 12. Error Handling

| Condition                                      | Bridge Behavior                                                                       |
| :--------------------------------------------- | :------------------------------------------------------------------------------------ |
| Plugin file not found or invalid               | Fail to start. Log error.                                                             |
| Agent key file not found                       | Fail to start. Log error.                                                             |
| Adapter unreachable                            | Return error to agent: "Credential Adapter unavailable."                              |
| Coordination Service unreachable               | Signer tools return error. Proposer `coordinate`/`wait` strategies fail gracefully.   |
| Adapter returns `malformed`                    | Return error to agent with details. Likely a bridge bug.                              |
| Action expired before approval                 | Return error to agent. Suggest re-proposing.                                          |
| Tool call arguments don't match plugin schema  | Return validation error to agent before constructing Action Package.                  |

---

## 13. Key Management

### 13.1 Key File Format

Signing keys are stored as JWK (JSON Web Key) files. For the MVP, only Ed25519 keys are supported.

```json
{
  "kty": "OKP",
  "crv": "Ed25519",
  "x": "<base64url public key>",
  "d": "<base64url private key>",
  "kid": "agent-proposer-1"
}
```

The `kid` (Key ID) identifies the signing key. The bridge sets it as the JWS protected-header `kid` on every Approval and signed artifact it produces, as required by MPAS Core (the JWS header MUST contain `alg` and `kid`). When omitted from the key file, the bridge derives a `kid` from the key's `did:key` identity.

### 13.2 Key Loading and Lifecycle

The `KeyManager` module handles:

- Loading a JWK file from disk.
- Validating key type (`OKP`) and curve (`Ed25519`).
- Deriving the `did:key` identifier from the public key.
- Providing a signing function that takes bytes and returns a JWS compact serialization.
- Rejecting keys that are missing the private component (`d` field) when signing is required.

The bridge loads its signing key at startup. If the key file is missing or invalid, the bridge MUST fail to start with a clear error message.

### 13.3 DID Derivation

The bridge derives the agent's DID from the loaded key:

- For Ed25519 keys: `did:key:z6Mk...` using the Multicodec Ed25519 public key prefix (`0xed01`).

This derived DID is used as the `proposer.did` in Action Envelopes and as the signer identity in Approvals. The `agent.did` field in configuration must match the derived DID — if they differ, the bridge MUST fail to start (prevents misconfiguration where a key doesn't match the declared identity).

The `omatrust-sdk` package provides DID derivation and validation utilities that may be used here rather than reimplementing multicodec encoding.

---

## 14. GitHub Reference Example

### 14.1 Purpose

The GitHub example (`packages/mcp-bridge/examples/github/`) is a runnable MPAS bridge that serves as a drop-in replacement for the official GitHub MCP server ([github.com/github/github-mcp-server](https://github.com/github/github-mcp-server)).

An agent configured to use the GitHub MPAS bridge sees the same tool names and argument schemas as the official server. The bridge routes calls through MPAS instead of executing directly.

### 14.2 Official Server Reference

The official GitHub MCP server exposes tools including:

| Tool Name            | Description                              |
| :------------------- | :--------------------------------------- |
| `create_issue`       | Create a new issue in a repository.      |
| `list_issues`        | List issues in a repository.             |
| `get_issue`          | Get details of a specific issue.         |
| `create_pull_request`| Create a new pull request.               |
| `merge_pull_request` | Merge an existing pull request.          |
| `list_branches`      | List branches in a repository.           |
| `delete_branch`      | Delete a branch from a repository.       |
| `push_files`         | Push file changes to a branch.           |
| `create_repository`  | Create a new repository.                 |

The MPAS GitHub plugin (`plugins/github-repo.json`) wraps a subset of these tools — specifically those that are destructive or high-impact. Per the Application Plugin Profile, the plugin operation names are the native MCP tool names exactly as exposed by the server. The bridge therefore exposes these tool names unchanged; no name mapping or translation is performed.

The plugin's `executionPayloadSchema` for each operation matches the argument schema of the corresponding official tool.

### 14.3 Running the Example

```bash
# From the mpas-sdk repo root:
cd packages/mcp-bridge/examples/github

# Configure (edit the JSON to point at your adapter and key):
cp config.example.json config.json

# Run as an MCP server (stdio transport):
npx tsx index.ts --config ./config.json
```

The agent's MCP configuration replaces the official GitHub server entry with this bridge:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["tsx", "/path/to/examples/github/index.ts", "--config", "./config.json"]
    }
  }
}
```

### 14.4 Example Config

```json
{
  "mode": "proposer",
  "plugin": "../../fixtures/plugins/github-repo.json",
  "adapter": {
    "url": "http://localhost:7544"
  },
  "agent": {
    "did": "did:key:z6Mk...",
    "keyFile": "./keys/proposer.json"
  },
  "target": {
    "applicationDid": "did:web:github.com",
    "executionProfile": {
      "id": "did:web:profiles.oma3.org:mcp",
      "format": "mcp.toolsCall"
    }
  },
  "approvalStrategy": "coordinate",
  "coordination": {
    "url": "http://localhost:7545"
  },
  "envelope": {
    "defaultExpirationMinutes": 30
  }
}
```

---

## 15. Open Questions

1. **Auto-signer mode:** Should the library support a mode where the MaintainerBridge automatically approves actions matching certain criteria (e.g., "approve all create_issue from did:key:z6Mk...")? This enables deterministic agent signers without LLM judgment. Needs careful safety guardrails.

2. **Action Envelope fields from agent:** Should the agent be able to influence any envelope fields (like expiration or target resource) via tool call arguments, or should the bridge control all envelope construction? Leaning toward bridge-controlled for security.

3. **Plugin discovery:** Should the bridge be able to fetch plugins from a URL on startup, or only load from local files? URL fetch adds convenience but introduces a trust question (how to verify integrity).

4. **Multi-application bridge:** Should a single ProposerBridge instance serve tools from multiple plugins/applications? Leaning toward one-application-per-instance for simplicity and clean tool namespacing.
