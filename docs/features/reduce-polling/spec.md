# Reduce Proposer Bridge Polling and Bound Bridge Lifetime

**Status:** Draft

**Created:** 2026-10-16

**Depends on:** [MCP Tasks integration](../mcp-tasks/spec.md), [MPAS HTTP Profile](../../../specs/mpas-profile-http.md) §9.2

**Normative output:** a revision of [MPAS MCP Proposer Bridge Profile](../../../specs/mpas-profile-mcp-proposer-bridge-client.md) §6 and §9 (proposed text in §8 below), and a clarification of [MPAS Core](../../../specs/mpas-specification.md) §6.9.2 rule 3 with the matching [HTTP Profile](../../../specs/mpas-profile-http.md) §6.5.1 text, both moving to v0.3 (§15)

**Companion:** plan.md (to be written after this specification is reviewed)

---

## 1. Purpose

Change how an MPAS proposer bridge talks to remote services so that:

1. A bridge polls the Coordination Service only when its client asks about a
   Task, never on a timer and never on its own initiative.
2. Remote retries (Verifier `pending`, transient failures) happen only when a
   client observes the Task, and back off instead of repeating every tick.
   Nothing in the bridge runs on a timer.
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
2. **A bridge nobody observes makes no approval polls.** Coordination is
   polled only when a client observes a Task. One poll returns updates for all
   of this proposer's pending Actions, so observing one Task can collect
   approvals for, and advance, another Task held by the same bridge. The
   initial submission to the Verifier always happens automatically. But an
   approved Action whose bridge receives no relevant observation before it
   expires is never sent to the Verifier for execution. An agent that no
   longer wants an Action may cancel its Task.
   Observation shows that a client is asking; it is not proof that the agent
   is attending to each Action.
3. **Observation never blocks on the network.** `tasks/get` returns the local
   record immediately. A Coordination poll it triggers runs in the
   background, and a later `tasks/get` sees the result.
4. **Polling is rate-limited per process.** There is at most one Coordination
   poll in flight, and at most one every `coordinationRefreshMinIntervalMs`
   (default 10 seconds). A request inside that interval gets the last known
   state, labeled with the time it was last checked, rather than an error.
5. **Retries happen on observation, after a backoff.** A retryable failure,
   or a Verifier `pending`, records a "not before" time (exponential backoff
   with jitter, honoring `Retry-After`). The bridge retries only when the Task
   is next observed after that time. If nobody observes the Task again, it is
   not retried. Work already in flight still finishes and saves its result.
   (This revises an earlier draft, in which remote retries ran on a timer
   independently of observation.)
6. **No periodic maintenance.** Expiration and result purging are local and
   happen on client activity and at startup. Expiry is also enforced whenever
   a Task is read or advanced.
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
10. **Hosts and agents may check either way.** Hosts that check Tasks
    automatically follow a state-based polling hint; agents that check only
    when prompted, for example when a Maintainer reports a decision, may wait
    for that prompt while approvals are outstanding. Periodic checking while
    awaiting approval is optional. A prompted check can start asynchronous
    work; further checks may be needed to collect the decision and observe
    completion (§8.3, §14.4).
11. **Profile version 3, and prompt Tasks.** These client-visible changes are
    a new profile version, and a tool call returns a Task within about one
    second (§14).

---

## 4. Coordination Observation

### 4.1 Triggers

The bridge contacts Coordination in exactly these cases:

| Case | Coordination call | Rate-limited |
|---|---|---|
| `tasks/get` for a Task whose workflow is `awaitingApprovals` | `pollWork()` | Yes |
| `mpas_wait_for_action_result` for such a workflow | `pollWork()`, once when the call starts | Yes |
| A Verifier response requires approvals | `createApprovalWorkflow()` | No |
| Observation of a Task whose Coordination workflow creation failed, after its backoff (§5) | `createApprovalWorkflow()` retried | Per-Task backoff |
| `tasks/cancel` after Coordination started | Best-effort `cancelAction()` | No |

Nothing else polls Coordination. In particular:

- **No startup poll.** `start()` is local only (§6.3).
- **No pre-expiry poll.** See decision 2. (Corrected from this spec's first
  draft, which said every individually unobserved Action expires.)

A poll's `actionUpdates` are applied as today, which may move a workflow to
`readyForSubmission`. As directly dependent work, the bridge then submits
each package that poll found ready, whichever Task was observed, through the
normal claimed submission path (§5).

The compatibility wait tool starts its timeout when the call begins. It
observes the Task like `tasks/get`: for a workflow awaiting approvals it
starts at most one rate-limited poll, and otherwise any due retry (§5). It
never awaits that work, so a slow or hanging poll never extends the requested wait, and
`timeoutSeconds: 0` returns at once without waiting on the network. The
shared poll may finish after the wait returns and still update local state.
The wait then follows local state until the workflow resolves or the timeout
passes, and doesn't poll again. An agent that wants another check calls the
tool again.

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

One poll returns updates for every pending Action of this proposer, so all of
that proposer's pending Tasks held by the bridge share each poll, and
observing one Task can advance others. The bridge applies an update only to a
local workflow whose Action Package names this bridge's proposer DID, as
defense in depth for a store shared between proposers. Deployments should use
one proposer per user account, and therefore one proposer per bridge.

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

## 5. Observation-Driven Progress

### 5.1 What Starts Remote Work

Nothing in the bridge runs on a timer. Remote work starts only in these ways:

| Event | Remote work |
|---|---|
| New tool call | Durably record the workflow, then begin its initial submission. |
| Observation of a Task (`tasks/get`, the compatibility wait tool) awaiting approvals | A rate-limited Coordination poll (§4). |
| Observation of any other non-terminal Task | That Task's next step, if due: retry a failed submission, re-check a Verifier `pending`, or submit a completed package. |
| An in-flight request completes | Persist its result and do directly dependent work: a poll that newly moves a workflow from `awaitingApprovals` to `readyForSubmission` submits that package. |
| `tasks/cancel` | Best-effort Coordination cancel. |

Observing one Task never retries another Task's failed step. The only
cross-Task effect is the shared Coordination poll (§4.2), and it is limited to
newly approved work. Whether an update is a new approval is decided inside
the Task's serialized lane: only a transition from `awaitingApprovals` to
`readyForSubmission` that this poll applied counts. Coordination keeps
reporting a ready workflow on every poll, so a workflow already in
`readyForSubmission`, for example because its completed submission failed, is
not submitted again when another Task is observed. Its retry needs an
observation of that Task itself, after its backoff.

### 5.2 Durable Attempt Log and Backoff

Every remote call's outcome is appended to the workflow's durable attempt log
(the store's `adapterAttempts`, which already holds each phase's idempotency
binding). Outcomes:

| Outcome | Meaning | Next call |
|---|---|---|
| `responded` | A definitive response was received and persisted. | Follows from the response (§5.6). |
| `pending` | The Verifier answered `pending` (legacy). | Re-check after a backoff of 2,000 ms doubling to 60,000 ms. |
| `unreachable` | A transient failure, or an unclassified failure whose outcome is unknown. | Retry after the §4.4 backoff, or the `Retry-After` delay. |
| `interrupted` | The shutdown abort cut the call short before any HTTP response; the outcome is unknown. | Retry on the next observation; no backoff. |
| `rejected` | A permanent failure. | None: the workflow resolves `unresolvable`. |

A `pending` or `unreachable` entry stores its "not before" time. The next
observation of the Task after that time retries; one before it does nothing
remote. Because the time is durable, backoff survives a restart.

The schedule follows the outcome of the last remote call attempted, not the
workflow's state changes. If one operation makes progress and then fails, for
example the Verifier requires approvals and creating the Coordination
workflow then fails, the failure's backoff and `Retry-After` still apply.

Idempotency keys and claim leases are unchanged. Every retry of an Action
reuses its persisted idempotency key and the identical request bytes; the
recorded request fingerprint enforces this. An idempotency binding belongs to
one key, so a replacement Action (A3 after A2) gets its own binding.

### 5.3 One Operation per Task

Each Task has at most one observation-driven operation in flight. A second
observation while one runs joins it instead of queuing another attempt. Every
operation on a Task, including the initial submission and Coordination
updates, runs in that Task's serialized lane. Eligibility (expiry, then the
"not before" time) is checked when the operation actually runs inside the
lane, and the attempt's outcome is recorded before the lane is released. A
retry queued behind another operation therefore sees that operation's
failure and its `Retry-After`.

### 5.4 Local Cleanup

Local cleanup expires overdue workflows and purges results past retention. It
contacts no remote service. It runs at startup and on client activity: tool
calls, Task observation and cancellation, at most once every 10 seconds.
Routine requests that never reach the bridge's workflow code, such as `ping`
and `tools/list`, trigger nothing.

Expiry does not depend on cleanup having run. A Task that is read or advanced
after its Action has expired is resolved as expired first, so it never reads
as still working.

### 5.5 Failure Classification

A failed remote call is classified before anything is recorded. HTTP
failures follow one rule on every path, whether the bridge reaches the
Verifier directly, through an Action Relay, or through the legacy Credential
Adapter client, and for the Coordination Service: an `MpasHttpError`
`retryable` flag decides when present, in either direction, and otherwise
408, 425, 429 and 5xx are retryable. A `503` marked `retryable: false` is
therefore permanent, and a `409` marked `retryable: true` is retryable. The
SDK implements the rule once (`isRetryableHttpFailure`) and every HTTP client
uses it.

- **Permanent:** authentication or authorization failures (401, 403); an
  HTTP rejection that is not retryable (4xx other than 408, 425 and 429, or
  an `MpasHttpError` with `retryable: false`); a request the client refused to
  send (identity mismatch, upstream-binding conflict, request validation);
  and a malformed or unparseable success response. The bridge records
  `rejected` and resolves the workflow `unresolvable`, with
  `ACTION_SUBMISSION_REJECTED` for Verifier submissions and the existing
  Coordination codes for Coordination. A malformed success response may mean
  the Action ran, so it is surfaced for reconciliation, never resubmitted.
- **Retryable:** network failures and timeouts, HTTP 408, 425, 429 and 5xx,
  an `MpasHttpError` with `retryable: true` (including the HTTP profile's
  `503 timeout`), and any failure the client cannot classify. An
  unclassified failure has an unknown outcome; the idempotency contract makes
  retrying it with the same key and request safe.
- **Interrupted:** a call that the shutdown abort itself cut short, with no
  HTTP response. Its outcome is unknown, not failed. The abort happens only
  when the grace period expires (§6.2). Anything received before or at that
  moment keeps its normal classification. In particular, a `503` with
  `Retry-After` that arrives during the grace period is recorded as
  `unreachable` with its delay, so a restarted bridge honors it. A network
  failure during the grace period is likewise an ordinary retryable failure.

### 5.6 Submission and Recovery Matrix

What the bridge does next is decided from durable state alone, so the same
rules apply in a running process and after a restart. "On observation" means
when this Task itself is observed, after any recorded "not before" time and
the Task's expiry check, and once any other process's claim lease has
expired.

| Situation | Durable evidence | What happens |
|---|---|---|
| Initial submission never sent | `created`; no `initial` binding, or none since the last outcome | On observation: send it with the persisted key. |
| Initial submission sent, outcome unknown (shutdown, crash, transport failure) | `created`; `initial` binding; last outcome `interrupted`, `unreachable` or none | On observation: resend the identical request with the same key. The Verifier returns the stored result or rejects a replay. |
| Initial submission failed permanently | last outcome `rejected` | Terminal `unresolvable`; never resent. |
| Verifier answered `executed` (including an application error) or `rejected` | resolution persisted | Terminal; never resent. |
| Verifier answered `additionalApprovalsRequired` | `responded`; replacement Action persisted; `submittingToCoordination` | Create the Coordination workflow with the replacement Action. |
| Coordination creation never sent, unknown or transiently failed | `submittingToCoordination`; last outcome `interrupted`, `unreachable` or none | On observation: create it again with the same replacement Action (Coordination treats an identical resubmission as idempotent). The Verifier is not contacted. |
| Coordination creation failed permanently | `rejected` | Terminal `unresolvable`. |
| Awaiting approvals | `awaitingApprovals` | On observation: rate-limited Coordination poll (§4). A transient poll failure backs off; a permanent one resolves awaiting workflows `unresolvable`. |
| Approval newly collected by a poll | the poll applied `awaitingApprovals` → `readyForSubmission` | Submit the completed package immediately, whichever Task was observed. |
| Completed submission never sent, unknown or transiently failed | `readyForSubmission` or `submittingToVerifier`; `completed` binding or none; last outcome not `rejected` | On observation of this Task only: send or resend the identical completed request with the same key. A repeated ready update from Coordination does not resubmit it. |
| Verifier answered `pending` (legacy) | `awaitingVerifierResult`; last outcome `pending` | On observation after the pending backoff: re-check with the same key. |
| Completed submission rejected as a replay | `REPLAY_DETECTED` or `ACTION_ID_HASH_MISMATCH` | Terminal `unresolvable` (`RESULT_UNAVAILABLE`). |
| Action expired | `expiresAt` in the past | Resolved as expired when read or advanced; nothing is sent. |

Shutdown never turns a call into a failure, and never erases one. A call
shutdown prevented from starting stays "never sent". A call the shutdown
abort cut short, with no response, is "sent, outcome unknown"
(`interrupted`). A call that got a response within the grace period is
recorded exactly as it would be at any other time: a definitive outcome as
`responded`, a transient failure as `unreachable` with its backoff and
`Retry-After`.

### 5.7 Trade-off

If a request fails and nobody observes the Task again, the bridge doesn't
retry it, and the Action eventually expires. This is deliberate: an idle or
leaked bridge makes no remote calls. Hosts that poll Tasks drive retries
naturally, and agents can check when useful. A Task whose Coordination
workflow couldn't be created is the case to watch: maintainers can't see the
request until the proposer's side observes the Task again.

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

A bridge cannot tell an accidental gateway disconnect from a full system
shutdown, so every trigger uses the same conservative policy. Shutdown is
split between the bridge's entry point (the generated wrapper) and the SDK
workflow runtime, along one path: the stdio helper calls the wrapper's
`shutdown()`, which calls the runtime's. Both are idempotent.

`ProposerBridge.shutdown(graceMs, { abortInFlight })`:

1. Stops accepting tool calls and Task operations, and stops the engine:
   from then on no new remote call starts, including a submission that a late
   Coordination response would otherwise trigger. Compatibility waits answer
   with the current state.
2. Lets calls already sent finish and persist their outcomes, for up to
   `shutdownGraceMs` (default 5,000 ms). It tracks all in-flight work,
   including work that starts during the wait, such as applying a late
   Coordination response to durable state.
3. If work remains when the grace expires, marks the in-flight calls as
   aborted, calls `abortInFlight`, then waits up to 500 ms for the aborted
   calls to record their interruption. Only failures without an HTTP
   response after this point are recorded as `interrupted` (§5.5).

The wrapper's `shutdown()` passes an `abortInFlight` that aborts its HTTP
clients through their shared `AbortSignal`, and closes the workflow store only
after the runtime's shutdown resolves. Unfinished workflows keep their Task
IDs, idempotency keys and request bindings.

The SDK runtime only stops and drains workflow activity and says when to
abort. HTTP cancellation, the store and the process belong to the wrapper.
The entry point exits with code 0 once shutdown completes, or with code 1 if
shutdown fails or takes longer than the configured `shutdownGraceMs` plus
1,000 ms. After shutdown starts, further stdout write errors are absorbed.

### 6.3 Startup

Startup is local only: it expires overdue workflows and purges old results.
It resumes no interrupted submission and contacts no remote service. Each
unfinished workflow follows the §5.6 matrix when its Task is next observed:
once any previous process's claim lease has expired, after its durable "not
before" time, and only if it has not expired. A host restarting many
bridges therefore causes no burst of resubmissions.

The entry point binds the shutdown triggers and connects the stdio transport
first, so stdin is read and its end detected from the start.

### 6.4 Where It Lives

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
| `shutdownGraceMs` | **New.** Default 5,000 ms. |
| `taskPollIntervalMs` | **Meaning narrows** to the hint while approvals are awaited (and for finished Tasks). **Default changes** from 5,000 ms to 60,000 ms. Still only a client hint. |
| `processingTaskPollIntervalMs` | **New.** Hint while the bridge itself has work to do. Default 2,000 ms. After a failure the hint is never shorter than the time until the retry is allowed (§14.3). |

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

> The bridge progresses a Task only in response to client requests. A tool
> call records the workflow and begins its initial submission. Observing a
> Task (`tasks/get` or the compatibility wait tool) may start that Task's next
> step. When an in-flight request completes, the bridge persists its result
> and performs directly dependent work: it MUST submit a completed Action
> Package once a Coordination poll reports it.
>
> A retryable failure or a Verifier `pending` MUST record a durable backoff,
> honoring `Retry-After`. The bridge MUST NOT retry before that time and
> retries only on a later observation of the Task itself. A permanent failure
> MUST be surfaced and MUST NOT be retried; a definitive Action outcome MUST
> NOT be resubmitted. A retry MUST reuse the Action's idempotency key and
> identical request. Only an approval newly collected by a poll may trigger a
> submission for a Task other than the one observed. The bridge MUST NOT run
> remote work on a timer. Startup reconciliation is local: an unfinished
> workflow resumes on the next observation of its Task. An operation for a
> Task MUST NOT start while another is in flight for it.
>
> On disconnect or shutdown the bridge MUST stop accepting requests and
> starting remote calls, SHOULD let calls already sent finish within a bounded
> grace period, and MUST NOT record an interrupted call as failed or
> cancelled.
>
> The bridge MUST poll Coordination only in response to a client observing a
> Task whose workflow awaits approvals. It MUST NOT poll Coordination at
> startup. It MUST NOT have more than one Coordination poll in
> flight at a time, and it MUST rate-limit polls; a request within the limit
> receives the last known state. Task observation MUST NOT wait on any remote
> service. An Action that no client observes MAY expire without its approvals
> being collected, and a failed submission that no client observes MAY expire
> without being retried. A Task read after its Action expired MUST be reported
> as expired.
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
> NOT wait on any remote service. It MAY start the Task's next step in the
> background (§9): a rate-limited Coordination poll while approvals are
> awaited, otherwise a due retry. Results appear in later responses.

The profile also adds `coordinationCheckedAt` (§4.3) to the
`org.oma3/mpas` Task metadata.

### 8.3 Proposer Agent Guidance

The proposer skill (`integrations/skills/mpas-proposer/SKILL.md` and its
ClawHub copy, `integrations/clawhub/mpas-proposer/SKILL.md`) currently tells
agents to treat `tasks/get` as read-only and says "the bridge continues
coordination and resubmission independently."

Both copies change to the guidance in §14.4.

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
      runtime makes no remote calls at all, including at startup and as the
      Action expires; reading the Task afterwards reports it as expired.
- [ ] Repeated `tasks/get` calls every 1 second produce at most one
      Coordination poll per `coordinationRefreshMinIntervalMs`, and never two
      in flight at once.
- [ ] A `tasks/get` within the rate limit returns the local state with
      `coordinationCheckedAt` set to the last successful poll.
- [ ] `tasks/get` returns without awaiting a pending poll, even when the
      poll hangs.
- [ ] A poll that reports `readyForSubmission` leads to exactly one
      completed-package submission, and one poll advances every awaiting Task
      of this proposer and no other proposer's workflow in a shared store.
- [ ] A Verifier `pending` or a failed submission is not retried without
      observation, and is retried on the first observation after its backoff.
      Observing every second, retries back off as specified and reuse the
      idempotency key.
- [ ] Observing one Task never retries another Task's failed step.
- [ ] A failed Coordination workflow creation keeps its `Retry-After` even
      though the same operation moved the workflow from `created` to
      `submittingToCoordination`.
- [ ] Observations during an in-flight attempt join it, and a retry queued
      behind another operation for the same Task (such as the initial
      submission) honors that operation's `Retry-After`.
- [ ] Startup makes no remote calls; an interrupted submission, including one
      recorded before a crash, resumes once, on observation, with its
      persisted key.
- [ ] Compatibility waits of 0 and 3 seconds return on time while a poll
      hangs, and the shared poll still advances state after a wait returns.
- [ ] Retryable poll failures, including 429, back off as specified and
      honor `Retry-After`; a success resets the delay.
- [ ] `shutdown()` waits for background work started by observation, stops
      serving requests, and is idempotent.
- [ ] For each boundary (never sent; initial sent with unknown outcome;
      Verifier response persisted with Coordination creation interrupted;
      completed submission sent with unknown outcome; definitive outcome
      persisted; legacy `pending` persisted): shut down, restart as another
      worker, observe another Task and confirm the interrupted one is
      untouched, then observe it and confirm the matrix behavior, the same key
      and request bytes, and the expiry check.
- [ ] A late Coordination response during shutdown updates durable state but
      starts no Verifier submission, and shutdown waits for it.
- [ ] A `503` with `Retry-After` received during the grace period is recorded
      as `unreachable` with its delay, which a restarted bridge honors; a
      network failure during the grace period is an ordinary retryable
      failure; at the abort, only a call with no HTTP response is recorded as
      `interrupted`.
- [ ] Permanent failures (HTTP 400, authentication, malformed response) are
      surfaced and never retried; executed application errors and definitive
      rejections are terminal; retryable failures and unclassified failures
      are retried with the same key after a durable backoff that survives a
      restart.
- [ ] A failed completed submission is not resubmitted by another Task's
      observation, however many polls repeat its ready update.
- [ ] The direct Action endpoint, Action Relay, Coordination Service and
      legacy Credential Adapter clients classify 400, 409 marked
      `retryable: true`, 429, 503 and 503 marked `retryable: false`
      identically; the endpoint client also classifies a malformed success
      response and a network failure.
- [ ] Through the relay, a 503 marked `retryable: false` stops the workflow
      after one request, and a 503 without a flag is recorded as retryable;
      Coordination creation stops on a 503 marked `retryable: false`.

Process tests, extending the 2026-10-16 experiment into the test suite:

- [ ] With a pending approval and a Coordination stub that never answers,
      closing stdin, or sending SIGTERM, makes the generated bridge exit with
      code 0 within `shutdownGraceMs` plus 1 second.
- [ ] A bridge restarted after a crash makes no submission at startup,
      resubmits the crashed workflow with the same idempotency key when the
      Task is observed, and exits promptly with code 0 when its client
      disconnects while that submission is in flight.
- [ ] A bridge whose stdout breaks (`EPIPE`) exits with code 0.
- [ ] A request already sent when the client disconnects finishes within the
      grace period, and its outcome is persisted before the process exits.

Profile and docs:

- [ ] §6 and §9 of the proposer bridge profile are revised as in §8.1 and
      §8.2, with a profile version note.
- [ ] Both copies of the proposer skill are updated as in §8.3.
- [ ] Bridge READMEs and config docs describe the new options, the
      deprecation of `pollIntervalMs`, and the fact that unobserved Actions
      are neither polled nor retried.

---

## 12. Rollout

1. Feature change: SDK §4–§7, §14 and §15, the `bridge-generator` template,
   the profile revision (§8.1, §8.2, §14.1), the proposer skill (§14.4), the
   Core and HTTP Profile v0.3 clarification and the reference credential
   adapter's duplicate handling (§15).
2. Release change, following the existing release process: publish
   `@oma3/mpas` 0.1.0-alpha.15 and adopt it across the repository. The CLI
   depends on the published SDK, so this change also gives
   `cli/src/bridge/github-bridge.ts` the same entry-point and configuration
   changes as the generator template, updates the bridge configuration table
   in `cli/README.md`, moves the generator's pinned SDK version to
   alpha.15, and moves the CLI's end-to-end tests to profile version 3.
3. Bridges in `mpas-applications` regenerated or bumped to the new SDK.
4. Running hosts restarted so each holds a single, current set of bridges.

Profile version 3 is a coordinated upgrade: bridges and the clients that
declare `org.oma3/mpas` move together, because a version 3 bridge rejects
version 2. Clients that use the conventional compatibility surface are
unaffected. No Coordination Service change is required. Credential adapters
should be upgraded with the bridges (§15.5), but either side works with the
other's previous release.

Behavior change for users: an approved Action now executes only when the
proposer's client checks on it. Release notes should say so.

---

## 13. Decisions from Review

1. **Rate limit:** 10 seconds (`coordinationRefreshMinIntervalMs`).
2. **Task hints:** 60 seconds while approvals are awaited
   (`taskPollIntervalMs`), 2 seconds while the bridge has work to do
   (`processingTaskPollIntervalMs`), never shorter than a pending retry's
   delay.
3. **Limit responses:** no special handling. A 429 backs off like any other
   retryable error, and `coordinationCheckedAt` already shows that the state
   is stale.
4. **Package structure:** unchanged for now (§10).
5. **Fast path:** keep returning the native `CallToolResult` when an Action
   settles within the budget. The Tasks extension lets the server choose
   between a direct result and a `CreateTaskResult` (§14.2).
6. **Profile version:** `"3"`, matched exactly.
7. **Executing duplicates:** join the dispatch in progress instead of
   answering `pending`; Core rule 3 is clarified and Core moves to v0.3. No
   new result values: `indeterminate` already covers an outcome nobody can
   know (§15).
8. **Terminal duplicates:** still rejected as a replay (Core rule 4
   unchanged).
9. **Joined wait:** the dispatch timeout plus 5 seconds, then `503 timeout`
   with `Retry-After: 2`. Bridges wait 45 seconds by default.

---

## 14. Profile Version 3 and Prompt Task Return

### 14.1 Profile Version 3

The bridge advertises and requires `org.oma3/mpas` version `"3"`, matched
exactly. Any other declared version, older or newer (`"2"`, `"2.2"`,
`"3.0"`), is rejected with JSON-RPC `-32021`; `data.requiredCapabilities`
names version `"3"`, and the message says which version was declared and
which is supported. Task metadata carries `version: "3"`. This is the MPAS
proposer-bridge profile version, not the MCP protocol version or the SDK
version. The conventional-client compatibility surface keeps its own version
and is unaffected.

Version 3 is a new major version because it changes client-visible workflow
responsibilities (§3, decision 5) and Task results (§14.2). Version 2 is not
preserved; existing version 2 deployments stay on version 2 until bridges and
clients upgrade together.

### 14.2 Prompt Task Return

A `tools/call` for an application tool:

1. Durably records the workflow, with its server-generated Task ID, before it
   can return a Task handle.
2. Begins the initial submission and waits at most one second
   (`TOOL_CALL_FAST_PATH_MS`), starting once the workflow is recorded.
3. Returns, for a Tasks client, the native `CallToolResult` (or an error
   `CallToolResult`) if the Action reaches a terminal outcome in that time.
   A conventional client receives its normal completed result.
4. Otherwise returns a `CreateTaskResult` for a Tasks client, or the existing
   deferred handle for a conventional client. It returns early when the
   Action is known to be deferred: once the Verifier has required approvals
   and the replacement Action is stored, it doesn't wait for the Coordination
   workflow to be created. A transient failure also returns at once.

The Tasks extension allows either result: the server alone decides whether to
return a `CreateTaskResult`, and a client that declared the extension handles
either. A `CreateTaskResult` is never sent to a client that hasn't declared
it.

Returning the Task neither aborts nor repeats the submission in flight. It
continues in the background, under the same Task ID and idempotency key, and
shutdown tracks it. If it later fails, the recovery matrix (§5.6) applies. A
Task check during the submission joins the Task's lane, and the eligibility
check inside the lane prevents a second submission (§5.3).

While the initial submission awaits the Verifier, the Task is `working`, with
status message "Awaiting the Verifier response.", authorization state
`submitted`, a 2-second polling hint, and metadata `version: "3"`, plus the
usual timestamps, TTL, Action identity, hash, disclosure and expiry.

### 14.3 Polling Hints and Status Messages

| Task state | `pollIntervalMs` | Status message |
|---|---|---|
| `created` | 2 s | "Awaiting the Verifier response." |
| `created`, last call failed | max(2 s, time until retry) | "The Verifier could not be reached. The bridge resends the same request when this Task is next checked." |
| `submittingToCoordination` | 2 s | "Registering the approval request with the Coordination Service." |
| `submittingToCoordination`, last call failed | max(2 s, time until retry) | "The approval request is not yet registered with the Coordination Service, so Maintainers cannot see it. The bridge retries when this Task is next checked." |
| `awaitingApprovals` | 60 s | "Awaiting MPAS authorization." |
| `readyForSubmission`, `submittingToVerifier` | 2 s, or max(2 s, time until retry) after a failure | "MPAS approvals collected; submitting for execution.", or a retry message after a failure |
| `awaitingVerifierResult` | max(2 s, time until re-check) | "Awaiting the MPAS Verifier result." |

The two base values are `processingTaskPollIntervalMs` and
`taskPollIntervalMs`. Hints are client hints only, separate from the bridge's
retry schedule and the Coordination rate limit. But because each check of a
working Task can start its next step, a host that follows the hint drives
retries at the right time. Status messages never imply authorization or
execution merely because a request was sent.

### 14.4 Host and Agent Guidance

The proposer skill names the components and their relationships: the MCP
host, the proposer agent, the bridge, the Coordination Service, and the
Verifier or credential adapter. The host's Task checks and the bridge's
Coordination polls are separate relationships. The guidance:

- supports hosts that check Tasks automatically, following the hint, and
  agents that initiate checks only when prompted; periodic checking while
  awaiting approval is optional;
- requires neither continuous polling nor waiting for a Maintainer's
  out-of-band report;
- explains that a prompted check may start asynchronous work without returning
  its outcome, so further checks using the returned hint may be needed to
  collect a reported decision and observe completion; checks stop at a terminal
  state;
- distinguishes timer-driven polling and retries, which the bridge does not
  perform, from request-triggered work that can finish asynchronously and
  trigger directly dependent work; without further observations, uncollected
  approvals or required retries can leave an Action to expire without executing;
- explains that host-managed checks needn't be duplicated by the agent's own
  tool calls;
- tells an agent whose Maintainer can't see the request to check the Task,
  whose status message says whether registration is still pending, and never
  to call the tool again;
- documents the compatibility wait tool separately: periodic checking while
  awaiting approval is optional, deferred responses may require further spaced
  wait calls after a reported decision, and a wait timeout does not create
  ongoing background polling or retries.

### 14.5 Acceptance Criteria

- [ ] Profile `"3"` is accepted; `"2"`, `"2.2"`, `"3.0"` and a numeric `3`
      are rejected with `-32021` naming `"3"`; `server/discover` advertises
      `"3"`; Task metadata carries `"3"`.
- [ ] An Action that settles within one second returns the native result to a
      Tasks client and to a conventional client.
- [ ] An Action that ends without a native result within one second (a
      permanent failure such as HTTP 400, or an invalid Verifier response)
      returns the completed error `CallToolResult` directly, not a Task; one
      that ends after the budget completes its Task with the same error.
- [ ] A slow initial submission returns a `CreateTaskResult` at one second
      with the §14.2 fields; the submission continues and resolves the Task;
      repeated Task checks during it cause no second submission.
- [ ] When approvals are required and Coordination creation is slow, the Task
      returns before creation completes, with authorization state
      `authorization_required` and the registering status message.
- [ ] Shutdown tracks a submission that outlives the tool call.
- [ ] Hints and status messages follow §14.3, including the retry-aligned
      hint and configuration overrides.

---

## 15. Duplicate Submissions of an Executing Action

### 15.1 Problem

A bridge sends the same Action again, with the same Action ID and idempotency
key, when it doesn't know whether the first submission arrived: after a
dropped connection, a request timeout, or a restart that interrupted a
submission (§5.6). If the first submission is still executing, Core v0.2
rule 3 required the Verifier to answer `pending`. The reference credential
adapter did, and the bridge then re-checked on a backoff, each re-check
another `pending` until the dispatch finished. Polling replaced an answer the
Verifier already had: the duplicate is the same Action, so it can wait for
the same outcome.

### 15.2 Duplicate Rules

| Ledger entry for the Action ID | Duplicate submission receives |
|---|---|
| None | Normal processing: verify, ledger, dispatch. |
| `executing`, same envelope hash, equivalent request | Joins the dispatch and receives its `ActionResponse`, or `503 timeout` with `retryable: true` and `Retry-After: 2` if the dispatch hasn't resolved within the join wait. |
| `executing`, same envelope hash, request differs under the idempotency rules (for example its `context`) | `409 conflict`. |
| `executing` or `resolved`, different envelope hash | Rejected (unchanged). |
| `resolved`, same envelope hash | Rejected as a replay (Core rule 4, unchanged). |

A joined submission never causes a dispatch, and losing its connection has
no effect on the dispatch. Only one `executing` event is logged. The reference
adapter no longer returns `pending`. Joining is in-process: after an adapter
restart there is nothing to join, and restart recovery already resolves an
`executing` entry as `indeterminate` (Core §6.9).

### 15.3 Bounded Wait and Timeouts

| Timeout | Default | Where |
|---|---|---|
| Upstream dispatch (`executionTarget.timeoutMs`) | 30 s | Credential adapter |
| Joined wait (`JOIN_WAIT_MARGIN_MS` added to the dispatch timeout) | dispatch timeout + 5 s | Credential adapter |
| Action request (`DEFAULT_ACTION_REQUEST_TIMEOUT_MS`) | 45 s | SDK, for `ActionEndpointClient` and `ActionRelayClient`; the bridge's submission timeout follows it |
| Claim lease (`DEFAULT_CLAIM_LEASE_MS`) | above the request timeout | SDK workflow engine |

Ordered this way, a joined submission receives the outcome in one response:
the dispatch resolves within its timeout, the join returns within 5 seconds
after that, and the bridge is still waiting. On `503 timeout` the bridge
records an `unreachable` attempt with the 2-second `Retry-After` and resends
the same request when the Task is next checked (§5.2), which joins again.

When the dispatch timeout expires, the adapter's MCP client sends
`notifications/cancelled` for the call, stops waiting, and records the Action
as `indeterminate`, as MCP's lifecycle guidance recommends for timed-out
requests. The upstream may still have done the work, so the Action is never
dispatched again and needs reconciling out of band.

### 15.4 Trade-off

An operator who sets a dispatch timeout above about 40 seconds makes the
joined wait longer than a bridge's request timeout. A duplicate then times
out at the bridge and is retried. A retry that arrives while the dispatch is
executing joins again, but one that arrives just after it resolves is
rejected as a replay, and the bridge can't recover the result; the Task ends
with that rejection. The operator guide (`cli/guides/credential-adapter.md`
§5.4) recommends keeping the dispatch timeout within the bridges' request
timeout. Returning the stored outcome to a terminal duplicate would remove
this case but changes Core rule 4, so it is out of scope.

### 15.5 Specifications and Compatibility

- **Core v0.3:** §6.9.2 rule 3 says an identical submission of an executing
  Action joins the dispatch and receives its outcome; a binding may bound the
  wait and answer with its retryable timeout, and may reject a joining
  submission that isn't equivalent. §6.5 step 2a and the replay paragraph
  match. Rule 4 is unchanged.
- **HTTP Profile v0.3:** §6.5.1 replaces "Idempotency and `pending`" with the
  duplicate rules above. Clients still accept `pending` from v0.2 Verifiers
  and from asynchronous Verifiers, so the bridge keeps its legacy `pending`
  handling (§5.2).
- **MCP profiles:** cite Core v0.3. The proposer bridge profile version stays
  `"3"`; this changes no MCP-visible behavior.
- **Relay path:** a relayed duplicate joins the same way. The relay worker
  already treats a 5xx from the adapter as retry-later.
- **Mixed versions:** a new bridge against an old adapter receives `pending`
  and re-checks; an old bridge against a new adapter receives the outcome, or
  a retryable `503 timeout` that it already retries.

### 15.6 Acceptance Criteria

- [ ] A duplicate of an executing Action, sent directly or in a relay
      `DeliveryEnvelope`, receives the same outcome as the original; the
      upstream tool is called once and one `executing` event is logged.
- [ ] A duplicate that passes the early ledger check and loses the dispatch
      gate still receives the outcome when the dispatch resolves while it
      closes its own unused upstream session: the joiner captures the
      dispatch before awaiting anything.
- [ ] A duplicate whose request differs (a different `context`) receives
      `409 conflict`.
- [ ] A duplicate still waiting at the join bound receives `503 timeout` with
      `retryable: true` and `Retry-After: 2`; once the dispatch resolves, the
      same request is rejected as a replay.
- [ ] On dispatch timeout the upstream MCP server receives
      `notifications/cancelled` and the Action is recorded as
      `indeterminate`.
- [ ] The default Action request timeout is 45 seconds, above the adapter's
      default joined wait and below the claim lease.
- [ ] A bridge that receives `503 timeout` with `Retry-After: 2` doesn't
      resend before the delay, then resends with the same idempotency key
      and resolves the Task.
