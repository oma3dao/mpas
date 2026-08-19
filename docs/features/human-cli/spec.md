# Human Maintainer CLI

**Status:** Implemented

**Created:** 2026-08-18

**Issue:** #50

**Companion:** [plan.md](./plan.md)

---

## 1. Purpose

Provide a first-class command-line workflow for a human Maintainer to discover,
inspect, and review MPAS Actions without running an agent harness. The CLI is
an interactive client for the existing signer-server MCP tools.

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
3. Review an Action and choose approve or reject after explicit confirmation.
4. Reuse the same `mpas_review_action`, `mpas_approve`, and `mpas_reject` tool
   calls used by agent Maintainers.
5. Add no alternate signing or Coordination implementation to the CLI.
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
mpas action review <action-id>
```

Short aliases may be added later, but documentation and stable automation use
the names above.

### 5.1 `action pending`

Lists pending Action Packages visible to and eligible for the configured
Maintainer. It prints the signer tool's structured result as readable JSON by
default. The initial release performs one on-demand query per invocation and
has no watch or periodic-polling mode.

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

### 5.3 `action review`

Calls `mpas_review_action`, prints the complete returned review material, and
prompts the human to choose Approve, Reject, or Cancel. Approve calls the
existing `mpas_approve` tool; Reject calls `mpas_reject`; Cancel makes no tool
call.

## 6. Configuration

The CLI uses the existing signer-server MCP registration and `.mpas`
configuration. It introduces no second profile, per-application configuration,
package cache, approval database, key setting, or Coordination setting.

## 7. Approval Safety Model

### 7.1 Exact package binding

The CLI retains no Action Package between commands. `inspect` and `review`
always call `mpas_review_action` and render the returned review set. After the
human confirms the displayed Action ID and decision, the CLI calls exactly one
existing decision tool with that Action ID. The CLI validates the minimum
response shape and checks that returned Action IDs match the requested ID.
Cryptographic verification, eligibility, signing, freshness, and submission
remain signer-server responsibilities and are not reimplemented by the CLI.

### 7.2 Interactive confirmation

Review is interactive. The complete review JSON is printed immediately before
the prompt, which states the Action ID and offers Approve, Reject, or Cancel.
Empty input, EOF, or an interrupted terminal means no decision is submitted.

The initial release has no `--yes`, piped-confirmation, or unattended signing
mode. Read-only commands may be used noninteractively.

### 7.3 Terminal and duplicate states

The signer server determines whether an Action is eligible or terminal. The CLI
prints its structured result or reports its tool error without independently
reclassifying the Action.

## 8. Output and Errors

Signer tool results go to stdout as readable JSON by default; diagnostics and
warnings go to stderr. `action pending`, `action inspect`, and decision receipts
emit the structured response provided by the signer server. The signer server
controls which fields appear in those responses and is responsible for
redaction. The CLI performs no additional filtering and makes no independent
guarantee that arbitrary signer-server output is redacted.

The CLI uses nonzero exit codes for unavailable signer tools, invalid tool
responses, tool-call failures, and signer-server errors. Cancel is a successful
no-op; EOF and interruption fail without submitting a decision.

## 9. Architecture

The CLI is an MCP client adapter over the existing signer-server tools:

- `pending` calls `mpas_list_pending`;
- `inspect` and `review` call `mpas_review_action`;
- a confirmed review calls `mpas_approve` or `mpas_reject`.

The CLI owns argument parsing, raw structured-result rendering, the interactive
prompt, response-shape checks, and exit-code mapping. It does not import signer SDK internals,
access key material, call Coordination directly, or change the signer server.

## 10. Acceptance Criteria

- A configured human Maintainer can list and inspect eligible pending Actions.
- Inspect performs no remote mutation.
- Review shows the complete fresh review view and requires an explicit
  approve/reject/cancel decision.
- The CLI displays the `mpas_review_action` result before making a decision
  tool call for the same Action ID.
- Signer-server rejections and terminal states are reported without being
  rewritten as CLI success.
- Existing `.mpas` configuration is sufficient and the CLI retains no package.
- The CLI uses the same signer tool calls as Marvin and other agent Maintainers.
- Tool-client integration works with the existing signer server over stdio.
- Unit and integration tests cover tool discovery, response validation, result
  rendering, confirmation, cancellation, diagnostics, and tool-call failures.
- Setup and command usage are documented for a human Maintainer.
