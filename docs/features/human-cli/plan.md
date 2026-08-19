# Implementation Plan: Human Maintainer CLI

**Spec:** [spec.md](./spec.md)

**Issue:** #50

**Created:** 2026-08-18

---

## Scope and Constraints

Implement an interactive CLI for human Maintainers on top of the existing MPAS
protocol SDK. Preserve exact Action Envelope signing, self-approval prevention,
and Coordination authorization semantics. Do not introduce an unattended
approval mode in this feature.

## Phase 0: Contract and Code Audit

1. Map the signer server's `mpas_list_pending`, review, approve, and reject
   paths to `CoordinationClient`, `ApprovalBuilder`, and key-loading code.
2. Compare the localhost and hosted SignerSet Coordination contracts and
   document any missing list/get/submit SDK operations.
3. Define typed service inputs and outputs shared by the CLI and signer server.
4. Add contract fixtures for pending, changed, expired, terminal, ineligible,
   and self-proposed Action Packages.

Exit criterion: the CLI can be implemented without importing demo server or
MCP transport code.

## Phase 1: Reusable Maintainer Service

Add an SDK-backed Maintainer service that:

- lists eligible pending Action Packages;
- fetches one package by Action ID;
- validates package structure and current state;
- computes the canonical Action Envelope hash;
- checks expiry, signer eligibility, and self-approval;
- builds approve/reject Approvals with `ApprovalBuilder`;
- submits an Approval through `CoordinationClient`.

Keep fetching and signing separate. The signing method accepts the fetched
package plus its expected digest and fails if a refreshed package differs.

Tests:

- canonical digest stability and mismatch rejection;
- expired and terminal package rejection;
- proposer/Maintainer identity separation;
- eligible and ineligible signer behavior;
- approve and reject Approval wire compatibility;
- Coordination success, duplicate, conflict, and network failures.

## Phase 2: Configuration and Key Safety

1. Define a Maintainer CLI config schema and named-config resolution under
   `~/.mpas`.
2. Implement precedence for flags, CLI environment variables, config, and
   defaults.
3. Reuse the existing key parser; add public identity derivation and DID match
   validation if absent.
4. Add POSIX ownership/type/mode checks and reject group- or world-readable
   private-key files. Document platform behavior where those checks are not
   available.
5. Centralize secret redaction for errors and JSON serialization.

Tests cover precedence, malformed config, missing keys, symlink/file-type
handling, unsafe modes, DID mismatch, and redaction.

## Phase 3: Read-only Commands

Add the command group and implement:

```text
mpas action pending [--json] [--watch] [--interval <duration>]
mpas action inspect <action-id> [--json]
```

Build one normalized inspection model used by table, detailed terminal, and
JSON renderers. Keep raw private/key data out of that model. Polling uses a
bounded interval, network timeout, and clean SIGINT handling.

Tests cover empty lists, multiple applications, Unicode/large arguments,
redaction, stable JSON, polling cadence, transient failures, and interruption.

Exit criterion: a human can find and fully inspect a hosted pending Action
without any Coordination mutation.

## Phase 4: Interactive Decisions

Implement:

```text
mpas action approve <action-id>
mpas action reject <action-id> [--reason <text>]
```

For both commands:

1. fetch and validate the current package;
2. render the normalized inspection view;
3. show decision, Action ID, application, operation, and digest in the prompt;
4. require an attached interactive terminal and explicit confirmation;
5. refetch and revalidate immediately before signing;
6. invalidate confirmation if the digest or relevant state changed;
7. build and submit the Approval;
8. print the Coordination receipt and resulting state.

Do not add `--yes` or accept confirmation from redirected stdin. Treat EOF,
SIGINT, and negative input as no submission.

Tests use an injectable prompt/terminal interface and cover affirmative,
negative, EOF, interruption, non-TTY, package-change race, expiration race,
duplicate Approval, and rejected submission.

## Phase 5: Signer-server Convergence

Refactor the existing MCP signer server to call the shared Maintainer service
for validation, hashing, Approval construction, and submission. Keep MCP tool
schemas and transport concerns in the server layer.

Add parity tests proving that CLI and MCP paths produce equivalent signed
Approval payloads for the same package, signer, and decision.

## Phase 6: End-to-end Verification

Run two end-to-end suites:

1. reference localhost Coordination Service with generated test identities;
2. hosted SignerSet staging/test environment with HTTP authentication enabled.

Verify list -> inspect -> approve -> proposer execution and list -> inspect ->
reject -> terminal rejection. Also verify self-approval, expiry, changed
package, service outage, unsafe key permissions, and no application credentials
on the Maintainer host.

No test may print or commit private keys.

## Phase 7: Documentation and Release

1. Add human Maintainer setup instructions, config examples with placeholders,
   command examples, and troubleshooting.
2. Document the exact approval security model and the absence of unattended
   signing.
3. Add shell completion entries for the command group without completing
   secrets or private paths.
4. Add release notes and confirm package/executable installation paths.
5. Link the implementation PR and final command names from issue #50.

## Definition of Done

- All acceptance criteria in [spec.md](./spec.md) pass.
- SDK, CLI, signer-server parity, and end-to-end tests pass in CI.
- The CLI signs only a freshly validated package whose digest matches the one
  explicitly confirmed by the human.
- Hosted SignerSet and localhost Coordination flows are documented and tested.
- No private key material or application credential is exposed in output,
  fixtures, logs, or repository history.
