# Conformance

This folder will contain the official MPAS conformance tools. Implementers test their MPAS implementation against these tools to validate correctness.

## Conformance Model

The conformance framework defines three test roles:

### Conformance Proposer

Submits well-formed action packages to an adapter under test and verifies correct handling:

- Valid packages are dispatched and produce execution receipts
- Invalid packages are rejected with appropriate error responses
- Policy evaluation produces correct authorization requirements

### Conformance Approver

Exercises the approval flow against a coordination service under test:

- Submits pending actions and verifies they appear for approval
- Signs approvals and verifies they are accepted
- Verifies self-approval is rejected
- Verifies threshold satisfaction triggers resolution

### Conformance Verifier

Validates the cryptographic and policy behavior of an adapter under test:

- Signature verification (valid signatures accepted, invalid rejected)
- Payload hash binding (mismatches rejected)
- Envelope expiration enforcement
- Dispatch ledger behavior (replay protection, at-most-once dispatch)
- Execution receipt correctness (proper signing, required fields)

## Status

Placeholder. The conformance tools and certification program are future work. The subfolder structure will be defined when implementation begins.
