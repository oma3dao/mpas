---
name: mpas-proposer
description: Allow any combination of agents, humans, or software to approve MCP tool calls that you flag.  Prevent your agent from deleting your production database or violating compliance.  Use this skill for agents that PROPOSE calls, not agents that approve calls.
version: 1.0.0
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

---

Use a configured MPAS MCP bridge as the only path for a protected operation.
Call the application's normal MCP tool. Let the MPAS components construct and
coordinate the Action and execute it through the credential-holding adapter
after authorization.

Require the MCP client to support the official `io.modelcontextprotocol/tasks`
extension and the `org.oma3/mpas` profile extension. Let the client negotiate
those extensions. If it cannot, report the incompatibility instead of trying
to emulate the MPAS Task lifecycle.

## Propose an Action

- Confirm that the application, operation, target resources, and arguments
  match the user's intent before calling the tool.
- Do not request or obtain protected application credentials.
- Do not bypass the bridge with a direct API, CLI, UI, or alternate MCP server.
- Call the application tool once. Every accepted call creates a new MPAS Action
  and returns an MCP Task; the `taskId` is also the MPAS Action ID.
- Record the Task ID and the bridge that returned it. Tasks are scoped to the
  bridge's configured proposer identity and must be observed through that same
  bridge. Task IDs are not shared across bridges — observing a Task through a
  different bridge returns not-found. Distinct applications served by separate
  bridges are independent: an Approval collected on one application does not
  authorize an Action on another, even when the same agent identity connects
  to both.

## Track the MCP Task

While the Task is `working`, inspect `_meta["org.oma3/mpas"]` and handle its
`authorizationState`:

- `submitted`: MPAS is evaluating the Action. It has not completed.
- `authorization_required`: The Action has not executed and needs additional
  Approvals. Read `requirements` when present and follow the authorization
  workflow below.
- `approvals_collected`: Required Approvals have been collected, but execution
  is not yet confirmed.
- `pending`: MPAS is awaiting a verifier or execution outcome. Do not report
  success yet.

Use the client's `tasks/get` operation to observe the existing Task. Treat it
as read-only: polling does not advance the MPAS workflow, and the bridge
continues coordination and resubmission independently. Respect the Task's
polling and retention hints; continuous polling is unnecessary.

Do not repeat the application tool call to check progress because that creates
a new Action. Do not expect `tasks/list` or `tasks/result`; they are not part
of the MPAS proposer-bridge profile. Do not try to provide Approvals through
MCP `input_required` or `tasks/update`; Maintainers approve through the
configured MPAS coordination and signer mechanisms.

## Obtain required authorization

1. Preserve the exact application, operation, target resources, arguments,
   Action ID, and action-envelope hash associated with the Task.
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

- For a `completed` Task, read its result. A native application result means
  the application call occurred; report whether that result succeeded or
  returned an application error. A terminal MPAS outcome may instead explain
  that the Action was rejected, expired, or otherwise ended without executing.
- Treat a `failed` Task as a stored MCP or execution error, not as evidence that
  the intended application outcome succeeded.
- Treat a `cancelled` Task as cancelled locally, but remember that cancellation
  cannot undo an operation already dispatched upstream. Verify the target
  system if execution timing is uncertain.
- Use `tasks/cancel` only when cancellation is requested and explain its
  cooperative, non-reversing behavior.
- Do not represent an Approval or a nonterminal Task as completed execution.
- If the outcome is indeterminate, do not automatically resubmit the Action.
  Check the target system when possible and report the uncertainty.
