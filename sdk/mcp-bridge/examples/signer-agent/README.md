# MPAS Signer Agent Example

This example starts an MCP server that exposes signer tools:

- `mpas_list_pending`
- `mpas_review_action`
- `mpas_approve`
- `mpas_reject`

## Prerequisites

- A running MPAS Coordination Service.
- An Ed25519 signer key file.

## Run

```sh
npx tsx examples/signer-agent/index.ts --config examples/signer-agent/config.example.json
```

The server uses MCP stdio transport. Add the command above to an MCP client configuration, replacing the placeholder DID, key path, and coordination URL for your deployment.
