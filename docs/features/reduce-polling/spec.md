# Reduce Proposer Bridge Polling and Bound Bridge Lifetime

**Status:** Draft

**Created:** 2026-10-16

**Depends on:** [MCP Tasks integration](../mcp-tasks/spec.md), [MPAS HTTP Profile](../../../specs/mpas-profile-http.md) §9.2

**Normative output:** a revision of [MPAS MCP Proposer Bridge Profile](../../../specs/mpas-profile-mcp-proposer-bridge-client.md) §6 and §9 (proposed text in §8 below)

**Companion:** plan.md (to be written after this specification is reviewed)

---

## 1. Purpose

Change how an MPAS proposer bridge talks to remote services so that:

1. A bridge polls the Coordination Service only when its client asks about a
   Task, never on a timer and never on its own initiative.
2. Remote retries (Verifier `pending`, transient failures) are paced and back
   off instead of repeating every tick.
3. A bridge process exits when its MCP client goes away, even while requests
   are in flight.

Together these make an idle or leaked bridge process cost nothing outside its
own host, the way a passive MCP server does.

---

## 2. Problem

### 2.1 Incident

On 2026-10-15 the production Coordination Service at `api.signerset.com`
became unavailable to maintainers. Approvals, review lookups and pending-work
listings returned HTTP 500 after about 20 seconds.

The traffic came from one host:

- An MCP host (OpenClaw, plus a Codex app-server it launched) had started nine
  copies of the GitHub proposer bridge over five days and never stopped the
  old ones. All nine shared one SQLite workflow store.
- The store held one Action awaiting approvals. Every copy polled
  `/mpas/v1/coordination/poll` every 2 seconds for it, about 4.5 requests per
  second in total.
- Each poll took about 20 seconds on the server at the time, so each copy had
  about ten polls in flight. Together they filled the API's 10-connection
  database pool, and other requests timed out.

The server-side locking defect that made each poll slow was fixed separately
in `signerset/mpas-coordination-server`. This specification addresses the
client side.

### 2.2 Bridge behavior that caused the load

- **Fixed timer.** `ProposerBridge.start()` runs `engine.pollOnce()` from
  `setInterval` every `pollIntervalMs` (default 2,000 ms)
  (`sdk/protocol/src/lib/bridge-runtime.ts`). It doesn't wait for the previous
  tick to finish, so slow responses stack up.
- **Polls whether or not anyone is waiting.** `pollOnce()` polls Coordination
  whenever any local workflow is `awaitingApprovals`
  (`sdk/protocol/src/lib/workflow-engine.ts`). Approvals are human-paced, and
  maintainers usually tell the proposer out of band when they approve or
  reject, so most of these polls find nothing new.
- **Retries repeat every tick.** The same tick re-submits Verifier `pending`
  work and retries transient adapter and Coordination failures, with no
  backoff and no `Retry-After` handling.
- **Every copy polls.** Processes that share a store each run their own timer.

The SDK already contains better building blocks that the bridge doesn't use.
`CoordinationServiceClient.runPollLoop()` polls sequentially with a 30-second
default, and the client supports the optional WebSocket notification session.

### 2.3 Bridge processes that never exit

The generated bridge entry point (`bridge-generator/src/bridge-codegen.ts`,
`runBridge`) and `cli/src/bridge/github-bridge.ts` connect a
`StdioServerTransport` but register no shutdown handling. A local experiment
on 2026-10-16, run against the alpha.14 GitHub bridge with a fake
Coordination Service, gave:

| Scenario | Result after stdin closed or signal sent |
|---|---|
| No pending work | Exited immediately |
| Pending approval, polls answered in 50 ms | Exited immediately |
| Pending approval, polls answered in 20 s | **Still running after 60 s**, about 10 polls in flight |
| SIGTERM or SIGINT, slow polls | Exited immediately, without closing the store |

The bridge exits on stdin EOF only when Node's event loop happens to be
empty. Overlapping in-flight polls keep it alive indefinitely.

In the incident, the old processes had sat idle for days. Had their stdin
been closed they would have exited, so the host most likely kept their
connections open. Exiting on EOF is still required hygiene. It is not
sufficient on its own, which is why §4 removes the background traffic
itself.

### 2.4 Cost

The Coordination Service may later limit or charge for API calls beyond a
free allowance. Every poll the bridge makes would then count against the
proposer's account. Polls that nobody asked for would cost money as well as
capacity.

---

## 3. Design Decisions

1. **Polls happen only when the client asks.** The bridge polls Coordination
   only when its client observes a Task: `tasks/get` or the compatibility
   wait tool. It never polls on a timer, at startup, or before an Action
   expires.
2. **Unobserved Actions are left to expire.** If nobody asks about an Action,
   the bridge doesn't find out that it was approved, and the Action expires.
   An agent that no longer wants an Action may cancel its Task. Either way,
   an approved Action executes only while its proposer is paying attention.
3. **Observation never blocks on the network.** `tasks/get` returns the local
   record immediately. A Coordination poll it triggers runs in the
   background, and a later `tasks/get` sees the result.
4. **Polling is rate-limited per process.** There is at most one Coordination
   poll in flight, and at most one every `coordinationRefreshMinIntervalMs`
   (default 10 seconds). A request inside that interval gets the last known
   state, labeled with the time it was last checked, rather than an error.
5. **Remote retries back off.** Verifier `pending` re-checks and transient
   failures use per-workflow exponential backoff with jitter and honor
   `Retry-After`.
6. **Local maintenance stays timed, remote work does not.** Expiration sweeps
   and result purging are local SQLite work and keep a slow timer.
7. **The bridge exits when its client leaves.** Stdin EOF, stdin close, an
   stdout write failure, SIGTERM, SIGINT and SIGHUP all trigger the same
   bounded, clean shutdown.
8. **No dependency on optional features.** Polling remains the interoperable
   baseline (HTTP profile §9.2, "Polling remains sufficient for
   interoperability"). WebSocket notification is future, optional work (§10).
9. **No cross-process poll lease.** A process nobody talks to makes no polls,
   so duplicate processes don't multiply load and coordinating between them
   is unnecessary. Existing submission claim leases still prevent double
   submission.
10. **Agents check when told.** Proposer agents are instructed to expect the
    maintainer to report an approval or rejection out of band, and to check
    the Task once when told (§8.3). The Task's polling hint becomes a slow
    fallback: 60 seconds.

---

## 4. Coordination Observation

### 4.1 Triggers

The bridge contacts Coordination in exactly these cases:

| Case | Coordination call | Rate-limited |
|---|---|---|
| `tasks/get` for a Task whose workflow is `awaitingApprovals` | `pollWork()` | Yes |
| `mpas_wait_for_action_result` for such a workflow | `pollWork()`, once when the call starts | Yes |
| A Verifier response requires approvals | `createApprovalWorkflow()` | No |
| `tasks/cancel` after Coordination started | Best-effort `cancelAction()` | No |

Nothing else polls Coordination. In particular:

- **No startup poll.** `start()` still runs reconciliation: it sweeps expired
  workflows and finishes any submission that was interrupted, such as a
  completed package in `readyForSubmission`. It doesn't poll Coordination.
- **No pre-expiry poll.** See decision 2.

A poll's `actionUpdates` are applied as today, which may move a workflow to
`readyForSubmission`. The completed package is then submitted through the
normal claimed submission path (§5).

The compatibility wait tool polls once when the call starts, subject to the
rate limit. It then waits on local state, as today, until the workflow
resolves or the wait times out. It doesn't poll again during the wait. An
agent that wants another check calls the tool again.

### 4.2 Rate Limit and Coalescing

Each bridge process keeps one poll state:

- **In flight.** If a poll is running, a new request attaches to it and starts
  nothing.
- **Minimum interval.** A request arriving less than
  `coordinationRefreshMinIntervalMs` (default 10,000 ms) after the previous
  poll *started* starts no poll.
- **Backoff.** While a failure backoff (§4.4) is active, requests start no
  poll.

A request that starts no poll still succeeds. It gets the current local state
and the time Coordination was last checked (§4.3).

One poll returns updates for every pending Action of this proposer, so all
pending Tasks share each poll.

This limit protects the Coordination Service from a single bridge process.
Protecting it from many processes or many proposers is a server-side
responsibility, such as per-DID rate limits. That is out of scope here (§10).

### 4.3 Observation Results

`handleTasksGet` builds the response from the local record and returns
without awaiting any network I/O. It may *start* a poll in the background.
That poll's results may advance the workflow, for example to
`readyForSubmission` and then to submission. Today's profile says `tasks/get`
"MUST NOT advance an MPAS workflow", so §8.2 revises that rule: the response
itself still reflects only local state and never waits, but it may trigger
the rate-limited poll.

For a workflow in `awaitingApprovals`, the `org.oma3/mpas` metadata in
`tasks/get` and compatibility wait results adds:

```json
"coordinationCheckedAt": "2026-10-16T10:05:00Z"
```

This is when the most recent *successful* poll completed, or null if this
process hasn't polled since it started. It tells the agent how fresh the
state is. An agent told by a maintainer that an approval was just submitted
can tell whether the answer it sees predates that approval.

### 4.4 Failure Backoff

A poll fails when `pollWork()` throws a retryable error (timeout, network
failure, 408, 425, 429 or 5xx). After a failure:

- delay = `min(cap, base × 2^(failures − 1))` with full jitter, using base
  5,000 ms and cap 300,000 ms;
- a `Retry-After` header, when present, sets the delay instead, capped at
  900,000 ms;
- a successful poll resets the failure count.

A 429 counts the same as other retryable errors. If the Coordination Service
later meters API calls, its limit responses slow the bridge down rather than
being retried immediately.

Permanent failures keep today's handling: affected workflows resolve
`unresolvable`.

### 4.5 Cost of Observation

The number of polls follows how often clients ask, bounded by the rate limit:

- **A process nobody talks to** makes no polls, however many pending Actions
  its store holds.
- **A host that follows the Task's polling hint** (60 seconds, §7) causes
  about one poll a minute while it watches: at most 30 over a 30-minute
  Action window.
- **A host that ignores the hint and calls `tasks/get` continuously** causes
  at most one poll per 10 seconds: at most 180 over a 30-minute window.
- **An agent that asks only when prompted,** for example when a maintainer
  reports an approval, causes one poll per prompt.

In every case polling stops when the client stops asking or the workflow
leaves `awaitingApprovals`.

---

## 5. Paced Remote Work

### 5.1 Remote Retries

Remote work other than Coordination observation runs from a per-workflow
schedule, not a shared tick:

| Workflow state | Remote action | Schedule |
|---|---|---|
| `created`, `submittingToCoordination` after a transient failure | Retry the submission | Backoff from the failure |
| `readyForSubmission` | Submit the completed package | Immediately when entered, then backoff on transient failure |
| `awaitingVerifierResult` | Re-submit with the same idempotency key | Backoff starting at 2,000 ms, cap 60,000 ms |

Backoff uses the §4.4 formula (exponential, full jitter, `Retry-After`
honored). The schedule is in memory. After a restart, `start()`
reconciliation runs each recoverable workflow once, as today, and then
resumes backoff. Reconciliation never polls Coordination (§4.1).

These retries finish work the bridge has already started, such as a submitted
package awaiting a Verifier result. They don't wait on a person, so they
don't require a client request.

Claim leases, idempotency keys and per-Task dispatch lanes are unchanged.

### 5.2 Local Maintenance

A local timer runs every `maintenanceIntervalMs` (default 60,000 ms):

- sweep expired workflows;
- purge results past retention;
- run any per-workflow remote work (§5.1) whose scheduled time has passed.

The timer is `unref`'d and wakes early when a scheduled retry falls due
before the next interval. Each run starts only after the previous one has
finished. A Coordination poll that moves a workflow to `readyForSubmission`
triggers a run immediately. Maintenance never polls Coordination.

---

## 6. Process Lifecycle

### 6.1 Shutdown Triggers

A stdio bridge begins shutdown on the first of:

- `end` or `close` on `process.stdin`;
- an error writing to `process.stdout`, such as `EPIPE`;
- SIGTERM, SIGINT or SIGHUP;
- an explicit `ProposerBridge.shutdown()` call.

This matches the MCP stdio shutdown sequence, in which the client closes the
server's input, then sends SIGTERM, then SIGKILL, and in which a server may
also end the session itself.

### 6.2 Shutdown Procedure

`ProposerBridge.shutdown(): Promise<void>` is idempotent and:

1. Stops accepting new tool calls and Task operations.
2. Stops the maintenance timer and cancels all scheduled remote work.
3. Aborts in-flight HTTP requests through an `AbortSignal` passed down to the
   Action endpoint, Action relay and Coordination clients.
4. Waits up to `shutdownGraceMs` (default 5,000 ms) for in-progress store
   writes to settle.
5. Closes the workflow store.

The entry point then exits with code 0. If shutdown doesn't complete within
`shutdownGraceMs` plus 1,000 ms, the entry point exits with code 1.

Aborting a submission is safe. Retries reuse the persisted idempotency key,
and claims expire through their existing lease, so the next process to start
reconciles the workflow.

### 6.3 Where It Lives

- The SDK provides `ProposerBridge.shutdown()` and a helper that binds the
  §6.1 triggers for a stdio server, so every bridge gets the same behavior.
- `bridge-generator` emits entry points that use the helper.
  `cli/src/bridge/github-bridge.ts` adopts it too.
- Generated bridges in `mpas-applications` pick it up when regenerated against
  the new SDK.

---

## 7. Configuration

| Option | Change |
|---|---|
| `pollIntervalMs` | **Deprecated.** Ignored apart from a one-time warning, because there is no timer to configure. |
| `coordinationRefreshMinIntervalMs` | **New.** Default 10,000 ms; minimum 5,000 ms. |
| `maintenanceIntervalMs` | **New.** Default 60,000 ms. |
| `shutdownGraceMs` | **New.** Default 5,000 ms. |
| `taskPollIntervalMs` | **Default changes** from 5,000 ms to 60,000 ms. Still only a client hint. |

Generated bridge configs accept the new options under `workflow`, alongside
the existing `workflow.pollIntervalMs`.

---

## 8. Normative and Guidance Changes

### 8.1 Proposer Bridge Profile §9

[MPAS MCP Proposer Bridge Profile](../../../specs/mpas-profile-mcp-proposer-bridge-client.md)
§9 currently says:

> The bridge MUST continue background Coordination polling, completed-package
> submission, startup reconciliation, and retry of transient adapter or
> Coordination failures until the current Action expires or the Task reaches a
> terminal state.

Proposed replacement:

> Task observation and MPAS progression are independent. Until the current
> Action expires or the Task reaches a terminal state, the bridge MUST perform
> startup reconciliation, MUST submit a completed Action Package once
> Coordination reports it, and MUST retry transient adapter and Coordination
> failures with backoff.
>
> The bridge MUST poll Coordination only in response to a client observing a
> Task whose workflow awaits approvals. It MUST NOT poll Coordination on a
> timer or at startup. It MUST NOT have more than one Coordination poll in
> flight at a time, and it MUST rate-limit polls; a request within the limit
> receives the last known state. Task observation MUST NOT wait on
> Coordination. An Action that no client observes MAY expire without its
> approvals being collected.
>
> A stdio bridge MUST exit when its input stream ends or closes, including
> while requests are in flight.

The §9 change also replaces "the bridge's internal background interval" in
the `pollIntervalMs` paragraph with "the bridge's Coordination rate limit".

### 8.2 Proposer Bridge Profile §6 and Task Metadata

§6 currently says:

> `tasks/get` is read-only and MUST NOT advance an MPAS workflow.

Proposed replacement:

> A `tasks/get` response reflects the bridge's local workflow state and MUST
> NOT wait on any remote service. A `tasks/get` for a workflow awaiting
> approvals MAY start a rate-limited Coordination poll (§9); that poll's
> results are applied in the background and appear in later responses.

The profile also adds `coordinationCheckedAt` (§4.3) to the
`org.oma3/mpas` Task metadata.

### 8.3 Proposer Agent Guidance

The proposer skill (`integrations/skills/mpas-proposer/SKILL.md` and its
ClawHub copy, `integrations/clawhub/mpas-proposer/SKILL.md`) currently tells
agents to treat `tasks/get` as read-only and says "the bridge continues
coordination and resubmission independently."

Both copies change to say:

- After notifying the Maintainers, expect a Maintainer to report back on the
  same channel when they approve or reject.
- When a Maintainer reports a decision, check the Task once, through
  `tasks/get` or `mpas_wait_for_action_result`.
- Don't keep checking otherwise. The bridge doesn't watch for approvals on
  its own, so an Action nobody checks on expires.
- `coordinationCheckedAt` shows when the state was last checked. If it is
  older than the Maintainer's report, check again after a few seconds.

---

## 9. Relationship to Earlier Features

- [MCP Tasks](../mcp-tasks/spec.md) §9 describes a background tick that polls
  Coordination. This feature replaces that mechanism. The earlier document is
  left unchanged as a historical record.
- [Routing](../routing/spec.md) §7 defines the optional WebSocket
  notification binding. This feature doesn't use it (§10).

---

## 10. Out of Scope

- **WebSocket notification.** A later feature may let a
  `CoordinationWorkAvailable` notification update the bridge's state when the
  service offers a session. It would still have to respect decision 2 and the
  rate limit.
- **Held-open polls.** Holding a Coordination poll open until work appears
  would need an HTTP profile extension.
- **Server-side protection and metering,** such as per-DID rate limits,
  overload responses, free-tier limits and incremental polling. These are
  tracked in the coordination service's participant-scaling issue.
- **Maintainer and signer clients.** The CLI signer already polls only on
  demand.
- **The host's process leak.** That needs its own report to the OpenClaw and
  Codex maintainers.
- **Moving bridge behavior out of `@oma3/mpas`.** Whether the workflow engine
  and bridge behavior belong in the protocol SDK, a separate package or a
  separate import path is a larger decision, deferred to its own feature.
  This feature changes the code where it lives today.

---

## 11. Acceptance Criteria

Unit tests, using fake timers and fake clients:

- [ ] With an `awaitingApprovals` workflow and no Task observation, the
      runtime makes no Coordination calls at all, including at startup and
      as the Action approaches expiry.
- [ ] An unobserved workflow whose Action was approved in Coordination
      expires locally without its completed package being submitted.
- [ ] Repeated `tasks/get` calls every 1 second produce at most one
      Coordination poll per `coordinationRefreshMinIntervalMs`, and never two
      in flight at once.
- [ ] A `tasks/get` within the rate limit returns the local state with
      `coordinationCheckedAt` set to the last successful poll.
- [ ] `tasks/get` returns without awaiting a pending poll, even when the
      poll hangs.
- [ ] The compatibility wait tool polls once when called and not again during
      its wait.
- [ ] A poll that reports `readyForSubmission` leads to exactly one
      completed-package submission.
- [ ] Startup reconciliation submits a persisted `readyForSubmission` package
      without polling Coordination.
- [ ] Retryable failures, including 429, increase the delay as specified.
      `Retry-After` is honored, and a success resets the delay.
- [ ] `awaitingVerifierResult` re-submissions back off up to 60 seconds and
      reuse the idempotency key.
- [ ] `shutdown()` aborts in-flight requests, closes the store, and is
      idempotent.

Process tests, extending the 2026-10-16 experiment into the test suite:

- [ ] With a pending approval and a Coordination stub that never answers,
      closing stdin makes the process exit with code 0 within
      `shutdownGraceMs` plus 1 second.
- [ ] SIGTERM and SIGINT behave the same way, and the store is closed
      cleanly.
- [ ] A generated bridge from `bridge-generator` passes both process tests.

Profile and docs:

- [ ] §6 and §9 of the proposer bridge profile are revised as in §8.1 and
      §8.2, with a profile version note.
- [ ] Both copies of the proposer skill are updated as in §8.3.
- [ ] Bridge READMEs and config docs describe the new options, the
      deprecation of `pollIntervalMs`, and the fact that unobserved Actions
      expire.

---

## 12. Rollout

1. Feature change: SDK §4–§7, the `bridge-generator` template, the profile
   revision (§8.1, §8.2) and the proposer skill (§8.3).
2. Release change, following the existing release process: publish
   `@oma3/mpas` 0.1.0-alpha.15 and adopt it across the repository. The CLI
   depends on the published SDK, so this change also gives
   `cli/src/bridge/github-bridge.ts` the same entry-point and configuration
   changes as the generator template, updates the bridge configuration table
   in `cli/README.md`, and moves the generator's pinned SDK version to
   alpha.15.
3. Bridges in `mpas-applications` regenerated or bumped to the new SDK.
4. Running hosts restarted so each holds a single, current set of bridges.

Mixed versions are safe. An old bridge still polls on its timer, and a new
one simply stops doing so. No protocol or server change is required.

Behavior change for users: an approved Action now executes only when the
proposer's client checks on it. Release notes should say so.

---

## 13. Decisions from Review

1. **Rate limit:** 10 seconds (`coordinationRefreshMinIntervalMs`).
2. **Task hint:** 60 seconds (`taskPollIntervalMs`). Agents are expected to
   learn about decisions from Maintainers, so the hint is only a fallback.
3. **Limit responses:** no special handling. A 429 backs off like any other
   retryable error, and `coordinationCheckedAt` already shows that the state
   is stale.
4. **Package structure:** unchanged for now (§10).
