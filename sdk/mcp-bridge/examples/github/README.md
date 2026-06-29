# GitHub MPAS MCP Bridge Example

This example starts an MCP server that exposes the GitHub operation tools from the MPAS GitHub plugin fixture and routes tool calls through a Credential Adapter instead of executing GitHub operations directly.

## Prerequisites

- A running MPAS Credential Adapter that accepts `POST /v1/actions`.
- An Ed25519 proposer key file.
- A GitHub MPAS Application Plugin JSON file.

## Run

```sh
npx tsx examples/github/index.ts --config examples/github/config.example.json
```

The server uses MCP stdio transport. Add the command above to an MCP client configuration, replacing the placeholder DID, key path, plugin path, adapter URL, and target application DID for your deployment.

This bridge is intended as a governed replacement for direct GitHub MCP write tools. The fixture keeps the MVP adapter contract operation names: `create_issue`, `merge_pull_request`, and `delete_branch`.
