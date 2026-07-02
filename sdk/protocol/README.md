# @oma3/mpas — MPAS Protocol SDK

TypeScript implementation of MPAS (Multi-Party Action Security) protocol primitives. This is the canonical library for building any MPAS integration — Proposer agents, Verifier/Adapter services, Signer servers, or Coordination Services.

## Organizing Principle

If it's defined by the MPAS specs (core, plugin profile, policy profile, HTTP profile), it belongs here. Implementation choices (HTTP framework, credential storage, dispatch strategy) belong in consumer code.

## What's Inside

### Protocol Types (`types/mpas.ts`)

Complete TypeScript definitions for all MPAS artifacts: ActionPackage, ActionEnvelope, Approval, ApprovalBundle, AuthorizationRequirements, ExecutionReceipt, coordination types, plugin types, HTTP profile types.

### Verification (`lib/verification.ts`)

Parse, validate, and cryptographically verify Action Packages:

- `parseActionPackage` — structural validation
- `validateActionEnvelope` — field validation, DID formats, timestamps, expiry
- `verifyPayloadBinding` — hash binding between payload and envelope
- `verifyApprovalSignature` — JWS signature verification
- `verifyApprovalBundle` — full bundle verification against trusted signers
- `verifyActionPackage` — end-to-end verification pipeline

### Policy Engine (`lib/policy-engine.ts`)

Evaluate JSON policy configurations per the MPAS Policy Profile:

- `evaluatePolicy` — match policies by action name, evaluate conditions, check thresholds
- Supports `allOf`/`anyOf` composition, signer groups, resource restrictions
- Self-approval prevention (proposer excluded from threshold counts)

### Plugin Loader (`lib/plugin-loader.ts`)

- `loadPlugin` — load and schema-validate MPAS Application Plugin JSON
- `validatePayloadAgainstPlugin` — validate Execution Payloads against operation schemas

### Receipt & Auth Requirements (`lib/receipt-builder.ts`, `lib/auth-requirements-builder.ts`)

- `buildAndSignReceipt` — construct and JWS-sign Execution Receipts
- `buildAuthorizationRequirements` — build AuthorizationRequirements from unsatisfied policy rules

### Proposer Primitives (`lib/action-package-builder.ts`, `lib/approval-builder.ts`, `lib/plugin-tool-generator.ts`)

- `ActionPackageBuilder` — construct Action Packages from tool calls
- `ApprovalBuilder` — construct and sign Approval objects
- `PluginToolGenerator` — generate MCP tool definitions from plugin operations

### Protocol Clients (`lib/adapter-client.ts`, `lib/coordination-client.ts`)

- `AdapterClient` — HTTP client for Credential Adapters (`POST /mpas/v1/action`)
- `CoordinationClient` — HTTP client for Coordination Services (submit, poll, approve, cancel)

### Key Management (`lib/key-manager.ts`, `lib/did-key.ts`)

- `KeyManager` — load Ed25519 keys from file, derive `did:key`, sign/verify JWS
- `deriveDidKey`, `generateEd25519Key`, `didKeyToKid` — DID utilities

### MCP Bridge (`bridges/proposer-bridge.ts`)

- `ProposerBridge` — MCP server class that wraps tool calls in MPAS artifacts, submits to adapter, handles coordination flow

### Trace (`lib/trace.ts`)

- `TraceWriter`, `TraceLogger` — structured JSONL trace logging for protocol events

## Usage

```typescript
import {
  verifyActionPackage,
  evaluatePolicy,
  KeyManager,
  ActionPackageBuilder,
  CoordinationClient,
} from "@oma3/mpas";

// Or import specific modules:
import { evaluatePolicy } from "@oma3/mpas/policy-engine";
import { loadPlugin } from "@oma3/mpas/plugin-loader";
import { KeyManager } from "@oma3/mpas/key-manager";
```

## Subpath Exports

Each module is available as a direct import for consumers that want to avoid pulling in the full barrel:

| Import path | Module |
|---|---|
| `@oma3/mpas` | Everything (barrel) |
| `@oma3/mpas/verification` | Verification pipeline |
| `@oma3/mpas/policy-engine` | Policy evaluation |
| `@oma3/mpas/plugin-loader` | Plugin loading & validation |
| `@oma3/mpas/receipt-builder` | Receipt construction |
| `@oma3/mpas/auth-requirements-builder` | Auth requirements |
| `@oma3/mpas/did-key` | DID key utilities |
| `@oma3/mpas/key-manager` | Key management |
| `@oma3/mpas/coordination-client` | Coordination Service client |
| `@oma3/mpas/approval-builder` | Approval construction |
| `@oma3/mpas/hash` | Hash utilities |
| `@oma3/mpas/trace` | Trace logging |

## Building

```sh
npm install
npm run build    # tsc → dist/
npm run test     # vitest
```

## Tests

42 tests covering all proposer-side primitives, hash utilities, bridge integration, and type conformance.
