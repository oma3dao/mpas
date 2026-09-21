# MPAS MCP Signer Server Profile

**Status:** Draft v0.1

**Profile version:** `1`

**MCP discovery:** normal `tools/list`

**Depends on:** [MPAS Core Specification v0.2](./mpas-specification.md) and [MPAS HTTP Profile v0.2](./mpas-profile-http.md)

**Feature records:** [Signer MCP Server specification](../docs/features/mcp-signer/spec.md) and [implementation plan](../docs/features/mcp-signer/plan.md)

---

## 1. Purpose and Scope

This profile defines an MCP server that lets one configured Signer inspect pending MPAS approval work and submit one signed `approve` or `reject` decision to a Coordination Service.

The server exposes exactly four MCP tools through normal `tools/list`:

- `mpas_list_pending`
- `mpas_review_action`
- `mpas_approve`
- `mpas_reject`

The server holds exactly one Signer key and one Signer DID per process. It is not a proposer bridge, a Verifier, an Action Relay, a Coordination Service, a credential adapter, or an application-credential custodian.

This version does not define an MCP profile-extension identifier. It does not advertise `org.oma3/mpas-signer`, use MCP Tasks, poll in the background, or define notifications. A client discovers this profile only by finding the exact four tools in `tools/list`.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174.

## 2. Identity and Trust Boundaries

1. A server process MUST load exactly one private signing key and derive exactly one Signer DID from it.
2. A configured Signer DID, when present, MUST exactly equal the DID derived from the configured key.
3. Tool arguments MUST NOT select a key, DID, Coordination Service, return path, or policy.
4. The Coordination Service URL and Signer key are trusted process configuration.
5. Authorization Requirements in a review set are signer context. They are not a guarantee of future execution and do not replace final Verifier policy.
6. The server MUST NOT hold or request reusable Application credentials.
7. The server MUST submit the Approval directly to the configured Coordination Service. It MUST NOT return it through the proposing MCP client or an Action Relay.

## 3. Tool Discovery

`tools/list` MUST return the four tools in Section 1 and no other Signer-profile tools. The tool descriptions are informative. The names and schemas are normative.

This profile does not use `server/discover`, an extension namespace, task capability negotiation, or tool-description notices. Implementations MAY expose unrelated administrative health behavior outside MCP, but that behavior is not part of this profile.

## 4. Common Schemas

### 4.1 Empty input

`mpas_list_pending` accepts only this closed object:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### 4.2 Action input

The other three tools accept only this closed object:

```json
{
  "type": "object",
  "required": ["actionId"],
  "properties": {
    "actionId": { "type": "string", "minLength": 1 }
  },
  "additionalProperties": false
}
```

Whitespace is significant. An implementation MUST reject an empty string but MUST NOT silently trim or rewrite a non-empty Action ID.

### 4.3 Error output

Every failed tool call MUST set MCP `isError` to `true`. Its `structuredContent` MUST be this closed shape:

```json
{
  "type": "object",
  "required": ["code", "message"],
  "properties": {
    "code": {
      "type": "string",
      "enum": [
        "SIGNER_INPUT_INVALID",
        "APPROVAL_REQUEST_NOT_FOUND",
        "REVIEW_SET_INTEGRITY_ERROR",
        "SIGNER_NOT_ELIGIBLE",
        "ACTION_EXPIRED",
        "COORDINATION_APPROVAL_REJECTED",
        "COORDINATION_RESPONSE_INVALID",
        "COORDINATION_UNAVAILABLE",
        "UNKNOWN_TOOL"
      ]
    },
    "message": { "type": "string", "minLength": 1 },
    "details": { "type": "object" }
  },
  "additionalProperties": false
}
```

`details`, when present, is diagnostic and non-authoritative. A server MUST NOT place secrets or private key material in it.

### 4.4 Complete embedded objects

The success schemas below close their top-level MCP result objects. Embedded `ApprovalRequest`, `SignerReviewSet`, `Approval`, and `CoordinationApprovalSubmissionResponse` values MUST be complete objects conforming to MPAS Core and the HTTP Profile. Implementations MUST NOT return summaries, projections, identifiers in place of objects, or extra top-level result members.

## 5. `mpas_list_pending`

The server MUST perform one signed Coordination poll for its configured Signer DID and return every complete `approvalRequest` in the Coordination response.

Success `structuredContent`:

```json
{
  "type": "object",
  "required": ["approvalRequests"],
  "properties": {
    "approvalRequests": {
      "type": "array",
      "items": { "type": "object" }
    }
  },
  "additionalProperties": false
}
```

An empty `approvalRequests` array is a successful result. This tool does not return `actionUpdates`.

## 6. `mpas_review_action`

The server MUST perform one signed Coordination poll and select the request whose `actionRef.actionId.value` exactly equals the supplied `actionId`. It MUST then perform the checks in Section 9 before returning review material.

Success `structuredContent`:

```json
{
  "type": "object",
  "required": ["approvalRequest", "reviewSet"],
  "properties": {
    "approvalRequest": { "type": "object" },
    "reviewSet": { "type": "object" }
  },
  "additionalProperties": false
}
```

`approvalRequest` MUST be the complete selected `ApprovalRequest`. `reviewSet` MUST be the complete `approvalRequest.signerReviewSet`. The server MUST NOT present either object when a Section 9 check fails.

## 7. `mpas_approve` and `mpas_reject`

Each tool MUST perform one signed Coordination poll, select the exact Action ID, and repeat every Section 9 check immediately before signing.

`mpas_approve` creates an Approval with decision `approve`. `mpas_reject` creates an Approval with decision `reject`. The Approval MUST bind to the computed hash of the complete Action Envelope and MUST use the one configured Signer key.

The server MUST submit this exact request to the configured Coordination Service approval endpoint:

```json
{
  "version": "1",
  "type": "CoordinationApprovalSubmission",
  "actionEnvelopeHash": {},
  "approval": {}
}
```

The `actionEnvelopeHash` MUST equal the verified `ApprovalRequest.actionRef.actionEnvelopeHash`. The `approval` MUST be the complete newly built Approval.

The server reports success only after the Coordination Service returns a well-formed `CoordinationApprovalSubmissionResponse` with `accepted: true`, the same Action ID, and the same Action Envelope hash.

Success `structuredContent`:

```json
{
  "type": "object",
  "required": ["approval", "coordinationResponse"],
  "properties": {
    "approval": { "type": "object" },
    "coordinationResponse": { "type": "object" }
  },
  "additionalProperties": false
}
```

The server MUST return the complete Approval and the complete accepted Coordination response. It MUST NOT report success for an HTTP rejection, `accepted: false`, a malformed response, a response bound to another Action, a timeout, invalid JSON, a network failure, or service unavailability.

## 8. Input Processing

Before any Coordination call, the server MUST reject:

- any non-object argument value;
- arrays;
- any undeclared member;
- a missing `actionId` on an Action tool;
- a non-string `actionId`; and
- an empty `actionId` string.

These failures use `SIGNER_INPUT_INVALID`. A tool name other than the exact four names uses `UNKNOWN_TOOL`.

## 9. Review and Signing Checks

The server MUST apply this procedure before presenting review material and MUST repeat it before signing:

1. Confirm the supplied `actionId`, `ApprovalRequest.actionRef.actionId.value`, and `SignerReviewSet.actionEnvelope.actionId.value` are exact string matches. The complete Action IDs in the reference and envelope, including the presence and value of `scope`, MUST also match. A mismatch uses `REVIEW_SET_INTEGRITY_ERROR`.
2. Compute the MPAS canonical hash of the complete `SignerReviewSet.actionEnvelope` and compare it to `ApprovalRequest.actionRef.actionEnvelopeHash`. A mismatch or unsupported hash algorithm uses `REVIEW_SET_INTEGRITY_ERROR`.
3. Compute the execution-profile hash of the complete `SignerReviewSet.executionPayload` and compare it to `actionEnvelope.executionPayloadHash`. This profile's reference implementation supports the MPAS JSON SHA-256 path. A missing, unsupported, or mismatched payload hash uses `REVIEW_SET_INTEGRITY_ERROR`.
4. When `authorizationRequirements` is present, require `result: additionalApprovalsRequired` and compare its `actionEnvelopeHash` to the verified Action Envelope hash. A missing approval path, wrong result, unsupported hash, or mismatch uses `REVIEW_SET_INTEGRITY_ERROR`.
5. Require `actionEnvelope.expiresAt` and compare it to trusted current time. If it is absent, expired, or invalid under Core's UTC timestamp format with exactly three fractional digits, use `ACTION_EXPIRED`.
6. When `SignerReviewSet.expiresAt` is present, compare trusted current time to it. If the review set is expired or the timestamp is invalid, use `ACTION_EXPIRED`.
7. When `authorizationRequirements.expiresAt` is present, compare trusted current time to it. If the requirements are expired or the timestamp is invalid, use `ACTION_EXPIRED`.
8. Determine the requested decision. For review, use `ApprovalRequest.requestedDecision`, which MUST be `approve` or `reject`. For signing, use the tool's decision and require it to equal `requestedDecision` when that field is present.
9. Confirm that the configured Signer DID is eligible for that decision through at least one threshold or override path:
   - a threshold path in `approvalRequirements.anyOf` or `approvalRequirements.allOf` matches when `eligibleSigners` contains the exact Signer DID and the path's `decision` equals the requested decision, with an absent `decision` defaulting to `approve` as required by Core; or
   - an `overrideSigners` entry matches when `signer` equals the exact Signer DID and `permissions` contains the requested decision.

If eligibility cannot be established, use `SIGNER_NOT_ELIGIBLE`. Signer eligibility is a pre-signing safety check, not final authorization. The Verifier still applies authoritative policy to the completed Action Package.

## 10. Stable Error Mapping

| Code | Condition |
|---|---|
| `SIGNER_INPUT_INVALID` | Tool arguments do not match the exact closed input schema. |
| `APPROVAL_REQUEST_NOT_FOUND` | The current signed poll contains no Approval Request for the exact Action ID. |
| `REVIEW_SET_INTEGRITY_ERROR` | Action identity, envelope hash, payload hash, requirements binding, or requested-decision binding is invalid. |
| `SIGNER_NOT_ELIGIBLE` | The configured Signer DID has no matching threshold or override path for the requested decision. |
| `ACTION_EXPIRED` | The Action Envelope, review set, or included Authorization Requirements is expired or has an invalid expiry. |
| `COORDINATION_APPROVAL_REJECTED` | Coordination returned a valid response with `accepted: false`. |
| `COORDINATION_RESPONSE_INVALID` | Coordination returned an HTTP authentication failure (401/403), invalid JSON, a malformed object, an undeclared member, or a response bound to another Action. |
| `COORDINATION_UNAVAILABLE` | A network error, timeout, or unavailable Coordination Service prevents the operation. |
| `UNKNOWN_TOOL` | The requested MCP tool name is not one of the four profile tools. |

The server MUST map thrown parse, network, timeout, malformed-response, rejection, and unavailability outcomes to these errors. It MUST NOT let one of those outcomes become a successful MCP tool result or a generic MCP internal error. Malformed pending objects use `COORDINATION_RESPONSE_INVALID` for `mpas_list_pending`; before review or signing, the specific expiry and integrity errors in Section 9 take precedence over that generic parse error. Missing or malformed approval paths and hash metadata use `REVIEW_SET_INTEGRITY_ERROR`. A returned Coordination response is checked when received, after the single ordinary submission; an invalid response MUST NOT trigger a retry. Its complete Action ID, including scope, and hash MUST match the submitted Action before success is returned.

## 11. Security Requirements

A conforming server MUST:

- keep the Signer private key inside the configured process boundary;
- derive and enforce one Signer DID from that key;
- use signed participant-bound Coordination requests when the HTTP Profile requires them;
- show or return the complete bound review material rather than an untrusted summary;
- repeat integrity, expiry, and eligibility checks immediately before signing;
- submit the Approval directly to Coordination;
- preserve the complete accepted Coordination response;
- treat Coordination workflow state as non-authoritative; and
- leave final authorization to the Verifier.

A conforming server MUST NOT:

- expose private key material in tool results or errors;
- accept a caller-supplied key, DID, Coordination URL, policy, or return path;
- act as a Proposer;
- send the Approval through the proposing MCP client or an Action Relay;
- custody reusable Application credentials;
- approve after any required check fails; or
- claim that Coordination acceptance means the Action is authorized or executed.

## 12. Conformance

A conforming implementation MUST prove:

1. `tools/list` returns exactly the four named tools with the closed schemas in this profile.
2. Valid pending, review, approve, and reject calls return the complete required objects.
3. Closed-input violations use `SIGNER_INPUT_INVALID` without a Coordination call.
4. Missing Action work uses `APPROVAL_REQUEST_NOT_FOUND`.
5. Action ID, Action Envelope hash, Execution Payload hash, Authorization Requirements binding, and requested-decision defects fail before presentation or signing.
6. Expired Action, review-set, and included requirements timestamps fail before presentation or signing.
7. An ineligible Signer fails before presentation or signing.
8. Negative, malformed, mismatched, unavailable, and failed Coordination outcomes never produce success.
9. The Approval is built with the configured key, binds to the verified Action Envelope hash, and is submitted directly to Coordination.
10. The complete accepted Coordination response is returned unchanged with the Approval.

Conformance to this MCP Signer profile does not imply conformance to the HTTP Signer endpoint in the HTTP Profile. They are separate client-facing transports over the same MPAS Core review and Approval rules.
