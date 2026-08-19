# Implementation Plan: Human Maintainer CLI

**Spec:** [spec.md](./spec.md)

**Issue:** #50

**Created:** 2026-08-18

---

## Scope and Constraints

Implement an interactive CLI for human Maintainers as a client of the existing
signer-server MCP tools. Do not duplicate signer, key, or Coordination logic.
Do not introduce an unattended approval mode in this feature.

## Phase 0: Contract and Code Audit

1. Record the schemas of `mpas_list_pending`, `mpas_review_action`,
   `mpas_approve`, and `mpas_reject`.
2. Define a small typed MCP client adapter for those existing tools.
3. Confirm the existing signer-server registration and `.mpas` configuration
   are sufficient; do not create a parallel CLI profile.
4. Add tool-response fixtures for pending, terminal, malformed, and failed
   requests.

Exit criterion: the CLI needs no signer SDK or direct Coordination dependency.

## Phase 1: Signer Tool Client

Add an MCP client adapter that invokes the four existing signer tools and
normalizes their structured results for terminal rendering. Do not persist
review sets or implement validation, hashing, signing, or submission.

Tests:

- tool discovery and missing-tool errors;
- structured result parsing and malformed responses;
- approve/reject argument forwarding;
- signer-server success and failure propagation.

## Phase 2: Existing Configuration

1. Reuse the existing signer-server MCP registration and `.mpas` files.
2. Add no CLI-specific identity, key, Coordination, or package-cache settings.
3. Centralize redaction for tool errors and JSON serialization.

Tests cover missing signer-server registration, unavailable tools, and
redaction. Key and signer configuration remain covered by signer-server tests.

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
mpas action review <action-id>
```

The command:

1. calls `mpas_review_action` for the Action ID;
2. render the normalized inspection view;
3. show decision, Action ID, application, operation, and digest in the prompt;
4. require an attached interactive terminal and an explicit Approve, Reject,
   or Cancel decision;
5. call `mpas_approve` or `mpas_reject` with the displayed Action ID;
6. print the signer tool's result and resulting state.

Do not add `--yes` or accept confirmation from redirected stdin. Treat EOF,
SIGINT, and negative input as no submission.

Tests use an injectable prompt/terminal interface and cover affirmative,
negative, EOF, interruption, non-TTY, approve/reject tool failures, and
malformed tool responses.

## Phase 5: Compatibility Verification

Do not modify the signer server. Add compatibility tests proving the CLI uses
the same tool names, schemas, and decision calls as an agent Maintainer.

## Phase 6: End-to-end Verification

Run two end-to-end suites:

1. reference localhost Coordination Service with generated test identities;
2. hosted SignerSet staging/test environment with HTTP authentication enabled.

Verify pending -> inspect -> review/approve -> proposer execution and pending ->
review/reject -> terminal rejection through the existing signer tools. Also
verify cancellation, unavailable tools, malformed results, and signer-server
error propagation.

No test may print or commit private keys.

## Phase 7: Documentation and Release

1. Add human Maintainer setup instructions that reuse the existing signer MCP
   registration, plus command examples and troubleshooting.
2. Document the exact approval security model and the absence of unattended
   signing.
3. Add shell completion entries for the command group without completing
   secrets or private paths.
4. Add release notes and confirm package/executable installation paths.
5. Link the implementation PR and final command names from issue #50.

## Definition of Done

- All acceptance criteria in [spec.md](./spec.md) pass.
- CLI tool-client and end-to-end tests pass in CI.
- The CLI calls existing signer tools, never possesses the private key, and
  retains no Action Package.
- Hosted SignerSet and localhost Coordination flows are documented and tested.
- No private key material or application credential is exposed in output,
  fixtures, logs, or repository history.
