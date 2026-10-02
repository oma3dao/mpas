# @oma3/mpas — MPAS Protocol SDK

TypeScript implementation of MPAS (Multi-Party Action Security) protocol primitives. This is the canonical library for building any MPAS integration — Proposer agents, Verifier services, Signer servers, or Coordination Services.

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

- `buildAndSignExecutionReceipt` — construct and JWS-sign Execution Receipts
- `buildAuthorizationRequirements` — build AuthorizationRequirements from unsatisfied policy rules

### Verifier Dispatch Ledger (`lib/dispatch-ledger.ts`)

Import `DispatchLedger` and `MemoryDispatchStore` from `@oma3/mpas`. The portable
ledger implements Core section 6.9; it is separate from proposer workflow state.
The public barrel also exports `DispatchStore`, `DispatchRecord`,
`DispatchResolution`, `DispatchRecovery`, `LedgerCheck`, `serializeDispatchRecord`
and `parseDispatchRecord`. No SQLite dependency or dispatch subpath is required.

```typescript
import { DispatchLedger, type DispatchStore } from "@oma3/mpas";

declare const durableStore: DispatchStore;
const ledger = new DispatchLedger(durableStore, Date.now, 0);
// At host restart only, after all prior dispatch workers have stopped:
ledger.recoverExecuting();
// Stop accepting work and drain current dispatches before shutdown:
ledger.close();
```

The constructor accepts a synchronous store, trusted clock, and trusted finite
nonnegative timestamp tolerance in milliseconds. Its default memory store is
for tests or explicitly ephemeral use: it cannot survive a process restart.
Opening another connection does not recover live work. The host, not the
store, owns the stopped-worker precondition for `recoverExecuting()`.

- `check(actionId, envelopeHash)` is advisory. Only `absent` returned from
  `authorizeDispatch(actionId, envelopeHash, expiresAt)` grants transmission.
  Call it after verification and side-effect-free target preparation, directly
  before transmission. An atomic unique insert chooses the sole winner.
- Replay identity is the complete Action ID, canonically encoded as JSON.
  Pass the complete `HashObject`, including its algorithm. Same-hash executing
  Actions are pending; a different hash is rejected; any resolved Action is replay.
- `resolve(actionId, resolution, response?)` returns the immutable winning record
  or undefined for an unknown Action. A response must match both the original
  full hash and result. The first resolution wins; a missing response can be
  attached once to that same result. Return the winning persisted response,
  not a locally produced response that lost a comparison race.
- `recoveryFor(actionId, envelopeHash)` returns copied internal recovery data.
  Public replay still rejects. Startup recovery durably marks executing records
  indeterminate and never grants retransmission, even when no target call occurred.
- `prune()` is explicit: it removes only resolved records strictly after expiry
  plus tolerance, using compare-and-delete. Equality, live executing records,
  and responses still in their recovery interval are retained. `size()` counts
  validated records. Invalid or overflowed timestamps fail closed.

Stores implement atomic `get`, `insertIfAbsent`, `compareAndSwap`, `entries`,
`deleteIfMatch` and `close`. Successful mutations must be durable before return;
comparison conflicts return false and I/O failures throw. Storage failure before
grant means close prepared resources and transmit nothing. Failure after
transmission must not expose an unpersisted terminal response or permit a retry.

Stored values are closed, versioned canonical JSON records. Parsers reject raw
duplicate members, noncanonical bytes, bad timestamps, unknown fields and invalid
response bindings; corrupt data must never be treated as an empty store. Returned
objects do not alias stored data. Storage validation is not receipt verification:
consumers still use `verifyExecutionReceipt` with their expected trust context.
The demo supplies a durable SQLite `DispatchStore` and documents its runtime and
operator requirements in [its README](../../examples/demo/README.md#durable-dispatch-storage).

### Proposer Primitives (`lib/action-package-builder.ts`, `lib/approval-builder.ts`)

- `ActionPackageBuilder` — construct Action Packages from tool calls
- `ApprovalBuilder` — construct and sign Approval objects

### Protocol Clients (`lib/action-endpoint-client.ts`, `lib/action-relay-client.ts`, `lib/adapter-client.ts`, `lib/coordination-client.ts`)

- `ActionEndpointClient` — common signed client for a Verifier or Action Relay `/verifier/action` endpoint
- `ActionRelayClient` — participant-bound relay Action submission, delivery polling, response delivery, and notifications
- `CredentialAdapterClient` — common Action submission plus adapter-specific operations such as health checks
- `CoordinationServiceClient` — client of Coordination Service workflow, approval, polling, cancellation, and notifications

Deprecated `AdapterClient` and `CoordinationClient` compatibility names remain for
the published alpha API. New integrations should use the canonical names above.

### Routing (`lib/routing.ts`)

- `parseDeliveryEnvelope` and typed Action request/response envelope parsers
- `buildDeliveryEnvelope`, recipient membership, and expiration helpers
- body/header idempotency resolution and request fingerprinting

### Key Management (`lib/key-manager.ts`, `lib/did-key.ts`)

- `KeyManager` — load Ed25519 or P-256 keys, preserve `did:jwk`, sign/verify JWS and raw bytes
- `deriveDidJwk`, `didJwkToJwk`, `didJwkToKid`, `generateEd25519Key`, `generateP256Key`, `generateMpasKey` — DID and key utilities

### Proposer Bridge Runtime (`lib/bridge-runtime.ts`, `lib/mcp-protocol-server.ts`, `lib/mcp-tasks-server.ts`, `lib/mcp-compatibility-server.ts`, `lib/workflow-engine.ts`, `lib/workflow-store.ts`)

Build asynchronous proposer bridges with wire-level detection for MCP 2026-07-28
Tasks clients and conventional MCP clients:

- `MpasProtocolServer` — single transport owner that locks each connection to Tasks or compatibility mode from its handshake
- `MpasTasksServer` — MCP discovery, exact upstream tools, and official `tasks/*` operations
- `MpasCompatibilityServer` — conventional initialization, deferred results, and `mpas_wait_for_action_result`
- `ProposerBridge` — creates Actions and maps one durable MPAS workflow to either client presentation
- `BridgeWorkflowEngine` — background workflow: initial Action submission, replacement-Action coordination, completed Action submission, and restart recovery
- `WorkflowStore`, `MemoryWorkflowStore` — durable-store contract and in-memory reference (no database dependency)

A proposer bridge is dedicated to one MCP client or agent identity and holds
one private key for one proposer DID. Independent clients require independent
bridge instances, keys, DIDs, and workflow authorization contexts.

### Bridge Generation

Static MCP bridges are generated outside the runtime SDK by the top-level
`bridge-generator/` package. Generated bridges import these SDK primitives
but define their MCP tool surface from the upstream server, not from plugin
policy metadata.

### Trace (`lib/trace.ts`)

- `TraceWriter`, `TraceLogger` — structured JSONL trace logging for protocol events

## Usage

Install the current alpha release:

```sh
npm install @oma3/mpas@alpha
```

```typescript
import {
  verifyActionPackage,
  evaluatePolicy,
  KeyManager,
  ActionPackageBuilder,
  CoordinationServiceClient,
} from "@oma3/mpas";

// Or import specific modules:
import { evaluatePolicy } from "@oma3/mpas/policy-engine";
import { loadPlugin } from "@oma3/mpas/plugin-loader";
import { KeyManager } from "@oma3/mpas/key-manager";
```

## Public API Conventions

- Clients are named for the remote service or endpoint they call, not for the actor using them.
- Client methods perform I/O with constructor-bound endpoint, signer, timeout, and transport state.
- Stateless protocol operations are verb-first functions such as `build`, `parse`, `validate`, `verify`, `compute`, `is`, and `has`.
- A primary artifact is the first parameter; optional behavior and multi-field submissions use named input objects.
- Deprecated alpha names are compatibility wrappers. New code and examples use only canonical APIs.
- Public runtime APIs include JSDoc describing protocol scope, side effects, identity behavior, and errors.

## Alpha 11 WorkflowStore Migration

Alpha 11 changes the proposer-bridge workflow contract. Custom `WorkflowStore`
implementations must be updated before adopting this release:

- `taskId` is a stable bridge/MCP Task identifier and must be distinct from
  every current or retired MPAS Action ID.
- `CreateWorkflowInput`, `ReplaceWorkflowActionInput`, and `WorkflowRecord`
  carry `actionIdempotencyKey`. Store it durably with the current Action and
  replace it atomically when `replaceAction` installs A2 or a later Action.
- Implement `replaceAction` and `getWorkflowByActionId`. Preserve aliases for
  retired Action IDs so compatibility lookups continue to resolve the stable
  Task.
- Reject duplicate Action IDs and reject `taskId === actionId`. Retries of one
  Action must reuse its stored idempotency key; a replacement Action must use a
  new key.

## Routing and Delivery

The routing API supports two Action topologies with the same Verifier-authored
`ActionResponse`:

| Topology | Request accepted by `/mpas/v1/verifier/action` | Client behavior |
|---|---|---|
| Direct Verifier | Bare `ActionRequest` or `DeliveryEnvelope<ActionRequest>` | The Verifier processes and returns its response directly. |
| Action Relay | `DeliveryEnvelope<ActionRequest>` | The call waits for the designated Verifier's first response. |

Here, Verifier covers both a native MPAS Application and a Credential Adapter.
Credential Adapter terminology is used only for adapter-specific behavior.

The Delivery Envelope is an outer routing layer. Parse it first, then pass its
payload to the parser and verification pipeline for that payload type. Recipient
membership grants delivery only; it does not make a recipient a Verifier or Signer.
See the [MPAS HTTP Profile](../../specs/mpas-profile-http.md#6-common-action-interface)
for the normative protocol behavior.

### Submit an Action directly

Build the inner Action message, then submit it to a directly reachable Verifier:

```typescript
import { randomUUID } from "node:crypto";
import {
  ActionEndpointClient,
  KeyManager,
  buildActionRequest,
  type ActionPackage,
} from "@oma3/mpas";

const proposerSigner = await KeyManager.fromFile("./proposer-key.json");
declare const actionPackage: ActionPackage;

const verifier = new ActionEndpointClient({
  url: "https://verifier.example.com",
  signer: proposerSigner,
});

const request = buildActionRequest({
  actionPackage,
  idempotencyKey: randomUUID(),
});

const response = await verifier.submitActionRequest(request);
```

The client adds the HTTP audience to the outer request body and creates a fresh
RFC 9421 nonce. If a transport retry is needed, reuse the same body-level
`idempotencyKey` and Action content; the client generates a new signature and nonce.

### Submit an envelope through an Action Relay

Wrap that same `ActionRequest` in a Delivery Envelope when routing metadata is
needed. The configured Verifier DID must occur in the recipient list, but it does
not have to be the only recipient:

```typescript
import {
  ActionRelayClient,
  buildActionRequest,
  buildDeliveryEnvelope,
  type ActionPackage,
  type Did,
  type MpasRfc9421Signer,
} from "@oma3/mpas";

declare const actionPackage: ActionPackage;
declare const proposerSigner: MpasRfc9421Signer;

const verifierDid = "did:jwk:...verifier..." as Did;
const auditRecipientDid = "did:jwk:...audit..." as Did;

const relay = new ActionRelayClient({
  url: "https://relay.example.com",
  signer: proposerSigner,
});

const request = buildActionRequest({
  actionPackage,
  idempotencyKey: "stable-key-for-this-action-submission",
});
const envelope = buildDeliveryEnvelope({
  sender: actionPackage.actionEnvelope.proposer.did,
  recipients: [verifierDid, auditRecipientDid],
  payload: request,
});
const response = await relay.submitAction(envelope);
```

A directly reachable Verifier is not automatically responsible for forwarding the
envelope to the other recipients. An Action Relay creates independent
delivery obligations for every recipient authorized by its policy.

For an idempotent retry, keep the same sender, recipient set, and Action content.
The envelope may be rebuilt with fresh `createdAt`, `expiresAt`, and `audience`
metadata; those transport fields do not change equivalence. The first accepted
envelope remains authoritative, so rebuilding does not extend its stored expiry.

When a direct or relayed Verifier returns `additionalApprovalsRequired` for A1,
retire A1 and construct replacement Action A2. A2 has a new Action ID, Action
Envelope hash, expiration, and Proposer Approval. Submit A2 and Proposer-authored,
A2-bound requirements through the coordination workflow:

```typescript
import { ActionPackageBuilder, CoordinationServiceClient } from "@oma3/mpas";

if (response.result === "additionalApprovalsRequired" &&
    response.authorizationRequirements) {
  const coordination = new CoordinationServiceClient({
    url: "https://coordination.example.com",
    signer: proposerSigner,
  });
  const builder = new ActionPackageBuilder({
    applicationDid,
    executionProfile,
    keyManager,
  });
  const replacement = await builder.buildCoordinationReplacement(
    actionPackage,
    response.authorizationRequirements,
  );
  await coordination.createApprovalWorkflow({
    actionPackage: replacement.actionPackage,
    authorizationRequirements: replacement.authorizationRequirements,
    idempotencyKey: "stable-key-for-coordination-submission",
  });
}
```

The Action endpoint and Coordination Service are independent. Receiving the relay
response never creates a workflow; the explicit call above does. A completed A2
package returned in `readyForSubmission` is A2's first Action-endpoint submission,
not a retry of A1. A bridge may keep one stable local MCP Task ID across A1, A2,
and any later replacements, but that Task ID is not an MPAS Action correlation key.
`createApprovalWorkflow` uses `/mpas/v1/coordination/workflow`. The deprecated
`submitAction` method uses the temporary `/mpas/v1/coordination/action` alias for
migration compatibility; `submitActionForCoordination` is a deprecated source-level
alias that uses the canonical workflow endpoint.

### Build and parse Delivery Envelopes

`parseDeliveryEnvelope` validates only the outer routing layer. Use a typed
payload parser after inspecting the payload discriminant:

```typescript
import {
  buildDeliveryEnvelope,
  parseActionRequestEnvelope,
  parseDeliveryEnvelope,
  type ActionRequest,
  type Did,
} from "@oma3/mpas";

declare const proposerDid: Did;
declare const verifierDid: Did;
declare const actionRequest: ActionRequest;
declare const received: unknown;

const outgoing = buildDeliveryEnvelope({
  sender: proposerDid,
  recipients: [verifierDid],
  payload: actionRequest,
});

const outer = parseDeliveryEnvelope(received);
if (outer.payload !== null &&
    !Array.isArray(outer.payload) &&
    typeof outer.payload === "object" &&
    outer.payload.type === "ActionRequest") {
  const typed = parseActionRequestEnvelope(received);
  // Continue with the existing Action Package verification pipeline.
}
```

The envelope has no idempotency key. Action-processing idempotency stays inside
the enclosed `ActionRequest`.

### Evaluate approval progress

Coordination Services can use `evaluateApprovalRequirements` to derive a
non-authoritative workflow state from immutable Signer decisions:

```typescript
import {
  evaluateApprovalRequirements,
  type AuthorizationRequirements,
} from "@oma3/mpas";

declare const authorizationRequirements: Extract<
  AuthorizationRequirements,
  { result: "additionalApprovalsRequired" }
>;
const status = evaluateApprovalRequirements(authorizationRequirements.approvalRequirements, [
  { signerDid: "did:jwk:...alice...", decision: "approve" },
  { signerDid: "did:jwk:...bob...", decision: "reject" },
]);
// status: "satisfied" | "pending" | "unreachable"
```

The first decision for a Signer DID and Action Envelope is final. The helper
throws if its input contains conflicting decisions for one Signer. It does not
verify Approval signatures and does not replace the Verifier's policy evaluation.

### Poll and return Verifier deliveries

Polling and response delivery are separate operations. The SDK removes the routing
layer, while the Verifier retains control of Action processing and response recipients:

```typescript
import {
  ActionRelayClient,
  KeyManager,
  buildDeliveryEnvelope,
  parseActionRequestEnvelope,
  type ActionRequest,
  type ActionResponse,
  type Did,
} from "@oma3/mpas";

const verifierSigner = await KeyManager.fromFile("./verifier-key.json");
const relay = new ActionRelayClient({
  url: "https://relay.example.com",
  signer: verifierSigner,
});

declare function processAction(request: ActionRequest): Promise<ActionResponse>;
declare function saveCursor(cursor: string | undefined): Promise<void>;

const page = await relay.pollDeliveries();
for (const delivery of page.deliveries) {
  if (typeof delivery.payload !== "object" ||
      delivery.payload === null ||
      Array.isArray(delivery.payload) ||
      delivery.payload.type !== "ActionRequest") continue;
  const incoming = parseActionRequestEnvelope(delivery);
  const response = await processAction(incoming.payload);
  await relay.submitActionResponse(buildDeliveryEnvelope({
    sender: verifierSigner.did,
    recipients: [incoming.payload.actionPackage.actionEnvelope.proposer.did],
    payload: response,
  }));
}

// Persist only after the page and submitted responses are durably accepted.
await saveCursor(page.nextCursor);
```

The Action Relay authorizes every requested response recipient. The SDK
does not impose deployment recipient policy.

For continuous short polling, use `runPollLoop`. Its cursor advances only after
`onPage` completes successfully.

### WebSocket work notifications

Action Relay WebSockets carry `RelayWorkAvailable`, never an MPAS payload. A native or
server-side socket adapter must use the exact returned URL and apply the supplied
`Authorization` header to the HTTP upgrade. For example, with the `ws` package:

```typescript
import WebSocket from "ws";
import {
  ActionRelayClient,
  KeyManager,
  type ActionRelayWebSocket,
} from "@oma3/mpas";

const participantSigner = await KeyManager.fromFile("./participant-key.json");
const relay = new ActionRelayClient({
  url: "https://relay.example.com",
  signer: participantSigner,
  webSocketFactory: ({ url, headers }) =>
    new WebSocket(url, { headers: { ...headers } }) as unknown as ActionRelayWebSocket,
});

declare function processPollPage(page: unknown): Promise<void>;

const connection = await relay.connectNotificationsAndPoll({
  onPage: async (page) => {
    await processPollPage(page);
  },
  onError: async (error) => {
    console.error("Notification-triggered poll failed", error);
  },
});

// A disconnected socket needs a new session ticket and connection.
connection.socket.close();
```

Polling remains authoritative and interoperable without WebSockets. Browser
WebSocket APIs cannot set the required upgrade `Authorization` header directly;
browser-facing applications normally use a native wrapper or an application
session managed by their deployment.

### Routing API reference

| API | Purpose |
|---|---|
| `buildActionRequest` | Build and validate the inner Action HTTP message. |
| `ActionEndpointClient.submitActionRequest` | Submit a pre-built bare or enveloped Action request. |
| `ActionRelayClient.submitAction` | Submit a canonical enveloped Action and receive the Verifier response. |
| `ActionRelayClient.pollDeliveries` | Retrieve relay-only Delivery Envelopes. |
| `ActionRelayClient.submitActionResponse` | Submit a Verifier response envelope to the relay. |
| `buildDeliveryEnvelope` | Build and validate routing metadata without interpreting payload semantics. |
| `parseDeliveryEnvelope` | Parse only the outer routing layer. |
| `parseActionRequest` | Parse the Action HTTP wrapper without replacing full package verification. |
| `parseActionRequestEnvelope` | Parse an envelope followed by its `ActionRequest` payload. |
| `parseActionResponse` | Parse the Action response discriminants. |
| `parseActionResponseEnvelope` | Parse an envelope followed by its `ActionResponse` payload. |
| `parseRelayPollResponse` | Parse a relay delivery page and its outer envelopes. |
| `parseRelayDeliveryResponse` | Parse a durable relay-delivery acknowledgement. |
| `parseCoordinationSessionResponse` | Parse notification session connection parameters. |
| `parseCoordinationWorkAvailable` | Parse the payload-free WebSocket frame. |
| `hasDeliveryEnvelopeRecipient` | Test explicit recipient membership. |
| `isDeliveryEnvelopeExpired` | Test the optional retrieval deadline. |
| `validateIdempotencyKey` | Validate the body-level idempotency key limit. |
| `resolveIdempotencyKey` | Resolve body idempotency with header fallback and mismatch detection. |
| `computeIdempotencyFingerprint` | Compute request equivalence without the idempotency key itself. |
| `evaluateApprovalRequirements` | Evaluate immutable Signer decisions as satisfied, pending, or unreachable coordination state. |
| `CoordinationServiceClient.createApprovalWorkflow` | Create an approval workflow after direct Verifier evaluation. |
| `CoordinationServiceClient.pollWork` | Retrieve Approval Requests and action updates. |
| `CoordinationServiceClient.submitApproval` | Submit a body-idempotent Signer Approval. |
| `CoordinationServiceClient.cancelAction` | Cancel a pending workflow with body idempotency. |
| `CoordinationServiceClient.createNotificationSession` | Obtain a one-use WebSocket upgrade ticket. |
| `CoordinationServiceClient.connectWorkNotifications` | Open a notification-only socket. |
| `CoordinationServiceClient.connectNotificationsAndPoll` | Poll whenever a work notification arrives. |
| `CoordinationServiceClient.runPollLoop` | Run cancellable short polling without WebSockets. |

Routing parsers throw `RoutingValidationError`. Action HTTP failures use
`ActionEndpointClientError`. Coordination calls distinguish authentication failures
(`MpasAuthError`), retryable availability failures (`CoordinationUnavailableError`),
and invalid or rejected responses (`CoordinationResponseError`).

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
| `@oma3/mpas/did-jwk` | DID JWK utilities |
| `@oma3/mpas/key-manager` | Key management |
| `@oma3/mpas/coordination-service-client` | Coordination Service client |
| `@oma3/mpas/coordination-client` | Deprecated Coordination Service client import |
| `@oma3/mpas/action-endpoint-client` | Common Action endpoint client |
| `@oma3/mpas/action-relay-client` | Action Relay client |
| `@oma3/mpas/credential-adapter-client` | Credential Adapter-specific client |
| `@oma3/mpas/routing` | Delivery Envelope and idempotency helpers |
| `@oma3/mpas/approval-builder` | Approval construction |
| `@oma3/mpas/approval-requirements` | Coordination-side approval expression evaluation |
| `@oma3/mpas/hash` | Hash utilities |
| `@oma3/mpas/trace` | Trace logging |

## Building

```sh
npm install
npm run build    # tsc → dist/
npm run test     # vitest
```

For local development before publishing a release, consumers can install this
directory directly:

```sh
npm install /path/to/mpas/sdk/protocol
```

## Releasing

Maintainer release instructions are documented in
[RELEASING.md](https://github.com/oma3dao/mpas/blob/main/sdk/protocol/RELEASING.md).

## Tests

Tests cover proposer-side primitives, hash utilities, bridge integration, verification, and type conformance.

## Future Package Split

When there is a concrete trigger — a third-party Verifier or Coordination
Service that needs protocol types without the MCP server stack, or the protocol
API stabilizing enough that breaking revs become rare — the SDK should split
along the **construct/sign vs. transport/verify** boundary:

**Signer/construct side** (future `@oma3/mpas-signer`): `approval-builder`,
`action-package-builder`, `key-manager`, `bridge-runtime`, `bridge-tasks`,
`bridge-compatibility`, `workflow-engine`, `workflow-store`, and the `mcp-*`
server modules.

**Protocol side** (stays in `@oma3/mpas`): types, `routing`, `rfc9421`,
`verification`, `receipt-builder`, `coordination-client`,
`action-endpoint-client`, `action-relay-client`, `adapter-client`,
`policy-engine`.

`approval-builder` is a clean leaf — nothing in `sdk/protocol` imports it, and
`verification.ts` does not need it. The dividing line is whether the module
constructs and signs artifacts (signer side) or transports and verifies them
(protocol side).


## Signature suites and signer providers

Version `0.1.0-alpha.13` adds P-256/ES256 alongside Ed25519/EdDSA. Every verifier
supports both; there is no verifier suite allow-list. Signing configuration
selects a key/suite, and unknown or mismatched selections fail closed.
Ed25519 remains the default for key generation.

```ts
import {
  generateP256Key, KeyManager, ApprovalBuilder, buildAndSignExecutionReceipt,
  verifyExecutionReceipt,
} from "@oma3/mpas";

const key = await generateP256Key();
const signer = KeyManager.fromJwk(key.privateJwk, { suite: "P-256" });
const publicOnly = KeyManager.fromJwk(key.publicJwk);
const approvalBuilder = new ApprovalBuilder({ signer });
// With an existing Action Envelope and its exact Execution Payload:
const approval = await approvalBuilder.buildApproval(actionEnvelope, "approve");
const receipt = await buildAndSignExecutionReceipt({
  signer, verifierDid: signer.did, actionEnvelope, executionPayload,
  result: { result: "executed" },
});
const valid = await verifyExecutionReceipt(receipt, {
  verifier: { did: signer.did }, actionEnvelope, executionPayload,
});
```

`KeyManager.fromFile(path)` retains stored `did:jwk` strings, including valid
optional public metadata; it rejects stored identity/key mismatches. A separate
`publicJwk` in the key file must match every coordinate. `fromJwk` can receive an
explicit trusted identity in `{ did }`. For a non-`did:jwk` identity, a configured
`kid` is required and the caller remains responsible for that trusted key binding;
this adds no network resolver. Public-only managers verify and reject signing.

`MpasSigner` combines `MpasJwsSigner` and `MpasRawSigner`. The contract exposes
`did`, `kid`, `algorithm` (`EdDSA` or `ES256`), and `publicKey`, plus:

- `signCompactJws(payload: Uint8Array): Promise<string>`: complete payload bytes
  in; complete compact JWS out.
- `signBytes(message: Uint8Array): Promise<Uint8Array>`: complete message bytes
  in; raw signature bytes out.

Builders use `MpasJwsSigner`; HTTP clients use the raw capability. Neither asks
for private key material. `signMpasCompactJws` and `signMpasBytes` validate provider
metadata and returned key, payload, and signature bindings. A provider may keep
its private key non-exportable. The test suite includes a Web Crypto provider
whose private CryptoKey cannot be exported.

Do not pre-hash inputs. For ES256, the signing operation hashes the complete JWS
`header.payload` input or raw HTTP signature base with SHA-256 exactly once.
Provider adapters must account for digest APIs and convert provider-internal DER
signatures to 64-byte raw `R || S`. Wire verifiers never accept DER. Fresh ECDSA
signatures can differ while remaining valid.

Existing `new ApprovalBuilder({ keyManager })`, `ActionPackageBuilder` with
`keyManager`, receipt `signingKey` inputs, and `KeyManager.sign()`/`verify()` aliases
remain supported through the shared implementation. Supply exactly one signer
input; ambiguous old/new inputs are rejected. Low-level Approval verification
accepts an optional expected signer DID when it differs from the minimal minted
DID; bundle verification uses the exact configured trusted DID automatically.

Every new HTTP request includes `alg="ed25519"` or
`alg="ecdsa-p256-sha256"`. Absent HTTP `alg` means claimed `ed25519`; reconstruct
the signature base without adding that parameter. P-256 requires explicit
`alg`. JWS always requires protected `alg` and an authorized `kid`. The original
HTTP `did` + `signBytes` call shape remains supported by deriving public metadata
from the DID, without duplicating the signer-provider abstraction.

P-256 identities require dual-suite services before registration/use. Registering
one is explicit identity rotation: it does not preserve an existing Ed25519 DID.
Retain existing Ed25519 identities and fixtures. See the [feature specification](../../docs/features/es256/spec.md)
and [conformance fixtures](../../conformance/signature-suites/README.md).
