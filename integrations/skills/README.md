# MPAS Agent Skills

Canonical [AgentSkills](https://agentskills.io) packages for MPAS proposer and
maintainer roles. These skills teach AI agents how to participate in MPAS (Multi-Party
Action System) governance flows over MCP.

They are harness-agnostic. Any MCP-capable client (OpenClaw, Kiro, Claude Code,
Codex CLI, Hermes, or any conforming implementation) can use them.

Give each agent exactly one role. Each SKILL.md includes the matching
prime-directive preamble and setup instructions at the top — follow those to
configure your agent's always-on instruction file (`AGENTS.md`, `CLAUDE.md`,
or equivalent). Do not combine both roles in one agent.

## Skills

| Skill | Role |
|---|---|
| `mpas-proposer` | Proposes governed actions through MPAS MCP bridges. Tracks MCP Tasks through the authorization lifecycle. |
| `mpas-maintainer` | Reviews and approves/rejects proposed actions. Independent verification gate before execution. |

Install one depending on the agent's role.

## What MPAS provides

- **Credential separation** — the agent never holds the write credential. An
  MCP bridge mediates; a Credential Adapter executes only after authorization.
- **Cryptographic action binding** — every Approval is a JWS over the hash of
  the exact operation, target, arguments, and conditions.
- **Independent authorization** — a separate signer identity (human, agent,
  or policy service) reviews and approves. Profile specifications and policy
  can enforce that a proposer cannot approve their own actions.
- **Flexible signer types** — a Maintainer can be a human reviewer, another
  AI agent, or a deterministic policy service that enforces SOC 2, HIPAA, PCI,
  KYC, or other regulatory requirements before authorizing execution.
- **Auditable dispatch ledger** — every action lifecycle is journaled with
  signed receipts.

## Installation

How you install depends on your agent harness:

- **Skill systems** (Kiro, OpenClaw) — install the skill directory directly.
  Then follow the "Setup: always-on preamble" section at the top of the
  SKILL.md to configure your instruction file.
- **Instruction files** (Claude Code, Codex CLI, Hermes) — paste the preamble
  from the top of the SKILL.md into your always-on instruction file, then
  paste the rest of the SKILL.md body after it.

## Links

- [MPAS Specification](../../specs/mpas-specification.md)
- [Demo Setup Guide](../../examples/demo/guides/setup-macos.md)
- [OMA3 DAO](https://www.oma3.org/)
