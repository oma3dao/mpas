# MPAS MCP Proposer Bridge Client Interface Profile

**Status:** Superseded

**Former version:** Draft v0.1 / interface version `1`

**Superseded by:** [MPAS MCP Extension](./mpas-extension-mcp.md)

**Historical feature record:** [Asynchronous MCP Proposer Bridge](../docs/features/mcp-proposer-spec/spec.md)

---

## 1. Supersession

This profile formerly defined the proprietary
`mpas_wait_for_action_result` interface, MPAS-specific result wrappers,
description notices, and output-schema unions.

Those mechanisms are deprecated and MUST NOT be implemented by a new or
regenerated MPAS proposer bridge. They have been replaced by the official MCP
extension `io.modelcontextprotocol/tasks` together with the companion
`org.oma3/mpas` extension defined in
[MPAS MCP Extension](./mpas-extension-mcp.md).

The replacement targets MCP `2026-07-28`. It does not target the removed
experimental core Tasks API from MCP `2025-11-25`.

## 2. Migration Summary

| Superseded v0.1 mechanism | Replacement |
|---|---|
| `mpas_wait_for_action_result` | `tasks/get` |
| `MpasBridgeDeferredResult` | Flat official `CreateTaskResult` |
| `MpasBridgeActionOutcome` | Completed Task with a tool-level error result |
| Tool-name discovery | `server/discover` extension capabilities |
| MPAS description notices | Exact upstream descriptions |
| MPAS output-schema unions | Exact upstream output schemas |
| Action reference used as polling handle | Task ID equal to Action ID |

There is no compatibility mode that exposes both interfaces. Existing clients
using this superseded profile must migrate before connecting to a regenerated
bridge.

## 3. Bridge Identity

The replacement specification makes the deployment invariant explicit: an
MPAS proposer bridge serves exactly one proposing client or agent identity and
holds exactly one private key for one proposer DID. It does not multiplex
independent clients or identities.

A future authenticated multi-client component requires a different service
name and profile and is not an MPAS proposer bridge under the current
specification.
