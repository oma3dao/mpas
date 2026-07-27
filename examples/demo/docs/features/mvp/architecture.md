# MPAS MVP — Program Plan

**Status:** Draft  
**Scope:** Cross-repository orchestration for the MPAS MVP  
**Repositories involved:**
- `oma3/mpas-docs` — Specifications (reference only)
- `oma3/mpas-sdk` — OMA3 packages (MCP bridge, schemas, test vectors, core utils)
- `mpas-local` — Wivity local services (Credential Adapter daemon + Coordination Service)

---

## 1. Overview

The MPAS MVP demonstrates multi-party agent governance end-to-end. Multiple agents collaborate on consequential actions (like deleting a GitHub branch), with cryptographic approvals required before execution.

### 1.1 Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Agent A (Proposer)                                │
│                           [Isolated container / macOS user]                 │
│                                                                             │
│  ┌──────────┐    MCP tools/call     ┌─────────────────────────────────┐     │
│  │  Agent   │ ────────────────────▶ │  Proposer Bridge                │     │
│  │  (LLM)   │ ◀──────────────────── │  (drop-in for GitHub MCP server)│     │
│  │          │    MCP response       │  Signs Action Packages          │     │
│  │          │                       └──────────────┬──────────────────┘     │
│  │          │    MCP tools/call     ┌──────────────────────────────────┐    │
│  │          │ ────────────────────▶ │  Maintainer Bridge               │    │
│  │          │ ◀──────────────────── │  (mpas_list_pending, …)          │    │
│  └──────────┘    MCP response       └─────────────--─┬─────────────────┘    │
└──────────────────────────────────────────────────────│──────────────────────┘
                                                       │
┌──────────────────────────────────────────────────────│──────────────────────┐
│                     Agent B (Signer)                 │                      │
│                     [Isolated container / macOS user]│                      │
│                                                      │                      │
│  ┌──────────┐    MCP tools/call     ┌────────────────┴─────────────────┐    │
│  │  Agent   │ ────────────────────▶ │  Maintainer Bridge               │    │
│  │  (LLM)   │ ◀──────────────────── │  (mpas_list_pending, …)          │    │
│  └──────────┘    MCP response       └─────────────--─┬─────────────────┘    │
└──────────────────────────────────────────────────────│──────────────────────┘
                                                       │
┌──────────────────────────────────────────────────────│──────────────────────┐
│                     Agent C (Signer)                 │                      │
│                     [Isolated container / macOS user]│                      │
│                                                      │                      │
│  ┌──────────┐    MCP tools/call     ┌────────────────┴─────────────────┐    │
│  │  Agent   │ ────────────────────▶ │  Maintainer Bridge               │    │
│  │  (LLM)   │ ◀──────────────────── │  (mpas_list_pending, …)          │    │
│  └──────────┘    MCP response       └─────────────--─┬─────────────────┘    │
└──────────────────────────────────────────────────────│──────────────────────┘
                                                       │
                         ┌─────────────────────────────▼─────────────────────┐
                         │         Coordination Service                      │
                         │         (shared, localhost REST API)              │
                         │                                                   │
                         │  • Receives proposals from proposer bridges       │
                         │  • Serves pending actions to maintainer bridges   │
                         │  • Collects signed approvals                      │
                         │  • Assembles Approval Bundles                     │
                         │  • Forwards completed packages to adapter         │
                         │  • Distributes receipts                           │
                         └─────────────────────────────┬─────────────────────┘
                                                       │
                                           Action Package (complete)
                                                       │
                         ┌─────────────────────────────▼─────────────────────┐
                         │         Credential Adapter                        │
                         │         (isolated, holds all secrets)             │
                         │                                                   │
                         │  • Verifies Action Packages from scratch          │
                         │  • Evaluates policy                               │
                         │  • Dispatches to real MCP servers using secrets   │
                         │  • Issues Execution Receipts                      │
                         └─────────────────────────────┬─────────────────────┘
                                                       │
                                              MCP tools/call
                                                       │
                                                       ▼
                                        ┌──────────────────────────┐
                                        │  Target MCP Server       │
                                        │  (e.g., official GitHub) │
                                        └──────────────────────────┘
```

### 1.2 Components

| Component | Where It Lives | What It Does |
|---|---|---|
| **Proposer Bridge** | Agent container, as an MCP server | Drop-in replacement for a real MCP server (e.g., GitHub). Exposes the same tool names. When an agent calls a tool, it constructs and signs an Action Package, then submits it to the Coordination Service. |
| **Maintainer Bridge** | Agent container, as an MCP server | Exposes MPAS approval tools (`mpas_list_pending`, `mpas_review_action`, `mpas_approve`, `mpas_reject`). Lets the agent participate in reviewing and approving other agents' proposals. |
| **Coordination Service** | Shared process (localhost) | REST API that stores pending proposals, serves them to eligible signers, collects approvals, and forwards completed Action Packages to the Credential Adapter once policy thresholds are met. |
| **Credential Adapter** | Isolated process (holds secrets) | Receives completed Action Packages, independently verifies all signatures and policy, then dispatches approved actions to real target MCP servers using stored credentials. Never exposes credentials to bridges or agents. |
| **Target MCP Server** | Spawned by Credential Adapter | The real application server (e.g., official GitHub MCP server). Only the adapter talks to it. |

> **Naming note.** Both components are MCP servers that translate an agent's tool calls into MPAS HTTP calls — "bridge" refers to that pattern, not to transparency. They're named differently because they're deployed differently:
>
> - The **Proposer Bridge** is a reusable base, not a standalone server. You run one instance *per application*, each wrapping an application plugin, so its server identity is the app it fronts (`github-mpas`, and later others). There is no single canonical "proposer server" to name.
> - **`mpas-coordination`** is a single, application-agnostic, standalone server that exposes the Coordination Service. It's named for the service it provides, not for any role: maintainers use it to review and approve, but it's equally available to a proposer or any participant that needs to poll coordination. That role-neutrality is exactly why it isn't `mpas-maintainer`.
>
> So three independent axes are in play: the agent **role / config `mode`** (`proposer` / `maintainer`), the **MCP server identity** (`github-mpas` / `mpas-coordination`), and the **component class** (`ProposerBridge` / `MaintainerBridge`). The class is named for the role that most uses it today; the server is named for the service it exposes. ("Signer" is a separate, generic protocol term for any participant that signs — see `trustedSigners`, `eligibleSigners`, `SignerReviewSet` — distinct from the maintainer role.)

### 1.3 Default Flow (Proposer → Coordination → Signers → Adapter → Execute)

1. **Agent A calls a tool** (e.g., `delete_branch_demo`) on its Proposer Bridge.
2. **Proposer Bridge constructs an Action Package** — Execution Payload + Action Envelope + Proposer Approval (signed with Agent A's key).
3. **Proposer Bridge submits to the Credential Adapter** directly. The adapter pins the `actionId` (lifecycle: `open`), verifies, evaluates policy → returns `additionalApprovalsRequired`. The `actionId` remains `open` (bundle-level failure does not consume it per Core Section 6.9.2).
4. **Proposer Bridge submits to the Coordination Service** (default `approvalStrategy: "coordinate"`). The coordination service stores the pending action (`awaitingApprovals` — a non-authoritative workflow state).
5. **Agent B's Maintainer Bridge polls the Coordination Service** — sees the pending action via `mpas_list_pending`.
6. **Agent B reviews and approves** — calls `mpas_review_action` then `mpas_approve`. The Maintainer Bridge signs an Approval with Agent B's key and submits it to the Coordination Service.
7. **Agent C does the same** — reviews and approves.
8. **Coordination Service detects threshold is met** (2 maintainer approvals collected). Assembles the full Approval Bundle into a completed Action Package. Transitions to `readyForResubmission`.
9. **Proposer Bridge polls, fetches the completed Action Package, and resubmits to the Credential Adapter** using the same `actionId` and same Action Envelope hash. Per Core Section 6.9.2, this resubmission is accepted because the action is `open` with matching hash.
10. **Credential Adapter performs full re-verification** of the newly submitted package — signatures, hash bindings, expiration, policy. Policy satisfied → transitions to `executing`.
11. **Policy satisfied → Adapter retrieves credentials** and dispatches `delete_branch_demo` to the real GitHub MCP server.
12. **Adapter issues an Execution Receipt** (lifecycle: `resolved(executed)`) and returns it to the Proposer Bridge.
13. **Proposer Bridge returns the result to Agent A.** The Coordination Service learns the outcome when the Proposer relays it.

### 1.4 Key Design Principles

- **Agents are isolated.** Each agent runs in its own container with its own signing key. Agents never share credentials or direct communication.
- **Bridges are the only agent interface.** Agents speak MCP — they don't know about MPAS protocol details, HTTP endpoints, or cryptographic artifact construction.
- **The Coordination Service is untrusted.** It's a message relay. It cannot forge approvals or bypass policy. The adapter verifies independently.
- **The Credential Adapter is the trust anchor.** It holds secrets, enforces policy, and executes. Nothing executes without its independent verification.
- **Tool names match the real server.** Proposer Bridges expose the same tool names as the official MCP server they replace. Agents making tool calls don't know they're going through MPAS.

---

## 2. Program Phases

| Phase | Work Location | Deliverable |
|---|---|---|
| **P0: Foundations** | `mpas-local` | Test fixtures, types, scaffolding |
| **P1: Verification** | `mpas-local` | Core verification pipeline |
| **P2: Policy** | `mpas-local` | Plugin loader, policy engine |
| **P3: Adapter Daemon** | `mpas-local` | Working daemon with MCP dispatch |
| **P4: MCP Bridge** | `oma3/mpas-sdk` | Bridge framework (proposer + signer capabilities) |
| **P5: Coordination** | `mpas-local` | Minimal localhost coordination service |
| **P6: Integration Demo** | `mpas-local/demo/` | Multi-agent demo (3 agents, 1 proposes, 2 approve) |

### 2.1 Dependency Graph

```
P0 ──▶ P1 ──▶ P2 ──▶ P3 ─-─┐
                           ├──▶ P6 (Integration Demo)
P4 (can start after P0) ───┤
                           │
P5 (can start after P3) ───┘
```

- P4 (MCP Bridge) can be developed in parallel with P1-P3 since it targets the adapter's HTTP interface (defined in P0 fixtures).
- P5 (Coordination Service) needs the adapter's interface to exist (P3) for forwarding.
- P6 (Demo) requires all components working together.

---

## 3. Phase Details

### P0–P3: Credential Adapter

See `docs/features/mvp/plan.md` for detailed tasks.

**Summary:** Build the adapter daemon that accepts Action Packages via HTTP, verifies them, evaluates policy, dispatches via MCP to target application servers, and returns receipts.

**Integration checkpoint after P3:** The adapter is running, and `curl -X POST http://localhost:7544/mpas/v1/action -H 'content-type: application/mpas+json' -d @action-request.json` (an ActionRequest wrapping the fixture) returns correct ActionResponse objects for all test fixtures.

---

### P4: MCP Bridge Framework

See `oma3/mpas-sdk/packages/mcp-bridge/docs/plan.md` for detailed tasks.

**Summary:** Build the library and example GitHub bridge that:
- Generates MCP tools from a plugin JSON (bare names matching the official server).
- Constructs Action Packages from tool calls.
- Signs Proposer Approvals.
- Submits to the Coordination Service (default strategy).
- Handles responses and reports status to the agent.
- Exposes signer tools (`mpas_approve`, `mpas_reject`, etc.).

**Integration checkpoint after P4:** An agent (or test script) calls `create_issue_demo` on the bridge, the bridge constructs an Action Package and submits to a mock coordination service. The coordination service forwards to the running adapter, and the adapter dispatches to the real GitHub MCP server. Issue is created.

---

### P5: Coordination Service (Minimal)

See `docs/features/coordination-localhost/plan.md` for detailed tasks.

**Summary:** Build a minimal localhost REST API that:
- Accepts proposals from bridges.
- Stores pending actions.
- Serves Signer Review Sets to signer agents.
- Accepts Approvals from signer agents.
- Forwards assembled Action Packages to the adapter.
- Distributes receipts.

**Integration checkpoint after P5:** A bridge submits a proposal that needs approvals → coordination service stores it → a maintainer bridge fetches and approves → coordination service re-submits to adapter → adapter executes → receipt is available.

---

### P6: Multi-Agent Integration Demo

**Location:** `mpas-local/demo/`

**Scenario:** Three agents collaborating on a destructive GitHub operation: deleting a repository branch.

**Setup:**
- Credential Adapter running with GitHub config (delete-branch requires 2 maintainer approvals).
- Coordination Service running on localhost.
- MPAS MCP Bridge (GitHub, proposer mode) for Agent A.
- MPAS MCP Bridge (signer mode) for Agent B and Agent C.

**Flow:**

1. Agent A (cleanup bot) calls `delete_branch_demo` on its Proposer Bridge.
2. Proposer Bridge constructs Action Package (Execution Payload + Action Envelope + Proposer Approval), submits to Coordination Service.
3. Coordination Service stores the pending action and makes it available to eligible signers.
4. Agent B's Maintainer Bridge polls the Coordination Service, sees the pending action via `mpas_list_pending`.
5. Agent B reviews (`mpas_review_action`) and approves (`mpas_approve`). Maintainer Bridge signs and submits Approval to Coordination Service.
6. Agent C does the same.
7. Coordination Service detects threshold met (2 maintainer approvals). Assembles completed Action Package.
8. Coordination Service forwards completed Action Package to Credential Adapter.
9. Adapter verifies independently → policy satisfied → dispatches `delete_branch_demo` to the real GitHub MCP server.
10. Adapter returns Execution Receipt to Coordination Service.
11. Coordination Service distributes receipt. All agents have confirmation.

**Demo deliverables:**
- `demo/docker-compose.yml` or `demo/start.sh` — starts all services.
- `demo/agents/proposer.ts` — simulates Agent A making the tool call.
- `demo/agents/signer-b.ts` — simulates Agent B reviewing and approving.
- `demo/agents/signer-c.ts` — simulates Agent C reviewing and approving.
- `demo/README.md` — prerequisites, how to run, expected output.

**Acceptance criteria:**
- [ ] `./demo/start.sh` launches all components.
- [ ] Full flow completes: propose → reject (insufficient) → collect approvals → re-submit → execute.
- [ ] Receipt is issued and verifiable.
- [ ] Demo is reproducible on a fresh machine with Node.js and a GitHub token.
- [ ] A developer can read the README and run the demo in under 10 minutes.

---

## 4. Shared Packages

The following packages from `oma3/mpas-sdk` are consumed by multiple repos:

| Package | Consumed By | Provides |
|---|---|---|
| `@oma3/mpas-core-utils` | Adapter, Bridge, Coordination Service | Types, hashing (JCS + SHA-256), JWS signing/verification |
| `@oma3/mpas-schemas` | Adapter, Bridge | JSON Schemas for Plugin Profile, Policy Profile, Action Package |
| `@oma3/mpas-test-vectors` | Adapter, Bridge, Coordination Service | Conformance test fixtures |
| `@oma3/mpas-mcp-bridge` | Bridge examples, agent integrations | ProposerBridge, MaintainerBridge, PluginToolGenerator |

For the MVP, these packages can be consumed via local workspace references or `file:` dependencies. Publishing to npm happens after the MVP is validated.

---

## 5. Integration Testing Strategy

| Test Level | What It Validates | Where It Lives |
|---|---|---|
| Unit tests | Individual functions and modules | Each repo's `tests/` folder |
| Component tests | A single running service with fixtures | Each repo's `tests/integration/` |
| Integration tests | Two services communicating | `tests/integration/` |
| End-to-end demo | Full multi-agent flow | `demo/` |

Integration tests:
- `adapter-bridge.test.ts` — bridge submits to adapter, validates responses.
- `adapter-coordination.test.ts` — coordination service forwards to adapter.
- `full-flow.test.ts` — propose → collect approvals → execute → receipt.

---

## 6. Timeline Guidance

This is not a calendar timeline — it's a sequencing guide for how tasks should be handed to coding agents:

| Order | Work | Estimated Tasks | Can Parallelize? |
|---|---|---|---|
| 1st | P0 (Fixtures + Types) | 6 tasks | No (foundation) |
| 2nd | P1 (Verification) | 7 tasks | No (sequential build) |
| 3rd | P2 (Policy) + P4 start (Bridge types) | 4 + 2 tasks | Yes (different repos) |
| 4th | P3 (Daemon) + P4 continue (Bridge proposer) | 9 + 3 tasks | Yes (different repos) |
| 5th | P5 (Coordination) + P4 finish (Bridge signer) | 5 + 2 tasks | Yes |
| 6th | P6 (Demo) | 2 tasks | No (needs everything) |

---

## 7. Success Criteria

The MPAS MVP is complete when:

1. A single agent can call a tool and have it auto-approved and executed through the full pipeline (P3 checkpoint).
2. The MCP Bridge generates correct Action Packages from tool calls and handles all adapter responses (P4 checkpoint).
3. Multiple signer agents can review and approve a pending action via the Coordination Service (P5 checkpoint).
4. The multi-agent demo runs end-to-end: propose → insufficient → collect approvals → re-submit → execute → receipt (P6).
5. All components are reproducible from source on a single macOS machine.
