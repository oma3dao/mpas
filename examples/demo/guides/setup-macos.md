# MPAS MVP Mac Demo Setup

**Target demo machine:** Intel or Apple Silicon Mac running macOS 11 Big Sur or newer  
**Tested target:** MacBook Pro 15-inch 2017, Intel Core i7, 16 GB RAM, macOS Ventura 13.7.x  
**Purpose:** Run the local MPAS demo stack with autonomous agents  
**Last updated:** 2026-08-17
**Specifications:** ../../specs/ (local)

| Document                             | Description                                                      |
| ------------------------------------ | ---------------------------------------------------------------- |
| `mpas-specification.md`              | Core protocol: Action Lifecycle, dispatch ledger, artifact model |
| `mpas-profile-http.md`               | HTTP Profile: wire format, ActionRequest/Response, coordination  |
| `mpas-profile-mcp.md`                | MCP Profile: execution payload format for MCP tool calls         |
| `mpas-profile-application-plugin.md` | Application Plugin Profile: plugin schema and operation defs     |
| `mpas-profile-policy-json.md`        | JSON Verifier Policy Profile: policy matching and evaluation     |

---

## Document Structure

**Repository path:** The recommended location is `~/Projects/mpas`, with
`mpas` itself as the repository root. The shell commands below use
`$HOME/Projects/mpas`. You may choose another location, but then replace that
path consistently. Configuration files require the corresponding absolute
path, such as `/Users/YOU/Projects/mpas`; MCP servers are launched without a
shell and do not expand `~` or `$HOME`.

**All commands assume you are on the `main` branch of `mpas`.** If you've checked out a feature branch for development, switch back to `main` before following this guide — the fixtures, configs, and CLI all need to be consistent with what `main` produces.

| Part       | What it covers                                    | Who needs it                                                      |
| ---------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| **Part 1** | Machine prerequisites, repo, build, agent harness | Every account (operator + agents)                                 |
| **Part 2** | Single-user demo setup: keys, configs, daemon     | Single-user flow (one account does everything)                    |
| **Part 3** | Agent role instructions + harness MCP setup       | §3.1 first, then §3.2 Codex / §3.3 OpenClaw / §3.4 Claude Desktop |
| **Part 4** | Demo scenarios + live GitHub dispatch             | Everyone running the demo                                         |
| **Part 5** | Multi-user hardening (workspace separation)       | Optional — for true key isolation across accounts                 |

If you already have Node 22 (or later) and your agent harness installed, skip to Part 1 Step 6 (Clone the repository).  
If you already have MPAS built and tests passing, skip to Part 2 (single-user) or Part 5 (multi-user agent account).

> **Which account should you use?**  
> For the single-user demo (Parts 1–4), use the macOS account you plan to keep as the **operator** (Credential Adapter + Coordination Service) if you later split into multiple users. This could be your existing development account or a new dedicated account. If you add workspace separation (Part 5), this account keeps the adapter and credential — the agent responsibilities move to new accounts.  
>  
> If you already have an account with Node, git, and the repo cloned — use that. If you're starting from scratch and plan to do the hardened three-user flow eventually, create the operator account first and set up here.

> **Roles — "proposer" and "maintainer":**  
> Throughout this guide we use **proposer** (submits governed actions) and **maintainer** (approves/rejects). Those are MPAS roles, not necessarily the string your harness uses as an agent id. How each harness names agents, display labels, and personas is covered in that harness’s Part 3 section. Role **instructions** (what each role must do) live in **§3.1**.
>
> **Terminology note:** The MPAS protocol uses "signer" as a generic term for any participant that signs something (both proposers and maintainers are signers). In this guide, we use "maintainer" for the specific role that reviews and approves/rejects actions. In config files, `signerKeys` registers Signer DIDs and `policy.signerGroups` defines authorization (who can propose and who can approve).

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
mkdir -p "$HOME/Projects"
git clone git@github.com:oma3dao/mpas.git "$HOME/Projects/mpas"
```

Ensure you're on `main`:

```sh
cd "$HOME/Projects/mpas"
git checkout main
```

If you prefer HTTPS (e.g., behind a corporate firewall that blocks SSH), use `https://github.com/oma3dao/mpas.git` instead. You'll need a PAT or credential helper configured.

**GitHub credential guidance for agent accounts:**

The SSH key (or PAT) used here gives this account read access to the MPAS source repo — that's fine for cloning and pulling. The security boundary that matters is **write access to the target repository** (the one the agent proposes actions against). To maintain that boundary:

- **Do not give the agent account write access** to the demo/target repository via SSH key, PAT, or git credential helper. If the agent can write to GitHub directly, it can bypass MPAS entirely.
- For agent accounts that need read-only access to additional repos, use a fine-grained PAT scoped to read-only: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token

The only path to write operations should be through the MPAS bridge → Credential Adapter, which holds the privileged token separately (configured in Part 2).

### Step 7: Build MPAS

Install, build, and test the demo. Its package lock installs the published MPAS protocol SDK:

```sh
cd "$HOME/Projects/mpas/examples/demo"
npm ci
npm run build
npm test
```

Expected: the demo test suite passes with no failures.

### Step 8: Run the E2E Test

This verifies the full stack end-to-end (proposer → coordination → maintainer → adapter → dispatch):

```sh
cd "$HOME/Projects/mpas/examples/demo"
npm run test:e2e:mcp-bridge
```

Expected: the local MCP bridge E2E tests pass.

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

Type a message (e.g., "hello") and confirm you get a response from the default agent. Exit with /quit. MPAS-specific configuration (security hardening, agent workspaces, bridge connections) happens in §3.3.

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
mkdir -p "$MPAS_HOME/config" "$MPAS_HOME/plugins" "$MPAS_HOME/credentials" "$MPAS_HOME/keys" "$MPAS_HOME/journal" "$MPAS_HOME/mcp-server-configs" "$MPAS_HOME/workflows"
```

### Copy the application plugin and deployment config

The plugin and config give you a template you can customize for your MPAS implementation.

```sh
cd "$HOME/Projects/mpas/examples/demo"
cp plugins/github-mirror-plugin.json "$MPAS_HOME/plugins/github-mirror-plugin.json"
cp configs/github-mirror-adapter-config.json "$MPAS_HOME/config/github-mirror-adapter-config.json"
```

### Generate signing keys

The test suite uses hardcoded private keys so that fixtures (signed action packages, JWS signatures) are reproducible across runs. Those keys are committed to the repository and are not secret. For the demo, you generate your own keys — each participant gets a fresh Ed25519 key pair that derives a unique `did:jwk` identity.

You need three keys:

| Key file              | Role       | Purpose                              |
| --------------------- | ---------- | ------------------------------------ |
| `adapter-key.json`    | Adapter    | Signs Execution Receipts             |
| `proposer-key.json`   | Proposer   | Signs Action Envelopes and proposals |
| `maintainer-key.json` | Maintainer | Signs approvals                      |

Generate them directly into `$MPAS_HOME/keys`:

```sh
cd "$HOME/Projects/mpas/examples/demo"
node dist/cli/index.js key generate adapter-key --key-dir "$MPAS_HOME/keys"
node dist/cli/index.js key generate proposer-key --key-dir "$MPAS_HOME/keys"
node dist/cli/index.js key generate maintainer-key --key-dir "$MPAS_HOME/keys"
chmod 600 "$MPAS_HOME"/keys/*.json
```

Each command prints a `did` and `publicJwk`. The generated identities use
`did:jwk`, so the DID itself contains the public verification key. You only
need the proposer and maintainer DIDs for the next step.

> **Expected output format:** Each `key generate` command prints something like:
> ```
> Generated key: adapter-key
>   did: did:jwk:eyJjcnYiOiJFZDI1NTE5...
>   publicJwk: {"kty":"OKP","crv":"Ed25519","x":"abc123..."}
>   Saved to: /Users/you/.mpas/keys/adapter-key.json
> ```
> The `did` is the full `did:jwk:...` string. You can extract it from the saved
> key file if you missed the terminal output. The printed `publicJwk` is useful
> for inspection, but it does not need to be copied into the deployment config
> for a `did:jwk` Signer.

### Register DIDs in the deployment config and bridge configs

You now need to paste the DIDs from the `key generate` output into three files.
The deployment config needs them in `signerKeys` (Signer registry) and
`policy.signerGroups` (authorization groups), and each bridge config needs the
corresponding DID in `agent.did`.

First, create the bridge config files with placeholders:

```sh
cat > $MPAS_HOME/mcp-server-configs/github-mirror-mcp-bridge-config.json <<EOF
{
  "mode": "proposer",
  "plugin": "$MPAS_HOME/plugins/github-mirror-plugin.json",
  "tools": "$HOME/Projects/mpas/examples/demo/bridge-tools/github-mirror-tools.json",
  "adapter": {
    "url": "http://127.0.0.1:7544"
  },
  "agent": {
    "did": "REPLACE_ME_WITH_PROPOSER_DID",
    "keyFile": "$MPAS_HOME/keys/proposer-key.json"
  },
  "target": {
    "applicationDid": "did:web:github-mirror.example"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  },
  "workflow": {
    "dbPath": "$MPAS_HOME/workflows/mirror.db"
  }
}
EOF
```

```sh
cat > $MPAS_HOME/mcp-server-configs/maintainer-signer-config.json <<EOF
{
  "agent": {
    "did": "REPLACE_ME_WITH_MAINTAINER_DID",
    "keyFile": "$MPAS_HOME/keys/maintainer-key.json"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  }
}
EOF
```

Now edit these three files using the DIDs from `key generate`:

1. **`$MPAS_HOME/config/github-mirror-adapter-config.json`** — replace the `signerKeys` array and update `policy.signerGroups`:

```json
"signerKeys": [
  {
    "did": "<did from proposer key generate output>",
    "label": "Proposer Agent"
  },
  {
    "did": "<did from maintainer key generate output>",
    "label": "Maintainer A"
  }
]
```

And inside the `policy` object, set the `signerGroups`:

```json
"signerGroups": {
  "all": [
    "<proposer did>",
    "<maintainer did>"
  ],
  "proposers": [
    "<proposer did>"
  ],
  "maintainers": [
    "<maintainer did>"
  ]
}
```

2. **`$MPAS_HOME/mcp-server-configs/github-mirror-mcp-bridge-config.json`** — replace `REPLACE_ME_WITH_PROPOSER_DID` with the proposer `did` value.

3. **`$MPAS_HOME/mcp-server-configs/maintainer-signer-config.json`** — replace `REPLACE_ME_WITH_MAINTAINER_DID` with the maintainer `did` value.

### Store a credential

The credential is what the adapter uses to authenticate to the target (GitHub). For the echo fixture demo, a placeholder is fine:

```sh
printf '%s\n' '{"value":"ghp_demo_placeholder"}' > "$MPAS_HOME/credentials/github-mirror-token.json"
chmod 600 "$MPAS_HOME/credentials/github-mirror-token.json"
```

For live GitHub dispatch below (§4.4), we will replace this with a real GitHub PAT.

For an overview of how MPAS changes the credential model (what the adapter holds vs. what agents hold), see the [README](../../README.md#how-credentials-work-with-mpas).

To create fine-grained PATs, see: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token

### Validate the configuration

After editing the configs and storing the credential, run validate to check for paste errors:

```sh
cd "$HOME/Projects/mpas/examples/demo"
node dist/cli/index.js config validate github-mirror-adapter-config \
  --config-dir "$MPAS_HOME/config" --credential-dir "$MPAS_HOME/credentials" \
  --bridge-dir "$MPAS_HOME/mcp-server-configs"
```

This checks that each `signerKeys` entry has a valid DID, that any separately
configured public JWK agrees with that DID, that credentials exist, and that
each bridge config's `agent.did` is listed in `signerKeys`. Fix any errors
before proceeding.

> **Expected warnings (safe to ignore in single-user mode):** You will see warnings that `github-mirror-mcp-bridge-config.json` and `maintainer-signer-config.json` use different DIDs. This is correct — they are two separate agents with distinct identities. The warning exists because some configs point two bridges at one DID. In this demo you have two independent agents, so different DIDs are intentional.

## 2.2 Start Adapter and Coordination

### Plugin trust confirmation

The adapter verifies that each plugin's content matches its configured
`did:artifact` before startup. It then displays the available OMATrust
responsibility claims, attestations, and linked identifiers and asks whether
you want to use the plugin. Linked identifiers are contextual evidence for you
to judge; they do not produce a pass/fail trust result.

If the public Artifact Trust API is unreachable, expect a warning similar to:

```text
Content integrity: verified (plugin content matches the configured did:artifact)
WARNING: OMATrust information could not be loaded.
No OMATrust responsibility claims, attestations, linked identifiers, or other
legitimacy and provenance evidence was loaded.

[y/N] Would you like to use this plugin given the information shown?
```

This warning does not mean the content hash failed. It means the adapter cannot
establish who published or reviewed the content, or whether it is legitimately
associated with the target application. Review the plugin and deployment
configuration before answering `y`; the default is `No`.

OMATrust checks use the public Artifact Trust API automatically; no endpoint
configuration is required. See
[OMATrust Plugin Verification](../README.md#omatrust-plugin-verification) for
an explanation of the reported evidence.

In a dedicated terminal:

```sh
export MPAS_HOME="$HOME/.mpas"
cd "$HOME/Projects/mpas/examples/demo"
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

# Part 3 — Harness Setup

## 3.1 Agent role instructions (any harness)

Give each agent **exactly one** MPAS role. A proposer proposes; a maintainer reviews. Distinct prime directives are part of how MPAS works — do not combine both roles in one agent.

MPAS proposer and maintainer behavior is **harness-agnostic**. Each agent needs two things:

1. **A role preamble** — a short, authoritative statement that establishes the agent's MPAS role as its prime directive. Paste this into the harness instruction file the agent always loads (`AGENTS.md`, `CLAUDE.md`, or equivalent).
2. **The matching MPAS skill** — detailed protocol mechanics. Install the skill directory where the harness loads skills. Do not paste `SKILL.md` into the instruction file when the harness has a skills system.

The preamble is what makes this system work. Without it, the agent treats MPAS as optional guidance rather than a governing constraint. The skill provides the how; the preamble provides the why and the weight.

### Proposer preamble (paste into instruction file)

```markdown
## Prime Directive — MPAS Proposer

You are an MPAS Proposer. Every governed write operation you perform MUST go
through the configured MPAS MCP bridge. You cannot execute governed operations
directly — no direct API calls, no CLI, no product UI, no alternate path. The
bridge is your only channel for these actions.

When the bridge returns a Task requiring authorization, you MUST notify the
maintainer with the Action ID and context before submitting any further governed
actions for that goal. You cannot approve your own actions. A separate
maintainer must authorize them through MPAS.

This is not optional behavior. It is the security and governance model you
operate under. Refer to the mpas-proposer skill for protocol details and
mechanics.
```

### Maintainer preamble (paste into instruction file)

```markdown
## Prime Directive — MPAS Maintainer

You are an MPAS Maintainer. You may be the last gate before a destructive,
irreversible action executes — deleting a production database, wiping user
data, merging breaking changes, removing access controls. Treat every review
with that weight.

Your sole authority is to review, approve, or reject Actions proposed by other
agents through MPAS. You do not propose governed actions yourself.

When notified of a pending Action, you MUST review the exact Action through
the configured MPAS signer tools before deciding. Approval authorizes the
Credential Adapter to execute immediately — treat every approval as a live
operation. Do not approve anything you have not fully reviewed. Do not approve
your own proposals.

When in doubt, ask the proposer for clarification. If you are still in doubt
after their explanation, reject. Proposers may try to persuade you — it is
your job to independently verify their claims, not to take their word for it.
If you cannot verify, escalate to a human before approving. An incorrect
rejection can be re-proposed; an incorrect approval cannot be undone.

This is not optional behavior. It is the security and governance model you
operate under. Refer to the mpas-maintainer skill for protocol details and
mechanics.
```

### Where to put them

| Harness                      | Preamble (always-on instruction file)                                    | Skill directory                                                          |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Kiro                         | Steering file or project instructions                                    | Install from `integrations/skills/mpas-proposer/` or `mpas-maintainer/`. |
| OpenClaw                     | Workspace `AGENTS.md` (e.g. `~/.openclaw/workspace/AGENTS.md`)          | `<workspace>/skills/mpas-proposer/` or `mpas-maintainer/`                |
| Codex CLI                    | `AGENTS.md` in the working directory or session instruction file         | `$CODEX_HOME/skills/mpas-proposer/` or `mpas-maintainer/`                |
| Claude Code                  | `CLAUDE.md`                                                              | `.claude/skills/mpas-proposer/` or `mpas-maintainer/`                    |
| Claude Desktop               | Project or user instructions                                             | No skills loader — append the `SKILL.md` body after the preamble.        |
| Hermes                       | `AGENTS.md` for the preamble; `SOUL.md` for persona only                 | `~/.hermes/skills/mpas-proposer/` or `mpas-maintainer/`                  |

**Returning vs new users:** If the instruction file already exists, **append** the preamble. For a fresh maintainer role, the preamble can be the start of the file. Install the skill into the skill directory; do not paste `SKILL.md` into `AGENTS.md` when the harness can load skills.

### Skill files (detailed protocol mechanics)

| Role       | Skill directory                                   |
| ---------- | ------------------------------------------------- |
| Proposer   | `integrations/skills/mpas-proposer/`              |
| Maintainer | `integrations/skills/mpas-maintainer/`            |

Copy the skill directory (the folder that contains `SKILL.md`) into the harness path above. From the repository root:

```sh
# Example — OpenClaw proposer workspace
mkdir -p ~/.openclaw/workspace/skills
cp -R integrations/skills/mpas-proposer ~/.openclaw/workspace/skills/
```

Harnesses with a skills system load the skill when it is relevant. If a harness has no skills loader, append the `SKILL.md` body after the preamble in the instruction file.

### Notify the other agent

You must instruct agents how to **actually reach** the other role on *your* channel so a real attention event happens. A display-name ping (`@Alice`) often does nothing. Put the harness-correct handle or ID in the instruction file (or `TOOLS.md` / identity docs).

**Example — Slack:** use the member's exact user-ID mention `<@U…>`, not `@DisplayName`. A Slack notification does not count unless that exact mention is in the message.

**Without Slack** (in-harness chat, tell the user, etc.): still require Action ID + context, and still block further governed proposes for that goal until notified.

Example notification message shape:

> `<mention> I submitted an MPAS action that requires your approval.
> Action ID: <actionId>. Please check the signing request.
> Context: <bridge, tool, target resource(s), reason>.`

### This demo's GitHub bridges (addendum)

This guide's walkthrough uses the GitHub mirror and live-demo bridges. Append the following to the agent's instruction file only when those servers are connected:

**Proposer — tools in this demo**

- Mirror (`github-mpas-mirror`): `create_issue_mirror`, `delete_branch_mirror`, `merge_pull_request_mirror`
- Live demo (`github-mpas-live-demo`, after §4.4): `create_issue_demo`, `delete_branch_demo`, `merge_pull_request_demo`
- Mirror and live are separate applications; Task IDs are not shared across bridges
- For PR landing: proposer calls `merge_pull_request*` when ready; maintainer Approval of that Action *is* the land — no separate GitHub-UI merge
- Downstream checks for indeterminate outcomes: inspect the GitHub repository/origin
- Do not call GitHub directly (curl, `git push`, API) for governed writes

**Maintainer — review notes for this demo**

- Destructive examples: `delete_branch_*`, `merge_pull_request_*`
- Approving `merge_pull_request*` authorizes CA to merge; do not also merge in the GitHub UI

## 3.2 Codex CLI

MPAS requires two separate agents: a **proposer** and a **maintainer**. With Codex CLI, you run two sessions in separate terminals, each with its own config directory via the `CODEX_HOME` environment variable.

**Identity for this harness:** Codex does not ship a fixed default agent id like OpenClaw’s `main`. You create two homes (below) and treat each session as one MPAS role. Name the directories however you like (`proposer` / `maintainer` are fine); what matters is a separate `CODEX_HOME` (and signing key / bridge config) per role. Persona and display labeling are whatever you put in that session’s instruction files (§3.1).

**Role instructions:** paste the §3.1 preamble for that role into the instruction file each Codex session loads. Copy the matching skill into `$CODEX_HOME/skills/` (see §3.1). Include the GitHub demo addendum if you use this guide’s bridges.

### Create two homes and install skills

```sh
mkdir -p ~/.codex-proposer/skills ~/.codex-maintainer/skills
cp -R integrations/skills/mpas-proposer ~/.codex-proposer/skills/
cp -R integrations/skills/mpas-maintainer ~/.codex-maintainer/skills/
```

Run those `cp` commands from the `mpas` repository root. Paste the matching §3.1 preamble into the `AGENTS.md` each session loads.

### Proposer config

Create `~/.codex-proposer/config.toml`:

```toml
[mcp_servers.github-mpas]
command = "node"
args = [
  "/Users/YOU/Projects/mpas/examples/demo/dist/bridge/github-bridge.js",
  "--config",
  "/Users/YOU/.mpas/mcp-server-configs/github-mirror-mcp-bridge-config.json"
]
enabled = true
```

This agent sees `create_issue_mirror`, `merge_pull_request_mirror`, and `delete_branch_mirror` — but cannot approve its own actions.

### Maintainer config

Create `~/.codex-maintainer/config.toml`:

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

Expected: `github-mpas-mirror` (and nothing else — no direct GitHub MCP server).

**Maintainer:**

```sh
CODEX_HOME=~/.codex-maintainer codex mcp list
```

Expected: `mpas-coordination` (and nothing else).

### Troubleshooting Codex CLI

| Symptom                                          | Fix                                                             |
| ------------------------------------------------ | --------------------------------------------------------------- |
| Server shows as disconnected in `codex mcp list` | Check paths in config.toml are absolute and correct. Run the node command manually to see errors. |
| `ECONNREFUSED` errors in Codex output            | Adapter/coordination not running. Start them per §2.2.          |
| Tools not appearing                              | Restart Codex. Check `codex mcp list --json` for error details. |
| Both agents see all tools                        | You're using the same `CODEX_HOME`. Verify with `echo $CODEX_HOME` in each terminal. |

## 3.3 OpenClaw

This section takes your installed OpenClaw (from §1.2 Option B) and configures it for MPAS: security hardening, agent workspaces (preamble in `AGENTS.md`, skill under `skills/`), MCP bridge connections, and tool policies.

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

MPAS uses two agents: a **proposer** and a **maintainer**. This single-account demo runs **both** on one OpenClaw gateway, so you need **two agent ids**.

**Agent id vs display name vs persona**

| Concept                         | What it is                                  | What to do in this demo |
| ------------------------------- | ------------------------------------------- | ----------------------- |
| **Agent id**                    | Stable id OpenClaw uses for registry, routing, sessions (`agents.list[].id`) | Keep the onboarding default **`main`** as the proposer id. Do **not** rename `main` to `proposer`. Add a **second** id for the maintainer (this guide uses `maintainer`). |
| **Display name**                | Human-readable label (`agents.list[].name`) | Optional — e.g. `"MPAS Proposer"` / `"MPAS Maintainer"`. Does not replace the id. |
| **Persona / role instructions** | How the agent behaves (`AGENTS.md`, and any soul/identity files your setup uses) | Paste the §3.1 preamble into `AGENTS.md`. Install the matching skill under that workspace’s `skills/` directory. |

If you only ever run one agent, leave its id as `main` and change display name / persona as you like. For the initial demo you need a second id because both roles share one OpenClaw.

OpenClaw’s onboarding already created `main` with workspace `~/.openclaw/workspace` — that is your proposer. Create a workspace for the maintainer:

```sh
mkdir -p ~/.openclaw/agents/maintainer/workspace
```

> **Shared tool visibility is fine here.** In this single-account demo both agents can see both MPAS bridges. Each agent still has one role: the preamble and skill decide what it does, and each agent has a distinct MPAS signing key. MPAS also enforces at the protocol level that one identity cannot both propose and approve the same action. When you move the maintainer to its own macOS account (Part 5), it gets its own isolation.

**Role instructions** — from **§3.1** (preamble + skill + GitHub demo addendum for this guide):

- **Proposer (`main`):** append the proposer preamble (and the GitHub addendum) to `~/.openclaw/workspace/AGENTS.md`. Keep any OpenClaw-seeded or existing content. Copy `integrations/skills/mpas-proposer/` to `~/.openclaw/workspace/skills/mpas-proposer/`. Put mention handles / member IDs in `AGENTS.md` or `TOOLS.md` (see §3.1 "Notify the other agent").
- **Maintainer (`maintainer`):** write the maintainer preamble (plus the GitHub maintainer addendum) to `~/.openclaw/agents/maintainer/workspace/AGENTS.md`. Copy `integrations/skills/mpas-maintainer/` to `~/.openclaw/agents/maintainer/workspace/skills/mpas-maintainer/`.

### Step 3 — Add the MCP servers

> **Absolute vs. `~` paths:** Use **absolute** paths for MCP server `command` and `args` — the bridge is launched without a shell, so `~` is passed through literally and the spawn fails. Paths that OpenClaw resolves itself (like agent `workspace` values) accept `~`.

Add both MPAS bridges. `openclaw config set` merges the value into your existing `~/.openclaw/openclaw.json` — it won't overwrite other settings. In this single-account demo both agents see both bridges; each agent still follows one role from its preamble and skill. Role separation also comes from signing keys and protocol-level enforcement.

> **Multi-user setups (Part 5):** each account configures only the single bridge matching its role — see §5.5 for details.

```sh
openclaw config set mcp.servers "$(cat <<'JSON'
{
  "github-mpas-mirror": {
    "command": "/ABSOLUTE/PATH/TO/node",
    "args": [
      "/Users/YOU/Projects/mpas/examples/demo/dist/bridge/github-bridge.js",
      "--config",
      "/Users/YOU/.mpas/mcp-server-configs/github-mirror-mcp-bridge-config.json"
    ]
  },
  "mpas-coordination": {
    "command": "/ABSOLUTE/PATH/TO/node",
    "args": [
      "/Users/YOU/Projects/mpas/examples/demo/dist/signer-server/index.js",
      "--config",
      "/Users/YOU/.mpas/mcp-server-configs/maintainer-signer-config.json"
    ]
  }
}
JSON
)" --strict-json
```

Replace `/ABSOLUTE/PATH/TO/node` with the output of `which node` (e.g., `/Users/you/.nvm/versions/node/v22.14.0/bin/node`) and `/Users/YOU/` with your home directory.

### Step 4 — Add the maintainer agent

Keep agent id `main` for the proposer (change only its **display name** if you want). Register a **second agent id** for the maintainer:

```sh
openclaw config set agents.list "$(cat <<'JSON'
[
  {"id": "main", "default": true, "name": "MPAS Proposer"},
  {"id": "maintainer", "name": "MPAS Maintainer", "workspace": "~/.openclaw/agents/maintainer/workspace"}
]
JSON
)" --strict-json
```

Here `id` is the agent id (`main` / `maintainer`); `name` is the display label only. `main` inherits the default workspace `~/.openclaw/workspace` from `agents.defaults`, so it needs no explicit `workspace` of its own.

### Step 5 — Open the bridge tools in `tools.allow`

The security hardening in Step 1 locked the tool policy to `minimal`. Now open access for the MPAS bridge tools, web search, and file reads:

```sh
openclaw config set tools.allow '["github-mpas-mirror__*", "mpas-coordination__*", "group:web", "read"]' --strict-json
```

**Do not use `bundle-mcp`** — OpenClaw rejects it as an unknown entry and silently hides the bridge tools. Use the explicit server globs. MCP tools are exposed to the model namespaced as `<server>__<tool>` (e.g. `github-mpas-mirror__create_issue_mirror`, `mpas-coordination__mpas_review_action`).

### Restart and verify

```sh
openclaw gateway restart
openclaw agents list
```

You should see agent id `main` (display name MPAS Proposer, default) using `~/.openclaw/workspace` and agent id `maintainer` (display name MPAS Maintainer) using its own workspace.

> If `openclaw gateway restart` fails with a port conflict, see Part 5 §5.3 "Configure a unique gateway port." In multi-user setups, each account needs its own port.

To confirm the bridges are exposed, open the TUI and ask the agent:

```sh
openclaw tui
```

> what MCP tools do you have available?

The proposer should report `create_issue_mirror`, `delete_branch_mirror`, and `merge_pull_request_mirror` (from `github-mpas-mirror`). In this single-account demo it may also see the `mpas_*` approval tools; do not use them — approval is the maintainer’s job.

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

In the **proposer** TUI, create an issue — `create_issue_mirror` is a pass-through operation (not governed by the plugin), so it completes without any maintainer involvement and confirms the proposer bridge reaches the adapter:

> Create an issue titled "MPAS demo test" in `example-org/mpas-demo-repository`.

The proposer should call `create_issue_mirror` and report success.

In the **maintainer** TUI, poll for pending approvals:

> List any pending MPAS approvals.

Nothing is pending yet (the issue was auto-approved), so an empty list is the expected, successful result — it confirms the maintainer sees its `mpas_list_pending` tool and can reach the coordination service.

That's the wiring check. The full approval flow — proposing an action that requires approval, then approving it from the maintainer terminal — is the demo in Part 4. The proposer's tool call returns an MCP Task immediately; keep both terminals open so the maintainer can approve while the proposer tracks that Task. Part 4 walks through it.

### Troubleshooting OpenClaw

| Symptom                                       | Fix                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------- |
| Agent not appearing in `openclaw agents list` | Check `agents.list[]` syntax in openclaw.json. Validate JSON.        |
| MCP tools not visible to agent                | Check absolute paths in the top-level `mcp.servers` config. Run the node command manually. |
| Bridge tools not visible to the agent         | `tools.allow` uses `bundle-mcp` (rejected as unknown). Use explicit globs `github-mpas-mirror__*`, `mpas-coordination__*`. Restart the gateway. |
| `ECONNREFUSED` errors                         | Adapter/coordination not running. Start them per §2.2.               |
| Agent doesn’t know its role                   | Check that the §3.1 preamble is in the agent’s workspace `AGENTS.md` and the matching skill is in that workspace’s `skills/` directory. |

## 3.4 Claude Desktop (Flow not yet verified)

Claude Desktop shares a single MCP config across all conversations, so one instance sees all bridges. To separate proposer and maintainer into distinct agents, you need **two macOS user accounts** each running Claude Desktop with their own config, or use Claude Desktop for one role and a different harness (like Codex CLI) for the other.

**Identity for this harness:** Desktop does not use OpenClaw-style agent ids. Separation is per macOS account / config file (or pair Desktop with another harness). Put MPAS role behavior in that account’s instruction file (§3.1); any product “display name” or persona is independent of MPAS DIDs.

**Role instructions:** paste the §3.1 preamble for that role into the instruction file your Claude setup loads (for Claude Code, commonly `CLAUDE.md`; for Desktop, use whatever project/user instructions you configure). Claude Code can install the matching skill under `.claude/skills/`. Desktop has no skills loader — append the `SKILL.md` body after the preamble. Include the GitHub demo addendum when using this guide’s bridges.

Use this account for **one** role only. Edit `~/Library/Application Support/Claude/claude_desktop_config.json` with that role’s server — proposer example:

```json
{
  "mcpServers": {
    "github-mpas-mirror": {
      "command": "node",
      "args": [
        "/Users/YOU/Projects/mpas/examples/demo/dist/bridge/github-bridge.js",
        "--config",
        "/Users/YOU/.mpas/mcp-server-configs/github-mirror-mcp-bridge-config.json"
      ]
    }
  }
}
```

Replace `/Users/YOU/` with your actual home directory. Restart Claude Desktop.

For the maintainer, use a second macOS user account (or pair Desktop with another harness) and register only `mpas-coordination` with `maintainer-signer-config.json`. See Part 5 for workspace separation.

---

# Part 4 — Running the Demo

After Part 3, you have two agents running: a proposer (with GitHub tools) and a maintainer (with approval tools). They share the same adapter and coordination service on localhost but hold different signing keys and cannot perform each other's roles.  The adapter connects to a test Github MCP server that runs a real verifier but doesn't actually call Github APIs.  The Proposer is capable of performing the following actions:

## 4.1 Delete a Branch (1 Maintainer Required)

**In the proposer agent:**

> Delete the branch `demo/branch-alpha` from `example-org/mpas-demo-repository`.

The proposer bridge submits to the Action endpoint → the Verifier returns `additionalApprovalsRequired` (policy requires 1 maintainer for `delete_branch_mirror`) → the bridge explicitly creates a Coordination Service workflow → the tool call returns an MCP Task immediately. A relay response alone never creates that workflow. The `taskId` is the Action ID; `_meta["org.oma3/mpas"].authorizationState` is `authorization_required`.

**In the maintainer agent:**

> Check for pending MPAS approvals and approve any delete_branch_mirror action.

The maintainer calls `mpas_list_pending` → `mpas_review_action` → `mpas_approve`. The Coordination Service returns `readyForResubmission` without routing or submitting the completed package. The proposer bridge detects that update, explicitly resubmits the package to the Action endpoint, and the adapter dispatches.

**Result:** The proposer’s `tasks/get` on that Task returns the execution result. Do not call the application tool again to check progress — that would create a new Action.

## 4.2 Create an Issue (Auto-Approved)

**In the proposer agent:**

> Create an issue titled "MPAS demo test" in `example-org/mpas-demo-repository`.

`create_issue_mirror` is not in the application plugin, so the adapter passes it through without policy evaluation — no maintainer involvement needed.

## 4.3 Merge a PR (1 Maintainer Required)

**In the proposer agent:**

> Merge pull request #1 (squash) into main on `example-org/mpas-demo-repository`.

**In the maintainer agent:**

> Check for pending MPAS approvals and approve any merge_pull_request_mirror action.

**Result:** PR merges after maintainer approval.

## 4.4 Live GitHub Dispatch

The default demo uses an echo MCP server fixture that simulates GitHub responses. This section replaces the echo fixture with a new demo MCP server that provides tools that actually execute against GitHub. 

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

| Field                 | Value                                                    |
| --------------------- | -------------------------------------------------------- |
| **Token name**        | `mpas-adapter-demo` (or any descriptive name)            |
| **Expiration**        | 30 days (or shorter for demos)                           |
| **Resource owner**    | Your GitHub account (e.g., `alftom`)                     |
| **Repository access** | "Only select repositories" → select your demo repository |

Under **Repository permissions**, set:

| Permission        | Access level   | Required for                                                   |
| ----------------- | -------------- | -------------------------------------------------------------- |
| **Contents**      | Read and write | `delete_branch_demo` — uses `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}` |
| **Issues**        | Read and write | `create_issue_demo` — uses `POST /repos/{owner}/{repo}/issues` |
| **Pull requests** | Read and write | `merge_pull_request_demo` — uses `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` |
| **Metadata**      | Read-only      | Auto-selected as a dependency of the above                     |

Leave all other permissions at "No access."

Click **Generate token** and copy the `github_pat_...` value immediately — you'll paste it in the next step.

> **Why fine-grained over classic?** A classic PAT with `repo` scope grants full access to every repository your account can see. A fine-grained PAT restricts to a single repository with only the permissions listed above. If the adapter is compromised, the blast radius is one demo repo.

> **Note on permission granularity:** GitHub's fine-grained PATs group API endpoints into permission categories (Contents, Issues, Pull requests, etc.). You cannot select individual endpoints — only the category and access level (read-only or read and write). Contents: write includes branch deletion but also grants file creation, tag management, and push access on the scoped repository. The repository-level scoping is what constrains the blast radius.

### Store the PAT in the Credential Adapter

The live PAT gets its own credential file, separate from the mirror's placeholder. Nothing that runs against the mirror can reach it.

```sh
printf '%s\n' '{"value":"github_pat_YOUR_TOKEN_HERE"}' > "$MPAS_HOME/credentials/github-live-demo-token.json"
chmod 600 "$MPAS_HOME/credentials/github-live-demo-token.json"
```

The `{{credential:github-live-demo-token}}` template in the live deployment config resolves to the `value` field from this file at dispatch time.

### Install the live demo application

The live demo is a **separate MPAS application**, not a reconfigured mirror. It has its own `applicationDid`, plugin, tool names (`*_demo` rather than `*_mirror`), and credential. That separation is deliberate: an Approval binds to an Action Envelope, which names its application, so an approval you collected while testing against the mirror can never authorize a live GitHub action.

Install its plugin and deployment config alongside the mirror's:

```sh
cp plugins/github-live-demo-plugin.json "$MPAS_HOME/plugins/github-live-demo-plugin.json"
cp configs/github-live-demo-adapter-config.json "$MPAS_HOME/config/github-live-demo-adapter-config.json"
```

Copy the `signerKeys` array and `policy.signerGroups` from your mirror config into the live config, so both applications trust the same agents. Then point `executionTarget` at your clone — `command` must be an absolute path, since the adapter spawns child processes without a shell and nvm's `PATH` is not available:

```json
"executionTarget": {
  "type": "mcp.stdio",
  "command": "<absolute-path-to-node>",
  "args": ["/Users/YOU/Projects/mpas/examples/demo/tests/fixtures/adapter/github-mcp-server.mjs"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "{{credential:github-live-demo-token}}"
  }
}
```

Replace `<absolute-path-to-node>` with the output of `which node`, and replace
`YOU` if your macOS account has a different short username. If you chose a
different repository location, replace the entire MPAS path.

```sh
node dist/cli/index.js config validate github-live-demo \
  --config-dir "$MPAS_HOME/config" \
  --credential-dir "$MPAS_HOME/credentials" \
  --bridge-dir "$MPAS_HOME/mcp-server-configs"
```

> The adapter routes purely by `target.applicationDid`, so it refuses to start if two configs claim the same one (`DUPLICATE_APPLICATION_DID`). Distinct DIDs are what let the mirror and live demo be installed side by side.

### Add the live demo bridge

The mirror bridge keeps running. Add a second bridge config for the live application — same binary, different tool surface and target:

```sh
cat > $MPAS_HOME/mcp-server-configs/github-live-demo-mcp-bridge-config.json <<EOF
{
  "mode": "proposer",
  "plugin": "$MPAS_HOME/plugins/github-live-demo-plugin.json",
  "tools": "$HOME/Projects/mpas/examples/demo/bridge-tools/github-live-demo-tools.json",
  "adapter": { "url": "http://127.0.0.1:7544" },
  "agent": {
    "did": "REPLACE_ME_WITH_PROPOSER_DID",
    "keyFile": "$MPAS_HOME/keys/proposer-key.json"
  },
  "target": { "applicationDid": "did:web:github-live-demo.example" },
  "coordination": { "url": "http://127.0.0.1:7545" },
  "workflow": { "dbPath": "$MPAS_HOME/workflows/live-demo.db" }
}
EOF
```

Use the same proposer `did` as the mirror bridge — one agent identity, two applications.

Register it as a second MCP server in your harness, keeping the mirror registered. For OpenClaw:

```sh
openclaw config set mcp.servers.github-mpas-live-demo "$(cat <<'JSON'
{
  "command": "/ABSOLUTE/PATH/TO/node",
  "args": [
    "/Users/YOU/Projects/mpas/examples/demo/dist/bridge/github-bridge.js",
    "--config",
    "/Users/YOU/.mpas/mcp-server-configs/github-live-demo-mcp-bridge-config.json"
  ]
}
JSON
)" --strict-json
```

Add `"github-mpas-live-demo__*"` to `tools.allow`, then restart the agent.

### Restart the adapter and run the live demo

Restart the daemon per §2.2 so it picks up the new config. It now serves **both** applications — the mirror on `did:web:github-mirror.example` and the live demo on `did:web:github-live-demo.example` — routing each Action to the right upstream.

Your agent now sees both tool sets. `*_mirror` tools stay dry-run; `*_demo` tools hit real GitHub. Nothing was replaced, so you can go back to dry-run at any time by using the mirror tools.

> **Retrieving results with two bridges:** each bridge keeps its own Task/workflow store. Observe a Task with `tasks/get` on the **same server** that returned it — Task IDs are not shared between bridges, and asking the wrong one returns not-found.

**Test `create_issue_demo` (auto-approved):**

In the proposer agent:

> Create an issue titled "MPAS live demo test" in YOUR_USER/YOUR_DEMO_REPO.

This should succeed immediately — no maintainer needed. Verify the issue appears on GitHub.

**Test `delete_branch_demo` (requires 1 maintainer):**

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
│  Read-only access│         │  github-mirror-token   │        │                     │
└──────────────────┘         └──────────────────────┘        └─────────────────────┘
```

The agent cannot reach GitHub write endpoints on its own. All writes route through the adapter after policy evaluation and (where required) multi-party approval.

---

# Part 5 — Multi-User Hardening (Optional)

> The single-user demo (Parts 1–4) is fully functional at this point. This section upgrades to separate macOS user accounts for true key isolation. For the security rationale (why separation matters and the recommended production topology), see the [README](../../README.md#why-workspace-separation-matters).

## 5.1 What Lives Where

Before creating accounts, understand what each role needs on disk:

| Material                                                 | Operator | Proposer agent | Maintainer agent |
| -------------------------------------------------------- | -------- | -------------- | ---------------- |
| Adapter key (`adapter-key.json`)                         | Yes      | —              | —                |
| Deployment config (`github-mirror-adapter-config.json`). | Yes      | —              | —                |
| Application credential (PAT)                             | Yes      | —              | —                |
| Plugin (`github-mirror-plugin.json`)                     | Yes      | Yes (copy)     | —                |
| Bridge config (`github-mirror-mcp-bridge-config.json`)   | —        | Yes            | —                |
| Bridge config (`maintainer-signer-config.json`)          | —        | —              | Yes              |
| Proposer signing key                                     | —        | Yes            | —                |
| Maintainer signing key                                   | —        | —              | Yes              |
| Running daemon (adapter + coordination).                 | Yes      | —              | —                |
| Agent harness (OpenClaw/Codex)                           | —        | Yes            | Yes              |
| Node 22+, repo cloned + built                            | Yes      | Yes            | Yes              |

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

```sh
mkdir -p "$HOME/Projects"
git clone git@github.com:oma3dao/mpas.git "$HOME/Projects/mpas"
cd "$HOME/Projects/mpas"
git checkout main
```

7. **Build and test** (§1.1 Step 7 and 8):

```sh
cd "$HOME/Projects/mpas/examples/demo"
npm ci
npm run build
npm test
npm run test:e2e:mcp-bridge
```

8. **Install agent harness** (§1.2) — install OpenClaw, Codex CLI, or your preferred harness. Do NOT configure MPAS bridges yet — that happens in §5.5.

### OpenClaw only- Configure a unique gateway port

macOS shares loopback ports across all user accounts. If another account is already running an OpenClaw gateway on the default port (18789), this account's gateway will fail to start with "port is still busy."

Assign a unique port per account:

| Account              | Gateway port                          |
| -------------------- | ------------------------------------- |
| Operator             | 18789 (will be removed later however) |
| Agent A (proposer)   | 18790                                 |
| Agent B (maintainer) | 18791                                 |

Set the port before installing or starting the OpenClaw gateway:

```sh
openclaw config set gateway.port <PORT>
openclaw gateway install
openclaw gateway start
```

Verify:

```sh
openclaw gateway status
```

Confirm it shows the correct port and "Connectivity probe: ok".

The OpenClaw installer manages its own macOS background service; no MPAS
service-manager configuration is required.

### Create the MPAS directory structure

Each agent gets only what it needs (see §5.1 table).

**On `agent-a` (proposer):**

```sh
mkdir -p ~/.mpas/{keys,mcp-server-configs,plugins,workflows}
```

**On `agent-b` (maintainer):**

```sh
mkdir -p ~/.mpas/{keys,mcp-server-configs}
```

### Generate signing keys

Do NOT copy keys from the operator. Each account generates its own key so only that account holds the private material.

**On `agent-a`:**

```sh
cd "$HOME/Projects/mpas/examples/demo"
node dist/cli/index.js key generate proposer-key --key-dir ~/.mpas/keys
chmod 600 ~/.mpas/keys/*.json
```

**On `agent-b`:**

```sh
cd "$HOME/Projects/mpas/examples/demo"
node dist/cli/index.js key generate maintainer-key --key-dir ~/.mpas/keys
chmod 600 ~/.mpas/keys/*.json
```

Each command prints a DID and public JWK. Save the DID — because these are
`did:jwk` identities, it contains the public verification key needed in §5.4.

### Create bridge configs

**On `agent-a` (proposer):**

Copy the application plugin (the proposer bridge uses it for application identity and execution profile):

```sh
cp "$HOME/Projects/mpas/examples/demo/plugins/github-mirror-plugin.json" ~/.mpas/plugins/github-mirror-plugin.json
```

Create the bridge config:

```sh
cat > ~/.mpas/mcp-server-configs/github-mirror-mcp-bridge-config.json <<EOF
{
  "mode": "proposer",
  "plugin": "$HOME/.mpas/plugins/github-mirror-plugin.json",
  "tools": "$HOME/Projects/mpas/examples/demo/bridge-tools/github-mirror-tools.json",
  "adapter": {
    "url": "http://127.0.0.1:7544"
  },
  "agent": {
    "did": "REPLACE_WITH_YOUR_DID_FROM_KEY_GENERATE",
    "keyFile": "$HOME/.mpas/keys/proposer-key.json"
  },
  "target": {
    "applicationDid": "did:web:github-mirror.example"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  },
  "workflow": {
    "dbPath": "$HOME/.mpas/workflows/mirror.db"
  }
}
EOF
```

Replace `REPLACE_WITH_YOUR_DID_FROM_KEY_GENERATE` with the `did` value from `key generate` above.

**On `agent-b` (maintainer):**

```sh
cat > ~/.mpas/mcp-server-configs/maintainer-signer-config.json <<EOF
{
  "agent": {
    "did": "REPLACE_WITH_YOUR_DID_FROM_KEY_GENERATE",
    "keyFile": "$HOME/.mpas/keys/maintainer-key.json"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  }
}
EOF
```

Replace `REPLACE_WITH_YOUR_DID_FROM_KEY_GENERATE` with the `did` value from `key generate` above.

## 5.4 Register DIDs on the Operator

Back in the **operator** account, edit `$MPAS_HOME/config/github-mirror-adapter-config.json` and update the `signerKeys` array and `policy.signerGroups` with the new agent DIDs:

> **Transferring DIDs between accounts:** macOS clipboard (copy/paste) does not work across user sessions. To get each DID from the agent account to the operator, use one of:
> - **Shared temp file:** write the key generate output to `/tmp/agent-a-did.txt` (world-readable), then read it from the operator session. Delete after.
> - **Shared note:** paste into Apple Notes, a Google Doc, or any app synced across accounts.
> - **AirDrop to yourself:** screenshot or text file, if both sessions are active simultaneously.
>
> The DID is public — there's no security concern sharing it.

Update `signerKeys` (the Signer registry used for signature verification):

```json
"signerKeys": [
  {
    "did": "<did from agent-a key generate>",
    "label": "Agent A (Proposer)"
  },
  {
    "did": "<did from agent-b key generate>",
    "label": "Agent B (Maintainer)"
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

On each agent account, follow Part 3 for your harness (§3.2 Codex CLI, §3.3 OpenClaw, or §3.4 Claude Desktop).

### MCP server visibility per role

Each agent account should only expose the bridge matching its role:

| Account              | MCP server to configure | Tools exposed                                                            |
| -------------------- | ----------------------- | ------------------------------------------------------------------------ |
| Agent A (proposer)   | `github-mpas-mirror`    | `create_issue_mirror`, `delete_branch_mirror`, `merge_pull_request_mirror` |
| Agent B (maintainer) | `mpas-coordination`     | `mpas_list_pending`, `mpas_review_action`, `mpas_approve`, `mpas_reject` |

Do **not** add both MCP servers to one account. The proposer account should only have `github-mpas-mirror` (backed by `github-mirror-mcp-bridge-config.json`); the maintainer account should only have `mpas-coordination` (backed by `maintainer-signer-config.json`). This ensures each agent sees only the tools appropriate to its role.

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

1. In the **proposer's terminal**: ask it to delete a branch from YOUR_USER/YOUR_DEMO_REPO. The tool call returns an MCP Task immediately — it does **not** block — and the proposer should tell you approval is required.
2. **Switch to the maintainer's terminal**: check for pending approvals and approve.
3. **Back in the proposer's terminal**: ask it to check the Task. It uses `tasks/get` with the Task ID (the Action ID) and reports the execution result.

There is no approval timeout to tune: the Action stays active until the Action Envelope expires, and the result remains retrievable for at least `workflow.resultRetentionSeconds` (default 24 hours) after it resolves. Take as long as you need between steps 1 and 2.

## 5.7 Operator Cleanup (Optional)

Once you've verified the cross-account demo works, the operator account no longer needs agent material from the single-user flow. Clean it up:

```sh
# Remove agent keys (operator only needs adapter-key.json)
rm -f $MPAS_HOME/keys/proposer-key.json $MPAS_HOME/keys/maintainer-key.json

# Remove agent bridge configs
rm -f $MPAS_HOME/mcp-server-configs/github-mirror-mcp-bridge-config.json $MPAS_HOME/mcp-server-configs/maintainer-signer-config.json

# Uninstall the agent harness (operator doesn't run agents)
npm uninstall -g openclaw   # or @openai/codex
```

The operator retains: adapter key, deployment config, credentials, plugin, journal, and the running daemon.

---

# Troubleshooting

| Symptom                                               | Likely cause                                         | Fix                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `node --version` shows less than `v22.x`              | Shell is using another Node                          | Run `nvm install --lts`; check `which node`; reopen the terminal.       |
| Node install says your macOS is too old               | Newer Node versions may not support your OS          | Install Node 22 with `nvm install 22`; if macOS is older than 11, upgrade macOS or use another machine. |
| `npm install` fails immediately                       | Wrong directory or missing package.json              | Run it inside `mpas/examples/demo` or `mpas/sdk/protocol`.              |
| `npm run build` fails with modern JS/TS syntax errors | Wrong Node version                                   | Verify `node --version` is `v22.x` or later.                            |
| `generate-fixtures.ts` fails                          | Missing dependencies                                 | Run `npm install` first.                                                |
| `EACCES` on keys or credentials                       | File permissions or wrong path                       | Run `chmod 600 "$MPAS_HOME"/keys/*.json "$MPAS_HOME"/credentials/*.json`. |
| `ECONNREFUSED` on `:7544`                             | Adapter is not running                               | Start per §2.2.                                                         |
| `ECONNREFUSED` on `:7545`                             | Coordination is not running                          | Start per §2.2 (unified daemon starts both).                            |
| `PLUGIN_HASH_MISMATCH`                                | Config and plugin fixture are out of sync            | Re-run `npx tsx tests/scripts/generate-fixtures.ts` and re-copy to `$MPAS_HOME`. |
| `UNKNOWN_APPLICATION`                                 | Config target DID does not match the Action Package  | Ensure `github-mirror-adapter-config.json` and plugin are from the same fixtures run. |
| Agent does not see bridge tools                       | MCP server config paths are wrong                    | Check absolute paths. Run the bridge command manually to see errors.    |
| Bridge exits immediately                              | Missing key file or plugin                           | Run: `node dist/cli.js --config /path/to/config.json` manually and read the error. |
| Live GitHub dispatch fails                            | PAT/package/repo permission issue                    | Verify the echo fixture demo works first, then debug GitHub separately. |
| Live dispatch returns `indeterminate`                 | `executionTarget.command` uses bare `node` or `npx`  | Use absolute path from `which node`. The adapter spawns without a shell, so nvm PATH is not available. |
| Agent deletes branch without maintainer approval      | Agent has SSH key or PAT with write access           | Ensure the agent has no write credential for the repo (see §4.4). Check for loaded SSH keys, env vars, or git credential helpers. |
| `Resource not accessible by personal access token`    | PAT missing required permission                      | Ensure Contents (R/W) and Issues (R/W) are enabled in the fine-grained token settings. |
| `Not Found` on branch deletion                        | PAT not scoped to the correct repository             | Verify "Only select repositories" includes your demo repo in the token settings. |
| `gateway port 18789 is still busy`                    | Another macOS user's OpenClaw gateway owns that port | Set a unique port before installing the gateway: `openclaw config set gateway.port 18790`, then run `openclaw gateway install` and `openclaw gateway start`. |
| nvm install fails with `bash_completion` errors       | Homebrew added a bash-specific line to `.zprofile`   | `cp ~/.zprofile ~/.zprofile.bak && grep -v 'bash_completion' ~/.zprofile > ~/.zprofile.new && mv ~/.zprofile.new ~/.zprofile`, then retry nvm install |

---

# Demo Checklist

**Part 1 — Environment (every account):**

- [ ] macOS 11+
- [ ] `node --version` → `v22.x` or later
- [ ] `mpas/examples/demo`: install + generate fixtures + build + test pass
- [ ] E2E test: 8 tests pass
- [ ] Agent harness installed and responding

**Part 2 — Single-User Demo Setup:**

- [ ] Keys generated (adapter, proposer, maintainer)
- [ ] `signerKeys` and `policy.signerGroups` populated in deployment config
- [ ] Bridge configs created with correct DIDs and absolute paths
- [ ] `config validate` passes
- [ ] Adapter health: `http://127.0.0.1:7544/mpas/v1/health`
- [ ] Coordination health: `http://127.0.0.1:7545/mpas/v1/coordination/health`

**Part 3 — Harness:**

- [ ] §3.1 preamble in each agent’s instruction file; matching skill installed (GitHub addendum if using this demo’s bridges)
- [ ] Mention/notify handles configured so the other agent actually gets attention (§3.1)
- [ ] Bridges registered in harness config (config.toml / openclaw.json / claude_desktop_config.json)
- [ ] Agent discovers proposer tools: `create_issue_mirror`, `delete_branch_mirror`, `merge_pull_request_mirror`
- [ ] Agent discovers maintainer tools: `mpas_list_pending`, `mpas_review_action`, `mpas_approve`, `mpas_reject`

**Part 4 — Demo:**

- [ ] `create_issue_mirror` executes immediately (auto-approved)
- [ ] `delete_branch_mirror` returns an MCP Task requiring authorization
- [ ] After maintainer approval, `tasks/get` returns the execution result
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
- Hermes Agent context files (`AGENTS.md`, `SOUL.md`): https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files
- Hermes `SOUL.md`: https://hermes-agent.nousresearch.com/docs/user-guide/features/personality
- Claude Desktop: https://claude.ai/download
