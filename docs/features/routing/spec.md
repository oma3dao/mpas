# MPAS Action Relay, Routing, and Work Notification — Feature Specification

**Status:** Draft
**Created:** 2026-08-20
**Revised:** 2026-08-29
**Tracks:** [#45](https://github.com/oma3dao/mpas/issues/45), [#20](https://github.com/oma3dao/mpas/issues/20), [#17](https://github.com/oma3dao/mpas/issues/17)
**Companion:** [plan.md](./plan.md)
**Related specifications:** [HTTP Profile](../../../specs/mpas-profile-http.md), [MPAS Core](../../../specs/mpas-specification.md)

---

## 1. Purpose and Relationship to MPAS

This feature adds a routing envelope, an Action Relay binding for the existing Verifier Action interface, relay delivery and polling, optional WebSocket work notifications, and body-level idempotency. An Action Relay and a Coordination Service are logically separate services even when one deployment hosts both.

It does not restate MPAS roles or processing. Implementations continue to follow:

- [Core §2](../../../specs/mpas-specification.md#2-definitions-and-terminology) for terminology;
- [Core §4](../../../specs/mpas-specification.md#4-architecture) and [Core §6](../../../specs/mpas-specification.md#6-protocol-and-processing-rules) for architecture, Action processing, coordination topologies, and the Action lifecycle;
- [Core §7.7](../../../specs/mpas-specification.md#77-coordination-service) for the Coordination Service trust boundary;
- [HTTP §4](../../../specs/mpas-profile-http.md#4-common-http-rules) for common HTTP, authentication, and idempotency rules;
- [HTTP §6](../../../specs/mpas-profile-http.md#6-common-action-interface) for `ActionRequest` and `ActionResponse` processing;
- [HTTP §8](../../../specs/mpas-profile-http.md#8-coordination-service-interface) for the existing Coordination Service workflow and poll; and
- [HTTP §§9–11](../../../specs/mpas-profile-http.md#9-polling-and-optional-push-notification) for polling, security, and conformance.

This feature updates [HTTP §6.2](../../../specs/mpas-profile-http.md#62-endpoint), adds the relay interface in HTTP §8.3, and updates [§14](../../../specs/mpas-profile-http.md#14-coordination-service-topology). A Proposer may submit the same enveloped Action request to either a directly reachable Verifier or an Action Relay, and a Verifier may retrieve a relayed Action request through the relay poll.

## 2. Additive Scope

This feature defines only:

- `DeliveryEnvelope`;
- body-level `idempotencyKey` on `ActionRequest` and signed-request `audience` on the outer submitted object;
- canonical `DeliveryEnvelope<ActionRequest>` submission to `POST /mpas/v1/verifier/action`;
- the existing `ActionResponse` as the response from either a direct Verifier or an Action Relay;
- Verifier submission of `DeliveryEnvelope<ActionResponse>` to an Action Relay;
- `RelayPollRequest` and `RelayPollResponse` for addressed deliveries;
- an authenticated WebSocket session and payload-free work notification; and
- routing that Verifier response to its addressed recipients.

It does not change the Core schemas or verification rules for `ActionEnvelope`, `ActionPackage`, `Approval`, `AuthorizationRequirements`, `ActionResponse`, or `ExecutionReceipt`. It does not define participant discovery, webhook registration, WebSocket payload delivery, acknowledgements, exactly-once delivery, end-to-end encryption, retry queues, or operational tuning.

## 3. Delivery Envelope

### 3.1 Schema

```json
{
  "version": "1",
  "type": "DeliveryEnvelope",
  "sender": "did:jwk:...sender...",
  "recipients": [
    "did:jwk:...recipient-1...",
    "did:jwk:...recipient-2..."
  ],
  "createdAt": "2026-08-25T12:00:00.000Z",
  "expiresAt": "2026-08-25T12:05:00.000Z",
  "audience": "https://action-service.example.com",
  "payload": {
    "version": "1",
    "type": "ActionRequest"
  }
}
```

| Field | Required | Definition |
| --- | :---: | --- |
| `version` | Yes | MUST be `"1"`. |
| `type` | Yes | MUST be `"DeliveryEnvelope"`. |
| `sender` | Yes | DID of the participant responsible for the payload's recorded provenance. |
| `recipients` | Yes | Non-empty array of unique recipient DIDs. |
| `createdAt` | Yes | MPAS Core §5 timestamp: RFC 3339 UTC with exactly three fractional digits and a `Z` suffix. |
| `expiresAt` | Optional | MPAS Core §5 timestamp and retrieval deadline. If present, it MUST be later than `createdAt`. |
| `audience` | Conditional | Receiving service origin under HTTP §4.6.3 when the envelope is the body of a signed HTTP request. |
| `payload` | Yes | JSON representation of an MPAS message or artifact. |

`DeliveryEnvelope` is routing metadata. It is not an Approval, does not assign an MPAS role, and does not replace the payload's verification requirements. These constraints follow Core §6.8.4 and HTTP §§4.4 and 10.

For participant-authored submission, the receiving endpoint MUST establish `signature keyid == DeliveryEnvelope.sender` under HTTP §4.6. The envelope is not an end-to-end signature.

`audience` belongs to the outer submitted object because it authenticates the HTTP request. A participant retrieving a stored envelope does not reinterpret the submission audience as routing or payload authorization data.

An Action Relay stores an independent retrieval obligation for each recipient. Retrieval by one recipient does not consume another recipient's delivery. Delivery storage uses the explicit recipient list and does not inspect the payload to infer recipients or authorization.

A receiving endpoint MUST reject an envelope whose `expiresAt` is not in the future at submission, before it creates any delivery obligation. Implementations SHOULD enforce a finite deployment-specific recipient-count limit to bound authorization work and delivery fan-out.

Every recipient receives the complete envelope and therefore learns the complete `recipients` array. In a multi-tenant deployment, this means that administrator-added recipients are visible to the other recipients carried in the same envelope.

For idempotent request equivalence, the Delivery Envelope layer treats `sender` and `recipients` as significant, with `recipients` compared as a set. `createdAt`, `expiresAt`, and `audience` are not significant because they may be regenerated for transport retry. The first accepted envelope remains authoritative, so a retry does not extend its stored `expiresAt`.

## 4. Common Action Submission

### 4.1 ActionRequest Additions

`ActionRequest` remains the HTTP §6.3 request message and gains:

| Field | Required | Definition |
| --- | :---: | --- |
| `idempotencyKey` | Recommended | Mutation idempotency key defined in Section 9. |
| `audience` | Conditional | Action endpoint origin under HTTP §4.6.3 only when a bare `ActionRequest` is the body of a signed direct request. |

For enveloped submission, `audience` occurs on the outer `DeliveryEnvelope`, while `idempotencyKey` remains in `ActionRequest` for the Action-processing layer. A bare direct submission carries both fields in `ActionRequest` because that message is then the outer submitted object.

The canonical request is:

```http
POST /mpas/v1/verifier/action
Content-Type: application/mpas+json
```

```json
{
  "version": "1",
  "type": "DeliveryEnvelope",
  "sender": "did:jwk:...proposer...",
  "recipients": [
    "did:jwk:...verifier...",
    "did:jwk:...informational-recipient..."
  ],
  "createdAt": "2026-08-25T12:00:00.000Z",
  "audience": "https://action-service.example.com",
  "payload": {
    "version": "1",
    "type": "ActionRequest",
    "idempotencyKey": "28ebf760-3948-493a-bc46-cc2f18e7172a",
    "actionPackage": {
      "version": "1",
      "type": "ActionPackage"
    }
  }
}
```

The endpoint MUST validate:

If the outer object's `type` is `DeliveryEnvelope`:
- `payload.type == "ActionRequest"`;
- `signature keyid == DeliveryEnvelope.sender == ActionEnvelope.proposer.did` when HTTP §4.6 authentication is enforced.

An Action has exactly one designated Verifier even when the envelope has multiple recipients. The designated Verifier comes from trusted endpoint or Action Relay configuration, not from the Proposer-authored `ActionRequest` or recipient order. The configured Verifier DID MUST occur in `DeliveryEnvelope.recipients`. Other recipients do not become Verifiers or Signers by receiving the Action.

If the outer object's `type` is `ActionRequest`:
- `signature keyid == ActionEnvelope.proposer.did` when HTTP §4.6 authentication is enforced.

For idempotent equivalence, the Action layer treats the complete `ActionRequest` as significant except for `idempotencyKey` and `audience`. The Action Package, including `actionId`, therefore remains significant.

### 4.2 Direct Verifier Behavior

A directly reachable Verifier requires its locally configured DID to occur in the envelope recipients. It MUST NOT require itself to be the only recipient. It then processes the enclosed `ActionRequest` and returns the existing HTTP §6.4 `ActionResponse` without another response wrapper.

One configured Verifier DID per Action endpoint is the ordinary deployment model. An implementation may multiplex identities, but trusted local routing configuration must select the applicable identity before processing; the selected DID must be an envelope recipient.

A direct Verifier is not responsible for forwarding the envelope to other recipients unless that endpoint also implements routing. Otherwise, delivery to those recipients remains the sender's responsibility.

A directly reachable Verifier MUST accept both `DeliveryEnvelope<ActionRequest>` and bare `ActionRequest`. Its configured endpoint identity already determines the Verifier for the bare form, so no routing field is required in that request. An Action Relay rejects the bare form because it lacks recipient routing and audit metadata. A raw `ActionPackage` is not an Action endpoint request form.

### 4.3 Action Relay Behavior

An Action Relay receiving the canonical request:

- resolves the designated Verifier DID from trusted deployment configuration;
- requires that configured DID to occur in the envelope recipients;
- authorizes every requested recipient under relay-administrator policy;
- creates delivery records for all authorized recipients; and
- returns the first authenticated `ActionResponse` received from the configured Verifier through Section 5.

Before storing or exposing the Action, the Action Relay verifies the Action Package's `executionPayloadHash` and `approvalBundle.actionEnvelopeHash` bindings. Invalid input creates neither a relayed Action nor a delivery. The relay records the designated Verifier independently from the recipient list.

The protocol does not define how deployment configuration is keyed. A hosted Action Relay may use account, tenant, application, or other trusted administrative scope. It MUST NOT trust the Proposer to assign the Verifier role, choose a recipient by array position, or silently substitute an unconfigured Verifier.

Relay delivery does not create or advance a Coordination Service workflow. If the Verifier returns `additionalApprovalsRequired`, the client may explicitly submit the Action Package and returned `AuthorizationRequirements` to `/mpas/v1/coordination/workflow`, contact Signers directly, or use another Coordination Service. A co-located relay record does not authorize that later workflow request.

### 4.4 Common Action Response

A direct Verifier returns the existing `ActionResponse`, including its existing correlation fields, as defined by HTTP §6.4. This feature does not wrap or redefine that response.

An Action Relay MUST NOT synthesize an `ActionResponse` to acknowledge that it stored or delivered the request. It durably records the relayed Action and deliveries, keeps the `/mpas/v1/verifier/action` submission pending for a bounded deployment-selected interval, and returns the first authenticated `ActionResponse` received from the configured Verifier. The returned message is the Verifier-authored response, not a relay status object.

If that wait bound expires first, the Action Relay returns `503 timeout` with `retryable: true`. It retains the relayed Action and delivery records and MUST NOT synthesize an Action result. The profile does not fix the duration. An equivalent idempotent retry resumes waiting for the same stored Verifier response.

If the Proposer's HTTP connection ends first, the durable relayed Action continues. An equivalent retry under Section 9 waits for or returns the same stored Verifier response. A WebSocket notification normally reduces the time until the Verifier polls, but notification delivery is not required for correctness. This version defines no separate relay-acceptance response; one may be considered later if relay latency commonly blocks clients for too long.

## 5. Action Relay Response Delivery

`POST /mpas/v1/relay/delivery` exists so a Verifier that retrieved a relayed `ActionRequest` through the relay poll can return its Verifier-authored `ActionResponse` to the Action Relay. Its request body is `DeliveryEnvelope<ActionResponse>`. It is not the initial Action submission path; the Proposer uses `/mpas/v1/verifier/action` for that purpose. This version defines no arbitrary participant-to-participant payload submission through this endpoint.

```http
POST /mpas/v1/relay/delivery
Content-Type: application/mpas+json
```

```json
{
  "version": "1",
  "type": "DeliveryEnvelope",
  "sender": "did:jwk:...verifier...",
  "recipients": [
    "did:jwk:...proposer...",
    "did:jwk:...maintainer..."
  ],
  "createdAt": "2026-08-25T12:00:00.000Z",
  "audience": "https://relay.example.com",
  "payload": {
    "version": "1",
    "type": "ActionResponse"
  }
}
```

The endpoint MUST require `payload.type == "ActionResponse"`, apply HTTP §4.6, and establish the identity and relayed-Action bindings in Section 8. The recipients MUST include the Action Proposer. The Action Relay rejects any additional recipient not authorized by relay-administrator policy. Recipient authorization does not assign a Signer or Verifier role. Eligible Signers receive Action review material through the separate Coordination Service workflow messages.

The Action Relay stores the envelope for its authorized recipients and uses a qualifying first response to complete the pending relayed `/mpas/v1/verifier/action` request.

Successful durable acceptance returns:

```json
{
  "version": "1",
  "type": "RelayDeliveryResponse",
  "accepted": true,
  "createdAt": "2026-08-25T12:00:01.000Z"
}
```

This response acknowledges Verifier response delivery to the Action Relay; it is not an Action result. The delivery envelope has no body-level idempotency field. An Action Relay MAY deduplicate response deliveries by authenticated sender plus the exact enclosed payload hash; otherwise repeated submissions may create repeated delivery records.

## 6. Relay Poll

The Action Relay exposes `POST /mpas/v1/relay/poll` with `RelayPollRequest` and `RelayPollResponse`. The request uses a signed DID and the relay-specific optional cursor and retry pattern. Its response contains relay deliveries only. Coordination `approvalRequests` and `actionUpdates` remain on `/mpas/v1/coordination/poll`, which never returns relay deliveries or relay cursors.

```json
{
  "version": "1",
  "type": "RelayPollResponse",
  "deliveries": [
    {
      "version": "1",
      "type": "DeliveryEnvelope",
      "sender": "did:jwk:...sender...",
      "recipients": ["did:jwk:...recipient..."],
      "createdAt": "2026-08-25T12:00:00.000Z",
      "payload": {
        "version": "1",
        "type": "ActionRequest"
      }
    }
  ]
}
```

- `deliveries` is an array of complete `DeliveryEnvelope` objects.
- Every returned envelope MUST be unexpired and contain the authenticated poll DID in `recipients`.
- `nextCursor` reflects delivery position only.
- A service MAY cap `deliveries`. Every non-empty delivery page MUST include `nextCursor` for the last returned delivery, including the currently known final page, so the client can durably advance its checkpoint. A poll after that cursor may return no deliveries and omit `nextCursor`.
- A Verifier may now poll for an `ActionRequest` addressed to its configured DID. This intentionally replaces the previous HTTP §8.5 statement that a Verifier never polls.
- Existing coordination `approvalRequests` and `actionUpdates` selection and meaning do not change.
- Poll delivery is at least once. Repeating a cursor may return the same envelope, so the recipient uses the enclosed MPAS object's existing identity and replay rules.

## 7. Optional WebSocket Notification Binding

The WebSocket carries only a notification to poll. It never carries a `DeliveryEnvelope` or another MPAS payload.

### 7.1 Session and Upgrade

The participant first obtains a ticket with an HTTP §4.6-authenticated request:

```http
POST /mpas/v1/relay/session
```

```json
{
  "version": "1",
  "type": "RelaySessionRequest",
  "did": "did:jwk:...participant...",
  "audience": "https://relay.example.com"
}
```

The service MUST establish `signature keyid == did` before returning:

```json
{
  "version": "1",
  "type": "RelaySessionResponse",
  "websocketUrl": "wss://relay.example.com/mpas/v1/relay/ws",
  "ticket": "opaque-single-use-value",
  "expiresAt": "2026-08-25T12:05:00.000Z"
}
```

The ticket is opaque, unguessable, one-use, DID-bound, omitted from URLs and logs, and valid for at most five minutes. Production URLs use `wss`.

The participant uses `websocketUrl` exactly as returned and performs a WebSocket `GET` upgrade with `Authorization: Bearer <ticket>`. It MUST NOT put the ticket in the URL. Success returns `101 Switching Protocols`; an invalid, expired, or used ticket returns `401`. The service atomically consumes the ticket and binds the connection to the authenticated DID. The ticket authorizes only the upgrade; after a disconnect the participant obtains a new ticket. Subsequent polls and submissions continue to use HTTP §4.6.

The client retains the Action Relay HTTPS origin used for the session request. A socket notification means to poll `/mpas/v1/relay/poll` at that origin; the client does not derive a poll origin from `websocketUrl`.

### 7.2 Notification

```json
{
  "version": "1",
  "type": "RelayWorkAvailable"
}
```

After binding every authenticated connection, including the first, the service MUST send a notification if any pollable work already exists for that DID. It SHOULD also notify after committing new pollable work. Notifications may be duplicated, coalesced, delayed, or lost; the authenticated poll remains authoritative.

Heartbeat, reconnect, backoff, connection limits, and local wake-up behavior are deployment choices.

## 8. Verifier-Produced ActionResponse Envelope

This feature defines how a Verifier places the existing HTTP §6.4 `ActionResponse` in a delivery envelope and submits it through Section 5; it does not define another Verifier response or receipt type.

A Verifier-produced response envelope has:

- the authenticated Verifier DID as `DeliveryEnvelope.sender`;
- the Proposer DID from the verified Action Envelope among the recipients;
- relay-administrator-authorized additional DIDs among the recipients when the Verifier wants them to receive the response; and
- the unchanged `ActionResponse` as payload.

For a relayed Action, `ActionResponse.verifier.did` is required. The Action Relay MUST establish:

```text
signature keyid == DeliveryEnvelope.sender
                == ActionResponse.verifier.did
                == recorded relayed-Action Verifier DID
```

It also applies the existing Action identity and hash rules from Core §§5–6 and HTTP §§6 and 8. Only an authenticated response from the recorded designated Verifier may complete the relayed Action request; a response from another envelope recipient may be delivered only if separately authorized and cannot complete it.

Before storing the response envelope, the Action Relay validates every recipient beyond the Proposer against relay-administrator policy. This authorization controls delivery only and does not alter approval eligibility or threshold evaluation.

Receiving an `additionalApprovalsRequired` response does not create an approval workflow. Workflow creation requires a separate authenticated `/mpas/v1/coordination/workflow` request and the Coordination Service's own authorization checks.

The first qualifying response envelope completes the pending `/mpas/v1/verifier/action` submission and is stored as its idempotent result. Its envelope, and any later responses for the same relayed Action, remain available to their addressed recipients through relay poll; recipients apply the normal duplicate-delivery rules.

The response is submitted over authenticated HTTP, not the notification WebSocket. The Action Relay preserves the `ActionResponse` and any `ExecutionReceipt` unchanged.

## 9. Body-Level Idempotency

Action-processing idempotency belongs to `ActionRequest`, including when that message is enclosed for relay. This feature also adds body-level `idempotencyKey` to the existing coordination mutation request messages. It is not added to `DeliveryEnvelope`, `ActionPackage`, or another Core artifact.

Records are scoped by authenticated DID and key:

- same DID, key, and equivalent request returns the stored result;
- same DID and key with a different request returns `409 idempotency_conflict`; and
- different DIDs may use the same key independently.

Equivalence is layered. Every message carrying `idempotencyKey`, and every routing frame around it, defines its own significant fields. Version 1 uses these scopes:

- `DeliveryEnvelope`: `sender`, `recipients` as a set, and the enclosed payload's equivalence contribution; transport timestamps, expiry, and audience are excluded.
- `ActionRequest`, `CoordinationActionRequest`, `CoordinationApprovalSubmission`, and `CoordinationActionCancelRequest`: the complete message except `idempotencyKey` and `audience`.

An object with no defined equivalence scope MUST NOT carry a body-level idempotency key, and an implementation MUST fail closed rather than silently hash the whole unknown object.

For canonical Action submission, the Action-processing layer reads the key from the enclosed `ActionRequest`. Verifier response delivery has no body-level idempotency key because `DeliveryEnvelope` does not define one. A retry of a request that has body-level idempotency uses the same idempotency key and a fresh HTTP §4.6 nonce.

For messages that define a body field, a service accepts that field during migration and SHOULD accept `Idempotency-Key` when it is absent. If both are present and differ, it returns `400 idempotency_mismatch`. Header-only use is compatibility behavior. This migration does not add an idempotency field to `DeliveryEnvelope`.

## 10. Security and Compatibility Rules

- HTTP §4.6 remains the authentication profile. This feature adds only the endpoint identity equalities stated above.
- Routing metadata and notification delivery are not MPAS authorization, consistent with Core §6.8.4 and HTTP §§4.4 and 10.
- An Action Relay and a Coordination Service remain non-authoritative services under Core §7.7 and the HTTP profile.
- Every requested recipient requires a protocol-defined or relay-administrator authorization basis. Recipient membership alone grants no MPAS role, and the Proposer does not assign the designated Verifier.
- An Action Relay and a Coordination Service are services, not protocol participants, and do not require DIDs.
- `POST /mpas/v1/coordination/workflow` is the workflow-creation endpoint after a Verifier returns Authorization Requirements, regardless of whether the preceding Action submission was direct or relayed. Relay state does not implicitly create or authorize a workflow.
- During migration, a Coordination Service should accept `POST /mpas/v1/coordination/action` as a deprecated alias with the same request, response, authorization, idempotency scope, and workflow side effects. New clients use `/coordination/workflow`.
- The endpoint rename does not rename the established version 1 `CoordinationActionRequest` and `CoordinationActionResponse` wire discriminants.
- Polling remains sufficient for interoperability; WebSocket support is optional.
- Existing `approvalRequests` and `actionUpdates` poll behavior is unchanged. A completed package is returned to the Proposer as `readyForResubmission`; the Coordination Service does not automatically submit or deliver it to the Verifier.
- For a given Action Envelope hash and Signer DID, the first valid coordination decision is final. Repeating the same decision is idempotent; a different decision is a `409` conflict. A changed decision requires a new Action Envelope and workflow. The Proposer's initial `propose` Approval is not an additional-approval decision under this rule.
- A Coordination Service SHOULD mark its non-authoritative workflow `rejected` as soon as the immutable decisions make the approval expression unreachable.
- This feature does not define discovery or coordination across multiple Coordination Services.
- `/mpas/v1/action` is a temporary compatibility alias for `/mpas/v1/verifier/action`, and `/mpas/v1/coordination/delivery` may temporarily alias `/mpas/v1/relay/delivery`. Aliases share the canonical operation's authorization, correlation, storage, and idempotency behavior and MUST NOT create duplicate mutations.
- `/mpas/v1/coordination/workflow-cancel` is the canonical workflow cancellation path. `/mpas/v1/coordination/action-cancel` remains a temporary alias using the established version 1 `CoordinationActionCancelRequest` and `CoordinationActionCancelResponse` wire types.

## 11. References

- [MPAS Core Specification](../../../specs/mpas-specification.md) — §§2, 4, 6, 7.7, and 8
- [MPAS HTTP Profile](../../../specs/mpas-profile-http.md) — §§4, 6, 8, 9, 10, 11, and 14
- [Coordination Authentication Feature](../auth/spec.md)
- [GitHub Issue #45](https://github.com/oma3dao/mpas/issues/45) — routing and delivery
- [GitHub Issue #20](https://github.com/oma3dao/mpas/issues/20) — body-level idempotency
- [GitHub Issue #17](https://github.com/oma3dao/mpas/issues/17) — request validation
- [RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421)
- [RFC 9530 — Digest Fields](https://www.rfc-editor.org/rfc/rfc9530)
