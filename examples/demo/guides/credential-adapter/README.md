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

mpas oauth login  --application-did <did>
mpas oauth status --application-did <did>
mpas oauth logout --application-did <did>
```

Use `mpas oauth login ... --no-browser` for a print-only/headless login flow.
Only an operator should execute OAuth login. Agents, proposer bridges, Action
submission, and automatic retries must never open the authorization URL or
initiate consent.

`application-did` is the exact `target.applicationDid` in an adapter deployment
config loaded from `--config-dir` (by default `$MPAS_HOME/config`). The config
loader already requires it to be unique. OAuth commands reject unknown
Application DIDs and applications whose execution target is not `mcp.http`.
Selector resolution reads only the deployment envelope fields needed for OAuth;
it does not load plugin artifacts or trigger plugin trust prompts.

The deployment's `executionTarget.auth.session` is the operator-controlled token
location name. The CLI and adapter resolve the same name to
`~/.mpas/oauth-sessions/<session>.json`; the MCP server does not choose it.

The first implementation manages one OAuth grant per Application DID. Its
security binding also includes the exact MCP resource, issuer, client, and
scopes resolved by the secure provider. A future multi-account design may add an
optional alias, but operators do not choose or persist a session number today.

## Current managed OAuth status

The demo CLI connects the OAuth command surface to a loopback callback listener
and the MCP SDK authorization flow. `oauth login` opens the operator's browser
(unless `--no-browser` is used), completes authorization, and stores the grant
under `~/.mpas/oauth-sessions/`. The session files use restrictive mode `0600`
permissions and are intended for local development and interoperability testing.
Production deployments should replace this file-backed provider with an
OS-managed or encrypted credential store.

The adapter reuses the stored grant for authenticated MCP HTTP dispatch and the
SDK refresh lifecycle. `oauth logout` deletes the local grant; remote revocation
is not currently available.

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
- `logout` removes local credentials even when remote revocation is unavailable.

## Related documentation

- [Demo setup for macOS](../setup-macos.md)
- [Managed MCP OAuth specification](../../../../docs/features/mcp-oauth/spec.md)
- [Managed MCP OAuth implementation plan](../../../../docs/features/mcp-oauth/plan.md)
