# Implementation Plan: MCP Signer Server and Credential Authority Migration

**Spec:** [spec.md](./spec.md)

**Issues:** #43 and #57

**Created:** 2026-09-01

---

## Variation Record

- **Variation name:** MPAS MCP Signer Server profile version 1.
- **Purpose:** Let one configured Signer review pending Actions and submit a bound `approve` or `reject` Approval directly to Coordination.
- **Repository and implementation:** `oma3dao/mpas` private candidate at `/Users/grig/work/mpas/.dev/contrib/wo335-signer-authority-3538463b`; reference server at `examples/demo/src/signer-server/index.ts`.
- **Specification revision:** repository baseline `3538463b668c596c80538e26700bf218c5b32ba1` plus this uncommitted Work Order candidate.
- **Implemented profiles:** MPAS MCP Signer Server Profile v0.1; MPAS Core v0.2 review and Approval rules; HTTP Profile v0.2 Coordination poll and approval endpoints.
- **Not implemented:** HTTP Signer endpoint conformance, proposer bridge mode, MCP Tasks, background polling, notifications, multi-Signer processes, or application credential custody.
- **Topology:** MCP client calls the local Signer server; the Signer server performs signed poll and approval calls directly to one configured Coordination Service; the Proposer later retrieves the completed package and submits it to the Verifier.
- **Trust boundaries:** Signer key, derived DID, Coordination URL, and trusted time are process configuration. Review material and Authorization Requirements remain untrusted until bound checks pass. Coordination acceptance is not final authorization.
- **Target Application and execution profile:** No fixed target is configured. Each review uses the exact `target.applicationDid` and `executionProfile` inside the verified Action Envelope.
- **Policy source:** Final policy remains trusted Verifier policy. The Signer uses bound Authorization Requirements only to prove that its DID is eligible for the requested decision.
- **Identity and key authorization:** one configured private key, one derived `did:jwk`, exact optional configured-DID match, and signed participant-bound HTTP requests.
- **Replay and dispatch ledger:** the Signer owns no dispatch ledger and performs no application dispatch. Coordination owns workflow idempotency; the Verifier owns authoritative replay state.
- **Credential boundary:** the process holds only its Signer key. It does not hold Application credentials.
- **Receipt and audit behavior:** the server returns the complete accepted Coordination response with the complete Approval. It creates no Execution Receipt and does not claim execution.
- **Extensions and deviations:** none. The MCP tool transport is the profile defined by this candidate; it does not claim HTTP Signer endpoint conformance.
- **Threat assumptions:** Coordination and the proposing path may supply malformed, stale, mismatched, or unauthorized review material. The configured host must protect the Signer key and trusted configuration.

## Implementation Steps

1. Publish the normative MCP Signer Server profile and these feature records.
2. Make the existing four-tool reference server match the closed schemas, checks, errors, and Coordination success boundary.
3. Rename plugin authority metadata to `expectedAuthority` in the normative profile, types, closed loader schema, fixtures, and examples.
4. Strongly type and validate preserved generator credential requirements.
5. Recompute both changed plugin artifact DIDs and update only exact references.
6. Run the focused and full offline package checks named by the Work Order.

## Verification Commands

```bash
(cd sdk/protocol && npm test -- tests/fixtures/plugin-keys.test.ts tests/types.test.ts)
(cd examples/demo && npm test -- tests/core/plugin-loader.test.ts tests/core/plugin-payload-validation.test.ts tests/fixtures/plugin-config-keys.test.ts tests/signer-server/signer-server.test.ts)
(cd bridge-generator && npm test -- tests/generate.test.ts)
(cd sdk/protocol && npm test && npm run typecheck && npm run build)
(cd examples/demo && npm test && npm run typecheck && npm run build)
(cd bridge-generator && npm test && npm run build)
```
