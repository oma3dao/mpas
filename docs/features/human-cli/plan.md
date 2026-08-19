# Implementation Plan: Human Maintainer CLI

**Spec:** [spec.md](./spec.md)

**Issue:** #50

**Created:** 2026-08-18

**Status:** Implemented on `feat/human-maintainer-cli`

---

## Scope and Constraints

Implement an interactive CLI for human Maintainers as a client of the existing
signer-server MCP tools. Do not duplicate signer, key, or Coordination logic.
Do not introduce an unattended approval mode in this feature.

## Phase 0: Contract and Code Audit

1. Record the schemas of `mpas_list_pending`, `mpas_review_action`,
   `mpas_approve`, and `mpas_reject`.
2. Define a small typed MCP client adapter with minimum structured-response
   validation for those existing tools.
3. Confirm the existing signer-server registration and `.mpas` configuration
   are sufficient; do not create a parallel CLI profile.
4. Add tool-response fixtures for pending, terminal, malformed, and failed
   requests.

Exit criterion: the CLI needs no signer SDK or direct Coordination dependency.

## Phase 1: Signer Tool Client

Add an MCP client adapter that invokes the four existing signer tools and
validates the minimum structured shape needed for raw JSON rendering. Do not
persist review sets or implement cryptographic validation, hashing, signing,
eligibility, or submission.

Tests:

- tool discovery and missing-tool errors;
- structured result parsing and malformed responses;
- approve/reject argument forwarding;
- signer-server success and failure propagation.

## Phase 2: Existing Configuration

1. Reuse the existing signer-server MCP registration and `.mpas` files.
2. Add no CLI-specific identity, key, Coordination, or package-cache settings.
3. Preserve signer-server stderr diagnostics while keeping MCP stdout isolated.

Tests cover missing signer configuration, unavailable tools, and visible
startup/configuration diagnostics. Redaction remains a signer-server concern.

## Phase 3: Read-only Commands

Add the command group and implement:

```text
mpas action pending
mpas action inspect <action-id>
```

Print each signer tool's structured result as readable JSON by default. Do not
add a normalized output model, table renderer, or CLI redaction layer. Each
invocation performs one on-demand query; there is no periodic polling.

Tests cover empty lists, malformed structured results, tool errors, and
interruption.

Exit criterion: a human can find and fully inspect a pending Action without any
Coordination mutation.

## Phase 4: Interactive Decisions

Implement:

```text
mpas action review <action-id>
```

The command:

1. calls `mpas_review_action` for the Action ID;
2. validate matching Action IDs and render the raw structured review JSON;
3. show the Action ID in the prompt immediately after that JSON;
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

## Phase 6: Integration Verification

Exercise the real CLI MCP client against the real signer server over stdio and
a local Coordination fixture. Verify cancellation, unavailable tools, malformed
results, signer diagnostics, and signer-server error propagation. Hosted
SignerSet and full proposer-to-execution end-to-end behavior are separate work.

No test may print or commit private keys.

## Phase 7: Documentation and Release

1. Add human Maintainer setup instructions that reuse the existing signer MCP
   registration, plus command examples and troubleshooting.
2. Document the exact approval security model and the absence of unattended
   signing.
3. Link the implementation PR and final command names from issue #50.

## Definition of Done

- All acceptance criteria in [spec.md](./spec.md) pass.
- CLI tool-client and real-stdio integration tests pass in CI.
- The CLI calls existing signer tools, never possesses the private key, and
  retains no Action Package.
- The CLI documents that signer responses are emitted as readable JSON and that
  the signer server owns response redaction.
