# Maintainer setup guide

A Maintainer is the participant who reviews and approves (or rejects) governed
actions proposed by others. This account holds a signing key and a signer
server config. It has no access to upstream application credentials and cannot
propose actions itself.

This guide covers everything a maintainer account needs: generating a signing
key, sending the DID to the adapter operator, configuring the signer server,
and reviewing actions either from the human CLI or an agent harness.

For the full single-machine demo walkthrough, see the
[macOS demo setup guide](setup-macos.md).

---

## 1. Prerequisites

Complete Part 1 of the [macOS demo setup guide](setup-macos.md) on this
account: Xcode CLI tools, Homebrew, nvm, Node 22+, SSH key, repo clone, and
build.

The Coordination Service is started by the operator as part of the adapter
daemon — it is not a separate process you start here. Complete steps 2–4 of
this guide first, send your DID to the operator, and wait for them to confirm
the daemon is running before attempting to connect.

---

## 2. Generate your signing key

Generate your Ed25519 signing key in this account:

```sh
export MPAS_HOME="$HOME/.mpas"
mkdir -p "$MPAS_HOME/keys" "$MPAS_HOME/mcp-server-configs"

cd "$HOME/Projects/mpas/examples/demo"
node dist/cli/index.js key generate maintainer-key --key-dir "$MPAS_HOME/keys"
chmod 600 "$MPAS_HOME/keys/maintainer-key.json"
```

The command prints your DID:

```
Generated key: maintainer-key
  did: did:jwk:eyJjcnYiOiJFZDI1NTE5...
  Saved to: /Users/you/.mpas/keys/maintainer-key.json
```

**Send the `did:jwk:...` string to the adapter operator.** They need it to
register you in the deployment config's `signerGroups.maintainers` before your
approvals will be accepted. The private key stays in this account — never share
the key file.

Wait for the operator to confirm your DID is registered before proceeding.

---

## 3. Create your signer server config

Replace `REPLACE_WITH_YOUR_DID` with the `did:jwk:...` value from step 2:

```sh
cat > "$MPAS_HOME/mcp-server-configs/maintainer-signer-config.json" <<EOF
{
  "agent": {
    "did": "REPLACE_WITH_YOUR_DID",
    "keyFile": "$MPAS_HOME/keys/maintainer-key.json"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  }
}
EOF
```

The signer server connects to the Coordination Service to list pending actions
and submit signed approvals. It does not connect to the Credential Adapter
directly and holds no application credentials.

---

## 4. Human Maintainer CLI

The human CLI is the simplest way to review actions without an agent harness.
It starts the existing signer server over stdio and calls the same MCP tools an
agent Maintainer uses. It does not read the signing key, call Coordination
directly, cache Action Packages, or implement a second approval path.

Build the reference implementation, then use the signer config created above:

```sh
cd "$HOME/Projects/mpas/examples/demo"
npm run build

node dist/cli/index.js action pending \
  --config "$MPAS_HOME/mcp-server-configs/maintainer-signer-config.json"
```

The commands are:

```text
mpas action pending                     List pending approval requests
mpas action inspect <action-id>         Fetch and print one review set; read-only
mpas action review <action-id>          Print the review set and prompt Approve/Reject/Cancel
```

If the package has been linked as the `mpas` executable, use `mpas` directly.
Otherwise substitute `node dist/cli/index.js` as shown above. The default signer
config path is `~/.mpas/mcp-server-configs/maintainer-signer-config.json`, so
`--config` can be omitted when that standard filename is used.

Example interactive review:

```sh
mpas action review urn:uuid:REPLACE_WITH_ACTION_ID
```

The CLI first invokes `mpas_review_action` and prints the complete structured
review result. It then warns that a decision will be signed and asks:

```text
Decision [a]pprove, [r]eject, [c]ancel:
```

- Approve invokes `mpas_approve` with the Action ID.
- Reject invokes `mpas_reject` with the Action ID.
- Cancel, empty input, EOF, or interruption submits nothing.

`action review` requires an interactive terminal. `pending`, `inspect`, and
decision receipts print the signer tool's structured response as readable JSON
by default. The signer server controls which fields it returns and is
responsible for redaction; the CLI does not apply an additional filter.

Approving an action authorizes the Credential Adapter to execute it. Always
check the target application, operation, resources, exact arguments, proposer,
expiry, and Action Envelope digest shown by the review result.

---

## 5. Register the signer server in your agent harness

Register the signer server as an MCP server. The maintainer account should only
register the signer server — do not add any proposer bridge to this account.

### Codex CLI

Add to `~/.codex-maintainer/config.toml` (create the directory if needed):

```toml
[mcp_servers.mpas-coordination]
command = "node"
args = [
  "/Users/YOU/Projects/mpas/examples/demo/dist/signer-server/index.js",
  "--config",
  "/Users/YOU/.mpas/mcp-server-configs/maintainer-signer-config.json"
]
enabled = true
```

Run the maintainer session:

```sh
CODEX_HOME=~/.codex-maintainer codex
```

### OpenClaw

```sh
openclaw config set mcp.servers.mpas-coordination "$(cat <<'JSON'
{
  "command": "/ABSOLUTE/PATH/TO/node",
  "args": [
    "/Users/YOU/Projects/mpas/examples/demo/dist/signer-server/index.js",
    "--config",
    "/Users/YOU/.mpas/mcp-server-configs/maintainer-signer-config.json"
  ]
}
JSON
)" --strict-json

openclaw config set tools.allow '["mpas-coordination__*"]' --strict-json
openclaw gateway restart
```

Replace `/ABSOLUTE/PATH/TO/node` with `which node` output and `/Users/YOU/`
with your home directory.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mpas-coordination": {
      "command": "node",
      "args": [
        "/Users/YOU/Projects/mpas/examples/demo/dist/signer-server/index.js",
        "--config",
        "/Users/YOU/.mpas/mcp-server-configs/maintainer-signer-config.json"
      ]
    }
  }
}
```

Restart Claude Desktop after saving.

---

## 6. Add role instructions to your agent

Paste the maintainer preamble from the
[macOS demo setup guide](setup-macos.md) §3.1 into the instruction file your
harness always loads (`AGENTS.md`, `CLAUDE.md`, or equivalent). Copy
`integrations/skills/mpas-maintainer/` into that harness’s skills directory
(see §3.1).

---

## 7. Verify

Confirm the signer server tools are visible and the coordination service is
reachable. In your agent session, ask:

> What MCP tools do you have available?

You should see exactly four tools: `mpas_list_pending`, `mpas_review_action`,
`mpas_approve`, and `mpas_reject`.

Then poll for pending actions to confirm connectivity:

> List any pending MPAS approvals.

An empty list is the expected successful result — it confirms the signer server
can reach the coordination service.

---

## Agent approval workflow

When a proposer submits a governed action that requires approval, you will be
notified with an Action ID. Your workflow:

1. Call `mpas_list_pending` to see pending actions, or `mpas_review_action`
   with the Action ID to inspect a specific one.
2. Review the action: is the target resource correct, is the operation
   reasonable, does it match what the user intended?
3. Call `mpas_approve` to authorize execution, or `mpas_reject` to block it
   with a reason.

Approving an action **is** authorizing the Credential Adapter to execute it.
You cannot approve your own proposals — MPAS enforces this at the protocol
level regardless of signer group membership.

---

## Related documentation

- [macOS demo setup guide](setup-macos.md) — full single-machine walkthrough
- [proposer setup guide](proposer.md)
- [Credential Adapter operator guide](credential-adapter.md)
