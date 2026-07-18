# Conformance

This folder will contain the official MPAS conformance tools. Implementers test their MPAS implementation against these tools to validate correctness.

## Scope: Conformance vs. Application CI

Conformance tests are **protocol-level and implementation-agnostic**: they validate any MPAS implementation — any credential adapter, coordination service, or bridge, from any vendor — against the specifications (hash binding, duplicate-key rejection, lifecycle semantics, result codes). They know nothing about any particular application.

They are distinct from the **application-level test harnesses** (compatibility and approval harnesses, hosted with production implementations in `oma3/mpas-applications`), which validate that one specific generated bridge is a faithful drop-in for one specific upstream server. When conformance tools exist, application CI runs the relevant conformance suite as one additional stage; the two layers do not merge. See `docs/features/bridge-generator/spec.md` §1.2.

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
