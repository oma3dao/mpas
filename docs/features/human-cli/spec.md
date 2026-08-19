# Human Maintainer CLI

**Status:** Draft

**Created:** 2026-08-18

**Issue:** #50

**Companion:** [plan.md](./plan.md)

---

## 1. Purpose

Provide a first-class command-line workflow for a human Maintainer to discover,
inspect, approve, or reject MPAS Action Packages without running an agent or an
MCP signer server.

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
3. Approve or reject an Action after explicit human confirmation.
4. Sign the exact canonical Action Envelope received from Coordination.
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
mpas action approve <action-id>
mpas action reject <action-id> [--reason <text>]
```

Short aliases may be added later, but documentation and stable automation use
the names above.

### 5.1 `action pending`

Lists pending Action Packages visible to and eligible for the configured
Maintainer. The default table includes Action ID, application DID, proposer
DID, operation, creation time, and expiry. `--json` emits structured read-only
output. `--watch` polls using a bounded configurable interval and stops cleanly
on SIGINT.

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

### 5.3 `action approve`

Fetches the current package, validates it, renders the inspection view, and
requires an explicit confirmation. On confirmation, it builds an `approve`
Approval over the package's exact Action Envelope and submits it to
Coordination.

### 5.4 `action reject`

Uses the same validation and confirmation flow, but builds a `reject`
Approval. A human-readable reason is recorded when the protocol and
Coordination API support it. The CLI must not imply that rejection cancels or
rolls back an operation already dispatched.

## 6. Configuration

Configuration precedence is:

1. command flags;
2. environment variables intended for the CLI;
3. a named MPAS Maintainer configuration under `~/.mpas`;
4. documented defaults.

The resolved configuration contains:

- Coordination Service URL;
- Maintainer DID;
- Maintainer private-key file;
- optional HTTP authentication/signing configuration;
- polling interval and network timeout.

The CLI MUST NOT print private key material. It MUST fail closed when the key
file is group- or world-readable on platforms where POSIX permission checks
are available. The key's public identity MUST match the configured Maintainer
DID before any signing operation.

## 7. Approval Safety Model

### 7.1 Exact package binding

The CLI MUST retain the package returned by Coordination and pass its Action
Envelope directly to the SDK Approval builder. It MUST NOT reconstruct the
signed object from the human-readable rendering.

Immediately before signing, the CLI MUST:

1. fetch the current package;
2. validate its schema and signatures as required by the MPAS profile;
3. canonicalize and hash the Action Envelope using the SDK implementation;
4. confirm that the displayed digest equals the digest being signed;
5. confirm that the Action has not expired;
6. confirm Maintainer eligibility and reject self-approval;
7. obtain explicit confirmation for that Action ID, decision, and digest.

If the package or digest changes between display and signing, confirmation is
invalidated and the CLI restarts the review flow.

### 7.2 Interactive confirmation

Approval and rejection are interactive by default. The prompt states the
decision, Action ID, application, operation, and digest. Empty input, EOF, or
an interrupted terminal means no decision is submitted.

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

The CLI layer owns argument parsing, configuration resolution, terminal
rendering, prompts, polling, redaction, and exit-code mapping. The existing MCP
signer server should consume the same service layer where practical so both
interfaces produce equivalent Approvals.

## 10. Acceptance Criteria

- A configured human Maintainer can list and inspect eligible pending Actions.
- Inspect performs no remote mutation.
- Approve and reject show the complete review view and require confirmation.
- The signed Approval binds to the exact canonical Action Envelope and digest
  shown to the user.
- Changed, expired, malformed, ineligible, and self-proposed Actions fail
  closed without submitting an Approval.
- Unsafe key permissions and DID/key mismatches block signing.
- Approval submission interoperates with both the reference Coordination
  Service and hosted SignerSet service.
- Unit and integration tests cover canonical integrity, confirmation,
  redaction, expiry/change races, identity checks, and Coordination responses.
- Setup and command usage are documented for a human Maintainer.

