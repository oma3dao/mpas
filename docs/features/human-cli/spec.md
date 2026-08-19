# Human Maintainer CLI

**Status:** Draft

**Created:** 2026-08-18

**Issue:** #50

**Companion:** [plan.md](./plan.md)

---

## 1. Purpose

Provide a first-class command-line workflow for a human Maintainer to discover,
inspect, and evaluate MPAS Actions without running an agent harness. The CLI is
a human interface to the existing signer server, which continues to own the
Maintainer key and perform signatures.

The CLI uses the same MPAS Coordination Service, Maintainer identity, signing
key, wire formats, and authorization rules as existing automated Maintainers.
It is a user interface over the protocol, not an alternate approval path.

## 2. Problem

MPAS includes proposer bridges and an MCP-based Maintainer flow, but a human
operator currently needs an agent harness to exercise that flow. This creates
unnecessary operational complexity and leaves no simple way to review a
pending action from a terminal.

A human-facing tool must make the authorization decision understandable while
preserving the protocol property that an Approval signs the exact Action
Envelope supplied by Coordination.

## 3. Goals

1. List pending Action Packages that the configured Maintainer is eligible to
   review.
2. Inspect an Action Package without signing or changing remote state.
3. Evaluate an Action and choose approve or reject after explicit confirmation.
4. Have the signer server sign the exact canonical Action Envelope most
   recently retrieved from Coordination.
5. Reuse SDK protocol, canonicalization, signing, and Coordination client code.
6. Provide safe defaults, actionable errors, and scriptable read-only output.

## 4. Non-goals

- Replacing the Coordination Service or Credential Adapter.
- Letting a Proposer approve its own Action.
- Storing application credentials or dispatching application operations.
- Editing an Action Package before approval.
- Automatically approving based on local policy.
- Providing a graphical interface.
- Supporting unattended approval in the initial release.

## 5. Command Surface

The commands are exposed under the existing `mpas` executable:

```text
mpas action pending
mpas action inspect <action-id>
mpas action evaluate <action-id>
```

Short aliases may be added later, but documentation and stable automation use
the names above.

### 5.1 `action pending`

Lists pending Action Packages visible to and eligible for the configured
Maintainer. The default table includes Action ID, application DID, proposer
DID, operation, creation time, and expiry. `--json` emits structured read-only
output. The initial release performs one on-demand query per invocation and has
no watch or periodic-polling mode.

### 5.2 `action inspect`

Fetches one Action Package and displays:

- Action ID and Action Envelope digest;
- proposer DID and application DID;
- operation/tool name;
- target resources and exact arguments;
- creation and expiration timestamps;
- existing Approvals and disclosed authorization requirements;
- whether the configured Maintainer is eligible to approve;
- the package's current Coordination state.

Inspection never creates an Approval.

### 5.3 `action evaluate`

Asks the signer server to fetch and validate the current review set, prints the
complete material and envelope digest that will be signed, and prompts the
human to choose Approve, Reject, or Cancel. The signer server signs that exact
retrieved envelope with the selected decision and submits it to Coordination.
A rejection reason is recorded when supported.

## 6. Configuration

The CLI reuses the Maintainer's existing `.mpas` files and signer-server
configuration. It introduces no second profile, per-application configuration,
package cache, or approval database. The signer server needs only the existing
Maintainer identity/key material and Coordination Service URL.

The CLI MUST NOT read or print private key material. The signer server owns key
loading, DID checks, file-permission checks, and unlocking. Password-protected
keys are unlocked by the signer server through an operator prompt, OS keychain,
or equivalent key agent; passwords are never command arguments or tool output.

## 7. Approval Safety Model

### 7.1 Exact package binding

The CLI and signer server MUST NOT retain an Action Package between commands.
Each invocation retrieves the latest review set. The signer server passes its
Action Envelope directly to the SDK Approval builder and MUST NOT reconstruct
the signed object from the human-readable rendering.

Before signing, the signer server MUST:

1. fetch the current package;
2. validate its schema and signatures as required by the MPAS profile;
3. canonicalize and hash the Action Envelope using the SDK implementation;
4. confirm that the displayed digest equals the digest being signed;
5. confirm that the Action has not expired;
6. confirm Maintainer eligibility and reject self-approval;
7. obtain explicit confirmation for that Action ID, decision, and digest.

The display and decision use one freshly retrieved in-memory review set. The
signer signs only the displayed digest. A stale hash, expiry, or non-pending
Coordination response fails closed and requires a new evaluation.

### 7.2 Interactive confirmation

Evaluation is interactive. The prompt states the Action ID, application,
operation, and digest and offers Approve, Reject, or Cancel. Empty input, EOF,
or an interrupted terminal means no decision is submitted.

The initial release has no `--yes`, piped-confirmation, or unattended signing
mode. Read-only commands may be used noninteractively.

### 7.3 Terminal and duplicate states

The CLI treats already resolved, rejected, cancelled, expired, or otherwise
terminal Actions as non-approvable. A duplicate Approval response is reported
accurately and never described as a new successful approval.

## 8. Output and Errors

Human output goes to stdout; diagnostics and warnings go to stderr. Secrets
and private key fields are always redacted. Read-only commands support JSON.
Mutating commands return a concise Coordination receipt containing the Action
ID, decision, signer DID, and resulting workflow state when available.

The CLI uses nonzero exit codes for invalid configuration, unsafe key
permissions, identity mismatch, ineligible signer, malformed or changed
package, expiration, declined confirmation, network failure, and Coordination
rejection. Errors distinguish retryable connectivity failures from permanent
authorization failures.

## 9. Architecture

Protocol behavior lives in reusable SDK modules:

- Coordination client operations for listing and retrieving pending packages
  and submitting Approvals;
- Action Package validation and canonical hashing;
- key loading and DID consistency checks;
- `ApprovalBuilder` signing for `approve` and `reject` decisions.

The CLI layer owns argument parsing, terminal rendering, the interactive
decision prompt, redaction, and exit-code mapping. It never possesses the
private key. The signer server owns fresh retrieval, key unlocking, validation,
signing, and submission.

## 10. Acceptance Criteria

- A configured human Maintainer can list and inspect eligible pending Actions.
- Inspect performs no remote mutation.
- Evaluate shows the complete fresh review view and requires an explicit
  approve/reject/cancel decision.
- The signed Approval binds to the exact canonical Action Envelope and digest
  shown to the user.
- Changed, expired, malformed, ineligible, and self-proposed Actions fail
  closed without submitting an Approval.
- Existing `.mpas` configuration is sufficient and the CLI retains no package.
- Unsafe key permissions, unlock failures, and DID/key mismatches block signing.
- Approval submission interoperates with both the reference Coordination
  Service and hosted SignerSet service.
- Unit and integration tests cover canonical integrity, confirmation,
  redaction, expiry/change races, identity checks, and Coordination responses.
- Setup and command usage are documented for a human Maintainer.
