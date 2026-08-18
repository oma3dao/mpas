# Proposer setup guide

A Proposer is the participant who submits governed actions through the MPAS
bridge. This account holds a signing key and a bridge config. It never holds
upstream application credentials — those stay in the Credential Adapter.

This guide covers everything a proposer account needs: generating a signing
key, sending the DID to the adapter operator, configuring the bridge, and
connecting to an agent harness.

For the full single-machine demo walkthrough, see the
[macOS demo setup guide](setup-macos.md).

---

## 1. Prerequisites

Complete Part 1 of the [macOS demo setup guide](setup-macos.md) on this
account: Xcode CLI tools, Homebrew, nvm, Node 22+, SSH key, repo clone, and
build.

The adapter daemon (which also runs the Coordination Service) is started by the
operator after all signer accounts are set up and their DIDs are registered.
Complete steps 2–4 of this guide first, send your DID to the operator, and wait
for them to confirm the daemon is running before attempting to connect.

---

## 2. Generate your signing key

Generate your Ed25519 signing key in this account:

```sh
export MPAS_HOME="$HOME/.mpas"
mkdir -p "$MPAS_HOME/keys" "$MPAS_HOME/mcp-server-configs" "$MPAS_HOME/plugins" "$MPAS_HOME/workflows"

cd "$HOME/Projects/mpas/examples/demo"
node dist/cli/index.js key generate proposer-key --key-dir "$MPAS_HOME/keys"
chmod 600 "$MPAS_HOME/keys/proposer-key.json"
```

The command prints your DID:

```
Generated key: proposer-key
  did: did:jwk:eyJjcnYiOiJFZDI1NTE5...
  Saved to: /Users/you/.mpas/keys/proposer-key.json
```

**Send the `did:jwk:...` string to the adapter operator.** They need it to
register you in the deployment config before you can submit actions. The
private key stays in this account — never share the key file.

Wait for the operator to confirm your DID is registered before proceeding.

---

## 3. Find the bridge for your application

The `application-registry/` folder in the `mpas` repository is the index of
all known MPAS bridges, regardless of where they are published. Bridges
contributed by the community live in `mpas-applications`, but third-party or
vendor implementations have their own repositories — the registry points to
all of them.

```sh
ls "$HOME/Projects/mpas/application-registry/"
```

Open the registry entry for the application you want — for example
`netlify-wivity.json` or `github-wivity.json`. The key fields are:

- **`application.applicationDid`** — the DID you put in your bridge config's
  `target.applicationDid`
- **`plugin.repository`** — where to find the `plugin.json` for the adapter
  operator
- **`publisher.repository`** — where the full bridge artifacts live (bridge
  source, `harness-config.json`, `adapter-config.example.json`). For
  community-contributed bridges this points into `mpas-applications`; for
  others it may be a separate repo entirely.

Clone the publisher's repository to get the bridge artifacts:

```sh
# For bridges in mpas-applications
git clone https://github.com/oma3dao/mpas-applications.git "$HOME/Projects/mpas-applications"

# The bridge for your application is under:
# $HOME/Projects/mpas-applications/applications/<name>/
```

Read the application's `README.md` in that folder before proceeding — it
documents provider-specific credential setup, bypass risks, and notes on the
governed surface.

## 4. Create your bridge config

Copy the application plugin into your local MPAS directory:

```sh
# Example for GitHub (wivity bridge)
cp "$HOME/Projects/mpas-applications/applications/github/plugin.json" \
   "$MPAS_HOME/plugins/github-plugin.json"
```

Create a bridge config. Use the `applicationDid` from the registry entry as
`target.applicationDid`, and replace `REPLACE_WITH_YOUR_DID` with your
`did:jwk:...` from step 2:

```sh
cat > "$MPAS_HOME/mcp-server-configs/github-mcp-bridge-config.json" <<EOF
{
  "mode": "proposer",
  "plugin": "$MPAS_HOME/plugins/github-plugin.json",
  "adapter": {
    "url": "http://127.0.0.1:7544"
  },
  "agent": {
    "did": "REPLACE_WITH_YOUR_DID",
    "keyFile": "$MPAS_HOME/keys/proposer-key.json"
  },
  "target": {
    "applicationDid": "did:web:wivity.com:applications:github-mcp-server"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  },
  "workflow": {
    "dbPath": "$MPAS_HOME/workflows/github.db"
  }
}
EOF
```

Replace `http://127.0.0.1:7544` and `http://127.0.0.1:7545` with the actual
adapter and coordination service URLs if the operator is running the daemon
remotely rather than on the same machine.

---

## 5. Register the bridge in your agent harness

Build the bridge before registering it — the `dist/` output doesn't exist
until you run the build:

```sh
cd "$HOME/Projects/mpas-applications/applications/github/bridge"
npm ci
npm run build
```

Register the built bridge as an MCP server.

Register the bridge as an MCP server. The proposer account should only register
the proposer bridge — do not add the maintainer signer server to this account.

### Codex CLI

Add to `~/.codex-proposer/config.toml` (create the directory if needed):

```toml
[mcp_servers.github-mpas]
command = "node"
args = [
  "/Users/YOU/Projects/mpas-applications/applications/github/bridge/dist/index.js",
  "--config",
  "/Users/YOU/.mpas/mcp-server-configs/github-mcp-bridge-config.json"
]
enabled = true
```

Run the proposer session:

```sh
CODEX_HOME=~/.codex-proposer codex
```

### OpenClaw

```sh
openclaw config set mcp.servers.github-mpas "$(cat <<'JSON'
{
  "command": "/ABSOLUTE/PATH/TO/node",
  "args": [
    "/Users/YOU/Projects/mpas-applications/applications/github/bridge/dist/index.js",
    "--config",
    "/Users/YOU/.mpas/mcp-server-configs/github-mcp-bridge-config.json"
  ]
}
JSON
)" --strict-json

openclaw config set tools.allow '["github-mpas__*", "group:web", "read"]' --strict-json
openclaw gateway restart
```

Replace `/ABSOLUTE/PATH/TO/node` with `which node` output and `/Users/YOU/`
with your home directory.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "github-mpas": {
      "command": "node",
      "args": [
        "/Users/YOU/Projects/mpas-applications/applications/github/bridge/dist/index.js",
        "--config",
        "/Users/YOU/.mpas/mcp-server-configs/github-mcp-bridge-config.json"
      ]
    }
  }
}
```

Restart Claude Desktop after saving.

---

## 6. Add role instructions to your agent

Paste the proposer preamble from the
[macOS demo setup guide](setup-macos.md) §3.1 into the instruction file your
harness always loads (`AGENTS.md`, `CLAUDE.md`, or equivalent). Copy
`integrations/skills/mpas-proposer/` into that harness’s skills directory
(see §3.1). Include the application-specific addendum for any bridges you
have connected.

---

## 7. Verify

Confirm the bridge tools are visible and the adapter is reachable. In your
agent session, ask:

> What MCP tools do you have available?

You should see the governed operation tools for the application you connected.
Progress is observed with `tasks/get` on the Task the bridge returns.

Then run a pass-through action (no approval needed) to confirm end-to-end
connectivity. Use any low-impact read or write operation supported by the
application you connected. If it succeeds, the bridge is correctly connected
to the adapter.

---

## Related documentation

- [macOS demo setup guide](setup-macos.md) — full single-machine walkthrough
- [maintainer setup guide](maintainer.md)
- [Credential Adapter operator guide](credential-adapter.md)
