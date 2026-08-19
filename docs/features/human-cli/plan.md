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
4. Confirm the existing `.mpas` identity/key and Coordination configuration is
   sufficient; do not create a parallel CLI profile.
5. Add contract fixtures for pending, changed, expired, terminal, ineligible,
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

Do not persist fetched packages. Evaluation retrieves one current review set,
displays its digest, and signs that same in-memory envelope after confirmation.

Tests:

- canonical digest stability and mismatch rejection;
- expired and terminal package rejection;
- proposer/Maintainer identity separation;
- eligible and ineligible signer behavior;
- approve and reject Approval wire compatibility;
- Coordination success, duplicate, conflict, and network failures.

## Phase 2: Existing Configuration and Key Safety

1. Reuse the existing `.mpas` Maintainer identity/key and Coordination config;
   add no CLI-specific profile or package cache.
2. Reuse the existing key parser; add public identity derivation and DID match
   validation if absent.
3. Keep signing in the signer server and add an unlock abstraction for
   password-protected keys using an operator prompt, OS keychain, or key agent.
4. Add POSIX ownership/type/mode checks and reject group- or world-readable
   private-key files. Document platform behavior where those checks are not
   available.
5. Centralize secret redaction for errors and JSON serialization.

Tests cover precedence, malformed config, missing keys, symlink/file-type
handling, unsafe modes, DID mismatch, and redaction.

## Phase 3: Read-only Commands

Add the command group and implement:

```text
mpas action pending [--json]
mpas action inspect <action-id> [--json]
```

Build one normalized inspection model used by table, detailed terminal, and
JSON renderers. Keep raw private/key data out of that model. Each invocation
performs one on-demand Coordination query; there is no periodic polling.

Tests cover empty lists, multiple applications, Unicode/large arguments,
redaction, stable JSON, transient failures, and interruption.

Exit criterion: a human can find and fully inspect a hosted pending Action
without any Coordination mutation.

## Phase 4: Interactive Decisions

Implement:

```text
mpas action evaluate <action-id>
```

The command:

1. asks the signer server to fetch and validate the current review set;
2. render the normalized inspection view;
3. show decision, Action ID, application, operation, and digest in the prompt;
4. require an attached interactive terminal and an explicit Approve, Reject,
   or Cancel decision;
5. bind the decision to the displayed Action ID and digest;
6. have the signer server sign that exact in-memory envelope;
7. submit it and fail on stale or terminal Coordination state;
8. print the Coordination receipt and resulting state.

Do not add `--yes` or accept confirmation from redirected stdin. Treat EOF,
SIGINT, and negative input as no submission.

Tests use an injectable prompt/terminal interface and cover affirmative,
negative, EOF, interruption, non-TTY, stale-hash response, expiration race,
duplicate Approval, rejected submission, and key-unlock failure.

## Phase 5: Signer-server Convergence

Refactor the existing MCP signer server to own the shared Maintainer service,
private-key unlock, validation, hashing, Approval construction, and submission.
Expose an evaluation operation for the human CLI; explicit approve/reject may
remain internal service operations for non-interactive automation.

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
- The signer server signs only the freshly retrieved envelope whose digest was
  displayed and explicitly confirmed; the CLI never possesses the private key
  or retains the package.
- Hosted SignerSet and localhost Coordination flows are documented and tested.
- No private key material or application credential is exposed in output,
  fixtures, logs, or repository history.
