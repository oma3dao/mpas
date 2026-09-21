# MCP Signer Server

**Status:** Draft

**Created:** 2026-09-01

**Issues:** #43 and #57

**Normative output:** [MPAS MCP Signer Server Profile v0.1](../../../specs/mpas-profile-mcp-signer.md)

**Companion:** [plan.md](./plan.md)

---

## 1. Purpose

Add one independently implementable MCP profile for a Signer that reviews pending MPAS Actions and submits `approve` or `reject` Approvals directly to a Coordination Service.

## 2. Public Contract

The server exposes exactly these tools through normal MCP `tools/list`:

- `mpas_list_pending`
- `mpas_review_action`
- `mpas_approve`
- `mpas_reject`

List pending accepts only an empty object. The other tools accept only one non-empty `actionId` string. All inputs and outputs are closed.

The profile uses one configured Signer key and DID per process. It does not add `org.oma3/mpas-signer`, proposer mode, MCP Tasks, background polling, notifications, or application-credential custody.

## 3. Integrity and Authority Boundary

Before review presentation and again before signing, the server verifies:

1. Action ID value equality across the call, Action reference, and Action Envelope, with matching complete scoped IDs in the reference and envelope.
2. The Action reference's hash against the complete Action Envelope.
3. The Execution Payload hash against the Action Envelope.
4. Included Authorization Requirements against the same Action Envelope hash.
5. Mandatory Action expiry and optional review-set and requirements expiry, using Core timestamps with exactly three fractional digits.
6. The configured Signer DID against a matching threshold or override path for the requested decision. An absent threshold decision means `approve`, as in Core.

The Signer check prevents an out-of-scope signature. It does not replace final Verifier policy.

## 4. Coordination Boundary

The Signer builds an Approval with its one configured key and submits it directly to Coordination. The proposing MCP client and Action Relay do not take part in this signature path.

Success requires a complete, well-formed, accepted Coordination response bound to the same Action. Negative, malformed, mismatched, timed-out, and unavailable results fail closed.

## 5. Stable Errors

The profile uses only:

- `SIGNER_INPUT_INVALID`
- `APPROVAL_REQUEST_NOT_FOUND`
- `REVIEW_SET_INTEGRITY_ERROR`
- `SIGNER_NOT_ELIGIBLE`
- `ACTION_EXPIRED`
- `COORDINATION_APPROVAL_REJECTED`
- `COORDINATION_RESPONSE_INVALID`
- `COORDINATION_UNAVAILABLE`
- `UNKNOWN_TOOL`

Every error has closed structured content with `code`, `message`, and optional `details`.

## 6. Related Credential Migration

The same candidate renames plugin `credentialRequirements[].requiredCapabilities` to optional `expectedAuthority: string[]`.

`expectedAuthority` is abstract, non-normative, review-only metadata. Provider OAuth scopes remain only in trusted deployment configuration at `executionTarget.auth.scopes`. `refreshScope` remains separate refresh-token behavior.

Legacy, mixed, unknown-key, and plugin `scopes` shapes fail rather than migrate silently.
