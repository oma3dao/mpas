# MPAS MVP Mac Demo Setup

**Target demo machine:** Intel or Apple Silicon Mac running macOS 11 Big Sur or newer  
**Tested target:** MacBook Pro 15-inch 2017, Intel Core i7, 16 GB RAM, macOS Ventura 13.7.x  
**Purpose:** Run the local MPAS demo stack with autonomous agents  
**Last updated:** 2026-06-14  
**Specifications:** ../../specs/ (local)

| Document                              | Description                                                       |
| ------------------------------------- | ----------------------------------------------------------------- |
| `mpas-specification.md`               | Core protocol: Action Lifecycle, dispatch ledger, artifact model  |
| `mpas-profile-http.md`                | HTTP Profile: wire format, ActionRequest/Response, coordination   |
| `mpas-profile-mcp.md`                 | MCP Profile: execution payload format for MCP tool calls          |
| `mpas-profile-application-plugin.md`  | Application Plugin Profile: plugin schema and operation defs      |
| `mpas-profile-policy-json.md`         | JSON Verifier Policy Profile: policy matching and evaluation      |

---

## Document Structure

**This guide assumes ~/Projects is the folder you use for Git repositories.  You can substitute with your own path if that is not the case.**

**All commands assume you are on the `main` branch of `mpas`.** If you've checked out a feature branch for development, switch back to `main` before following this guide — the fixtures, configs, and CLI all need to be consistent with what `main` produces.

| Part       | What it covers                                    | Who needs it                                                     |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| **Part 1** | Machine prerequisites, repo, build, agent harness | Every account (operator + agents)                                |
| **Part 2** | Single-user demo setup: keys, configs, daemon     | Single-user flow (one account does everything)                   |
| **Part 3** | Harness-specific MCP bridge configuration         | Depends on your agent (Codex CLI, OpenClaw, Claude Desktop)      |
| **Part 4** | Demo scenarios + live GitHub dispatch             | Everyone running the demo                                        |
| **Part 5** | Multi-user hardening (workspace separation)       | Optional — for true key isolation across accounts                |

If you already have Node 22 (or later) and your agent harness installed, skip to Part 1 Step 6 (Clone the repository).  
If you already have MPAS built and tests passing, skip to Part 2 (single-user) or Part 5 (multi-user agent account).

> **Which account should you use?**  
> For the single-user demo (Parts 1–4), use the macOS account you plan to keep as the **operator** (Credential Adapter + Coordination Service) if you later split into multiple users. This could be your existing development account or a new dedicated account. If you add workspace separation (Part 5), this account keeps the adapter and credential — the agent responsibilities move to new accounts.  
>  
> If you already have an account with Node, git, and the repo cloned — use that. If you're starting from scratch and plan to do the hardened three-user flow eventually, create the operator account first and set up here.

> **Agent naming — "proposer" and "maintainer":**  
> Throughout this guide we use the role names **proposer** (the agent that calls GitHub tools) and **maintainer** (the agent that approves/rejects actions), because they describe what each agent does. Your harness, however, creates a default agent with a generic name:
>
> | Harness        | Default agent name | Use it as      |
> | -------------- | ------------------ | -------------- |
> | OpenClaw       | `main`             | the proposer   |
> | Codex CLI      | none — you create config dirs yourself | name them explicitly |
>
> **Recommendation:** Keep the default name (`main`) rather than renaming it — renaming can break the harness's internal agent registry and message routing. Just remember: **wherever this guide says "proposer," substitute your harness's default agent name** (`main` for OpenClaw). For the **maintainer**, you create a second agent — name that one `maintainer` (or any name you like) since it has no default.
>
> **Terminology note:** The MPAS protocol uses "signer" as a generic term for any participant that signs something (both proposers and maintainers are signers). In this guide, we use "maintainer" for the specific role that reviews and approves/rejects actions. In config files, `signerKeys` is the key registry (DID + publicJwk for verification) and `policy.signerGroups` defines authorization (who can propose, who can approve).

---

# Part 1 — Environment Setup

This part gets your Mac ready: runtime, repository, build, and agent harness. Every account (operator and agent) completes Part 1.

> **Note:** If you later set up workspace separation (Part 5), each agent account will need its own Part 1 setup — Node (22+, LTS recommended), agent harness, GitHub access, and a built copy of the repo. Global tools installed via Homebrew (`jq`, `gh`) are shared across macOS users, but Node (via nvm) and npm global packages (like OpenClaw or Codex CLI) are per-user. Plan accordingly.

## 1.1 Prerequisites

Follow these steps in order. If you already have a tool installed, verify it and skip to the next one.

### Step 1: Xcode Command Line Tools

This installs `git` and other build tools needed for everything that follows.

```sh
xcode-select --install
```

If already installed, this will tell you so. Verify git is available:

```sh
git --version
```

### Step 2: Install Homebrew

Homebrew is the package manager for macOS system tools.

Install: https://brew.sh

After installation, follow the instructions Homebrew prints to add it to your PATH. Verify:

```sh
brew --version
```

### Step 3: Install nvm (Node Version Manager)

nvm manages Node.js versions per user account. It is **not** installed via Homebrew — use the installer from the project page.

Install: https://github.com/nvm-sh/nvm#installing-and-updating

After installation, **close and reopen your terminal** (or run `source ~/.zshrc`) so the `nvm` command becomes available. Verify:

```sh
nvm --version
```

### Step 4: Install Node.js (22 or later)

MPAS requires Node 22 or later. The current LTS is recommended; Node 22 remains supported for older macOS versions (11+).

```sh
nvm install --lts
node --version   # should show v22.x or later
```

If you're on an older Mac (macOS 11–12) and the current LTS doesn't support your OS, fall back to Node 22:

```sh
nvm install 22
```

### Step 5 (Optional): jq and GitHub CLI

```sh
brew install jq gh
```

- `jq` — pretty-prints JSON (useful for reading adapter responses).
- `gh` — GitHub CLI (simplifies cloning private repos).

### Step 6: Clone the repository

Clone the source repository. You'll need it for the build step next.

**SSH key setup (if you haven't already):**

Most users authenticate to GitHub via SSH. If you don't have an SSH key configured for this account, follow GitHub's guide: https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent

Verify your key works:

```sh
ssh -T git@github.com
```

Expected: `Hi <username>! You've successfully authenticated...`

**Clone via SSH (recommended):**

```sh
mkdir -p ~/Projects/mpas
cd ~/Projects/mpas
git clone git@github.com:oma3dao/mpas.git mpas
```

Ensure you're on `main`:

```sh
cd ~/Projects/mpas/mpas && git checkout main
```

If you prefer HTTPS (e.g., behind a corporate firewall that blocks SSH), use `https://github.com/oma3dao/mpas.git` instead. You'll need a PAT or credential helper configured.

**GitHub credential guidance for agent accounts:**

The SSH key (or PAT) used here gives this account read access to the MPAS source repo — that's fine for cloning and pulling. The security boundary that matters is **write access to the target repository** (the one the agent proposes actions against). To maintain that boundary:

- **Do not give the agent account write access** to the demo/target repository via SSH key, PAT, or git credential helper. If the agent can write to GitHub directly, it can bypass MPAS entirely.
- For agent accounts that need read-only access to additional repos, use a fine-grained PAT scoped to read-only: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token

The only path to write operations should be through the MPAS bridge → Credential Adapter, which holds the privileged token separately (configured in Part 2).

### Step 7: Build MPAS

Install dependencies and build the demo package and MCP bridge:

```sh
cd ~/Projects/mpas/mpas/examples/demo
npm install
npx tsx scripts/generate-fixtures.ts
npm run build
npm test
```

Then the protocol SDK:

```sh
cd ~/Projects/mpas/mpas/sdk/protocol
npm install
npm run build
npm test
```

Expected: `examples/demo` passes 213+ tests; `sdk/protocol` passes 42 tests.

### Step 8: Run the E2E Test

This verifies the full stack end-to-end (proposer → coordination → maintainer → adapter → dispatch):

```sh
cd ~/Projects/mpas/mpas/examples/demo
npm run test:e2e:mcp-bridge -- --mcp-bridge-dir ~/Projects/mpas/mpas/sdk/protocol
```

Expected: 2 tests pass (approval flow + replay detection).

## 1.2 Install Your Agent Harness

Install one (or more) of the following. Each option ends with a verification that the harness is alive. You do not configure MPAS bridges yet — that happens in Part 3.

### Option A: Codex CLI

Codex CLI is OpenAI's agentic coding CLI. Lightweight, runs in a terminal, works over SSH on older Macs.

```sh
npm install -g @openai/codex
codex --version
```

Sign in with your OpenAI account when prompted (`codex login`), or set an API key:

```sh
export OPENAI_API_KEY="sk-..."
```

For detailed installation help, see: https://github.com/openai/codex

**Verify:** `codex --version` prints a version number.

### Option B: OpenClaw

OpenClaw is an open-source autonomous agent framework with multi-channel support.

```sh
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

For detailed macOS installation (including Apple Silicon troubleshooting): https://openclaw.ai/

**Verify** the gateway is running:

```sh
openclaw gateway status
```

Expected: Gateway running, RPC healthy. If the gateway didn't start during onboarding, run `openclaw gateway start`.

Open the TUI to confirm the agent responds:

```sh
openclaw tui
```

Type a message (e.g., "hello") and confirm you get a response from the default agent. Exit with /quit. MPAS-specific configuration (security hardening, agent workspaces, bridge connections) happens in §3B.

### Option C: Claude Desktop (Flow not yet verified)

Claude Desktop is Anthropic's desktop MCP client. Download from: https://claude.ai/download

After installation it reads MCP config from `~/Library/Application Support/Claude/claude_desktop_config.json`.

**Verify:** Open the app and confirm the model responds in a new conversation.

> **After Part 1:** Continue to Part 2 for the single-user demo (one account does everything). If you're setting up an agent account in a multi-user topology, see Part 5 instead — it covers agent-specific key generation, bridge config, then points you to Part 3.

---

# Part 2 — Single-User Demo Setup

This part sets up the entire MPAS demo on a single account: all signing keys, deployment config, bridge configs, credentials, and the daemon. It assumes you completed Part 1 (the repo is cloned, built, and tests pass).

> **Single-user vs. multi-user:** In this flow, one account generates all keys (adapter + proposer + maintainer), creates all bridge configs, holds the credential, runs the daemon, AND runs the agents. For workspace separation across multiple macOS accounts (recommended for security), go through this flow first to understand the process and then see Part 5.

## 2.1 Prepare a Demo MPAS Home

```sh
export MPAS_HOME="$HOME/.mpas"
mkdir -p "$MPAS_HOME/config" "$MPAS_HOME/plugins" "$MPAS_HOME/credentials" "$MPAS_HOME/keys" "$MPAS_HOME/journal" "$MPAS_HOME/bridge-configs"
```

### Copy the application plugin and deployment config

The plugin and config give you a template you can customize for your MPAS implementation.

```sh
cd ~/Projects/mpas/mpas/examples/demo
cp tests/fixtures/plugins/github-repo.json "$MPAS_HOME/plugins/github-repo.json"
cp tests/fixtures/configs/github-strict.json "$MPAS_HOME/config/github-strict.json"
```

### Generate signing keys

The test suite uses hardcoded private keys so that fixtures (signed action packages, JWS signatures) are reproducible across runs. Those keys are committed to the repository and are not secret. For the demo, you generate your own keys — each participant gets a fresh Ed25519 key pair that derives a unique `did:key` identity.

You need three keys:

| Key file                | Role       | Purpose                               |
| ----------------------- | ---------- | ------------------------------------- |
| `adapter-key.json`      | Adapter    | Signs Execution Receipts              |
| `proposer-key.json`     | Proposer   | Signs Action Envelopes and proposals  |
| `maintainer-a-key.json` | Maintainer | Signs approvals                       |

Generate them directly into `$MPAS_HOME/keys`:

```sh
cd ~/Projects/mpas/mpas/examples/demo
node dist/cli/index.js key generate adapter-key --key-dir "$MPAS_HOME/keys"
node dist/cli/index.js key generate proposer-key --key-dir "$MPAS_HOME/keys"
node dist/cli/index.js key generate maintainer-a-key --key-dir "$MPAS_HOME/keys"
chmod 600 "$MPAS_HOME"/keys/*.json
```

Each command prints the `did` and `publicJwk` needed for the next step (registering them in the deployment config).

> **Expected output format:** Each `key generate` command prints something like:
> ```
> Generated key: adapter-key
>   did: did:key:z6MkhaXg...
>   publicJwk: {"kty":"OKP","crv":"Ed25519","x":"abc123..."}
>   Saved to: /Users/you/.mpas/keys/adapter-key.json
> ```
> The `did` is the full `did:key:z6Mk...` string. The `publicJwk` is the JSON object on that line (including the braces). You can also extract both values from the saved key file itself if you missed the terminal output.

### Register keys in the deployment config and bridge configs

You now need to paste the `did` and `publicJwk` values from the `key generate` output into three files. The deployment config needs them in `signerKeys` (key registry) and `policy.signerGroups` (authorization groups), and each bridge config needs the corresponding `did` in `agent.did`.

First, create the bridge config files with placeholders:

```sh
cat > $MPAS_HOME/bridge-configs/proposer-bridge.json <<EOF
{
  "mode": "proposer",
  "plugin": "$MPAS_HOME/plugins/github-repo.json",
  "adapter": {
    "url": "http://127.0.0.1:7544"
  },
  "agent": {
    "did": "REPLACE_ME_WITH_PROPOSER_DID",
    "keyFile": "$MPAS_HOME/keys/proposer-key.json"
  },
  "target": {
    "applicationDid": "did:web:github.example"
  },
  "approvalStrategy": "wait",
  "approvalTimeoutMs": 300000,
  "coordination": {
    "url": "http://127.0.0.1:7545"
  }
}
EOF
```

```sh
cat > $MPAS_HOME/bridge-configs/maintainer-a-bridge.json <<EOF
{
  "agent": {
    "did": "REPLACE_ME_WITH_MAINTAINER_A_DID",
    "keyFile": "$MPAS_HOME/keys/maintainer-a-key.json"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  }
}
EOF
```

Now edit these three files using the `did` and `publicJwk` values from `key generate`:

1. **`$MPAS_HOME/config/github-strict.json`** — replace the `signerKeys` array and update `policy.signerGroups`:

```json
"signerKeys": [
  {
    "did": "<did from proposer key generate output>",
    "label": "Proposer Agent",
    "publicJwk": { <publicJwk from proposer key generate output> }
  },
  {
    "did": "<did from maintainer-a key generate output>",
    "label": "Maintainer A",
    "publicJwk": { <publicJwk from maintainer-a key generate output> }
  }
]
```

And inside the `policy` object, set the `signerGroups`:

```json
"signerGroups": {
  "all": [
    "<proposer did>",
    "<maintainer-a did>"
  ],
  "proposers": [
    "<proposer did>"
  ],
  "maintainers": [
    "<maintainer-a did>"
  ]
}
```

2. **`$MPAS_HOME/bridge-configs/proposer-bridge.json`** — replace `REPLACE_ME_WITH_PROPOSER_DID` with the proposer `did` value.

3. **`$MPAS_HOME/bridge-configs/maintainer-a-bridge.json`** — replace `REPLACE_ME_WITH_MAINTAINER_A_DID` with the maintainer-a `did` value.

### Store a credential

The credential is what the adapter uses to authenticate to the target (GitHub). For the echo fixture demo, a placeholder is fine:

```sh
printf '%s\n' '{"value":"ghp_demo_placeholder"}' > "$MPAS_HOME/credentials/github-test-token.json"
chmod 600 "$MPAS_HOME/credentials/github-test-token.json"
```

For live GitHub dispatch below (§4.4), we will replace this with a real GitHub PAT.

For an overview of how MPAS changes the credential model (what the adapter holds vs. what agents hold), see the [README](../../README.md#how-credentials-work-with-mpas).

To create fine-grained PATs, see: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token

### Validate the configuration

After editing the configs and storing the credential, run validate to check for paste errors:

```sh
cd ~/Projects/mpas/mpas/examples/demo
node dist/cli/index.js config validate github-strict \
  --config-dir "$MPAS_HOME/config" --credential-dir "$MPAS_HOME/credentials" \
  --bridge-dir "$MPAS_HOME/bridge-configs"
```

This checks that each `signerKeys` entry has a DID that matches its `publicJwk`, that credentials exist, and that each bridge config's `agent.did` is listed in `signerKeys`. Fix any errors before proceeding.

> **Expected warnings (safe to ignore in single-user mode):** You will see warnings that `proposer-bridge.json` and `maintainer-a-bridge.json` use different DIDs. This is correct — they are two separate agents with distinct identities. The warning exists for the dual-role case where one agent runs both bridges with a shared DID (so self-approval prevention applies between them). In the single-user demo, you have two independent agents, so different DIDs are intentional.

## 2.2 Start Adapter and Coordination

In a dedicated terminal:

```sh
export MPAS_HOME="$HOME/.mpas"
cd ~/Projects/mpas/mpas/examples/demo
node dist/cli/index.js daemon start \
  --config-dir "$MPAS_HOME/config" \
  --credential-dir "$MPAS_HOME/credentials" \
  --adapter-key "$MPAS_HOME/keys/adapter-key.json" \
  --journal-path "$MPAS_HOME/journal/dispatch-ledger.jsonl" \
  --host 127.0.0.1 \
  --port 7544 \
  --coordination-port 7545
```

Expected output:

```json
{"status":"started","address":"http://127.0.0.1:7544","coordinationAddress":"http://127.0.0.1:7545","loadedConfigs":1}
```

Verify:

```sh
curl -s http://127.0.0.1:7544/mpas/v1/health | jq .
curl -s http://127.0.0.1:7545/mpas/v1/coordination/health | jq .
```

Keep this terminal running.

## 2.3 Configuration Reference

For detailed documentation on all configuration files (application plugin, deployment config, bridge config, key files, credential files, and policy rules), see the [README](../../README.md#configuration-model).

---

# Part 3 — Harness-Specific Setup

Choose the section for your agent harness. Each section explains how to run the agents with MPAS using the specific harness.

> **Reminder:** "Proposer" and "maintainer" are role names used throughout this guide. For OpenClaw, the proposer is your default `main` agent. See the agent-naming note in the Document Structure section above.

## 3A. Codex CLI

MPAS requires two separate agents: a **proposer** (calls GitHub tools) and a **maintainer** (reviews and approves). With Codex CLI, you run two sessions in separate terminals, each with its own config directory via the `CODEX_HOME` environment variable.

### Create two config directories

```sh
mkdir -p ~/.codex-proposer
mkdir -p ~/.codex-maintainer
```

### Proposer config

Create `~/.codex-proposer/config.toml`:

```toml
[mcp_servers.github-mpas]
command = "node"
args = [
  "/Users/YOU/Projects/mpas/mpas/sdk/protocol/dist/cli.js",
  "--config",
  "/Users/YOU/.mpas/bridge-configs/proposer-bridge.json"
]
enabled = true
```

This agent sees `create_issue`, `merge_pull_request`, and `delete_branch` — but cannot approve its own actions.

### Maintainer config

Create `~/.codex-maintainer/config.toml`:

```toml
[mcp_servers.mpas-coordination]
command = "node"
args = [
  "/Users/YOU/Projects/mpas/mpas/examples/demo/dist/signer-server/index.js",
  "--config",
  "/Users/YOU/.mpas/bridge-configs/maintainer-a-bridge.json"
]
enabled = true
```

This agent sees `mpas_list_pending`, `mpas_review_action`, `mpas_approve`, and `mpas_reject` — but cannot propose actions.

Replace `/Users/YOU/` with your actual home directory in both files.

### Run the two agents

**Terminal 1 — Proposer:**

```sh
CODEX_HOME=~/.codex-proposer codex
```

**Terminal 2 — Maintainer:**

```sh
CODEX_HOME=~/.codex-maintainer codex
```

### Verify tool discovery

In each terminal, confirm only the intended server is registered:

**Proposer:**

```sh
CODEX_HOME=~/.codex-proposer codex mcp list
```

Expected: `github-mpas` (and nothing else — no direct GitHub MCP server).

**Maintainer:**

```sh
CODEX_HOME=~/.codex-maintainer codex mcp list
```

Expected: `mpas-coordination` (and nothing else).

### Troubleshooting Codex CLI

| Symptom                                              | Fix                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Server shows as disconnected in `codex mcp list`     | Check paths in config.toml are absolute and correct. Run the node command manually to see errors.  |
| `ECONNREFUSED` errors in Codex output                | Adapter/coordination not running. Start them per §2.2.                                             |
| Tools not appearing                                  | Restart Codex. Check `codex mcp list --json` for error details.                                    |
| Both agents see all tools                            | You're using the same `CODEX_HOME`. Verify with `echo $CODEX_HOME` in each terminal.               |

## 3B. OpenClaw

This section takes your installed OpenClaw (from §1.2 Option B) and configures it for MPAS: security hardening, agent workspaces with role instructions, MCP bridge connections, and tool policies.

### Step 1 — Security hardening

> **Warning:** OpenClaw's default `coding` profile grants filesystem read/write (`group:fs`), shell execution (`group:runtime`), web access (`group:web`), and session spawning. Shell execution and file write access let an agent bypass MPAS entirely — it could `curl` GitHub directly, run `git push`, or modify its own bridge config. Lock it down before connecting the bridges.

Lock down the tool policy:

```sh
openclaw config set tools.profile minimal
openclaw config set tools.elevated.enabled false
openclaw gateway restart
```

How this works (per the [OpenClaw tool policy docs](https://clawdhub.mintlify.app/gateway/config-tools)):

- `"profile": "minimal"` — strips all built-in tools down to `session_status` only.
- Elevated execution is disabled — prevents prompt injection escalation via unsandboxed commands.

You'll open specific tool access for the MPAS bridges in Step 5 below.

**Verify:**

```sh
openclaw config get tools
```

Expected: `"profile": "minimal"`. If you still see `"profile": "coding"`, restart the gateway.

When you later move to separate user accounts (Part 5), OS-level permissions provide an additional layer — each agent can only read its own `~/.mpas/keys/` and cannot access the operator's credentials. The tool policy is still recommended as defense in depth.

### Step 2 — Set up agent workspaces

MPAS uses two agents: a **proposer** (calls GitHub tools) and a **maintainer** (approves/rejects). OpenClaw's onboarding already created the default `main` agent with workspace `~/.openclaw/workspace` — that becomes your proposer. Create a workspace for the maintainer:

```sh
mkdir -p ~/.openclaw/agents/maintainer/workspace
```

> **Symmetric tool access is fine here.** In this single-account demo both agents can see both MPAS bridges. Role separation comes from each agent's instructions and its distinct MPAS signing key — MPAS enforces at the protocol level that one identity can't both propose and approve the same action. When you move the maintainer to its own macOS account (Part 5), it gets its own isolation.

**Proposer agent** — append the following to the existing `~/.openclaw/workspace/AGENTS.md` (don't replace the file; OpenClaw seeded it with default workspace guidance you want to keep):

```markdown
## MPAS Proposer Role

You are a GitHub operations agent. You propose actions through the MPAS MCP bridge
and wait for approval from a separate maintainer agent before they execute.

### Your MPAS tools

- `create_issue` — Create a GitHub issue (auto-approved, no maintainer needed)
- `delete_branch` — Delete a branch (requires 1 maintainer approval)
- `merge_pull_request` — Merge a PR (requires 1 maintainer approval)

### How approval works

When you call a tool that requires approval, the bridge submits your request to
the coordination service and waits up to 5 minutes for a maintainer to approve.
You do not need to do anything — just wait for the result to come back.

If the action is rejected or times out, you'll get an error response. Report it
to the user and ask how they'd like to proceed.

### Important

- You cannot approve your own actions. A separate maintainer agent handles approvals.
- All actions target the repository specified in the user's request.
- Do not attempt to access GitHub directly (via curl, git push, or API calls).
  All writes go through the MPAS bridge.
```

**Maintainer agent** — create `~/.openclaw/agents/maintainer/workspace/AGENTS.md`:

```sh
cat > ~/.openclaw/agents/maintainer/workspace/AGENTS.md <<'EOF'
# MPAS Maintainer Agent

You are a security review agent. You monitor pending MPAS actions proposed by
other agents, review them for safety, and approve or reject them.

## Your tools

- `mpas_list_pending` — List actions waiting for approval
- `mpas_review_action` — Get full details of a pending action
- `mpas_approve` — Approve a pending action (it will execute)
- `mpas_reject` — Reject a pending action (it will not execute)

## Your workflow

1. Periodically check for pending actions with `mpas_list_pending`
2. For each pending action, review it with `mpas_review_action`
3. Evaluate whether the action is safe and appropriate:
   - Is the target repository correct?
   - Is the operation reasonable (not deleting main, not merging to wrong branch)?
   - Does the action match what the user likely intended?
4. Approve safe actions. Reject anything suspicious or unclear.

## Important

- You cannot propose actions yourself — only review and approve/reject.
- Be cautious with destructive operations (delete_branch, merge_pull_request).
- If an action looks suspicious, reject it and explain why.
- Check for pending actions when prompted or when you receive a notification.
EOF
```

### Step 3 — Add the MCP servers

> **Absolute vs. `~` paths:** Use **absolute** paths for MCP server `command` and `args` — the bridge is launched without a shell, so `~` is passed through literally and the spawn fails. Paths that OpenClaw resolves itself (like agent `workspace` values) accept `~`.

Add both MPAS bridges. `openclaw config set` merges the value into your existing `~/.openclaw/openclaw.json` — it won't overwrite other settings. In this single-account demo both agents see both bridges; role separation comes from instructions, signing keys, and protocol-level enforcement.

> **Multi-user setups (Part 5):** each account configures only the single bridge matching its role — see §5.5 for details.

```sh
openclaw config set mcp.servers "$(cat <<'JSON'
{
  "github-mpas": {
    "command": "/ABSOLUTE/PATH/TO/node",
    "args": [
      "/Users/YOU/Projects/mpas/mpas/sdk/protocol/dist/cli.js",
      "--config",
      "/Users/YOU/.mpas/bridge-configs/proposer-bridge.json"
    ]
  },
  "mpas-coordination": {
    "command": "/ABSOLUTE/PATH/TO/node",
    "args": [
      "/Users/YOU/Projects/mpas/mpas/examples/demo/dist/signer-server/index.js",
      "--config",
      "/Users/YOU/.mpas/bridge-configs/maintainer-a-bridge.json"
    ]
  }
}
JSON
)" --strict-json
```

Replace `/ABSOLUTE/PATH/TO/node` with the output of `which node` (e.g., `/Users/you/.nvm/versions/node/v22.14.0/bin/node`) and `/Users/YOU/` with your home directory.

### Step 4 — Add the maintainer agent

The default `main` agent is your proposer. Add a second agent for the maintainer (this merges into your existing agents config):

```sh
openclaw config set agents.list "$(cat <<'JSON'
[
  {"id": "main", "default": true, "name": "MPAS Proposer"},
  {"id": "maintainer", "name": "MPAS Maintainer", "workspace": "~/.openclaw/agents/maintainer/workspace"}
]
JSON
)" --strict-json
```

`main` inherits the default workspace `~/.openclaw/workspace` from `agents.defaults`, so it needs no explicit `workspace` of its own.

### Step 5 — Open the bridge tools in `tools.allow`

The security hardening in Step 1 locked the tool policy to `minimal`. Now open access for the MPAS bridge tools, web search, and file reads:

```sh
openclaw config set tools.allow '["github-mpas__*", "mpas-coordination__*", "group:web", "read"]' --strict-json
```

**Do not use `bundle-mcp`** — OpenClaw rejects it as an unknown entry and silently hides the bridge tools. Use the explicit server globs. MCP tools are exposed to the model namespaced as `<server>__<tool>` (e.g. `github-mpas__create_issue`, `mpas-coordination__mpas_review_action`).

### Restart and verify

```sh
openclaw gateway restart
openclaw agents list
```

You should see `main` (default, MPAS Proposer) using `~/.openclaw/workspace` and `maintainer` (MPAS Maintainer) using its own workspace.

> If `openclaw gateway restart` fails with a port conflict, see Part 5 §5.3 "Configure a unique gateway port." In multi-user setups, each account needs its own port.

To confirm the bridges are exposed, open the TUI and ask the agent:

```sh
openclaw tui
```

> what MCP tools do you have available?

The proposer should report `create_issue`, `delete_branch`, `merge_pull_request` (from `github-mpas`) plus the `mpas_*` approval tools (symmetric visibility).

### Interacting with the agents

Run each agent in its own terminal using the TUI. Each terminal holds a persistent interactive session for one agent — the same two-terminal setup you'll use for the demo in Part 4.

**Terminal 1 — proposer (`main`):**

```sh
openclaw tui
```

The default session connects to the `main` agent (your proposer).

**Terminal 2 — maintainer:**

```sh
openclaw tui --session agent:maintainer:main
```

Now run a wiring check in each session.

In the **proposer** TUI, create an issue — `create_issue` is auto-approved, so it completes without any maintainer involvement and confirms the proposer bridge reaches the adapter:

> Create an issue titled "MPAS demo test" in `example-org/mpas-demo-repository`.

The proposer should call `create_issue` and report success.

In the **maintainer** TUI, poll for pending approvals:

> List any pending MPAS approvals.

Nothing is pending yet (the issue was auto-approved), so an empty list is the expected, successful result — it confirms the maintainer sees its `mpas_list_pending` tool and can reach the coordination service.

That's the wiring check. The full approval flow — proposing an action that requires approval, then approving it from the maintainer terminal — is the demo in Part 4. Because an approval-required action makes the proposer's tool call block until a maintainer approves, you keep both terminals open and act in the maintainer terminal while the proposer waits; Part 4 walks through it.

### Troubleshooting OpenClaw

| Symptom                                              | Fix                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Agent not appearing in `openclaw agents list`        | Check `agents.list[]` syntax in openclaw.json. Validate JSON.                                     |
| MCP tools not visible to agent                       | Check absolute paths in the top-level `mcp.servers` config. Run the node command manually.        |
| Bridge tools not visible to the agent                | `tools.allow` uses `bundle-mcp` (rejected as unknown). Use explicit globs `github-mpas__*`, `mpas-coordination__*`. Restart the gateway. |
| `ECONNREFUSED` errors                                | Adapter/coordination not running. Start them per §2.2.                                            |
| Agent doesn't know its role                          | Check that `AGENTS.md` exists in the agent's workspace directory.                                 |

## 3C. Claude Desktop (Flow not yet verified)

Claude Desktop shares a single MCP config across all conversations, so one instance sees all bridges. To separate proposer and maintainer into distinct agents, you need **two macOS user accounts** each running Claude Desktop with their own config, or use Claude Desktop for one role and a different harness (like Codex CLI) for the other.

**Single-account setup (one agent plays both roles — not recommended for production, but works for a visual demo):**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "github-mpas": {
      "command": "node",
      "args": [
        "/Users/YOU/Projects/mpas/mpas/sdk/protocol/dist/cli.js",
        "--config",
        "/Users/YOU/.mpas/bridge-configs/proposer-bridge.json"
      ]
    },
    "mpas-coordination": {
      "command": "node",
      "args": [
        "/Users/YOU/Projects/mpas/mpas/examples/demo/dist/signer-server/index.js",
        "--config",
        "/Users/YOU/.mpas/bridge-configs/maintainer-a-bridge.json"
      ]
    }
  }
}
```

Replace `/Users/YOU/` with your actual home directory. Restart Claude Desktop.

**Multi-account setup (recommended):** Create a second macOS user account, install Claude Desktop there with only the maintainer bridge in its config. See Part 5 for details on workspace separation.

---

# Part 4 — Running the Demo

After Part 3, you have two agents running: a proposer (with GitHub tools) and a maintainer (with approval tools). They share the same adapter and coordination service on localhost but hold different signing keys and cannot perform each other's roles.  The adapter connects to a test Github MCP server that runs a real verifier but doesn't actually call Github APIs.  The Proposer is capable of performing the following actions:

## 4.1 Delete a Branch (1 Maintainer Required)

**In the proposer agent:**

> Delete the branch `demo/branch-alpha` from `example-org/mpas-demo-repository`.

The proposer bridge submits to the adapter → adapter returns `additionalApprovalsRequired` (policy requires 1 maintainer for `delete_branch`) → bridge submits to coordination and waits.

**In the maintainer agent:**

> Check for pending MPAS approvals and approve any delete_branch action.

The maintainer calls `mpas_list_pending` → `mpas_review_action` → `mpas_approve`. The proposer bridge detects `readyForResubmission`, resubmits, and the adapter dispatches.

**Result:** The proposer agent's original tool call resolves with the execution result.

## 4.2 Create an Issue (Auto-Approved)

**In the proposer agent:**

> Create an issue titled "MPAS demo test" in `example-org/mpas-demo-repository`.

The policy allows `create_issue` without approval. The adapter dispatches immediately — no maintainer involvement needed.

## 4.3 Merge a PR (1 Maintainer Required)

**In the proposer agent:**

> Merge pull request #1 (squash) into main on `example-org/mpas-demo-repository`.

**In the maintainer agent:**

> Check for pending MPAS approvals and approve any merge_pull_request action.

**Result:** PR merges after maintainer approval.

## 4.4 Live GitHub Dispatch

The default demo uses an echo MCP server fixture that simulates GitHub responses. This section replaces the echo fixture with the real `@modelcontextprotocol/server-github` MCP server so that actions actually execute against GitHub.

### Prerequisites

- A GitHub repository you control with expendable branches.
- A fine-grained GitHub Personal Access Token (PAT) scoped to that repository.
- The echo fixture demo (§4.1–4.2) working end-to-end before attempting live dispatch.

### Ensure the agent has no direct write access to the repository

**This is critical.** If the agent can reach GitHub write endpoints on its own (via SSH key, PAT, or git credential helper), it can bypass MPAS entirely. The agent must have no credential with write scope for the demo repository.

Do not give your agent write access to the GitHub repository directly. All writes must go through MPAS.

How you achieve this depends on your setup — separate GitHub accounts, restricted SSH keys, read-only deploy keys, or simply not loading credentials in the agent's environment. The key principle: the agent's only path to GitHub write operations is through the MPAS MCP bridge.

### Create demo branches

Set up a repository with expendable branches for the demo. If you don't already have one, create a new repo on GitHub (e.g., `YOUR_USER/mpas-demo-repository`), then:

```sh
cd /tmp && git clone git@github.com:YOUR_USER/YOUR_DEMO_REPO.git && cd YOUR_DEMO_REPO
git checkout -b demo/branch-alpha && git push origin demo/branch-alpha
git checkout -b demo/branch-beta && git push origin demo/branch-beta
```

### Create a fine-grained GitHub PAT for the Credential Adapter

The Credential Adapter holds the privileged token. Create it at:

https://github.com/settings/personal-access-tokens/new

Configure it as follows:

| Field                 | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| **Token name**        | `mpas-adapter-demo` (or any descriptive name)                      |
| **Expiration**        | 30 days (or shorter for demos)                                     |
| **Resource owner**    | Your GitHub account (e.g., `alftom`)                               |
| **Repository access** | "Only select repositories" → select your demo repository           |

Under **Repository permissions**, set:

| Permission          | Access level   | Required for                                                                                      |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| **Contents**        | Read and write | `delete_branch` — uses `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`                     |
| **Issues**          | Read and write | `create_issue` — uses `POST /repos/{owner}/{repo}/issues`                                         |
| **Pull requests**   | Read and write | `merge_pull_request` — uses `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`                 |
| **Metadata**        | Read-only      | Auto-selected as a dependency of the above                                                        |

Leave all other permissions at "No access."

Click **Generate token** and copy the `github_pat_...` value immediately — you'll paste it in the next step.

> **Why fine-grained over classic?** A classic PAT with `repo` scope grants full access to every repository your account can see. A fine-grained PAT restricts to a single repository with only the permissions listed above. If the adapter is compromised, the blast radius is one demo repo.

> **Note on permission granularity:** GitHub's fine-grained PATs group API endpoints into permission categories (Contents, Issues, Pull requests, etc.). You cannot select individual endpoints — only the category and access level (read-only or read and write). Contents: write includes branch deletion but also grants file creation, tag management, and push access on the scoped repository. The repository-level scoping is what constrains the blast radius.

### Store the PAT in the Credential Adapter

```sh
printf '%s\n' '{"value":"github_pat_YOUR_TOKEN_HERE"}' > "$MPAS_HOME/credentials/github-test-token.json"
chmod 600 "$MPAS_HOME/credentials/github-test-token.json"
```

The `{{credential:github-test-token}}` template in the deployment config resolves to the `value` field from this file at dispatch time.

### Update the deployment config

Edit `$MPAS_HOME/config/github-strict.json`:

Change `executionTarget` from the echo fixture to the demo GitHub MCP server:

```json
"executionTarget": {
  "type": "mcp.stdio",
  "command": "<absolute-path-to-node>",
  "args": ["<absolute-path-to>/mpas/examples/demo/tests/fixtures/adapter/github-mcp-server.mjs"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "{{credential:github-test-token}}"
  }
}
```

Replace `<absolute-path-to-node>` with the output of `which node` (e.g., `/Users/you/.nvm/versions/node/v24.1.0/bin/node`). The `command` field must be an absolute path because the adapter spawns child processes without a shell, so nvm's PATH is not available.

Replace `<absolute-path-to>` with the full path to `examples/demo` in your `mpas` clone (e.g., `/Users/you/Projects/mpas/mpas/examples/demo/tests/fixtures/adapter/github-mcp-server.mjs`).

### Restart the adapter and run the live demo

Stop the daemon (Ctrl+C) and restart per §2.2. The adapter will now spawn the real GitHub MCP server as its execution target.

**Test `create_issue` (auto-approved):**

In the proposer agent:

> Create an issue titled "MPAS live demo test" in YOUR_USER/YOUR_DEMO_REPO.

This should succeed immediately — no maintainer needed. Verify the issue appears on GitHub.

**Test `delete_branch` (requires 1 maintainer):**

In the proposer agent:

> Delete the branch `demo/branch-alpha` from YOUR_USER/YOUR_DEMO_REPO.

Then in the maintainer agent, approve the pending action. After approval, the branch should disappear from GitHub. Verify with:

```sh
git ls-remote --heads origin demo/branch-alpha
# Should return nothing — branch is gone
```

### Reset branches for the next demo run

```sh
cd /tmp/YOUR_DEMO_REPO
git push origin main:demo/branch-alpha
git push origin main:demo/branch-beta
```

### Credential flow summary

```
┌──────────────────┐         ┌──────────────────────┐        ┌─────────────────────┐
│  Proposer Agent  │         │  Credential Adapter  │        │  GitHub API         │
│                  │         │                      │        │                     │
│  No SSH key      │───MCP──▶│  Holds the PAT       │──API──▶│  Executes action    │
│  No GitHub PAT   │  bridge │  in credentials/     │        │  on demo repo       │
│  Read-only access│         │  github-test-token   │        │                     │
└──────────────────┘         └──────────────────────┘        └─────────────────────┘
```

The agent cannot reach GitHub write endpoints on its own. All writes route through the adapter after policy evaluation and (where required) multi-party approval.

---

# Part 5 — Multi-User Hardening (Optional)

> The single-user demo (Parts 1–4) is fully functional at this point. This section upgrades to separate macOS user accounts for true key isolation. For the security rationale (why separation matters, production topology, dual-role agents), see the [README](../../README.md#why-workspace-separation-matters).

## 5.1 What Lives Where

Before creating accounts, understand what each role needs on disk:

| Material                                   | Operator | Proposer agent       | Maintainer agent     |
| ------------------------------------------ | -------- | -------------------- | -------------------- |
| Adapter key (`adapter-key.json`)           | Yes      | —                    | —                    |
| Deployment config (`github-strict.json`).  | Yes      | —                    | —                    |
| Application credential (PAT)               | Yes      | —                    | —                    |
| Plugin (`github-repo.json`)                | Yes      | Yes (copy)           | —                    |
| Bridge config (`proposer-bridge.json`)     | —        | Yes                  | —                    |
| Bridge config (`maintainer-a-bridge.json`) | —        | —                    | Yes                  |
| Proposer signing key                       | —        | Yes                  | —                    |
| Maintainer signing key                     | —        | —                    | Yes                  |
| Running daemon (adapter + coordination).   | Yes      | —                    | —                    |
| Agent harness (OpenClaw/Codex)             | —        | Yes                  | Yes                  |
| Node 22+, repo cloned + built              | Yes      | Yes                  | Yes                  |

The operator holds the credential and runs the daemon. Each agent holds only its own signing key and bridge config — it cannot access the other agent's key or the operator's credential. All three accounts communicate over `127.0.0.1` (loopback is shared across macOS users on the same host).

## 5.2 Create Agent Accounts

You need two new macOS user accounts. The operator is your existing account from Part 2 (the one running the daemon).

Create the accounts via System Settings (Users & Groups → Add User) or terminal:

```sh
sudo sysadminctl -addUser agent-a -fullName "Agent A (Proposer)" -password -
sudo sysadminctl -addUser agent-b -fullName "Agent B (Maintainer)" -password -
```

Standard accounts are fine — admin is not required.

**Enable fast user switching:**

You'll switch between accounts frequently during setup and the demo. Enable fast user switching so you can swap without logging out:

1. Open **System Settings → Control Center**.
2. Scroll to **Fast User Switching** and set "Show in Menu Bar" to the icon or account name.
3. Now click your name/icon in the menu bar to switch users instantly. If you have it, enabling Touch ID makes things even faster.  

Each user's session stays active in the background — the operator's daemon keeps running while you work in an agent account.

> **What's shared vs. per-user across macOS accounts:**
> - **Shared:** Homebrew packages (`jq`, `gh`), loopback network (`127.0.0.1`)
> - **Per-user:** Node via nvm, npm global packages (OpenClaw, Codex CLI), SSH keys, git credentials, `~/.mpas/` directory

## 5.3 Set Up Each Agent Account

Before starting, make sure the operator's daemon is running (§2.2). The adapter and coordination service must be up so agent accounts can reach them over loopback.

Log in as each agent user and complete the following. Do this for `agent-a` (proposer) first, then repeat for `agent-b` (maintainer).

### Verify connectivity to the operator's services

Confirm the agent account can reach the adapter and coordination endpoints:

```sh
curl -s http://127.0.0.1:7544/mpas/v1/health | jq .
curl -s http://127.0.0.1:7545/mpas/v1/coordination/health | jq .
```

Both should return a JSON health response. If they fail, switch to the operator account and start the daemon per §2.2.

### Install prerequisites

Install the toolchain from Part 1. On each agent account:

1. **Xcode CLI Tools** (§1.1 Step 1) — `xcode-select --install`
2. **Homebrew** (§1.1 Step 2) — already installed from the operator account; add it to this user's PATH:

```sh
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
brew --version
```
3. **nvm** (§1.1 Step 3) — install, close and reopen terminal
4. **Node 22+** (§1.1 Step 4) — `nvm install --lts`
5. **SSH key** (§1.1 Step 6) — each macOS user has its own `~/.ssh`. Generate a key and add it to GitHub for this account.
6. **Clone repo** (§1.1 Step 6):

7. **Build and test** (§1.1 Step 7 and 8):

8. **Install agent harness** (§1.2) — install OpenClaw, Codex CLI, or your preferred harness. Do NOT configure MPAS bridges yet — that happens in §5.5.

### OpenClaw only- Configure a unique gateway port

macOS shares loopback ports across all user accounts. If another account is already running an OpenClaw gateway on the default port (18789), this account's gateway will fail to start with "port is still busy."

Assign a unique port per account:

| Account              | Gateway port                          |
| -------------------- | ------------------------------------- |
| Operator             | 18789 (will be removed later however) |
| Agent A (proposer)   | 18790                                 |
| Agent B (maintainer) | 18791                                 |

Set the port and reinstall the LaunchAgent so the service file picks it up:

```sh
openclaw config set gateway.port <PORT>
launchctl bootout gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist 2>/dev/null || true
openclaw gateway install
openclaw gateway start
```

Verify:

```sh
openclaw gateway status
```

Confirm it shows the correct port and "Connectivity probe: ok".

> **Note:** `openclaw gateway restart` will fail if it tries to stop a gateway on the old port that belongs to another user. Use the `bootout` + `install` + `start` sequence above instead.

### Create the MPAS directory structure

Each agent gets only what it needs (see §5.1 table).

**On `agent-a` (proposer):**

```sh
mkdir -p ~/.mpas/{keys,bridge-configs,plugins}
```

**On `agent-b` (maintainer):**

```sh
mkdir -p ~/.mpas/{keys,bridge-configs}
```

### Generate signing keys

Do NOT copy keys from the operator. Each account generates its own key so only that account holds the private material.

**On `agent-a`:**

```sh
cd ~/Projects/mpas/mpas/examples/demo
node dist/cli/index.js key generate proposer-key --key-dir ~/.mpas/keys
chmod 600 ~/.mpas/keys/*.json
```

**On `agent-b`:**

```sh
cd ~/Projects/mpas/mpas/examples/demo
node dist/cli/index.js key generate maintainer-a-key --key-dir ~/.mpas/keys
chmod 600 ~/.mpas/keys/*.json
```

Each command prints the `did` and `publicJwk`. Save these — you'll need them in §5.4.

### Create bridge configs

**On `agent-a` (proposer):**

Copy the application plugin (the proposer bridge needs it to build action packages):

```sh
cp ~/Projects/mpas/mpas/examples/demo/tests/fixtures/plugins/github-repo.json ~/.mpas/plugins/github-repo.json
```

Create the bridge config:

```sh
cat > ~/.mpas/bridge-configs/proposer-bridge.json <<EOF
{
  "mode": "proposer",
  "plugin": "$HOME/.mpas/plugins/github-repo.json",
  "adapter": {
    "url": "http://127.0.0.1:7544"
  },
  "agent": {
    "did": "REPLACE_WITH_YOUR_DID_FROM_KEY_GENERATE",
    "keyFile": "$HOME/.mpas/keys/proposer-key.json"
  },
  "target": {
    "applicationDid": "did:web:github.example"
  },
  "approvalStrategy": "wait",
  "approvalTimeoutMs": 300000,
  "coordination": {
    "url": "http://127.0.0.1:7545"
  }
}
EOF
```

Replace `REPLACE_WITH_YOUR_DID_FROM_KEY_GENERATE` with the `did` value from `key generate` above.

**On `agent-b` (maintainer):**

```sh
cat > ~/.mpas/bridge-configs/maintainer-a-bridge.json <<EOF
{
  "agent": {
    "did": "REPLACE_WITH_YOUR_DID_FROM_KEY_GENERATE",
    "keyFile": "$HOME/.mpas/keys/maintainer-a-key.json"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  }
}
EOF
```

Replace `REPLACE_WITH_YOUR_DID_FROM_KEY_GENERATE` with the `did` value from `key generate` above.

## 5.4 Register DIDs on the Operator

Back in the **operator** account, edit `$MPAS_HOME/config/github-strict.json` and update the `signerKeys` array and `policy.signerGroups` with the new agent DIDs:

> **Transferring DIDs between accounts:** macOS clipboard (copy/paste) does not work across user sessions. To get the `did` and `publicJwk` values from each agent account to the operator, use one of:
> - **Shared temp file:** write the key generate output to `/tmp/agent-a-did.txt` (world-readable), then read it from the operator session. Delete after.
> - **Shared note:** paste into Apple Notes, a Google Doc, or any app synced across accounts.
> - **AirDrop to yourself:** screenshot or text file, if both sessions are active simultaneously.
>
> The DID and publicJwk are public values — there's no security concern sharing them.

Update `signerKeys` (the key registry for signature verification):

```json
"signerKeys": [
  {
    "did": "<did from agent-a key generate>",
    "label": "Agent A (Proposer)",
    "publicJwk": { <publicJwk from agent-a key generate> }
  },
  {
    "did": "<did from agent-b key generate>",
    "label": "Agent B (Maintainer)",
    "publicJwk": { <publicJwk from agent-b key generate> }
  }
]
```

And inside the `policy` object, update `signerGroups` (authorization):

```json
"signerGroups": {
  "all": ["<agent-a did>", "<agent-b did>"],
  "proposers": ["<agent-a did>"],
  "maintainers": ["<agent-b did>"]
}
```

Restart the daemon (stop with Ctrl+C, restart per §2.2) so it picks up the new signers.

## 5.5 Complete Harness-Specific Setup

On each agent account, follow Part 3 for your harness (§3A for Codex CLI, §3B for OpenClaw, §3C for Claude Desktop).

### MCP server visibility per role

Each agent account should only expose the bridge matching its role:

| Account              | MCP server to configure | Tools exposed                                                     |
| -------------------- | ----------------------- | ----------------------------------------------------------------- |
| Agent A (proposer)   | `github-mpas`           | `create_issue`, `delete_branch`, `merge_pull_request`             |
| Agent B (maintainer) | `mpas-coordination`     | `mpas_list_pending`, `mpas_review_action`, `mpas_approve`, `mpas_reject` |

Do **not** add both MCP servers to one account. The proposer account should only have `github-mpas` (backed by `proposer-bridge.json`); the maintainer account should only have `mpas-coordination` (backed by `maintainer-a-bridge.json`). This ensures each agent sees only the tools appropriate to its role.

The single-user demo (Parts 2–4) configures both on one account for convenience, but in the multi-user topology, role separation is enforced at the harness level in addition to the protocol level.

## 5.6 Verify Cross-Account Demo

With the operator's daemon running, verify each role independently, then test the approval flow. By this point you've likely switched to your real repository (§4.4), so use that in place of `YOUR_USER/YOUR_DEMO_REPO` below.

**Step 1 — Proposer acts alone (no maintainer needed):**

In the proposer's terminal (logged in as `agent-a`), create an issue:

> Create an issue titled "MPAS cross-account test" in YOUR_USER/YOUR_DEMO_REPO.

This is auto-approved — it should succeed without any maintainer involvement. If it does, the proposer's bridge can reach the adapter and dispatch works.

**Step 2 — Maintainer acts alone:**

In the maintainer's terminal (logged in as `agent-b`), poll for pending approvals:

> List any pending MPAS approvals.

Nothing is pending yet (the issue was auto-approved), so an empty list is the expected result. This confirms the maintainer's bridge can reach the coordination service.

**Step 3 — Full approval flow across accounts:**

1. In the **proposer's terminal**: ask it to delete a branch from YOUR_USER/YOUR_DEMO_REPO. The tool call will block, waiting for maintainer approval.
2. **Switch to the maintainer's terminal**: check for pending approvals and approve.
3. **Back in the proposer's terminal**: confirm the tool call resolved with the execution result.

If the proposer times out before you can switch and approve, increase `approvalTimeoutMs` in `~/.mpas/bridge-configs/proposer-bridge.json` (default is 5 minutes / `300000` ms).

## 5.7 Operator Cleanup (Optional)

Once you've verified the cross-account demo works, the operator account no longer needs agent material from the single-user flow. Clean it up:

```sh
# Remove agent keys (operator only needs adapter-key.json)
rm -f $MPAS_HOME/keys/proposer-key.json $MPAS_HOME/keys/maintainer-a-key.json

# Remove agent bridge configs
rm -f $MPAS_HOME/bridge-configs/proposer-bridge.json $MPAS_HOME/bridge-configs/maintainer-a-bridge.json

# Uninstall the agent harness (operator doesn't run agents)
npm uninstall -g openclaw   # or @openai/codex
```

The operator retains: adapter key, deployment config, credentials, plugin, journal, and the running daemon.

## 5.8 Symmetric Signers (Dual-Role Agents)

In some topologies, every agent acts as both proposer and maintainer — each can propose actions and approve other agents' proposals (but never its own, enforced by MPAS). This is useful when you have a peer group of equivalent agents rather than dedicated proposer/maintainer roles.

### Key and config setup

Each symmetric agent needs:

1. **One signing key** — generate a single key per agent:

```sh
node dist/cli/index.js key generate agent-1 --key-dir ~/.mpas/keys
```

2. **Two bridge configs** pointing at the same key file:

```sh
# Proposer bridge
cat > ~/.mpas/bridge-configs/proposer-bridge.json <<EOF
{
  "mode": "proposer",
  "plugin": "$HOME/.mpas/plugins/github-repo.json",
  "adapter": { "url": "http://127.0.0.1:7544" },
  "agent": {
    "did": "<did from key generate>",
    "keyFile": "$HOME/.mpas/keys/agent-1.json"
  },
  "target": { "applicationDid": "did:web:github.example" },
  "approvalStrategy": "wait",
  "approvalTimeoutMs": 300000,
  "coordination": { "url": "http://127.0.0.1:7545" }
}
EOF

# Signer server config
cat > ~/.mpas/bridge-configs/maintainer-a-bridge.json <<EOF
{
  "agent": {
    "did": "<did from key generate>",
    "keyFile": "$HOME/.mpas/keys/agent-1.json"
  },
  "coordination": { "url": "http://127.0.0.1:7545" }
}
EOF
```

3. **AGENTS.md for the symmetric role** — the agent needs instructions covering both responsibilities. Don't concatenate the dedicated proposer and maintainer instructions (they conflict — one says "you cannot approve" while the other says "your job is to approve"). Use a combined version:

```sh
cat > ~/.openclaw/workspace/AGENTS.md <<'EOF'
# MPAS Symmetric Agent

You are a GitHub operations agent with dual responsibilities: you can propose
actions through the MPAS MCP bridge AND review/approve actions proposed by other
agents. You cannot approve your own proposals — only actions from a different agent.

## Proposer tools (github-mpas)

- `create_issue` — Create a GitHub issue (auto-approved, no other agent needed)
- `delete_branch` — Delete a branch (requires approval from another agent)
- `merge_pull_request` — Merge a PR (requires approval from another agent)

## Maintainer tools (mpas-coordination)

- `mpas_list_pending` — List actions waiting for approval
- `mpas_review_action` — Get full details of a pending action
- `mpas_approve` — Approve a pending action (it will execute)
- `mpas_reject` — Reject a pending action (it will not execute)

## How approval works

When you propose an action that requires approval, the bridge submits your request
and waits for a different agent to approve. You cannot approve it yourself.

When reviewing actions from other agents, evaluate whether the action is safe:
- Is the target repository correct?
- Is the operation reasonable?
- Does it match what the user likely intended?

## Important

- You CANNOT approve your own proposals (MPAS enforces this at the protocol level).
- You CAN approve proposals from other agents.
- Do not access GitHub directly (via curl, git push, or API calls).
EOF
```

4. **Both MCP servers** configured in the agent's harness — this is the one case where an agent legitimately sees both `github-mpas` and `mpas-coordination`.

**OpenClaw** — configure both servers via CLI:

```sh
openclaw config set mcp.servers "$(cat <<'JSON'
{
  "github-mpas": {
    "command": "/ABSOLUTE/PATH/TO/node",
    "args": [
      "/Users/YOU/Projects/mpas/mpas/sdk/protocol/dist/cli.js",
      "--config",
      "/Users/YOU/.mpas/bridge-configs/proposer-bridge.json"
    ]
  },
  "mpas-coordination": {
    "command": "/ABSOLUTE/PATH/TO/node",
    "args": [
      "/Users/YOU/Projects/mpas/mpas/examples/demo/dist/signer-server/index.js",
      "--config",
      "/Users/YOU/.mpas/bridge-configs/maintainer-a-bridge.json"
    ]
  }
}
JSON
)" --strict-json
```

**Codex CLI** — add both servers to `config.toml`:

```toml
[mcp_servers.github-mpas]
command = "node"
args = [
  "/Users/YOU/Projects/mpas/mpas/sdk/protocol/dist/cli.js",
  "--config",
  "/Users/YOU/.mpas/bridge-configs/proposer-bridge.json"
]
enabled = true

[mcp_servers.mpas-coordination]
command = "node"
args = [
  "/Users/YOU/Projects/mpas/mpas/examples/demo/dist/signer-server/index.js",
  "--config",
  "/Users/YOU/.mpas/bridge-configs/maintainer-a-bridge.json"
]
enabled = true
```

5. **Deployment config** — on the operator account, register the agent's DID in `$MPAS_HOME/config/github-strict.json`:

In `signerKeys`:

```json
{
  "did": "<agent-1 did>",
  "label": "Agent 1 (symmetric)",
  "publicJwk": { <publicJwk from key generate> }
}
```

In `policy.signerGroups`, add the agent's DID to both `proposers` and `maintainers` (and `all`):

```json
"signerGroups": {
  "all": ["<agent-1 did>", "<agent-2 did>"],
  "proposers": ["<agent-1 did>", "<agent-2 did>"],
  "maintainers": ["<agent-1 did>", "<agent-2 did>"]
}
```

Each symmetric agent appears in both the `proposers` and `maintainers` groups instead of being in only one.

### Protocol enforcement

MPAS prevents self-approval regardless of role configuration:
- Agent 1 proposes an action → Agent 1 **cannot** approve that same action
- Agent 2 proposes an action → Agent 1 **can** approve it (and vice versa)

This means symmetric signers require at least two agents to function. A single symmetric agent can propose but will always need a different agent to approve.

### When to use symmetric vs. dedicated roles

| Topology         | Use when                                                   |
| ---------------- | ---------------------------------------------------------- |
| Dedicated roles  | Clear proposer/maintainer separation; simpler mental model |
| Symmetric signers| Peer agents that should all have equal capabilities        |

---

# Troubleshooting

| Symptom                                                | Likely cause                                          | Fix                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `node --version` shows less than `v22.x`               | Shell is using another Node                           | Run `nvm install --lts`; check `which node`; reopen the terminal.                                |
| Node install says your macOS is too old                | Newer Node versions may not support your OS           | Install Node 22 with `nvm install 22`; if macOS is older than 11, upgrade macOS or use another machine. |
| `npm install` fails immediately                        | Wrong directory or missing package.json               | Run it inside `mpas/examples/demo` or `mpas/sdk/protocol`.                                    |
| `npm run build` fails with modern JS/TS syntax errors  | Wrong Node version                                    | Verify `node --version` is `v22.x` or later.                                                    |
| `generate-fixtures.ts` fails                           | Missing dependencies                                  | Run `npm install` first.                                                                         |
| `EACCES` on keys or credentials                        | File permissions or wrong path                        | Run `chmod 600 "$MPAS_HOME"/keys/*.json "$MPAS_HOME"/credentials/*.json`.                        |
| `ECONNREFUSED` on `:7544`                              | Adapter is not running                                | Start per §2.2.                                                                                  |
| `ECONNREFUSED` on `:7545`                              | Coordination is not running                           | Start per §2.2 (unified daemon starts both).                                                     |
| `PLUGIN_HASH_MISMATCH`                                 | Config and plugin fixture are out of sync             | Re-run `npx tsx scripts/generate-fixtures.ts` and re-copy to `$MPAS_HOME`.                       |
| `UNKNOWN_APPLICATION`                                  | Config target DID does not match the Action Package   | Ensure `github-strict.json` and plugin are from the same fixtures run.                           |
| Agent does not see bridge tools                        | MCP server config paths are wrong                     | Check absolute paths. Run the bridge command manually to see errors.                             |
| Bridge exits immediately                               | Missing key file or plugin                            | Run: `node dist/cli.js --config /path/to/config.json` manually and read the error.           |
| Live GitHub dispatch fails                             | PAT/package/repo permission issue                     | Verify the echo fixture demo works first, then debug GitHub separately.                          |
| Live dispatch returns `indeterminate`                  | `executionTarget.command` uses bare `node` or `npx`   | Use absolute path from `which node`. The adapter spawns without a shell, so nvm PATH is not available. |
| Agent deletes branch without maintainer approval           | Agent has SSH key or PAT with write access            | Ensure the agent has no write credential for the repo (see §4.4). Check for loaded SSH keys, env vars, or git credential helpers. |
| `Resource not accessible by personal access token`     | PAT missing required permission                       | Ensure Contents (R/W) and Issues (R/W) are enabled in the fine-grained token settings.           |
| `Not Found` on branch deletion                         | PAT not scoped to the correct repository              | Verify "Only select repositories" includes your demo repo in the token settings.                 |
| `gateway port 18789 is still busy`                     | Another macOS user's OpenClaw gateway owns that port  | Set a unique port per account: `openclaw config set gateway.port 18790`, then `launchctl bootout gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist && openclaw gateway install && openclaw gateway start` |
| nvm install fails with `bash_completion` errors        | Homebrew added a bash-specific line to `.zprofile`    | `cp ~/.zprofile ~/.zprofile.bak && grep -v 'bash_completion' ~/.zprofile > ~/.zprofile.new && mv ~/.zprofile.new ~/.zprofile`, then retry nvm install |

---

# Demo Checklist

**Part 1 — Environment (every account):**

- [ ] macOS 11+
- [ ] `node --version` → `v22.x` or later
- [ ] `mpas/examples/demo`: install + generate fixtures + build + test pass
- [ ] `sdk/protocol`: install + build + test pass
- [ ] E2E test: 2 tests pass
- [ ] Agent harness installed and responding

**Part 2 — Single-User Demo Setup:**

- [ ] Keys generated (adapter, proposer, maintainer-a)
- [ ] `signerKeys` and `policy.signerGroups` populated in deployment config
- [ ] Bridge configs created with correct DIDs and absolute paths
- [ ] `config validate` passes
- [ ] Adapter health: `http://127.0.0.1:7544/mpas/v1/health`
- [ ] Coordination health: `http://127.0.0.1:7545/mpas/v1/coordination/health`

**Part 3 — Harness:**

- [ ] Bridges registered in harness config (config.toml / openclaw.json / claude_desktop_config.json)
- [ ] Agent discovers proposer tools: `create_issue`, `delete_branch`, `merge_pull_request`
- [ ] Agent discovers maintainer tools: `mpas_list_pending`, `mpas_review_action`, `mpas_approve`, `mpas_reject`

**Part 4 — Demo:**

- [ ] `create_issue` executes immediately (auto-approved)
- [ ] `delete_branch` blocks until maintainer approves, then executes
- [ ] Live GitHub (§4.4): branch actually deleted after approval

**Part 5 — Multi-User Hardening (optional):**

- [ ] Agent accounts created (`agent-a`, `agent-b`)
- [ ] Part 1 completed on each agent account (Node 22+, repos on `main`, built, tests pass)
- [ ] `~/.mpas` directory structure created on each agent
- [ ] Fresh keys generated on each agent account
- [ ] DIDs registered in operator's `signerKeys` and `policy.signerGroups`; daemon restarted
- [ ] Bridge configs created on each agent account (proposer has plugin copy)
- [ ] Part 3 (harness setup) completed on each agent account
- [ ] Cross-account demo verified (§5.6)
- [ ] Operator cleanup done (§5.7, optional)

---

# References

- MPAS Specifications: ../../specs/ (local)
- Node.js LTS macOS support: https://nodejs.org/en/about/previous-releases
- Codex CLI: https://github.com/openai/codex
- Codex CLI MCP config: https://openai-codex.mintlify.app/configuration/mcp-servers
- OpenClaw: https://openclaw.ai/
- Claude Desktop: https://claude.ai/download
