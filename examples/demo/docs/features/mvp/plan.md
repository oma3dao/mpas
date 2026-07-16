# MPAS Credential Adapter — MVP Implementation Plan

**Status:** Draft  
**Spec:** `docs/features/mvp/spec.md`  
**Target:** macOS (development on M2 Air, testable on a single machine)  
**Language:** TypeScript (Node.js)  
**Approach:** Test-fixture-first, phased delivery, each task completable by a coding agent  
**Overall program plan:** See `mpas-program/mvp-plan.md` for cross-repo orchestration

---

## 1. Scope

This plan covers the Credential Adapter daemon only. It does not cover:

- The MCP Bridge framework (`mpas-sdk/packages/mcp-bridge`) — see that package's own plan.
- The Coordination Service (`mpas-local/src/coordination/`) — see `docs/features/coordination-localhost/plan.md`.
- The multi-agent demo (spans all repos) — see `mpas-program/mvp-plan.md`.

This plan produces a working adapter that:
- Accepts Action Packages via HTTP
- Verifies them per MPAS Core
- Validates payloads against application plugins
- Evaluates policy
- Dispatches approved actions to target MCP servers
- Issues Execution Receipts

---

## 2. Phases

| Phase | Deliverable |
|---|---|
| Phase 0 | Test fixtures, scaffolding, type definitions |
| Phase 1 | Core verification pipeline |
| Phase 2 | Plugin and policy engine |
| Phase 3 | Adapter daemon (HTTP endpoint, config loading, MCP dispatch, receipts) |

---

## 3. Phase 0: Test Fixtures, Scaffolding, and Types

### 3.1 Tasks

#### Task 0.1: Repository scaffolding

Set up the TypeScript project structure:

```
mpas-local/
  package.json              # Node.js project, TypeScript, ESM
  tsconfig.json
  src/
    index.ts                # Daemon entry point (placeholder)
    core/                   # OMA3 protocol logic (extractable to @oma3/mpas-core-utils)
      verification.ts
      policy-engine.ts
      plugin-loader.ts
      receipt-builder.ts
      auth-requirements-builder.ts
      types.ts
    adapter/                # Wivity implementation
      daemon.ts
      config-loader.ts
      credential-provider.ts
      dispatch/
        mcp-stdio.ts
        mcp-http.ts
      http-endpoint.ts
    cli/
      index.ts
  tests/
    fixtures/
    core/
    adapter/
    integration/
  docs/
    features/
```

**Done when:** `npm install` succeeds, `npm run build` compiles with zero errors, `npm test` runs (with zero tests initially).

#### Task 0.2: Neutral MPAS type definitions

Define TypeScript types for all MPAS Core data structures:
- `ExecutionPayload`
- `ActionEnvelope`
- `Approval`
- `ApprovalBundle`
- `ActionPackage`
- `AuthorizationRequirements`
- `ExecutionReceipt`

These types must match the MPAS Core Specification v0.2 field tables exactly.

**Done when:** Types compile. A sample Action Package can be constructed in TypeScript with full type checking.

#### Task 0.3: Test fixtures — valid Action Packages

Create JSON fixture files representing well-formed Action Packages:

| Fixture | Description |
|---|---|
| `valid-no-approval-required.json` | A `create_issue` action with proposer approval only. Policy auto-approves (no threshold rule matches). |
| `valid-two-approvals.json` | A `merge_pull_request` into `main` with proposer + 2 maintainer approvals. Satisfies a threshold-2 policy. |
| `valid-delete-branch.json` | A `delete_branch` with proposer + 1 maintainer approval. Satisfies a threshold-1 policy. |

Each fixture includes:
- A complete Execution Payload (MCP tool-call format)
- A complete Action Envelope (with real computed hashes)
- An Approval Bundle (with JWS signatures from test keys)

**Done when:** Each fixture is valid JSON, hashes are consistent (payload hash in envelope matches actual payload hash), signatures verify against the test keys.

#### Task 0.4: Test fixtures — invalid/edge-case Action Packages

| Fixture | Description | Expected Outcome |
|---|---|---|
| `malformed-missing-envelope.json` | Action Package without Action Envelope | `malformed` |
| `invalid-payload-hash-mismatch.json` | Execution Payload hash doesn't match envelope | `rejected` |
| `invalid-expired-envelope.json` | Action Envelope with `expiresAt` in the past | `rejected` (expired) |
| `invalid-bad-signature.json` | Approval with an invalid JWS signature | `rejected` |
| `insufficient-approvals.json` | Merge into main with only proposer approval (policy needs 2 maintainers) | `additionalApprovalsRequired` |
| `invalid-unknown-application.json` | `target.applicationDid` not in any deployment config | `rejected` (unknown application) |
| `invalid-disabled-operation.json` | Operation exists in plugin but not in `enabledOperations` | `rejected` |

**Done when:** Each fixture is valid JSON with the specific defect described.

#### Task 0.5: Test fixtures — plugins, configs, and keys

Create fixture files for:

| Fixture | File |
|---|---|
| GitHub application plugin | `fixtures/plugins/github-repo.json` |
| Deployment config (auto-approve low-risk) | `fixtures/configs/github-auto-approve.json` |
| Deployment config (require 2 maintainer approvals for merges) | `fixtures/configs/github-strict.json` |
| Test signing keys (Ed25519, 3 key pairs) | `fixtures/test-keys/proposer.json`, `fixtures/test-keys/maintainer-a.json`, `fixtures/test-keys/maintainer-b.json` |
| Adapter signing key | `fixtures/test-keys/adapter.json` |

The plugin must conform to the MPAS Application Plugin Profile v0.2 (operations as an array, credential requirements at top level, no nativeBinding).

**Done when:** Plugin validates against the Application Plugin Profile JSON Schema. Deployment configs reference the plugin correctly. Keys can sign and verify JWS.

#### Task 0.6: Fixture generation script

Create a script (`scripts/generate-fixtures.ts`) that:
- Loads the test keys
- Constructs valid Action Packages programmatically (compute real hashes, produce real signatures)
- Writes the fixture JSON files
- Can regenerate fixtures if the schema changes

This ensures fixtures stay consistent with the types and are not hand-crafted.

**Done when:** Running `npx ts-node scripts/generate-fixtures.ts` produces all fixture files in `tests/fixtures/` and they pass structural validation.

### 3.2 Acceptance Criteria

- [ ] `npm run build` — zero compile errors
- [ ] `npm test` — zero failures (fixtures validate structurally)
- [ ] Fixture hashes are internally consistent (can be verified by a simple check script)
- [ ] Plugin fixture validates against the Application Plugin Profile JSON Schema
- [ ] All fixture Approvals verify against the corresponding test key

---

## 4. Phase 1: Core Verification Pipeline

### 4.1 Tasks

#### Task 1.1: Action Package parser

Implement `parseActionPackage(json: unknown): ActionPackage | ParseError`

- Validates the top-level structure has `executionPayload`, `actionEnvelope`, `approvalBundle`.
- Returns typed ActionPackage or a structured error.

**Done when:** Passes tests against all valid and malformed fixtures.

#### Task 1.2: Action Envelope validation

Implement `validateActionEnvelope(envelope: ActionEnvelope): ValidationResult`

- Checks required fields: `version`, `type`, `actionId`, `target.applicationDid`, `executionProfile.id`, `executionPayloadHash`, `createdAt`, `expiresAt`.
- Checks expiration (`expiresAt` must be in the future).
- Checks `executionProfile.id` is a valid DID.

**Done when:** Passes tests against valid envelopes and expired/malformed envelopes.

#### Task 1.3: Execution Payload hash verification

Implement `verifyPayloadBinding(payload: ExecutionPayload, envelope: ActionEnvelope): boolean`

- Computes SHA-256 hash of JCS-canonicalized Execution Payload.
- Compares to `actionEnvelope.executionPayloadHash`.

**Done when:** Returns `true` for consistent fixtures, `false` for `invalid-payload-hash-mismatch.json`.

#### Task 1.4: JWS signature verification

Implement `verifyApprovalSignature(approval: Approval, publicKey: JsonWebKey): boolean`

- Parses JWS Compact Serialization.
- Verifies signature against provided public key.
- Rejects `alg: none`.
- Supports Ed25519 (`EdDSA`) as the minimum algorithm.

**Done when:** Verifies all valid fixture Approvals, rejects `invalid-bad-signature.json`.

#### Task 1.5: Approval Bundle verification

Implement `verifyApprovalBundle(bundle: ApprovalBundle, envelopeHash: string, trustedSigners: TrustedSigner[]): VerifiedApprovals`

- Computes Action Envelope hash.
- Checks `approvalBundle.actionEnvelopeHash` matches.
- For each Approval: verifies signature, confirms it binds to the envelope hash, confirms signer DID is in `trustedSigners`.
- Returns the set of verified approvals with their signer roles.

**Done when:** Passes for all valid fixtures, fails for bad signatures and hash mismatches.

#### Task 1.6: Dispatch ledger (replay protection)

Implement `DispatchLedger` backed by an append-only journal (Core §6.9). Verification itself is stateless; the ledger only enforces at-most-once dispatch.

- `check(actionId, envelopeHash)` — returns `absent` / `pending` / `reject` (different-hash or resolved).
- `authorizeDispatch(actionId, envelopeHash, expiresAt)` — atomic check-and-write of the `executing` entry.
- `resolve(actionId, result)` — immutable `executing → resolved(executed|failed|indeterminate)`.

**Done when:** First submission is dispatched; an identical resubmission while `executing` returns `pending`; a resolved actionId is rejected as replay; a different envelope hash for a ledgered actionId is rejected.

#### Task 1.7: Full verification pipeline

Compose all above into `verifyActionPackage(pkg: ActionPackage, config: VerificationConfig): VerificationResult`

- Runs all checks in order, statelessly (no replay state inside verification).
- Returns first failure or `verified` with extracted metadata (operation name, verified signers, etc.).

**Done when:** Running the full pipeline against all fixtures produces expected outcomes.

### 4.2 Acceptance Criteria

- [ ] `npm test -- --grep "core/verification"` — all pass
- [ ] Valid fixtures → `verified`
- [ ] Each invalid fixture → specific expected error
- [ ] Dispatch ledger: same actionId dispatched at most once (resolved/different-hash → reject; executing+same-hash → pending)
- [ ] `alg: none` rejected

---

## 5. Phase 2: Plugin and Policy Engine

### 5.1 Tasks

#### Task 2.1: Plugin loader

Implement `loadPlugin(path: string): MpasApplicationPlugin | LoadError`

- Reads JSON file.
- Validates against the Application Plugin Profile JSON Schema.
- Returns typed plugin object or error.

**Done when:** Loads valid plugin fixture successfully, rejects malformed plugin JSON.

#### Task 2.2: Plugin schema validator

Implement `validatePayloadAgainstPlugin(payload: ExecutionPayload, plugin: MpasApplicationPlugin): OperationMatch | ValidationError`

- Finds the operation in the plugin's `operations` array whose `name` matches the payload's `/name` field.
- Validates the full payload against that operation's `executionPayloadSchema`.
- Returns the matched operation or a validation error.

**Done when:** Valid payloads match and validate. Unknown operations rejected. Malformed arguments rejected.

#### Task 2.3: Policy evaluation engine

Implement `evaluatePolicy(pkg: ActionPackage, verifiedApprovals: VerifiedApprovals, policy: PolicyConfig): PolicyResult`

Where `PolicyResult` is:
- `satisfied` — execution may proceed
- `additionalApprovalsRequired` — with Authorization Requirements object
- `denied` — definitively rejected (operation disabled, resource restricted, etc.)

Policy evaluation:
- Iterate rules.
- For each rule whose `match.conditions` all evaluate true against the Execution Payload:
  - Check whether `verifiedApprovals` satisfy the rule's `requirements` (count by role, check threshold).
- If a matching rule is not satisfied, return `additionalApprovalsRequired` with details.
- If no rules match and `defaultPolicy` is `deny`, return `denied`.
- If no rules match and `defaultPolicy` is `allow`, return `satisfied`.

**Done when:**
- `valid-no-approval-required.json` + auto-approve config → `satisfied`
- `insufficient-approvals.json` + strict config → `additionalApprovalsRequired` with correct threshold info
- `valid-two-approvals.json` + strict config → `satisfied`
- Disabled operation → `denied`
- Resource restriction violated → `denied`

#### Task 2.4: Authorization Requirements builder

Implement `buildAuthorizationRequirements(envelope: ActionEnvelope, unsatisfiedRules: UnsatisfiedRule[], adapterDid: string): AuthorizationRequirements`

- Builds a standards-compliant Authorization Requirements object per MPAS Core Section 5.8.
- Binds to the Action Envelope hash.
- Includes threshold requirements with eligible signer DIDs.

**Done when:** Output validates against the MPAS Core Authorization Requirements structure.

### 5.2 Acceptance Criteria

- [ ] `npm test -- --grep "core/policy"` — all pass
- [ ] Plugin loader accepts valid plugins, rejects invalid
- [ ] Policy engine produces correct results for all fixture combinations
- [ ] Authorization Requirements are well-formed and bound to correct hashes

---

## 6. Phase 3: Adapter Daemon

### 6.1 Tasks

#### Task 3.1: Deployment config loader

Implement `loadDeploymentConfigs(configDir: string): Map<string, DeploymentConfig>`

- Reads all JSON files in `~/.mpas/config/`.
- Validates each against the deployment config schema.
- Indexes by `target.applicationDid` for fast lookup.
- Verifies each config's plugin reference (loads plugin, checks artifact hash).

**Done when:** Loads fixture configs. Rejects configs with missing plugins or hash mismatches.

#### Task 3.2: Credential provider — file-based

Implement `FileCredentialProvider`

- Reads credentials from `~/.mpas/credentials/<handle>.json` (simple `{ "value": "..." }` files).
- Returns the credential value for dispatch.
- Files should be `chmod 600` (user-only read).

**Done when:** Resolves handles that exist, returns error for missing handles.

#### Task 3.3: MCP stdio dispatch

Implement `dispatchMcpStdio(target: McpStdioTarget, toolName: string, args: object, credential: string): McpResult`

- Spawns the MCP server process with configured command/args/env.
- Injects credentials into the process environment using the `{{credential:handle}}` resolution.
- Sends a `tools/call` JSON-RPC request over stdio.
- Reads the response.
- Manages process lifecycle (start on first call, reuse for subsequent calls, shutdown on daemon stop).

**Done when:** Can call a real MCP server (e.g., a simple echo MCP server test fixture) and get a response.

#### Task 3.4: MCP HTTP dispatch

Implement `dispatchMcpHttp(target: McpHttpTarget, toolName: string, args: object, credential: string): McpResult`

- Connects to the HTTP/SSE MCP endpoint.
- Sends a `tools/call` request.
- Returns the response.

**Done when:** Can call an HTTP MCP server and get a response.

#### Task 3.5: Execution Receipt builder and signer

Implement `buildAndSignReceipt(envelope: ActionEnvelope, payload: ExecutionPayload, result: ReceiptResult, adapterDid: string, signingKey: JsonWebKey): ExecutionReceipt`

- Constructs receipt payload per MPAS Core Section 5.9.
- Computes `actionEnvelopeHash` and `executionPayloadHash`.
- Signs as JWS with the adapter's key.

**Done when:** Produced receipts verify against the adapter's public key. All required fields present.

#### Task 3.6: HTTP endpoint

Implement the HTTP server (Fastify or Express):

- `POST /mpas/v1/action` — accepts an `ActionRequest` (wrapping the Action Package), runs full pipeline, returns an `ActionResponse` (receipt or auth requirements).
- `GET /mpas/v1/health` — returns adapter status.

Full pipeline integration:
1. Parse the ActionRequest / Action Package
2. Look up deployment config by `target.applicationDid`
3. Dispatch-ledger check (Core §6.9); stateless verification (core verification pipeline)
4. Validate payload against plugin
5. Check resource restrictions
6. Evaluate policy
7. If satisfied: resolve credential and launch/connect target (pre-ledger), write `executing`, dispatch MCP `tools/call`, build receipt, resolve the ledger entry
8. Return the `ActionResponse`

**Done when:** Can `curl -X POST http://localhost:7544/mpas/v1/action -H 'content-type: application/mpas+json' -d @fixtures/valid-no-approval-required.json` and get a valid `ActionResponse` with a receipt.

#### Task 3.8: CLI — daemon and testing

Implement:
- `mpas daemon start` — starts the HTTP server in the foreground, loads all configs and plugins.
- `mpas daemon status` — shows loaded configs and listen address.
- `mpas test submit <file>` — submits a fixture file to the running daemon.
- `mpas test dry-run <file>` — verifies and evaluates policy without dispatching.

**Done when:** Daemon starts, loads configs, responds to health check and action submissions.

#### Task 3.9: CLI — plugin and credential management

Implement:
- `mpas plugin install <path>` — validates and copies plugin to `~/.mpas/plugins/`.
- `mpas plugin list` — lists installed plugins.
- `mpas credential set <handle>` — prompts for credential value, stores in `~/.mpas/credentials/`.
- `mpas credential list` — lists handles without showing values.
- `mpas config validate <name>` — validates a deployment config (checks plugin ref, credential handles).

**Done when:** Can install a plugin, set a credential, validate a config, and have the daemon use them.

#### Task 3.10: Dispatch timeout and ledger hardening

Harden the dispatch layer and dispatch ledger for sustained daemon operation:

**Dispatch timeout:**
- Accept an optional `timeoutMs` from the deployment config's `executionTarget` (default: 30000 ms).
- For stdio dispatch: if the child process does not respond within `timeoutMs`, reject the pending promise, kill the child process, and return an `McpError` with code `DISPATCH_TIMEOUT`.
- For HTTP dispatch: pass an `AbortSignal` with the configured timeout to the `fetch` call.
- On timeout, the adapter resolves the ledger entry and returns a receipt with result `indeterminate` (outcome unconfirmed), not `failed`.

**Dispatch ledger durability and retention:**
- Persist `executing` and `resolved` events to an append-only JSONL journal; `executing` is fsync'd before transmission (write-ahead).
- On restart, recover orphan `executing` entries as `indeterminate` (idempotent) and never re-dispatch.
- Reject any Action Package whose `expiresAt − now` exceeds the configurable maximum envelope validity window (default: 24 hours); retain ledger entries until `expiresAt` plus clock-skew tolerance. The journal MUST NOT grow without bound under sustained load.

**Done when:**
- A slow echo MCP server fixture (that sleeps > timeout) resolves as `indeterminate`. Normal-speed fixtures still pass.
- A simulated restart with an orphan `executing` entry recovers as `indeterminate` without re-dispatching (verified by unit test).

### 6.2 Acceptance Criteria

- [ ] Daemon starts and responds to `GET /mpas/v1/health`
- [ ] Dispatch timeout fires for unresponsive MCP servers (receipt with result `indeterminate`)
- [ ] Dispatch ledger enforces at-most-once dispatch; `executing` records survive restart and recover as `indeterminate`; entries retained until `expiresAt` + skew
- [ ] `valid-no-approval-required.json` → 200 `ActionResponse` with receipt (result: `executed`) against a test MCP server
- [ ] `insufficient-approvals.json` → 200 with `additionalApprovalsRequired`
- [ ] `valid-two-approvals.json` → 200 with receipt (result: `executed`)
- [ ] All invalid fixtures → appropriate rejection responses
- [ ] Credential handle not found → stateless `rejected` (no receipt, no ledger entry; pre-ledger preparation failure)
- [ ] Duplicate action ID → rejected (replay)
- [ ] Resource restriction violated → rejected
- [ ] Plugin hash mismatch on load → daemon refuses to start config
- [ ] `mpas test submit` and `mpas test dry-run` work against fixtures

---

## 7. Dependencies

| Phase | Depends On |
|---|---|
| Phase 0 | Nothing (first) |
| Phase 1 | Phase 0 (types and fixtures) |
| Phase 2 | Phase 1 (verification pipeline) |
| Phase 3 | Phase 1 + Phase 2 (full pipeline) |

---

## 8. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (Node.js, ESM) | Comfortable for developer, excellent AI agent support, cross-platform |
| HTTP framework | Fastify | Fast, typed, good DX |
| JWS library | `jose` | Mature, supports Ed25519, well-typed |
| JSON Schema validation | `ajv` | Standard, fast, supports draft 2020-12 |
| JSON Canonicalization | `json-canonicalize` (RFC 8785 / JCS) | Required by MPAS Core for hash computation |
| Hash algorithm | SHA-256 | Default per MPAS Core |
| Signing algorithm | Ed25519 (EdDSA) | Minimum required by MVP |
| MCP SDK | `@modelcontextprotocol/sdk` | Official MCP TypeScript SDK |
| Test framework | Vitest | Fast, native ESM, good assertion library |
| Credential storage (MVP) | File-based (`~/.mpas/credentials/`) | Simple, no platform dependencies. Keychain integration deferred. |
| Process management | Node.js child_process | For MCP stdio server spawning |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| MCP SDK doesn't support all needed patterns (stdio management, tool registration) | Evaluate SDK early in Phase 3. Fall back to raw JSON-RPC if needed. |
| JWS/Ed25519 interop between bridge and adapter | Use `jose` library consistently. Define test vectors in Phase 0. |
| Fixture generation is complex (real hashes, real signatures) | Build generation script in Phase 0 so fixtures are always consistent. |
| Integration with MCP bridge requires aligned types | Share types via `@oma3/mpas-core-utils` or publish them early. |

---

## 10. Coding Agent Guidelines

Each task is designed to be completable by a coding agent (Codex, Claude) in a single session. Guidelines for handoff:

1. **Always run tests.** Every task has tests. The task is done when tests pass.
2. **Fixtures are the source of truth.** If implementation disagrees with fixture expectations, the implementation is wrong.
3. **Stay in scope.** Each task has a specific module and specific tests. Don't refactor unrelated code.
4. **Use existing types.** Types are defined in Phase 0. Import and use them, don't redefine.
5. **Follow the spec.** `docs/features/mvp/spec.md` is the authoritative reference for behavior.
6. **No secrets in code.** Test keys are fixture data. Real credentials are never committed.
7. **One module per task.** Each task maps to one file or one small set of related files. Keep boundaries clean.
