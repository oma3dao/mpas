# MPAS agent skills

Canonical [AgentSkills](https://agentskills.io) packages for MPAS proposer and
maintainer roles. Copy a skill directory into the harness skills path
(OpenClaw workspace `skills/`, Hermes `~/.hermes/skills/`, Codex
`$CODEX_HOME/skills/`, and similar).

Give each agent exactly one role. Paste the matching prime-directive preamble
from [`examples/demo/guides/setup-macos.md`](../../examples/demo/guides/setup-macos.md)
§3.1 into that agent's always-on instruction file (`AGENTS.md`, `CLAUDE.md`,
or equivalent). Do not combine both roles in one agent.

| Role       | Directory          |
| ---------- | ------------------ |
| Proposer   | `mpas-proposer/`   |
| Maintainer | `mpas-maintainer/` |
