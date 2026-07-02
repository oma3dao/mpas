# MPAS MCP Bridge — Delta Plan

**Status:** Ready for implementation  
**Context:** The coordination service spec has been finalized in `mpas-local/docs/features/coordination-localhost/spec.md`. The bridge MVP spec (`spec.md` in this folder) has been updated to reflect the new architecture. This document summarizes what changed and why, so the implementation can be updated accordingly.

---

## Why the spec changed

1. **Coordination service API simplified.** The coordination service now has four endpoints (submit action, poll, submit approval, cancel) instead of the original five (which included a separate approvals-query). The poll endpoint returns everything — approval requests for signers and state updates (with completed Action Packages) for proposers — in one response.

2. **Proposer and signer are separate servers.** Originally the bridge supported a "combined" mode where one MCP server instance did both proposer and signer work. This was removed because multiple ProposerBridge instances (one per application) would all redundantly poll the coordination service for signer work. The MPAS Signer MCP Server is now a distinct standalone server — one per agent, across all applications.

3. **No background polling on the signer server.** The MPAS Signer MCP Server queries the coordination service on demand when the agent calls `mpas_list_pending`. No timer, no `pollIntervalMs` config.

4. **Coordination service returns a completed Action Package.** When approvals are collected, the coordination service assembles the full Action Package (original payload + envelope + updated approval bundle). The proposer just forwards it to the adapter. No client-side assembly needed.

---

## High-level change list

### Removed

- **Combined mode** (`mode: "both"`) — remove from config parsing, remove `CombinedBridge` class or combined logic, remove the `full-participant` example.
- **Separate approvals-query endpoint** — `CoordinationClient` no longer needs `getReviewSet()`, `listPending()`, or `getReceipt()` as separate methods.
- **Background polling** — no timer-based polling in `MaintainerBridge`. Remove `pollIntervalMs` config field if present.

### Modified

- **`CoordinationClient`** — rewrite to match the new coordination service API:
  - `submitAction(pkg, authReqs)` → `POST /mpas/v1/coordination/action`
  - `poll(did)` → `POST /mpas/v1/coordination/poll` — returns `{ approvalRequests, actionUpdates }`
  - `submitApproval(actionEnvelopeHash, approval)` → `POST /mpas/v1/coordination/approval` — returns `{ accepted: boolean }`
  - `cancelAction(actionId, did)` → `POST /mpas/v1/coordination/action-cancel`

- **`ProposerBridge`** — update the `coordinate` and `wait` strategies:
  - On `additionalApprovalsRequired`: call `coordinationClient.submitAction(originalPackage, authReqs)`
  - Poll using `coordinationClient.poll(agentDid)` and look at `actionUpdates` for own actions
  - When an update has `state: "readyForResubmission"` and includes `actionPackage`, resubmit that package to the adapter directly
  - Support `cancelAction` if the agent or bridge decides to abort

- **`MaintainerBridge`** — update to use on-demand querying:
  - `mpas_list_pending` → calls `coordinationClient.poll(agentDid)` and returns `approvalRequests`
  - `mpas_review_action` → uses data from the `signerReviewSet` returned in the approval request (no separate fetch needed)
  - `mpas_approve` / `mpas_reject` → calls `coordinationClient.submitApproval(actionEnvelopeHash, signedApproval)`

- **Configuration** — remove `mode: "both"`, keep `mode: "proposer"` and `mode: "signer"` as separate configs for separate processes.

### Added

- **`cancelAction`** method on `CoordinationClient`.
- **Progress awareness** — `ProposerBridge` can optionally expose approval progress to the agent (how many approved/rejected/pending) from `actionUpdates[].progress`.

### Tests to update

- Tests that use combined mode need removal or rewrite as separate proposer/signer tests.
- `CoordinationClient` unit tests need updating to match new request/response shapes.
- `ProposerBridge` tests for `coordinate`/`wait` strategies need updating to work with the new poll-based flow (receive completed `actionPackage` from poll response).
- `MaintainerBridge` tests need updating to reflect on-demand querying rather than background polling.
- Integration tests should verify the full flow: ProposerBridge → adapter → coordination → MaintainerBridge approves → ProposerBridge gets completed package → resubmits → receipt.

---

## Reference documents

- Coordination service spec: `mpas-local/docs/features/coordination-localhost/spec.md`
- Coordination service plan: `mpas-local/docs/features/coordination-localhost/plan.md`
- MPAS Core Specification: `oma3/mpas-docs/specification/mpas-specification.md` (sections 4.1, 4.2 updated)
- Bridge MVP spec: `spec.md` (this folder, already updated)
