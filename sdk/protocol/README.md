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

- `KeyManager` — load Ed25519 keys from file, derive `did:jwk`, sign/verify JWS
- `deriveDidKey`, `generateEd25519Key`, `didKeyToKid` — DID utilities

### Proposer Bridge Runtime (`lib/bridge-runtime.ts`, `lib/mcp-protocol-server.ts`, `lib/mcp-tasks-server.ts`, `lib/mcp-compatibility-server.ts`, `lib/workflow-engine.ts`, `lib/workflow-store.ts`)

Build asynchronous proposer bridges with wire-level detection for MCP 2026-07-28
Tasks clients and conventional MCP clients:

- `MpasProtocolServer` — single transport owner that locks each connection to Tasks or compatibility mode from its handshake
- `MpasTasksServer` — MCP discovery, exact upstream tools, and official `tasks/*` operations
- `MpasCompatibilityServer` — conventional initialization, deferred results, and `mpas_wait_for_action_result`
- `ProposerBridge` — creates Actions and maps one durable MPAS workflow to either client presentation
- `BridgeWorkflowEngine` — background workflow: submission, coordination, resubmission, restart recovery
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

When a direct or relayed Verifier returns `additionalApprovalsRequired`, explicitly
submit that Action Package and the Verifier's requirements through the coordination workflow:

```typescript
import { CoordinationServiceClient } from "@oma3/mpas";

if (response.result === "additionalApprovalsRequired" &&
    response.authorizationRequirements) {
  const coordination = new CoordinationServiceClient({
    url: "https://coordination.example.com",
    signer: proposerSigner,
  });
  await coordination.createApprovalWorkflow({
    actionPackage,
    authorizationRequirements: response.authorizationRequirements,
    idempotencyKey: "stable-key-for-coordination-submission",
  });
}
```

The Action endpoint and Coordination Service are independent. Receiving the relay
response never creates a workflow; the explicit call above does.
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
