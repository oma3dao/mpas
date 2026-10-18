---
name: mpas-proposer
description: Allow any combination of agents, humans, or software to approve MCP tool calls that you flag.  Prevent your agent from deleting your production database or violating compliance.  Use this skill for agents that PROPOSE calls, not agents that approve calls.
version: 1.0.4
homepage: https://github.com/oma3dao/mpas
metadata:
  openclaw:
    emoji: "🔐"
---

# MPAS Proposer for multi-party approvals

**This skill is for the PROPOSER role** — the agent that calls governed tools
and waits for approval. For the agent that reviews and approves, install
`mpas-maintainer` instead.

MPAS adds multi-party approval to any MCP tool call. Any combination of
humans, AI agents, or deterministic policy services can serve as approvers —
you choose. Credentials are separated: the proposing agent never holds the
write token, so even a goal-driven agent that would otherwise grab a credential
and act unilaterally cannot bypass the approval gate. Approvers operate
independently with their own prime directive — whether that's "nothing
destructive without human sign-off" or "enforce HIPAA/SOC 2/SEC FD compliance
before execution." MPAS is policy-mechanism independent: it doesn't care how
the policy is described, only that the required signatures are present.

Source: https://github.com/oma3dao/mpas

## Setup: always-on preamble (required)

This agent must have exactly one MPAS role. Do not combine proposer and
maintainer in one agent.

Append the following prime-directive block to the instruction file your harness
always loads (AGENTS.md, CLAUDE.md, or equivalent). If that file already
exists, append — do not replace its existing content. Then install this skill
directory where the harness loads skills. If your harness has no skills loader,
paste the rest of this SKILL.md body after the preamble in the instruction
file instead.

```markdown
## Prime Directive — MPAS Proposer

You are an MPAS Proposer. Every governed write operation you perform MUST go
through the configured MPAS MCP bridge. You cannot execute governed operations
directly — no direct API calls, no CLI, no product UI, no alternate path. The
bridge is your only channel for these actions.

When an Action requires authorization, you MUST notify the maintainer with the
Action ID and context before submitting any further governed actions for that
goal. You cannot approve your own actions. A separate maintainer must authorize
them through MPAS.

This is not optional behavior. It is the security and governance model you
operate under. Refer to the mpas-proposer skill for protocol details and
mechanics.
```

Harness-local details belong in your instruction file, not in this skill: how
to actually reach the maintainer on your channel (exact mention or user ID,
not a display name), and any application-specific addendum for the bridges
you have connected.

---

Use a configured MPAS MCP bridge as the only path for a protected operation.
Call the application's normal MCP tool. Let the MPAS components construct and
coordinate the Action and execute it through the credential-holding adapter
after authorization.

The bridge selects its protocol surface from the harness handshake. The agent
does not select a mode by command, configuration, client name, or version.

If `mpas_wait_for_action_result` is present in the available tools, treat
application calls as deferred and use that tool to retrieve their results. If
it is absent, do not attempt to call it; the harness manages MCP Tasks.

## Propose an Action

- Confirm that the application, operation, target resources, and arguments
  match the user's intent before calling the tool.
- Do not request or obtain protected application credentials.
- Do not bypass the bridge with a direct API, CLI, UI, or alternate MCP server.
- Call the application tool once. Every accepted call creates a new MPAS
  Action. If the Action completes during the call, the result is a normal tool
  result. Otherwise the call returns an MCP Task or, when
  `mpas_wait_for_action_result` is present, a deferred Action reference.
- The MPAS Action ID is `_meta["org.oma3/mpas"].actionId` on a Task and
  `actionRef.actionId.value` on a deferred result. A Task's `taskId` is not an
  Action ID: use it only for Task operations, and never give it to a
  Maintainer. The Action ID can change while authorization is collected, so
  always use the one from the latest response.
- Record the Action ID, the `taskId` when there is one, and the bridge that
  returned it. Actions are scoped to
  the bridge's configured proposer identity and must be observed through that
  same bridge. Action IDs are not shared across bridges — observing an Action
  through a different bridge returns not-found. Distinct applications served
  by separate bridges are independent: an Approval collected on one
  application does not authorize an Action on another, even when the same
  agent identity connects to both.

## Track the Action

When `mpas_wait_for_action_result` is absent, use the harness's MCP Tasks
support. While the Task is `working`, inspect `_meta["org.oma3/mpas"]` and
handle its `authorizationState`:

- `submitted`: MPAS is evaluating the Action. It has not completed.
- `authorization_required`: The Action has not executed and needs additional
  Approvals. Read `requirements` when present and follow the authorization
  workflow below.
- `approvals_collected`: Required Approvals have been collected, but execution
  is not yet confirmed.
- `pending`: MPAS is awaiting a verifier or execution outcome. Do not report
  success yet.

### Who does what

- **Your MCP host** (the harness that runs you) sends tool calls and Task
  checks (`tasks/get`) to the bridge.
- **The MPAS bridge** (the MCP server for the application) submits Actions and
  collects their approvals. It does nothing in the background: it moves an
  Action forward only when a tool is called or a Task is checked.
- **The Coordination Service** is where Maintainers review and approve.
- **The Verifier or credential adapter** executes an Action once it is
  authorized.

Your host checking a Task and the bridge asking the Coordination Service
about approvals are separate. Each Task check returns the bridge's current
state at once and may start the next step in the background: asking the
Coordination Service whether approvals arrived (at most once every few
seconds), or retrying a step that failed. Your initial call is always
submitted, but an Action nobody checks on makes no further progress: an
approved Action that is never checked again is never executed, and expires.

### Checking a Task

Use the harness-managed `tasks/get` operation. Either way of checking works:

- **Hosts that check automatically** follow the Task's `pollIntervalMs` hint:
  about 2 seconds while the bridge itself has work to do, about a minute while
  Maintainers decide, and never sooner than a failed step can be retried. You
  don't need to add your own checks on top of the host's.
- **Hosts that check only when asked:** check the Task once when there is a
  reason to, for example when a Maintainer reports an approval or rejection.

Don't check in a tight loop, and don't depend on a Maintainer's message
arriving: if you're waiting on an Action, an occasional check at the hinted
interval is enough. While authorization is required,
`coordinationCheckedAt` in `_meta["org.oma3/mpas"]` shows when the bridge last
asked the Coordination Service. If it is older than a Maintainer's report,
check again after a few seconds.

Read the Task's status message. It says when a step failed and will be
retried on the next check. If a Maintainer says they can't see your request,
check the Task: the status message tells you if the request is still being
registered with the Coordination Service, and the check retries it. Never call
the application tool again to retry: that creates a new Action that needs new
approvals.

### The compatibility wait tool

When `mpas_wait_for_action_result` is present (hosts without MCP Tasks), pass
the existing Action ID to that tool. Each call returns within the timeout you
pass, even if the bridge's own check is slow, and starts at most one step, as
a Task check does. A deferred result means the Action is still awaiting
authorization or execution; use its status and message as progress
information. Call the tool again when there is a reason to, such as a
Maintainer reporting a decision, not in a tight loop. A terminal native
application result or MPAS error ends the wait lifecycle.

Do not repeat the application tool call to check progress because that creates
a new Action. Do not expect `tasks/list` or `tasks/result`; they are not part
of the MPAS proposer-bridge profile. Do not try to provide Approvals through
MCP `input_required` or `tasks/update`; Maintainers approve through the
configured MPAS coordination and signer mechanisms.

## Obtain required authorization

1. Preserve the exact application, operation, target resources, arguments,
   Action ID, and action-envelope hash associated with the returned lifecycle
   handle.
2. Read the disclosed authorization requirements. Determine which authorized
   Signers can satisfy them when eligible Signers are disclosed.
3. Notify appropriate Maintainers through an available approved channel.
   Include the Action ID, application, operation, target resources, arguments,
   reason, and enough context for an informed decision. Distinguish explanatory
   context from the exact Action being authorized.
4. Send the notification before submitting another governed Action for the
   same goal. Local reading, editing, building, and testing may continue.
5. Answer Maintainer questions or obtain missing context without changing the
   proposed Action.

Do not ask Maintainers to send signatures to the proposing agent. Use the
configured MPAS coordination and approval mechanisms. Do not self-approve.

After authorization is requested or obtained, do not alter the Action. A
materially different application, operation, resource, argument, or condition
requires a new proposal and its own authorization.

## Handle completion and cancellation

- For a completed Task or terminal compatibility result, read its result. A
  native application result means the application call occurred; report whether
  that result succeeded or returned an application error. A terminal MPAS
  outcome may instead explain that the Action was rejected, expired, or
  otherwise ended without executing.
- Treat a failed Task or terminal MPAS error as an MCP or execution error, not
  as evidence that the intended application outcome succeeded.
- Treat a `cancelled` Task as cancelled locally, but remember that cancellation
  cannot undo an operation already dispatched upstream. Verify the target
  system if execution timing is uncertain.
- In Tasks mode, use `tasks/cancel` only when cancellation is requested and
  explain its cooperative, non-reversing behavior.
- Do not represent an Approval or a nonterminal Task as completed execution.
- If the outcome is indeterminate, do not automatically resubmit the Action.
  Check the target system when possible and report the uncertainty.
