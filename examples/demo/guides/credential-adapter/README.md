# Credential Adapter operator guide

The Credential Adapter is the trusted MPAS component that verifies Action
Packages, evaluates policy, holds downstream credentials, dispatches authorized
operations, and signs Execution Receipts. Agents and MCP bridges must not have
access to its credential stores or operator controls.

This guide is the operator-facing home for the demo Credential Adapter. The
feature specifications under [`docs/features`](../../../../docs/features/) are
the design authority; this guide explains how to operate the reference demo.

## Commands

```sh
mpas daemon start
mpas daemon status

mpas oauth login  --deployment <id> --session <name>
mpas oauth status --deployment <id> --session <name>
mpas oauth logout --deployment <id> --session <name>
```

Use `mpas oauth login ... --no-browser` for a print-only/headless login flow.
Only an operator should execute OAuth login. Agents, proposer bridges, Action
submission, and automatic retries must never open the authorization URL or
initiate consent.

## Current managed OAuth status

The OAuth command surface and redacted operator-service contract are present,
but the secure OAuth session provider, callback listener, encrypted token store,
refresh lifecycle, and remote revocation are not connected yet. Until that
provider is installed, the commands fail closed with
`oauth_operator_service_unavailable`; they do not create plaintext token files
or open a browser.

The exact operator command is safe to show in an `oauth_login_required` or
`oauth_reauthorization_required` result. Tokens, client secrets, authorization
codes, PKCE material, cookies, and callback query strings must never be printed.

## Security boundary

- Run the adapter in an operator-controlled OS account or equivalent isolated
  environment; do not colocate its credentials with proposer/maintainer agents.
- OAuth authenticates the adapter to a downstream MCP server. It never counts
  as an MPAS Approval and never bypasses Action verification or policy.
- `status` output is deliberately redacted to issuer, exact resource, client
  mode, scope names, expiry/refreshability, and reauthorization state.
- `logout` must remove local credentials even when remote revocation is
  unavailable. The connected secure provider will implement that lifecycle.

## Related documentation

- [Demo setup for macOS](../setup-macos.md)
- [Managed MCP OAuth specification](../../../../docs/features/mcp-oauth/spec.md)
- [Managed MCP OAuth implementation plan](../../../../docs/features/mcp-oauth/plan.md)
