# MPAS MCP Bridge — MVP Implementation Plan

**Status:** Draft  
**Spec:** `docs/spec.md`  
**Target:** macOS (development on M-series Mac, testable on a single machine)  
**Language:** TypeScript (Node.js, ESM)  
**Approach:** Test-fixture-first, phased delivery, each task completable by a coding agent  
**Overall program plan:** See `mpas-program/mvp-plan.md` for cross-repo orchestration (this is Phase P4)

---

## 1. Scope

This plan covers the `@oma3/mpas-mcp-bridge` package only. It does not cover:

- The Credential Adapter (`mpas-credential-adapter`) — see that repo's own plan.
- The Coordination Service (`mpas-coordination-server`) — see that repo's own plan.
- The MPAS specifications (`mpas-docs`) — reference only.

This plan produces:

1. **Reusable libraries** — `ActionPackageBuilder`, `ApprovalBuilder`, `AdapterClient`, `CoordinationClient`, `PluginToolGenerator`, `KeyManager` — usable independently by any TypeScript MPAS developer.
2. **Bridge server classes** — `ProposerBridge` and `MaintainerBridge` — compose the libraries into MCP servers.
3. **GitHub reference example** — A runnable MPAS bridge that replaces the official GitHub MCP server for governed tool calls.

---

## 2. Phases

| Phase | Deliverable |
|---|---|
| Phase 0 | Project scaffolding, types, test fixtures, key utilities |
| Phase 1 | Proposer libraries (ActionPackageBuilder, AdapterClient, PluginToolGenerator) |
| Phase 2 | Signer libraries (ApprovalBuilder, CoordinationClient) |
| Phase 3 | Bridge servers (ProposerBridge, MaintainerBridge, combined mode) |
| Phase 4 | GitHub reference example |

---

## 3. Phase 0: Scaffolding, Types, Fixtures, and Key Management

### 3.1 Tasks

#### Task 0.1: Repository and package scaffolding

Set up the TypeScript package structure:

```
packages/mcp-bridge/
  package.json              # @oma3/mpas-mcp-bridge, TypeScript, ESM
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                # Public exports barrel
    types/
      mpas.ts               # MPAS Core types (ActionPackage, Envelope, Approval, etc.)
      mcp.ts                # MCP tool definition types
      config.ts             # Bridge configuration types
    lib/
      key-manager.ts        # Key loading, validation, DID derivation, signing
      plugin-tool-generator.ts
      action-package-builder.ts
      adapter-client.ts
      coordination-client.ts
      approval-builder.ts
    bridges/
      proposer-bridge.ts
      maintainer-bridge.ts
    utils/
      hash.ts               # JCS canonicalization + SHA-256
      jws.ts                # JWS compact serialization (sign/verify)
  tests/
    fixtures/
    lib/
    bridges/
    integration/
  examples/
    github/
    signer-agent/
    full-participant/
```

**Done when:** `npm install` succeeds, `npm run build` compiles with zero errors, `npm test` runs (with zero tests initially).

#### Task 0.2: MPAS type definitions

Define TypeScript types shared across the package. These should align with the types from `mpas-credential-adapter` (future extraction to `@oma3/mpas-core-utils`):

- `ExecutionPayload` — `{ name: string; arguments: Record<string, unknown> }`
- `ActionEnvelope` — full envelope per MPAS Core Section 5.3
- `HashObject` — `{ alg: string; value: string }`
- `Approval` — per MPAS Core Section 5.5
- `ApprovalBundle` — per MPAS Core Section 5.6
- `ActionPackage` — per MPAS Core Section 5.7
- `AuthorizationRequirements` — per MPAS Core Section 5.8
- `ExecutionReceipt` — per MPAS Core Section 5.9
- `SignerReviewSet` — per MPAS Core Section 5.4
- `MpasApplicationPlugin` — per Application Plugin Profile v0.2
- `ProposerConfig`, `MaintainerConfig`, `CombinedConfig` — bridge configuration types
- `AdapterResponse` — the HTTP-profile `ActionResponse` (and `MpasHttpError` for non-2xx)
- `McpToolDefinition` — MCP tool registration shape

**Done when:** Types compile. A sample Action Package can be constructed in TypeScript with full type checking.

#### Task 0.3: Test fixtures — keys and plugin

Create fixture files:

| Fixture | File | Description |
|---|---|---|
| Proposer key | `fixtures/keys/proposer.json` | Ed25519 JWK with private key |
| Signer A key | `fixtures/keys/signer-a.json` | Ed25519 JWK with private key |
| Signer B key | `fixtures/keys/signer-b.json` | Ed25519 JWK with private key |
| GitHub plugin | `fixtures/plugins/github-repo.json` | `MpasApplicationPlugin` with `merge_pull_request`, `delete_branch`, `create_issue` |
| Adapter signing key | `fixtures/keys/adapter.json` | For generating mock receipts in tests |

Keys must be real Ed25519 key pairs that can sign and verify. The plugin must conform to the Application Plugin Profile JSON Schema.

**Done when:** Keys can produce verifiable signatures. Plugin validates against the schema.

#### Task 0.4: Test fixtures — Action Packages and responses

Create JSON fixtures representing expected inputs and outputs:

| Fixture | Description |
|---|---|
| `valid-create-issue-package.json` | Complete Action Package for `create_issue` with proposer approval |
| `valid-merge-pr-package.json` | Complete Action Package for `merge_pull_request` with proposer + 2 signer approvals |
| `adapter-response-executed.json` | `ActionResponse`: `result: "executed"` with `executionReceipt` and `executionResult` |
| `adapter-response-needs-approvals.json` | `ActionResponse`: `result: "additionalApprovalsRequired"` with auth requirements |
| `adapter-response-rejected.json` | `ActionResponse`: `result: "rejected"` with error |
| `adapter-http-error.json` | `MpasHttpError`: 400-level transport/structural error |
| `coordination-pending-actions.json` | Coordination Service response: list of pending actions for a signer |
| `coordination-review-set.json` | Coordination Service response: Signer Review Set for one action |

**Done when:** All fixtures are valid JSON with correct hash bindings and verifiable signatures.

#### Task 0.5: Fixture generation script

Create `scripts/generate-fixtures.ts` that:

- Loads test keys.
- Constructs Action Packages programmatically (real hashes, real JWS signatures).
- Generates mock adapter and coordination responses.
- Writes all fixture files.

**Done when:** Running `npx tsx scripts/generate-fixtures.ts` regenerates all fixtures and they pass structural validation.

#### Task 0.6: KeyManager implementation

Implement `src/lib/key-manager.ts`:

```typescript
class KeyManager {
  static fromFile(path: string): Promise<KeyManager>;
  static fromJwk(jwk: JsonWebKey): KeyManager;

  get did(): string;           // did:key derived from public key
  get publicKey(): JsonWebKey; // Public JWK (no 'd' field)

  sign(payload: Uint8Array): Promise<string>;  // Returns JWS compact serialization
  verify(jws: string): Promise<boolean>;       // Verify a JWS against this key
}
```

- Validates key type is `OKP` with curve `Ed25519`.
- Derives `did:key` using Multicodec prefix `0xed01` + raw public key bytes → multibase base58btc.
- Uses `jose` library for JWS sign/verify.
- Rejects keys missing `d` field when signing is attempted.
- Validates that configured `agent.did` matches derived DID (if both present).

**Done when:** Can load fixture keys, derive correct `did:key` identifiers, sign payloads, and verify signatures round-trip.

#### Task 0.7: Hash utilities

Implement `src/utils/hash.ts`:

```typescript
// JCS-canonicalize a JSON object and compute SHA-256, return as HashObject
function computeHash(obj: unknown): HashObject;

// Verify a hash binding
function verifyHash(obj: unknown, expected: HashObject): boolean;
```

Uses `json-canonicalize` (RFC 8785) and Node.js `crypto.createHash('sha256')`.

**Done when:** `computeHash` on fixture Execution Payloads produces the same hash values stored in fixture Action Envelopes.

### 3.2 Acceptance Criteria

- [ ] `npm run build` — zero compile errors
- [ ] `npm test` — zero failures
- [ ] Fixture keys produce verifiable JWS signatures
- [ ] Fixture plugin validates against Application Plugin Profile JSON Schema
- [ ] Fixture Action Packages have correct internal hash bindings
- [ ] `KeyManager` derives correct `did:key` from test keys
- [ ] Hash utilities produce deterministic canonical hashes

---

## 4. Phase 1: Proposer Libraries

### 4.1 Tasks

#### Task 1.1: PluginToolGenerator

Implement `src/lib/plugin-tool-generator.ts`:

```typescript
class PluginToolGenerator {
  constructor(plugin: MpasApplicationPlugin);

  generateTools(): McpToolDefinition[];
  getInputSchema(operationName: string): JsonSchema;
  getOperation(operationName: string): PluginOperation | undefined;
}
```

- Reads the plugin's `operations` array.
- For each operation, generates an MCP tool definition:
  - `name` = operation `name`
  - `description` = operation `description`
  - `inputSchema` = extracted from `executionPayloadSchema.properties.arguments`
- Validates the plugin has at least one operation.

**Done when:** Loading the GitHub plugin fixture produces 3 MCP tool definitions matching the operations. Input schemas match the argument shapes from the plugin.

#### Task 1.2: ActionPackageBuilder

Implement `src/lib/action-package-builder.ts`:

```typescript
class ActionPackageBuilder {
  constructor(config: {
    applicationDid: string;
    executionProfile: { id: string; format: string };
    keyManager: KeyManager;
    defaultExpirationMinutes?: number;
  });

  buildFromToolCall(toolName: string, args: object): Promise<ActionPackage>;
  buildPayload(toolName: string, args: object): ExecutionPayload;
  buildEnvelope(payload: ExecutionPayload): ActionEnvelope;
  signProposerApproval(envelope: ActionEnvelope): Promise<Approval>;
  assemblePackage(payload: ExecutionPayload, envelope: ActionEnvelope, approval: Approval): ActionPackage;
}
```

- `buildPayload`: wraps `{ name: toolName, arguments: args }`.
- `buildEnvelope`: generates UUID action ID, computes payload hash, sets proposer DID from KeyManager, sets expiration.
- `signProposerApproval`: computes envelope hash, builds JWS over the canonical Approval payload, returns Approval object.
- `assemblePackage`: combines payload + envelope + approval bundle into ActionPackage.
- `buildFromToolCall`: orchestrates all of the above in one call.

**Done when:** Building an Action Package from `("create_issue", { owner: "oma3dao", repo: "test", title: "Hello" })` produces a valid package where:
- Payload hash in envelope matches the actual payload hash.
- Proposer Approval signature verifies against the proposer's public key.
- Approval binds to the correct envelope hash.

#### Task 1.3: AdapterClient

Implement `src/lib/adapter-client.ts`:

```typescript
class AdapterClient {
  constructor(config: { url: string });

  submit(pkg: ActionPackage): Promise<AdapterResponse>;
  healthCheck(): Promise<{ status: string }>;
}
```

- POSTs an `ActionRequest` (wrapping the Action Package) to `{url}/mpas/v1/action` with `Content-Type: application/mpas+json`.
- Parses a 2xx response into the `ActionResponse` shape; parses a non-2xx `MpasHttpError` into a typed `AdapterRequestError`.
- Handles network errors gracefully (timeout, connection refused → typed `AdapterUnavailable` error).
- Uses `fetch` (Node.js built-in from v18+).

**Done when:** 
- Against a mock HTTP server returning fixture responses, correctly parses all `ActionResponse` results and surfaces `MpasHttpError` (400) as `AdapterRequestError`.
- Network error produces a typed `AdapterUnavailable` error.
- Health check hits `GET {url}/mpas/v1/health`.

#### Task 1.4: Proposer flow integration test

Create `tests/lib/proposer-flow.test.ts` that wires together PluginToolGenerator + ActionPackageBuilder + AdapterClient with a mock HTTP adapter:

1. Load GitHub plugin → generate tools.
2. Simulate a tool call (`create_issue`).
3. Build Action Package.
4. Submit to mock adapter → get `executed` ActionResponse.
5. Verify the full round-trip.

Also test the `additionalApprovalsRequired` flow:
1. Submit → get auth requirements.
2. Verify the bridge receives structured requirements.

**Done when:** Tests pass with mock adapter returning fixture responses.

### 4.2 Acceptance Criteria

- [ ] `PluginToolGenerator` produces correct MCP tool definitions from the GitHub plugin
- [ ] `ActionPackageBuilder` produces Action Packages with valid hash bindings and signatures
- [ ] `AdapterClient` correctly parses all `ActionResponse` results and the `MpasHttpError` path
- [ ] Integration test demonstrates full proposer flow against mock adapter
- [ ] All libraries are independently importable (no circular dependencies)

---

## 5. Phase 2: Signer Libraries

### 5.1 Tasks

#### Task 2.1: ApprovalBuilder

Implement `src/lib/approval-builder.ts`:

```typescript
class ApprovalBuilder {
  constructor(config: { keyManager: KeyManager });

  buildApproval(envelope: ActionEnvelope, decision: 'approve' | 'reject', reason?: string): Promise<Approval>;
  verifyApproval(approval: Approval, signerPublicKey: JsonWebKey): Promise<boolean>;
}
```

- Computes Action Envelope hash (JCS + SHA-256).
- Constructs the canonical Approval payload: `{ actionEnvelopeHash, decision, signerDid, createdAt }`.
- Signs as JWS compact serialization over the canonical payload.
- Returns a complete Approval object.
- `verifyApproval`: verifies a received Approval's JWS against a known public key.

**Done when:**
- Building an approval for a fixture Action Envelope produces a verifiable JWS.
- The approval's `actionEnvelopeHash` matches the computed envelope hash.
- `verifyApproval` returns true for valid approvals, false for tampered ones.

#### Task 2.2: CoordinationClient

Implement `src/lib/coordination-client.ts`:

```typescript
class CoordinationClient {
  constructor(config: { url: string });

  submitPendingAction(pkg: ActionPackage, authReqs: AuthorizationRequirements): Promise<string>;
  listPending(signerDid: string): Promise<PendingAction[]>;
  getReviewSet(actionId: string): Promise<SignerReviewSet>;
  submitApproval(actionId: string, approval: Approval): Promise<void>;
  getReceipt(actionId: string): Promise<ExecutionReceipt | null>;
  getStatus(actionId: string): Promise<ActionStatus>;
}
```

HTTP calls map to the Coordination Service endpoints (per MPAS HTTP Profile Section 8.3):
- `submitPendingAction` → `POST /mpas/v1/coordination/action`
- `listPending` → `POST /mpas/v1/coordination/poll` (with signer DID filter)
- `getReviewSet` → `POST /mpas/v1/coordination/poll` (with action ID filter, returns Signer Review Set)
- `submitApproval` → `POST /mpas/v1/coordination/approval`
- `getReceipt` → `POST /mpas/v1/coordination/poll` (with action ID filter, returns receipt if resolved)
- `getStatus` → `POST /mpas/v1/coordination/poll` (with action ID filter, returns status)

**Done when:**
- Against a mock HTTP coordination server returning fixture responses, all methods parse correctly.
- Network errors produce typed errors.
- `listPending` returns an array of `PendingAction` objects.

#### Task 2.3: Signer flow integration test

Create `tests/lib/signer-flow.test.ts`:

1. Mock coordination service with one pending action.
2. `CoordinationClient.listPending(signerDid)` → returns pending action.
3. `CoordinationClient.getReviewSet(actionId)` → returns Signer Review Set.
4. Verify payload hash binding (ensure integrity before presenting to signer).
5. `ApprovalBuilder.buildApproval(envelope, "approve")` → produces signed Approval.
6. `CoordinationClient.submitApproval(actionId, approval)` → submits.
7. Verify the round-trip.

**Done when:** Tests pass with mock coordination server.

### 5.2 Acceptance Criteria

- [ ] `ApprovalBuilder` produces Approvals with verifiable JWS signatures
- [ ] `ApprovalBuilder` correctly binds approvals to Action Envelope hashes
- [ ] `CoordinationClient` correctly calls all coordination endpoints
- [ ] Signer flow integration test demonstrates full review → approve cycle
- [ ] `verifyApproval` rejects tampered approvals

---

## 6. Phase 3: Bridge Servers

### 6.1 Tasks

#### Task 3.1: ProposerBridge

Implement `src/bridges/proposer-bridge.ts`:

```typescript
class ProposerBridge {
  constructor(config: ProposerConfig);

  getToolDefinitions(): McpToolDefinition[];
  handleToolCall(toolName: string, args: object): Promise<ToolCallResult>;
  buildMcpServer(): McpServer;
}
```

Composes:
- `PluginToolGenerator` for tool registration.
- `ActionPackageBuilder` for Action Package construction.
- `AdapterClient` for submission.
- `CoordinationClient` for the `coordinate` and `wait` approval strategies.
- `KeyManager` for signing.

`handleToolCall` flow:
1. Validate args against plugin schema (early rejection).
2. Build Action Package via `ActionPackageBuilder`.
3. Submit via `AdapterClient`.
4. Handle response:
   - `executed` → return result content to agent.
   - `rejected` → return MCP error with reason.
   - `additionalApprovalsRequired` → based on `approvalStrategy`:
     - `return`: return structured pending status to agent.
     - `coordinate`: submit to Coordination Service, return pending status.
     - `wait`: submit to Coordination Service, poll until resolved or timeout.
   - `malformed` → return MCP error.

`buildMcpServer` creates an MCP server instance (using `@modelcontextprotocol/sdk`) with all tools registered and wired to `handleToolCall`.

**Done when:**
- Loads GitHub plugin and registers 3 tools.
- A tool call to `create_issue` with mock adapter returning `executed` → returns success.
- A tool call with mock adapter returning `additionalApprovalsRequired` + `coordinate` strategy → submits to mock coordination service and returns pending.
- A tool call with invalid args → returns validation error before submission.

#### Task 3.2: MaintainerBridge

Implement `src/bridges/maintainer-bridge.ts`:

```typescript
class MaintainerBridge {
  constructor(config: MaintainerConfig);

  getToolDefinitions(): McpToolDefinition[];
  handleToolCall(toolName: string, args: object): Promise<ToolCallResult>;
  buildMcpServer(): McpServer;
}
```

Composes:
- `CoordinationClient` for fetching pending actions and submitting approvals.
- `ApprovalBuilder` for signing approvals.
- `KeyManager` for signing.
- Hash utilities for verifying review set integrity.

Registers 4 MCP tools:
- `mpas_list_pending` → `CoordinationClient.listPending(signerDid)`
- `mpas_review_action` → `CoordinationClient.getReviewSet(actionId)` + verify hash binding + return structured review data.
- `mpas_approve` → verify envelope integrity, `ApprovalBuilder.buildApproval(envelope, "approve")`, `CoordinationClient.submitApproval`.
- `mpas_reject` → same as approve but with `decision: "reject"` and optional reason.

**Security check in `mpas_review_action`:** Before presenting data to the agent, verify that the Execution Payload hash matches the Action Envelope's `executionPayloadHash`. If they don't match, return an error (potential tampering by coordination service).

**Done when:**
- Registers 4 signer tools.
- `mpas_list_pending` with mock coordination returns pending actions.
- `mpas_review_action` returns structured review data with integrity verified.
- `mpas_approve` produces a valid approval and submits it.
- `mpas_review_action` with tampered payload hash → returns integrity error.

#### Task 3.3: Combined bridge mode

Implement the `"mode": "both"` configuration in `src/bridges/proposer-bridge.ts` (or a thin `CombinedBridge` wrapper):

- Instantiates both `ProposerBridge` and `MaintainerBridge`.
- Merges their tool definitions into a single MCP server.
- Routes tool calls by name prefix: `mpas_*` → MaintainerBridge, everything else → ProposerBridge.

**Done when:** A combined bridge exposes both application tools and signer tools. A single MCP server instance handles both.

#### Task 3.4: MCP transport setup (stdio)

Wire `buildMcpServer()` to the MCP SDK's stdio transport:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Bridge creates an MCP Server, registers tools, connects transport
const transport = new StdioServerTransport();
await server.connect(transport);
```

Create a CLI entry point (`src/cli.ts`) that:
- Accepts `--config <path>` argument.
- Loads and validates the config JSON.
- Instantiates the appropriate bridge (proposer/signer/both).
- Starts the MCP stdio server.

**Done when:** Running `npx tsx src/cli.ts --config fixtures/configs/proposer.json` starts an MCP server that responds to `tools/list` with the registered tools.

#### Task 3.5: Configuration validation

Implement config schema validation:

- Validate required fields based on mode:
  - `proposer`: requires `plugin`, `adapter.url`, `agent.did`, `agent.keyFile`, `target`.
  - `signer`: requires `agent.did`, `agent.keyFile`, `coordination.url`.
  - `both`: requires all of the above.
- Validate `agent.did` matches the derived DID from the key file.
- Validate plugin file exists and loads correctly.
- Validate key file exists and is valid Ed25519 JWK.
- Return clear error messages for each validation failure.

**Done when:** Invalid configs produce descriptive error messages. Valid configs pass validation. DID mismatch between config and key is caught.

### 6.2 Acceptance Criteria

- [ ] `ProposerBridge` handles all adapter response types correctly
- [ ] `ProposerBridge` implements all 3 approval strategies (`return`, `coordinate`, `wait`)
- [ ] `MaintainerBridge` exposes all 5 signer tools
- [ ] `MaintainerBridge` verifies review set integrity before presenting to agent
- [ ] Combined mode serves both proposer and signer tools
- [ ] CLI entry point starts a working stdio MCP server
- [ ] Invalid configuration produces clear error messages at startup

---

## 7. Phase 4: GitHub Reference Example

### 7.1 Tasks

#### Task 4.1: GitHub plugin fixture

Ensure `fixtures/plugins/github-repo.json` is complete and accurate:

- Covers at minimum: `merge_pull_request`, `delete_branch`, `create_issue`.
- Argument schemas match the official GitHub MCP server ([github.com/github/github-mcp-server](https://github.com/github/github-mcp-server)) tool signatures.
- Conforms to the Application Plugin Profile v0.2.
- Has realistic `policySuggestions` (merge to main = high impact, delete branch = medium impact).

This fixture was created in Phase 0 but may need refinement based on the official server's actual schemas.

**Done when:** Plugin passes JSON Schema validation. Tool schemas match the official GitHub MCP server's tool argument shapes.

#### Task 4.2: GitHub example entry point

Create `examples/github/index.ts`:

```typescript
import { ProposerBridge } from '../../src/index.js';

const config = loadConfig(process.argv);
const bridge = new ProposerBridge(config);
const server = bridge.buildMcpServer();
// Connect stdio transport and run
```

Create `examples/github/config.example.json` with placeholder values.

Create `examples/github/README.md` explaining:
- What this example does.
- Prerequisites (running Credential Adapter, key file, plugin).
- How to configure.
- How to add to an agent's MCP config.
- Reference to the official GitHub MCP server it replaces.

**Done when:** The example starts, responds to `tools/list` with the 3 GitHub tools, and can handle a tool call (against a running adapter or mock).

#### Task 4.3: Signer agent example

Create `examples/signer-agent/index.ts`:

```typescript
import { MaintainerBridge } from '../../src/index.js';

const config = loadConfig(process.argv);
const bridge = new MaintainerBridge(config);
const server = bridge.buildMcpServer();
// Connect stdio transport and run
```

Create `examples/signer-agent/config.example.json` and `README.md`.

**Done when:** The example starts and responds to `tools/list` with the 5 signer tools.

#### Task 4.4: End-to-end integration test

Create `tests/integration/bridge-to-adapter.test.ts`:

Test requires a mock Credential Adapter (simple HTTP server returning fixture responses). The test:

1. Starts the mock adapter.
2. Instantiates a `ProposerBridge` with the GitHub plugin.
3. Calls `handleToolCall("create_issue", { owner: "oma3dao", repo: "test", title: "Hello" })`.
4. Mock adapter returns `executed` with receipt.
5. Verifies the bridge returns the execution result.

Second test:
1. Mock adapter returns `additionalApprovalsRequired`.
2. Mock coordination service is running.
3. Bridge uses `coordinate` strategy, submits to coordination service.
4. Verify the pending action is submitted correctly.

**Done when:** Integration tests pass against mock services. The full proposer flow works end-to-end within the package.

### 7.2 Acceptance Criteria

- [ ] GitHub example starts as a functional MCP server
- [ ] GitHub example's tool list matches the plugin operations
- [ ] Signer agent example starts and serves signer tools
- [ ] End-to-end integration test validates proposer flow with mock adapter
- [ ] All examples have README documentation
- [ ] `npm run build` still passes with examples included

---

## 8. Dependencies

| Phase | Depends On |
|---|---|
| Phase 0 | Nothing (first). Can start after P0 of the credential adapter (shared fixture format understanding). |
| Phase 1 | Phase 0 (types, fixtures, KeyManager, hash utils) |
| Phase 2 | Phase 0 (types, fixtures, KeyManager, hash utils) |
| Phase 3 | Phase 1 + Phase 2 (all libraries) |
| Phase 4 | Phase 3 (working bridge servers) |

Phase 1 and Phase 2 can be developed in parallel — they share Phase 0 outputs but don't depend on each other.

---

## 9. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (Node.js ≥ 20, ESM) | Matches ecosystem, MCP SDK is TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` | Official MCP TypeScript SDK |
| JWS / JWK library | `jose` | Mature, supports Ed25519 (EdDSA), well-typed |
| JSON Canonicalization | `json-canonicalize` | RFC 8785 / JCS, required by MPAS Core |
| Hash algorithm | SHA-256 via Node.js `crypto` | Default per MPAS Core |
| Key algorithm | Ed25519 (EdDSA) | Minimum required by MVP |
| HTTP client | Node.js built-in `fetch` | No extra dependency, available since Node 18 |
| Test framework | Vitest | Fast, native ESM, good assertion library |
| UUID generation | Node.js `crypto.randomUUID()` | Built-in, no dependency |
| Multibase/Multicodec | `@noble/ed25519` + manual prefix | For `did:key` derivation from Ed25519 public keys |
| JSON Schema validation | `ajv` | For plugin validation (optional, lightweight) |

---

## 10. Package Exports

The published `@oma3/mpas-mcp-bridge` package exports:

```typescript
// Library classes (composable by other MPAS developers)
export { KeyManager } from './lib/key-manager.js';
export { PluginToolGenerator } from './lib/plugin-tool-generator.js';
export { ActionPackageBuilder } from './lib/action-package-builder.js';
export { AdapterClient } from './lib/adapter-client.js';
export { CoordinationClient } from './lib/coordination-client.js';
export { ApprovalBuilder } from './lib/approval-builder.js';

// Bridge server classes
export { ProposerBridge } from './bridges/proposer-bridge.js';
export { MaintainerBridge } from './bridges/maintainer-bridge.js';

// Utilities
export { computeHash, verifyHash } from './utils/hash.js';

// Types
export type {
  ActionPackage,
  ActionEnvelope,
  ExecutionPayload,
  Approval,
  ApprovalBundle,
  AuthorizationRequirements,
  ExecutionReceipt,
  SignerReviewSet,
  MpasApplicationPlugin,
  ProposerConfig,
  MaintainerConfig,
  CombinedConfig,
  AdapterResponse,
  McpToolDefinition,
} from './types/index.js';
```

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| MCP SDK API changes between now and implementation | Pin SDK version. Review SDK changelog before Phase 3. |
| `jose` Ed25519 JWS format doesn't match adapter expectations | Validate interop in Phase 0 with shared test vectors. Use the same `jose` version. |
| `did:key` derivation is tricky (multicodec encoding) | Implement early in Phase 0 with test vectors. Reference the did:key spec directly. |
| Coordination Service API not yet defined (P5 hasn't started) | Code `CoordinationClient` against the MPAS HTTP Profile Section 8 endpoints. These are stable. Mock responses in tests. |
| Plugin schema drifts from official GitHub MCP server tools | Cross-reference official server repo during Task 4.1. Accept that the plugin covers a subset. |
| Shared types not yet extracted to `@oma3/mpas-core-utils` | Duplicate types locally for now. Mark with `// TODO: import from @oma3/mpas-core-utils when published`. |

---

## 12. Coding Agent Guidelines

Each task is designed to be completable by a coding agent in a single session.

1. **Always run tests.** Every task has tests. The task is done when tests pass.
2. **Fixtures are the source of truth.** If implementation disagrees with fixture expectations, the implementation is wrong.
3. **Stay in scope.** Each task targets specific files. Don't refactor unrelated code.
4. **Use existing types.** Types are defined in Task 0.2. Import and use them.
5. **Follow the spec.** `docs/spec.md` is the authoritative reference for behavior.
6. **No secrets in code.** Test keys are fixture data only. Never commit real keys.
7. **One module per task.** Each task maps to one source file or one small set of related files.
8. **Libraries are independent.** `ActionPackageBuilder`, `ApprovalBuilder`, etc. must be usable without `ProposerBridge` or `MaintainerBridge`. Don't couple them to bridge lifecycle.
9. **Mock external services.** Tests against the adapter and coordination service use mock HTTP servers (Vitest `vi.fn` + simple `http.createServer` or MSW). Never depend on running services for unit/component tests.
10. **Use the MCP SDK properly.** Follow the patterns in the official MCP SDK examples for server creation and tool registration. Don't reinvent MCP JSON-RPC handling.
