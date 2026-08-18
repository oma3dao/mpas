# MPAS Skills for ClawHub

Cryptographic multi-party authorization for OpenClaw agent operations.

## The gap

OpenClaw agents performing write operations against real systems (GitHub,
databases, cloud infrastructure, payment APIs) currently have no approval
mechanism. No credential separation. No audit trail. A prompt injection,
hallucination, or misunderstood instruction executes immediately against
production with whatever credentials the agent holds.

MPAS fills that gap.

## What these skills provide

| Capability | What it means for your agent |
|---|---|
| **Credential separation** | Your agent never holds the write token. An MCP bridge mediates; a Credential Adapter holds the real credential and executes only after authorization. |
| **Cryptographic action binding** | Every Approval is a JWS over the hash of the exact operation, target, arguments, and conditions. An approval for "delete branch X" cannot authorize "delete branch Y." |
| **Independent authorization** | A separate signer identity (human, agent, or policy service) reviews and approves. Profile specifications and policy can enforce that a proposer cannot approve their own actions. |
| **Flexible signer types** | A Maintainer can be a human reviewer, another AI agent, or a deterministic policy service that enforces SOC 2 change-control, HIPAA access constraints, PCI audit rules, or KYC verification. |
| **Auditable dispatch ledger** | Every action lifecycle (propose → approve/reject → execute/fail) is journaled with signed receipts. |

## Install

```sh
openclaw skills install @oma3/mpas-proposer
openclaw skills install @oma3/mpas-maintainer
```

Install one or both depending on your agent's role. An agent that both proposes
and approves others' actions (symmetric signer) installs both — MPAS enforces
that one identity cannot approve its own proposals.

## Skills

| Skill | Role |
|---|---|
| `mpas-proposer` | Proposes governed actions through MPAS MCP bridges. Tracks authorization lifecycle via MCP Tasks. |
| `mpas-maintainer` | Reviews and approves/rejects proposed actions. Last gate before execution. |

## How it works

```
┌─────────────────┐        ┌──────────────┐        ┌────────────────────┐
│  Proposer Agent │──MCP──▶│  MPAS Bridge │──HTTP──▶│ Credential Adapter │
│  (no credential)│        │  (mediator)  │        │ (holds the token)  │
└─────────────────┘        └──────────────┘        └────────────────────┘
                                  │                          │
                                  ▼                          ▼
                           ┌──────────────┐          ┌──────────────┐
                           │ Coordination │◀─────────│ Target System│
                           │   Service    │          │ (GitHub, DB) │
                           └──────────────┘          └──────────────┘
                                  ▲
                                  │
                           ┌──────────────┐
                           │  Maintainer  │
                           │  (approver)  │
                           └──────────────┘
```

1. Proposer calls an application tool through the MPAS MCP bridge.
2. Bridge constructs an Action Envelope (signed by proposer), submits to adapter.
3. Adapter evaluates policy → requires additional approval.
4. Proposer notifies Maintainer with Action ID and context.
5. Maintainer reviews the exact action, approves (signs) or rejects.
6. Adapter receives the approval, dispatches with the real credential.
7. Result flows back to the proposer.

## Compliance and regulated environments

For environments where "an LLM thought it looked safe" is not sufficient:

- **SOC 2 Type II** — signed approval + dispatch ledger satisfies change-control.
- **HIPAA** — deterministic signer enforces minimum-necessary before PHI access.
- **PCI DSS** — dual authorization and segregation of duties via separate signer identities.
- **KYC/AML** — identity verification gate before financial operations execute.

The Maintainer is a DID with a signing key. It can be a human, another agent,
or a deterministic policy service that signs only when compliance conditions
are met.

## Links

- [MPAS Protocol](https://github.com/oma3dao/mpas)
- [OMA3 DAO](https://www.oma3.org/)
- [Full Setup Guide](https://github.com/oma3dao/mpas/blob/main/examples/demo/guides/setup-macos.md)
