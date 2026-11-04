# Running MPAS from a shell

This guide sets up an MPAS deployment on machines you reach only through a
shell, with no web browser or desktop. Any Linux host works as long as you
have a shell and storage that persists: a cloud VM (such as EC2), a server,
or a container platform with a volume (such as Railway). Every step on the
machine is a terminal command. The few steps that need a browser, such as
confirming a sign-in code, happen on your own computer.

It covers three components. Each gets its own machine, or at least its own
user account:

- **Maintainer:** an always-on agent that reviews and approves Actions.
- **Proposer:** an always-on agent that does work through MPAS.
- **Credential Adapter:** the only component that holds the real credentials
  for the applications MPAS governs. It checks each Action against policy and
  carries it out.

You talk to the two agents through a messaging app of your choice, such as
Slack or Telegram.

| Part | What you end up with |
| :--- | :--- |
| [1. Starting point](#part-1--get-to-the-starting-point) | A shell, as the component's own user, with its files on persistent storage |
| [2. Harness](#part-2--set-up-the-harness) | An agent signed in to a model and answering you in your messaging app (Maintainer and Proposer) |
| [3. Maintainer](#part-3--set-up-the-maintainer) | A Maintainer that can review and approve Actions |
| [4. Credential Adapter](#part-4--create-the-credential-adapter) | The adapter's account, application and credentials |
| [5. Proposer](#part-5--set-up-the-proposer) | A Proposer that submits Actions through MPAS |
| [6. Start the adapter](#part-6--start-the-credential-adapter) | The adapter running, with both participants registered |
| [7. Close setup access](#part-7--close-setup-access) | No setup access left behind |
| [8. Test](#part-8--test-the-whole-flow) | Proof that the whole flow works |

**Why the adapter comes before the Proposer.** The Proposer needs the
adapter's address and DID before it can add an application. The adapter
needs the Proposer's DID before it can start. So you create the adapter in
Part 4, set up the Proposer in Part 5, and start the adapter in Part 6. If
someone else runs the adapter, skip Parts 4 and 6 and ask them for its
address and DID.

**Who does what.** A person does every part. They involve sign-ins and
secrets, and Parts 3–6 create identities and decide what each component
trusts; an agent must not set up its own limits. Creating the machines can
be handed to a coding agent on your own computer if your host's appendix
says how. Never use the agent that will run on the machine for this.

---

## Before you start

### What you need

| Item | Where it comes from |
| :--- | :--- |
| A machine (or user account) for each component | A Linux VM or server, or a container platform with a persistent volume. See Part 1. |
| A model provider account | For example a ChatGPT/Codex subscription, an Anthropic or OpenAI API key, or another provider your harness supports |
| A messaging app | Any platform your harness supports, already set up. See 2.1. |
| Coordination URL | The Coordination Service the participants share. Commercial services offer one, or you can run your own. See [Appendix D](#appendix-d--coordination-service-and-action-relay). |
| Action Relay URL (optional) | A hosted relay that carries Actions from the Proposer to the Credential Adapter. Not needed if the two share a machine or a private network (see Part 4). It may come from the same provider as the Coordination Service, or a different one. See [Appendix D](#appendix-d--coordination-service-and-action-relay). |
| The application to govern | Its folder in [mpas-applications](https://github.com/oma3dao/mpas-applications/tree/main/applications) (Part 4, step 4), and its credentials (an API token, or an OAuth sign-in) |

### Pick a harness

This guide covers OpenClaw and Hermes for the two agents. Both are built to
run as always-on agents: they run as a service, connect to messaging apps,
and can be set up entirely from a terminal. Either one can hold either role.
A common pairing is a Hermes Maintainer and an OpenClaw Proposer. The
Credential Adapter needs no harness.

### Values to write down

None of these is secret. Never write down a private key, an API key or a
token here.

| Value | Maintainer | Credential Adapter | Proposer |
| :--- | :--- | :--- | :--- |
| Machine and user (or service) | | | |
| Harness | | — | |
| Bot or account in the messaging app | | — | |
| Coordination URL | | — | |
| Action URL | — | | |
| Application folder URL and name | — | | |
| DID | | (the Verifier DID) | |

---

## Part 1 — Get to the starting point

Everything a component needs lives under one directory on persistent
storage, which this guide calls **`USER_HOME`**. For an agent, that includes
the harness's settings and model sign-in, its instructions and skills, and
the MPAS account and signing key. For the adapter, it includes the
application's credentials.

**Each component needs its own machine, or at least its own user.** A
participant's signing key is a file under its `USER_HOME`, and so are the
adapter's credentials. Anything that can read those files can act as that
component. Never put two components under one user.

How you set this up depends on the host:

- **A Linux VM or server** (EC2, a VPS, a machine you own): `USER_HOME` is
  the user's home directory. Follow [Appendix A](#appendix-a--linux-vm-or-server).
- **Railway:** the container's home directory doesn't survive a restart, so
  `USER_HOME` is a mounted volume. Follow [Appendix B](#appendix-b--railway).

Either way, you end at the same starting point, and then continue with
Part 2 (for an agent) or Part 4 (for the Credential Adapter):

| Requirement | How to check |
| :--- | :--- |
| A shell on the machine, running bash | `echo "$BASH_VERSION"` prints a version. If not, run `bash`. |
| You're working as the component's own user, which nothing else uses | `whoami` (on Railway this is root, inside the agent's own container) |
| `USER_HOME` is set in every new shell, to a directory that survives a restart | `echo "$USER_HOME"` |
| Node.js 22 or later | `node --version` |
| Outbound HTTPS works | `curl -sI https://registry.npmjs.org` returns `HTTP/2 200` |

---

## Part 2 — Set up the harness

Do this part for the Maintainer and for the Proposer. At the end, each agent
answers you in your messaging app. MPAS isn't installed yet.

Where a step differs by host, it says what to do on a **Linux VM or server**
and on **Railway**. On Railway, every command on the machine runs in the
service's shell (`railway ssh --project <project> --service <service>`), and
changes to the service's settings are made in the Railway website.

### 2.1 Choose and set up your messaging app

You talk to each agent through a messaging app. Use any platform your
harness supports, such as Slack, Telegram, Discord or WhatsApp. Each
harness's documentation lists the platforms it supports and has a setup
guide for each:

- OpenClaw: [channels](https://docs.openclaw.ai/channels)
- Hermes: [messaging platforms](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)

**Choosing a platform.** Whoever can talk to an agent can instruct it, and
whoever controls its bot controls that conversation. That matters most for
the Maintainer, which approves Actions. Consider:

- **Who administers the bots.** On some platforms a bot belongs to one
  person's account (a Telegram bot belongs to whoever created it in
  @BotFather). On others it belongs to an organization that several admins
  manage (a Slack app belongs to a workspace and can have several
  collaborators). For a team, or a consortium of organizations, choose the
  second kind. Slack Connect, for example, lets each member organization
  run its own agents in its own workspace and meet in shared channels.
- **Whether bots can see each other's messages.** This decides how the
  Proposer can reach the Maintainer (below).

**Before you go on, have these ready**, following your harness's guide for
the platform:

- **One bot (or app) per agent.** Never share one between the Maintainer and
  the Proposer: it is how you tell them apart.
- **The fewest permissions that do the job.** Give each bot only what its
  agent needs. For example, OpenClaw offers a Recommended and a Minimal
  Slack manifest. Start from Minimal and add `files:read` and `files:write`
  for an agent that needs to read or share files, such as the Proposer.
  Consider leaving file access off the Maintainer: it reviews Actions
  through its MPAS tools, and files are an easy way to slip instructions
  into an agent.
- **Its tokens.** Each platform's guide says which ones it needs, for
  example one bot token for Telegram, or an app token and a bot token for
  Slack. Keep them in your password manager.
- **The user IDs allowed to talk to each agent:** yours, and anyone else's
  who should. Limit the Maintainer to the people who are entitled to direct
  approvals.

**Plan how the Proposer will reach the Maintainer.** When an Action needs
approval, the Maintainer must find out. Pick one:

| Option | How it works | Notes |
| :--- | :--- | :--- |
| The Proposer messages the Maintainer | Both bots are in one group or channel. The Proposer mentions the Maintainer. | The platform must let bots see each other's messages: Slack does; Telegram only with [Bot-to-Bot Communication Mode](https://core.telegram.org/api/bots/bot-to-bot) turned on. The Maintainer's harness must also allow the Proposer's bot as a sender. |
| The Proposer tells you, and you tell the Maintainer | The Proposer messages you. You forward the request to the Maintainer. | Works on every platform. You stay in the loop. |
| The Maintainer checks on a schedule | A scheduled task asks the Maintainer to check for pending approvals every few minutes (OpenClaw `openclaw cron add`, Hermes scheduled tasks). | Works on every platform, with no bot-to-bot messaging. Approvals wait up to one interval. |

You write the choice into the Proposer's instructions in Part 5.

### 2.2 OpenClaw

1. **Install OpenClaw.**

   *On a Linux VM or server:*

   ```bash
   npm install -g openclaw@2026.10.3
   ```

   Use a current release from
   [OpenClaw's releases](https://github.com/openclaw/openclaw/releases)
   rather than `latest`, so the version only changes when you choose.

   *On Railway:* OpenClaw comes with the service's image. Check it:
   `openclaw --version`.

2. **On Railway only: add OpenClaw's secrets.** On Railway, OpenClaw's
   gateway and its commands read these from service variables:

   | Variable | What it is | Where the value comes from |
   | :--- | :--- | :--- |
   | `OPENCLAW_GATEWAY_TOKEN` | The **gateway token**: the password that `openclaw` commands use to talk to the gateway | Generate one (below) |
   | Your messaging platform's token variables | This agent's bot tokens, under the names OpenClaw's guide for your platform gives, for example `TELEGRAM_BOT_TOKEN`, or `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` | Your platform (2.1) |

   1. **Generate the gateway token.** On your own computer, run:

      ```bash
      openssl rand -hex 32
      ```

      It prints 64 random characters. On Windows without `openssl`, use
      PowerShell:
      `[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`.
      You don't need to keep it: nothing in this guide asks you to type it.

   2. **Add each secret.** In the Railway website, open the service →
      **Variables** → **New Variable**. Enter the name, paste the value, and
      click **Add**.

   3. **Seal each secret.** Open the ⋮ menu on its row and choose **Seal**.
      Railway then never shows the value again in its website, API or CLI.
      The running service, and a shell in it, still see it. Sealing can't be
      undone; to change a sealed value, delete the variable and add it again.

   4. **Deploy** from the banner at the top of the canvas, and clear the
      values from your clipboard.

   5. **Check the shell sees them.** Open a new shell in the service and run:

      ```bash
      echo "${OPENCLAW_GATEWAY_TOKEN:+gateway token set}"
      ```

      It should print `gateway token set`. Check your messaging token
      variables the same way, for example
      `echo "${SLACK_BOT_TOKEN:+set}"`. This shows only whether a secret is
      there, never its value. If they're missing, the shell doesn't receive
      sealed values: delete the variables, add them again without sealing,
      and deploy.

3. **Sign in to the model.**

   *On a Linux VM or server:*

   ```bash
   openclaw onboard --install-daemon
   ```

   Onboarding also installs and starts the gateway, and creates the gateway
   token. It saves the token in OpenClaw's settings, so you never need to
   handle it.

   *On Railway:*

   ```bash
   openclaw onboard --mode local --no-install-daemon \
     --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
     --skip-channels
   ```

   These flags tell OpenClaw to read the gateway token from the
   `OPENCLAW_GATEWAY_TOKEN` variable (step 2) instead of creating its own.
   Every `openclaw` command in your shell reads the same variable, so they
   can all reach the gateway. Without it, they fail with "Missing gateway
   auth token". `--no-install-daemon` is there because Railway runs the
   gateway, and `--skip-channels` because step 4 connects your messaging
   app.

   In both cases, choose the model provider when asked. A ChatGPT/Codex
   subscription shows a URL and a code: open the URL on your computer and
   enter the code. For an API key, paste the key when asked.

   Onboarding asks **"What should we call the agent?"**. Your answer becomes
   the agent's id, for example `mpas-proposer`. Any name works; MPAS doesn't
   depend on it. Each machine or service runs only this one agent.

   **Check the gateway token** (Railway only). It should be a reference to
   the variable, not the token itself:

   ```bash
   openclaw config get gateway.auth.token
   ```

   It should show `"source": "env"` and `OPENCLAW_GATEWAY_TOKEN`. If it shows
   a long random string instead, onboarding stored the token in OpenClaw's
   settings file, where any agent tool that reads files could see it. Point
   it at the variable:

   ```bash
   openclaw config set gateway.auth.token '{"source":"env","provider":"default","id":"OPENCLAW_GATEWAY_TOKEN"}' --strict-json
   ```

   **Check the model.** Run `openclaw doctor`. If it reports an
   "Unknown model", onboarding chose a model your account can't use. List
   the ones you can, and pick one:

   ```bash
   openclaw models list --refresh --provider <provider>
   openclaw models set <model>
   ```

4. **Connect your messaging app.** Follow
   [OpenClaw's guide for your platform](https://docs.openclaw.ai/channels).
   Typically you install the platform's plugin if it needs one, then add the
   channel with `openclaw channels add`, and set who may talk to the agent.

   Wherever the guide has you supply a token:

   - *On a Linux VM or server:* read it into a shell variable first, so it
     isn't shown on screen or saved in your shell history, and pass the
     variable. For example, for Telegram:

     ```bash
     read -rs TOKEN    # paste the token, press Enter
     openclaw channels add --channel telegram --token "$TOKEN"
     unset TOKEN
     ```

   - *On Railway:* use the guide's option to read the token from an
     environment variable, so it stays in the sealed Railway variable
     (step 2) and never goes into OpenClaw's settings. For example, for
     Telegram: `openclaw channels add --channel telegram --use-env`.

   If OpenClaw asks **"Set up administration from your own chat account?"**,
   it is asking who the agent's **command owner** is (step 7 explains).
   Either answer **Yes**, choose **Set up my operator account** and enter
   your own personal user ID, or skip it: step 7 sets it either way.

5. **Start the gateway.**

   *On a Linux VM or server:* onboarding already started it. Restart it so
   it picks up the messaging connection:

   ```bash
   openclaw gateway restart
   ```

   *On Railway:* the service is still running `sleep infinity` from setup.
   Open the service → **Settings** → **Deploy** → **Custom Start Command**,
   and delete the command, leaving the field empty. The image's own command
   then starts the gateway. Click **Deploy** on the banner.

6. **Talk to it in the terminal.** Before involving the messaging app,
   check the agent and the model work:

   ```bash
   openclaw tui
   ```

   This opens a chat with the agent in your shell. Type
   "Reply with exactly: online" and press Enter. It should answer. Press
   Ctrl+C to leave. If it says "Missing gateway auth token", see the
   troubleshooting table.

   The gateway needs a minute after it starts or restarts. Until it's ready,
   `openclaw tui` fails with only "The CLI command failed". Check it's ready
   first:

   ```bash
   curl -s http://127.0.0.1:18789/readyz
   ```

   To see the real reason for any `openclaw` failure, run the command again
   with `OPENCLAW_DEBUG=1` in front, for example `OPENCLAW_DEBUG=1 openclaw tui`.

7. **Make yourself the command owner.** OpenClaw separates two kinds of
   access:

   | | Who | Can |
   | :--- | :--- | :--- |
   | **Chat access** | Users you allow (step 8) | Talk to the agent |
   | **Command owner** | Accounts listed in `commands.ownerAllowFrom` | Also administer the agent from the messaging app: restart and update it, approve shell commands it asks to run, and, if enabled, change its settings, MCP servers and plugins |

   Set the owner to your own user ID on the messaging platform (on Slack,
   your member ID), never a bot's or anyone else's:

   ```bash
   openclaw config set commands.ownerAllowFrom '["slack:U0123ABCD"]' --strict-json
   openclaw config get commands.ownerAllowFrom
   ```

   Do this before step 8. If no owner is set, OpenClaw makes the first
   sender you approve in step 8 the owner, and on the Maintainer that must
   never be the Proposer's bot or anyone who doesn't administer this agent.
   Step 11 then turns off most of what an owner can do from chat.

8. **Allow yourself to chat with the agent.** If the agent already answers
   you, you're allowed; skip this step. Otherwise OpenClaw asks new users
   to pair: send your bot any message in the messaging app, and OpenClaw
   replies with a short pairing code. In the shell:

   ```bash
   openclaw pairing list <platform>
   openclaw pairing approve <platform> <CODE>
   ```

   For example, `openclaw pairing approve slack 4F7K2Q`. Use the code the
   bot sent, not a user ID. Codes expire after an hour.

9. **Check:** message the bot in your messaging app: "Reply with exactly:
   online". It should answer.

10. **Optional: limit the agent's tools.** What keeps MPAS in force is that
   this machine holds **no credentials** for the governed applications (Part
   7). Without them, even an agent with a full shell can't change those
   applications. Limiting tools is extra protection against mistakes and
   prompt injection. To allow only reading files plus the MPAS tools:

   ```bash
   openclaw config set tools.profile minimal
   openclaw config set tools.elevated.enabled false
   openclaw config set tools.allow '["read"]' --strict-json
   ```

   Do this before Part 3 or 5: `mpas` adds its tools to `tools.allow` only
   if the list already exists. Restart the harness afterwards
   ([how](#24-restarting-the-harness)).

   Limiting tools also stops anyone chatting with the agent from asking it
   to download and install skills or other software: that needs shell and
   file-writing tools, whoever asks.

11. **Recommended: turn off administration from chat.** You are the agent's
    command owner (step 7), and a command owner can administer the agent
    from the messaging app. OpenClaw leaves the most powerful owner commands
    off by default (changing settings, MCP servers or plugins, and running
    shell commands), but turns on restart, update, and approving shell
    commands the agent asks to run. Administer the agent through the shell
    instead, and turn chat administration off. Setting the defaults
    explicitly keeps them off if a later version changes them:

    ```bash
    openclaw config set commands.config false
    openclaw config set commands.mcp false
    openclaw config set commands.plugins false
    openclaw config set commands.debug false
    openclaw config set commands.bash false
    openclaw config set commands.restart false
    openclaw config set tools.elevated.enabled false
    ```

    Restart the harness afterwards. Keep yourself as the owner anyway: if no
    owner is set, the next `openclaw pairing approve` quietly makes that
    sender the owner. This step matters most on the Maintainer.

### 2.3 Hermes

1. **Install Hermes.**

   *On a Linux VM or server:*

   ```bash
   curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
   . ~/.bashrc
   ```

   The installer may stop and print a command that needs administrator
   rights. If it does: type `exit` to return to your admin user, run the
   printed command there, then switch back to the agent's user
   (`sudo -iu <user>`) and run the installer again.

   *On Railway:* Hermes comes with the service's image. Check it:
   `hermes --version`.

2. **Sign in to the model.**

   ```bash
   hermes model
   ```

   Choose a provider. A ChatGPT/Codex subscription shows a URL and a code to
   enter on your computer. For an API key, paste it when asked.

3. **Set the working folder**, where Hermes reads its instructions file
   (`AGENTS.md`):

   ```bash
   mkdir -p "${HERMES_HOME:-$HOME/.hermes}/workspace"
   hermes config set terminal.cwd "${HERMES_HOME:-$HOME/.hermes}/workspace"
   ```

   The folder stays empty for now. Hermes doesn't create `AGENTS.md`; you
   create it in Part 3 or 5, with the agent's MPAS role.

4. **Talk to it in the terminal.** Check the agent and the model work:

   ```bash
   cd "${HERMES_HOME:-$HOME/.hermes}/workspace" && hermes chat
   ```

   Type "Reply with exactly: online" and press Enter. It should answer.
   Press Ctrl+C to leave. Start `hermes chat` from the working folder: in
   the shell, Hermes reads `AGENTS.md` from the folder you start it in. The
   gateway always uses the working folder from step 3.

5. **Connect your messaging app.**

   ```bash
   hermes gateway setup
   ```

   Choose your platform. Paste the tokens it asks for, and enter the user IDs
   allowed to talk to the agent; Hermes ignores everyone else. Hermes's
   [guide for your platform](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)
   explains where each value comes from. The wizard saves them in Hermes's
   settings file (`.env` in the Hermes home), which is on the volume on
   Railway, so Hermes needs no Railway variables for them.

6. **Start the gateway.**

   *On a Linux VM or server:*

   ```bash
   hermes gateway install
   hermes gateway start
   hermes gateway status
   ```

   *On Railway:* first give Hermes ownership of its files (see
   [Hermes file ownership on Railway](#hermes-file-ownership-on-railway)):

   ```bash
   chown -R hermes:hermes /opt/data
   ```

   Then open the service → **Settings** → **Deploy** → **Custom Start
   Command**, and replace the setup command with:

   ```
   /opt/hermes/docker/entrypoint-dispatch.sh gateway run
   ```

   Click **Deploy** on the banner. Keep the
   `/opt/hermes/docker/entrypoint-dispatch.sh` part: it starts Hermes the way
   its image intends, supervised and as its own `hermes` user. `gateway run`
   on its own fails, and `hermes gateway run` runs it as root.

7. **Check:** message the bot in your messaging app: "Reply with exactly:
   online". It should answer. If it doesn't, run `hermes doctor`.

8. **Optional: limit the agent's tools.** As with OpenClaw, the real
   protection is that the machine holds no application credentials. To limit
   tools as well, run `hermes tools` and turn off the toolsets the role
   doesn't need.

### 2.4 Restarting the harness

Later steps say "restart the harness" after a change. This is how:

| Host | OpenClaw | Hermes |
| :--- | :--- | :--- |
| Linux VM or server | `openclaw gateway restart` | `hermes gateway restart` |
| Railway | From your computer: take the service's SSH command (right-click the service → **Copy SSH Command**), change `ssh` to `restart`, and add `--yes`. Or right-click the service → **Restart**. | Same |

On Railway, the gateway is the container's main program, not an installed
service, so `openclaw gateway restart` and `hermes gateway restart` have
nothing to restart there. OpenClaw says so with "Gateway restart failed:
Error: service management skipped: non-default state dir or config path";
that is expected, not a problem with your setup. Restarting the Railway service restarts the
container. Two Railway terms:

- **Restart** reruns the same container. Use it after changing harness or
  MPAS settings.
- **Redeploy** (or **Deploy**, after a settings change) starts a new
  container from the image, with the same volume. Railway needs it after you
  change variables or the start command. Anything outside the volume is
  lost.

#### Hermes file ownership on Railway

The Railway shell runs as root, but Hermes runs as its own `hermes` user, and
it can't read files root creates with private permissions, such as the MPAS
signing key. Hermes's own commands switch users by themselves; other
commands, including `mpas`, don't. So on Railway, after running such
commands and before restarting Hermes, run:

```bash
chown -R hermes:hermes /opt/data
```

OpenClaw on Railway needs nothing like this: the shell and the gateway both
run as root.

### 2.5 Where things are

Parts 3 and 5 use these paths. They are written so the same command works
on Linux and on Railway.

| | OpenClaw | Hermes |
| :--- | :--- | :--- |
| `--harness` flags for `mpas` | `--harness openclaw` | `--harness hermes --harness-home "${HERMES_HOME:-$HOME/.hermes}"` |
| Instructions file | `${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}/AGENTS.md` | `${HERMES_HOME:-$HOME/.hermes}/workspace/AGENTS.md` |
| Skills folder | `${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}/skills` | `${HERMES_HOME:-$HOME/.hermes}/skills` |
| MPAS account | `${MPAS_HOME:-$HOME/.mpas}` | Same |

**Part 2 is done when** the bot answers you, and still answers after you
restart the harness.

---

## Part 3 — Set up the Maintainer

At the end of this part, the Maintainer has its own signing key and can
review, approve and reject Actions from your messaging app.

1. **Open a shell** as the Maintainer's user (Part 1).

2. **Install the `mpas` command.**

   ```bash
   npm install -g @oma3/mpas-cli@alpha
   mpas --help | head -3
   ```

3. **Create the Maintainer account.** Use your Coordination URL and your
   harness's flags from [Where things are](#25-where-things-are):

   ```bash
   mpas init maintainer --coordination https://coordination.example.org --harness openclaw
   ```

   ```bash
   mpas init maintainer --coordination https://coordination.example.org --harness hermes --harness-home "${HERMES_HOME:-$HOME/.hermes}"
   ```

   The command:
   - creates the signing key in the MPAS account (`keys/signing-key.json`);
   - prints the Maintainer's **DID** (`did:jwk:...`). Write it down;
   - registers the `mpas-coordination` MCP server with the harness. This
     gives the agent its review tools;
   - on Hermes, installs the `mpas-maintainer` skill;
   - prints a **role preamble**: a short block starting with
     `## Prime Directive — MPAS Maintainer`. You need it in step 5.

4. **Install the skill** (OpenClaw only; Hermes already has it). The skill
   explains to the agent how MPAS review works.

   ```bash
   mkdir -p "${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}/skills"
   cp -R "${MPAS_HOME:-$HOME/.mpas}/skills/mpas-maintainer" "${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}/skills/"
   ```

5. **Tell the agent its role.** The agent reads its instructions file
   (`AGENTS.md`) at the start of every conversation. Add the role preamble to
   it: it tells the agent it is the Maintainer and points it to the skill.
   `mpas` never edits this file itself.

   The file doesn't exist yet; the command below creates it. Run the line
   for your harness, paste the preamble that step 3 printed,
   press Enter, then press Ctrl+D. Paste only the lines between
   ```` ```markdown ```` and ```` ``` ````, not those two lines:

   ```bash
   cat >> "${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}/AGENTS.md"
   ```

   ```bash
   cat >> "${HERMES_HOME:-$HOME/.hermes}/workspace/AGENTS.md"
   ```

   If you no longer have the preamble, it is the block under
   "Prime Directive" at the top of `SKILL.md` in the skills folder.

6. **Validate.**

   ```bash
   mpas config validate
   ```

7. **Restart the harness** ([how](#24-restarting-the-harness)). `mpas` may
   print `openclaw gateway restart`; on Railway, restart the service instead.
   On Railway
   with Hermes, first run `chown -R hermes:hermes /opt/data`
   ([why](#hermes-file-ownership-on-railway)).

8. **Register the DID.** If you lost it, `mpas config` prints it. Send only
   the DID, never a file; a `did:jwk` contains the public key, so it is all
   anyone needs.
   - **Coordination Service:** register it as its operator instructs.
   - **Credential Adapter:** if you run it, you add the DID in Part 4, step 7.
     Otherwise send it to whoever runs the adapter.

9. **Check in your messaging app.** Ask the agent: "List pending MPAS
   approvals." An empty list is the right answer: the Maintainer reached the
   Coordination Service and nothing is waiting. If it reports an
   authorization error, the DID isn't registered with the Coordination
   Service yet. Then ask "Which MCP tools do you have?" It should list
   `mpas_list_pending`, `mpas_review_action`, `mpas_approve` and
   `mpas_reject`.

**Part 3 is done when** the agent lists pending approvals, even an empty
list.

---

## Part 4 — Create the Credential Adapter

The Credential Adapter holds the real credentials for the application. It
receives each Action from the Proposer, checks its signatures and the
policy, and only then calls the application. Skip Parts 4 and 6 if someone
else runs it; get its Action URL and Verifier DID from them.

### How Actions reach it

The Proposer sends each Action to the **Action URL**. There are two ways to
set this up:

| | Relay | Direct |
| :--- | :--- | :--- |
| How it works | The Proposer sends Actions to a hosted **Action Relay**. The adapter collects them from the relay and sends results back. | The Proposer connects to the adapter itself. |
| Action URL | The relay's URL | The adapter's address, for example `http://127.0.0.1:7544` |
| Where the adapter can be | Anywhere. The Proposer and the adapter can be on completely separate machines and networks, such as a Proposer on Railway and an adapter on a private server. | Where the Proposer can reach it: the same machine (as a separate user), or the same private network |
| Inbound connections to the adapter | None. It only connects out. | From the Proposer only |
| Needs | A relay provider. It can be the same provider as your Coordination Service, or a different one. | Nothing extra |

**Use a relay** unless the Proposer and the adapter share a machine or a
private network. It is the most flexible: you can move either one later
without changing the other's network. **Use direct** when they are on the
same machine or private network: there's no relay to set up, and nothing
goes over the internet.

Never expose a direct-mode adapter to the public internet.

### Where to run it

Give the adapter its own user, created as in
[Appendix A](#appendix-a--linux-vm-or-server), steps 1–4. It needs no
harness.

- **With a relay:** preferably on its own Linux machine, so no agent's user
  shares a machine with the credentials. The machine needs no inbound access
  except your admin path.
- **Direct, same machine as the Proposer:** a separate user on the
  Proposer's machine. Nothing is exposed to the network, but anyone with
  root on that machine can read the adapter's credentials.
- **Direct, private network:** its own machine on a network the Proposer can
  reach, with its port open to the Proposer only.

**Don't run the adapter on Railway** or a similar container platform. Use a
standard Linux machine. On a container platform, the adapter can't run
applications whose tools start with Docker, and anyone who can administer
the project can open a shell in it and read every credential.

### Steps

1. **Open a shell** as the adapter's user, and install `tmux` (as your admin
   user, if needed: `sudo apt install -y tmux`). Part 6 runs the adapter in
   it.

2. **Install the `mpas` command.**

   ```bash
   npm install -g @oma3/mpas-cli@alpha
   ```

3. **Create the adapter account.**

   *With a relay:*

   ```bash
   mpas init verifier --action https://relay.example.org --mode relay
   ```

   *Direct* (use the address the Proposer will connect to;
   `http://127.0.0.1:7544` on the same machine):

   ```bash
   mpas init verifier --action http://127.0.0.1:7544 --mode direct
   ```

   The command creates the adapter's signing key and prints its DID. This is
   the **Verifier DID** the Proposer needs. With a relay, also register the
   Verifier DID with the relay as its provider instructs, so the relay
   delivers this adapter's Actions to it.

4. **Add the application.** Open
   [mpas-applications/applications](https://github.com/oma3dao/mpas-applications/tree/main/applications)
   in your browser, click the application's folder, and copy the address
   from the address bar. It looks like
   `https://github.com/oma3dao/mpas-applications/tree/main/applications/railway`.
   The folder's name (here `railway`) becomes the application's name in
   `mpas`.

   ```bash
   mpas mcp add https://github.com/oma3dao/mpas-applications/tree/main/applications/<name>
   ```

   Before going on, check the application is genuine. The command prints the
   plugin's `artifactDid`. Compare it with `plugin.artifactDid` in the
   application's entry in [`application-registry/`](../../application-registry/).
   If they differ, stop.

   The command saves the plugin and a draft of the adapter's configuration
   for this application, then prints the next steps, including the command
   that starts the adapter. Keep that output; Part 6 uses it.

5. **Read the application's README** (the command prints its link). It says
   which credential the application needs and how to get one with the least
   access.

6. **Store the credential.** The README names the handle to use.

   *A token or API key:*

   ```bash
   read -rs TOKEN    # paste the token, press Enter
   printf '%s' "$TOKEN" | mpas credential set <handle>
   unset TOKEN
   ```

   *An OAuth sign-in* (for example Netlify):

   ```bash
   mpas oauth login --application-did <applicationDid> --no-browser
   ```

   Open the printed URL on your computer and sign in. The README gives the
   `applicationDid`.

   If the application starts its tool with Docker (the README says so, and
   the draft configuration shows `"command": "docker"`), Docker must be
   installed and usable by this user. Membership of the `docker` group gives
   a user root-level control of the machine, so run such an adapter on its
   own machine.

7. **Add the Maintainer.**

   ```bash
   mpas signer add --app <name> --maintainer <Maintainer DID> --label maintainer
   ```

8. **Give the Proposer what it needs:** the Action URL and the Verifier DID.
   `mpas config` prints both.

**Part 4 is done when** you have the Verifier DID and Action URL for the
Proposer, and the credential is stored.

---

## Part 5 — Set up the Proposer

The Proposer follows the same steps as the Maintainer, plus three things:
it needs the adapter's details, it adds the application, and its
instructions say how to reach the Maintainer.

1. **Open a shell** as the Proposer's user, and install the `mpas` command
   ([Part 3](#part-3--set-up-the-maintainer), steps 1–2).

2. **Create the Proposer account.** Use the Coordination URL, and the Action
   URL (the relay's URL, or the adapter's address) and Verifier DID from
   Part 4:

   ```bash
   mpas init proposer \
     --coordination https://coordination.example.org \
     --action https://relay.example.org \
     --verifier-did did:jwk:...
   ```

   It creates the key and prints the Proposer's **DID**. Write it down.

3. **Add the application.** Use the same folder URL as the adapter (Part 4,
   step 4), and check the printed `artifactDid` the same way.

   ```bash
   mpas mcp add https://github.com/oma3dao/mpas-applications/tree/main/applications/<name> --harness openclaw
   ```

   ```bash
   mpas mcp add https://github.com/oma3dao/mpas-applications/tree/main/applications/<name> --harness hermes --harness-home "${HERMES_HOME:-$HOME/.hermes}"
   ```

   The command saves the plugin and the bridge config, registers the
   application's MCP server (`<name>-mpas`) with the harness, installs the
   `mpas-proposer` skill on Hermes, and prints the Proposer's role preamble.
   The agent then sees the application's tools, but every call goes through
   MPAS.

   > **Until application bridges are published on npm,** this command stops
   > with "The bridge package ... is not published on npm". The plugin and
   > bridge config are saved, but the MCP server isn't registered. Do
   > [Appendix C](#appendix-c--proposer-bridge-before-npm-publication), then
   > continue with step 4.

4. **Install the skill** (OpenClaw only; Hermes already has it):

   ```bash
   mkdir -p "${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}/skills"
   cp -R "${MPAS_HOME:-$HOME/.mpas}/skills/mpas-proposer" "${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}/skills/"
   ```

5. **Tell the agent its role, and how to reach the Maintainer.** Add two
   things to the instructions file (paths in
   [Where things are](#25-where-things-are)):

   - the role preamble that step 3 printed. It tells the agent it is the
     Proposer and points it to the `mpas-proposer` skill;
   - a section saying what to do when an Action needs approval, using the
     option you picked in 2.1.

   Run the `cat >>` line for your harness from Part 3, step 5. Paste the
   preamble, then one of the sections below (edited for your setup), press
   Enter, then Ctrl+D.

   *The Proposer messages the Maintainer:*

   ```markdown
   ## Notifying the Maintainer
   When an MPAS Action needs approval, post in <channel> and mention the
   Maintainer (<exact mention, for example <@U0123ABCD> on Slack>):
   "MPAS Action <Action ID> needs your review. Tool: <tool>. Target:
   <what it changes>. Reason: <why>."
   Then wait. Don't submit more governed Actions for the same goal until it
   is approved or rejected.
   ```

   *The Proposer tells you:*

   ```markdown
   ## Notifying the Maintainer
   When an MPAS Action needs approval, tell the user: "MPAS Action
   <Action ID> needs the Maintainer's review. Tool: <tool>. Target: <what it
   changes>. Reason: <why>." The user forwards it to the Maintainer.
   Then wait. Don't submit more governed Actions for the same goal until it
   is approved or rejected.
   ```

   *The Maintainer checks on a schedule:* use the "tells you" section, so you
   know what is waiting.

6. **Validate.**

   ```bash
   mpas config validate <name>
   ```

   On OpenClaw with limited tools (2.2, step 10), also check that
   `"<name>-mpas__*"` is in the list printed by
   `openclaw config get tools.allow`.

7. **Restart the harness** ([how](#24-restarting-the-harness)). `mpas` may
   print `openclaw gateway restart`; on Railway, restart the service instead.
   On Railway
   with Hermes, first run `chown -R hermes:hermes /opt/data`
   ([why](#hermes-file-ownership-on-railway)).

8. **Check in your messaging app.** Ask "Which MCP tools do you have?" It
   should list the application's tools and **no** `mpas_approve` or
   `mpas_reject`.

9. **Register the DID** with the Credential Adapter (Part 6, step 1, or send
   it to whoever runs the adapter) and with the Coordination Service, as for
   the Maintainer.

**Part 5 is done when** the agent lists the application's tools.

---

## Part 6 — Start the Credential Adapter

Skip this part if someone else runs the adapter. Open a shell as the
adapter's user.

1. **Add the Proposer.**

   ```bash
   mpas signer add --app <name> --proposer <Proposer DID>
   mpas signer list --app <name>
   ```

   The list should show both DIDs and no placeholders.

2. **Validate, then make the configuration live.**

   ```bash
   mpas config validate <name>
   ```

   When it passes, it prints the command that moves the draft into place.
   Typically:

   ```bash
   mv ~/.mpas/config/drafts/<name>-adapter-config.json ~/.mpas/config/
   ```

3. **Start the adapter** in a `tmux` session, so it keeps running after you
   disconnect:

   ```bash
   tmux new -s mpas-adapter
   ```

   Inside it, run the `mpas adapter start` command that Part 4, step 4
   printed. With a relay, it looks like this, with your relay URL and a
   state file named for it:

   ```bash
   mpas adapter start \
     --config-dir ~/.mpas/config \
     --credential-dir ~/.mpas/credentials \
     --adapter-key ~/.mpas/keys/signing-key.json \
     --journal-path ~/.mpas/journal/dispatch-ledger.jsonl \
     --verifier-relay-url https://relay.example.org \
     --verifier-relay-state ~/.mpas/journal/verifier-relay-<id>.json
   ```

   Direct mode uses the same command without the two `--verifier-relay`
   lines. It listens on `127.0.0.1:7544`, which only the same machine can
   reach. On a private network, add `--host <this machine's private IP>`.

   If you no longer have the printed command, `mpas config` prints it again.
   It then offers to change settings; press Enter to keep each one.

   The adapter shows what it knows about the application's plugin and asks
   whether to use it. Review it and type `y`. Then detach from `tmux` with
   Ctrl+B, then D. The adapter keeps running.

   The adapter only accepts the plugin when someone answers in a terminal.
   After a reboot, start it again the same way.

4. **Check it.**

   *With a relay:* before detaching, look for a log line with
   `"event":"connected"`: the adapter reached the relay. If you see
   `disconnected` or errors instead, check the relay URL and that the relay
   knows the Verifier DID (Part 4, step 3).

   *Direct:* from the Proposer's machine, check it can reach the adapter at
   the Action URL:

   ```bash
   curl -s http://127.0.0.1:7544/mpas/v1/health
   ```

   To see the adapter again: `tmux attach -t mpas-adapter`.

**Part 6 is done when** the adapter is running and connected to the relay,
or reachable from the Proposer.

---

## Part 7 — Close setup access

MPAS works only if no agent has a way around it. Setup needed some of those
ways. Remove them now.

1. **No credentials for governed applications on agent machines.** This is
   the one that matters most. The Maintainer and Proposer must not hold API
   keys, tokens, OAuth sessions or Git write access for any application MPAS
   governs: not in environment variables, files, or the harness's settings.
   Only the Credential Adapter holds them. (The model provider's key is
   fine; it isn't a governed application.)

2. **No cloud credentials on agent machines.** On EC2, an agent machine has
   no IAM instance role, or the metadata service (IMDS) is blocked for the
   agent's user. Any process on the machine can fetch an instance role's
   credentials. If that cloud is an application MPAS governs, that bypasses
   MPAS completely. The same applies to other clouds' instance identities.

3. **No agent keeps admin access to the hosts.** If a coding agent created
   any machine or service, remove its access: its cloud or platform login,
   any MCP server for the platform, and any API tokens created for setup.
   Admin access to a host means reading every key and credential on it. For
   Railway, if an agent did Appendix B.2:
   - run `railway logout` in the account it used;
   - remove the Railway MCP server from its settings (for Claude Code,
     `claude mcp remove railway`) and delete any Railway skills that
     `railway setup agent` installed;
   - revoke any OAuth connection in Railway **Account Settings**;
   - delete any Railway tokens created for setup.

   If Railway, or any other host platform, is itself an application governed
   by MPAS, this is mandatory.

4. **Users can't escalate.** No agent's user is in the `sudo`, `wheel` or
   `docker` group, and no user can read another's `USER_HOME`. (The
   adapter's user may be in `docker` if an application needs it, which is
   one reason it has its own machine.)

5. **No inbound access** to any machine except your admin path (SSH or your
   platform's shell). The one exception is a direct-mode adapter on a
   private network: its port is open to the Proposer only, never to the
   internet. On Railway, each service → **Settings** → **Networking** lists
   no domain.

6. **Only the right people are admins.** Review who can SSH to each machine,
   use `sudo` on it, or administer it in your cloud or platform. On
   OpenClaw, `openclaw config get commands.ownerAllowFrom` lists only that
   agent's own administrators: never the other agent's bot, and never the
   Proposer's people on the Maintainer. On Railway,
   project → **Settings** → **Members** lists only people you trust with
   every agent in that project, since each of them can read every agent's
   key.

---

## Part 8 — Test the whole flow

1. Each agent answers in your messaging app after the harness restarts.
2. `mpas config validate` passes for each component.
3. The Maintainer lists pending approvals and has no application tools.
4. The Proposer lists the application's tools and no approval tools.
5. An Action the policy approves automatically completes.
6. An Action that needs approval becomes pending, and the Maintainer finds
   out (from the Proposer, from you, or on its schedule).
7. The Maintainer reviews that exact Action and approves or rejects it.
8. The Proposer gets the final result for its original task.
9. After each machine restarts (a reboot, or a Railway redeploy), the DIDs,
   model sign-ins, messaging connections, skills, instructions and MPAS
   tools are all still there, and you have started the adapter again.

For a scripted sequence, use
[Part 4 of the macOS guide](setup-macos.md#part-4--running-the-demo), with
these agents in place of the local terminals.

---

## Running it

### Updates

- Update the `mpas` command with `npm install -g @oma3/mpas-cli@<version>`,
  then restart the harness (or the adapter). The MCP servers that `mpas`
  registered run the installed command, so they pick up the new version.
- Pin versions in production: the harness, and the `mpas` command.
- To update a harness on Linux, install the new version. On Railway, change
  the image tag in the service's **Settings** → **Source**, then redeploy.
  Don't change files inside the image.
- Re-run Part 8 after any change to a harness, model, CLI, key, policy or
  network.

### Backups

Back up `USER_HOME` before any harness, CLI or key change. On Railway, use
the volume's backups: service → volume → **Backups**. The backup holds
private keys, and for the adapter, credentials. Protect it like the machine
itself: encrypt it, and store it where no other component's user can read
it.

### Rotating a key

Let pending Actions finish. Then run `mpas key rotate`. Register the new DID
with the adapter and the Coordination Service, then restart. `mpas key
rotate` prints the steps for the account's role. To avoid any gap, create
the new key first with `mpas key generate`, have it registered, then run
`mpas key rotate --use-key <file>`.

### Troubleshooting

| Symptom | Cause and fix |
| :--- | :--- |
| `mpas: command not found` | Install it (Part 3, step 2). On Railway, check `NPM_CONFIG_PREFIX` is set (Appendix B). |
| A file or setting disappears after a restart | It was written outside `USER_HOME`, or the harness doesn't see the same paths as your shell. |
| `openclaw gateway restart` or `hermes gateway install` fails with a bus error | `XDG_RUNTIME_DIR` isn't set, or linger isn't enabled. See Appendix A, steps 2–3. |
| The OpenClaw agent doesn't see its MPAS tools | You limited tools, and `tools.allow` is missing `mpas-coordination__*` or `<name>-mpas__*`. Add it with `openclaw config set tools.allow '[...]' --strict-json` and restart. Don't use `bundle-mcp`. |
| Hermes doesn't show its MPAS tools | Run `hermes mcp test mpas-coordination`. Check the `--harness-home` you gave `mpas` is the Hermes home Hermes really uses. Restart, then start a new conversation. |
| `openclaw` says only "The CLI command failed" | Run the same command with `OPENCLAW_DEBUG=1` in front to see why. Right after a start or restart, the gateway may not be ready yet: check `curl -s http://127.0.0.1:18789/readyz` and try again. |
| `Missing gateway auth token` (OpenClaw) | On Railway: `OPENCLAW_GATEWAY_TOKEN` isn't set, or onboarding didn't use it. Check it as in 2.2, step 2, then run the Railway `openclaw onboard` command in 2.2, step 3 again. On Linux: run `openclaw onboard --install-daemon` again. |
| The agent ignores you | OpenClaw: approve the pairing (2.2, step 8). Hermes: your ID isn't on the allowed list; run `hermes gateway setup` again. |
| The adapter declines the plugin | It was started without a terminal, or someone answered `n`. Start it in `tmux` (Part 6, step 3). |
| An Action never reaches the adapter | The adapter isn't running, isn't connected to the relay, or isn't reachable from the Proposer (Part 6, step 4). Or the Proposer's Action URL is wrong; fix it with `mpas config --action <url>`. |
| `ECONNREFUSED 127.0.0.1` | A URL is still the local default. Set the real Coordination or Action URL with `mpas config`. |
| `mpas mcp add` says the bridge isn't published | See [Appendix C](#appendix-c--proposer-bridge-before-npm-publication). |
| An agent can act without MPAS | It has a direct credential for the application. Remove it (Part 7, step 1). |
| Railway: a deployment exits right away | The gateway started before the agent was set up. Use the setup start command from Appendix B until 2.2, step 5 or 2.3, step 6. |
| Railway: OpenClaw can't write its files (`EACCES`) | `RAILWAY_RUN_UID=0` is missing. Add it and redeploy. |
| Railway: OpenClaw settings disappear after a redeploy | `HOME` or `OPENCLAW_HOME` isn't `/home/node`, or the volume isn't mounted there. |
| Railway: Hermes reports `executable gateway could not be found` | The start command is `gateway run` on its own. Use `/opt/hermes/docker/entrypoint-dispatch.sh gateway run`. |
| Railway: Hermes can't read the MPAS key or config | Files were created as root. Run `chown -R hermes:hermes /opt/data` and restart. |
| Railway: `mpas` disappears after a redeploy | `NPM_CONFIG_PREFIX` is missing, so it was installed outside the volume. Set it, redeploy, and install again. |
| Railway: `openclaw gateway restart` fails with "service management skipped: non-default state dir or config path" | Expected: there is no installed service in the container, and `HOME` deliberately points at the volume. Restart the Railway service instead (2.4). |
| Railway: a `*.railway.internal` hostname doesn't resolve | Private networking only works within one Railway project and environment. Use the public HTTPS URL. |

---

## Appendix A — Linux VM or server

This gets a Linux machine to the [starting point](#part-1--get-to-the-starting-point)
for one component. Repeat it for each component: on separate machines, or as
separate users on one machine. These steps assume Ubuntu or Debian and an
admin user that can run `sudo`.

1. **Lock down inbound traffic.** Allow nothing except SSH, or use your
   cloud's terminal access (for example AWS Session Manager) and allow
   nothing. On EC2, don't attach an IAM instance role to an agent machine
   (Part 7, step 2).

2. **Create the component's user.** This guide uses `mpas`. If several
   components share the machine, give each its own user, such as
   `mpas-maintainer`, `mpas-proposer` and `mpas-adapter`. The user must not be
   able to use `sudo`.

   ```bash
   sudo adduser --disabled-password --gecos "" mpas
   sudo chmod 700 /home/mpas
   sudo loginctl enable-linger mpas
   ```

   `chmod 700` keeps other users out of its home directory.
   `enable-linger` lets its programs keep running when nobody is logged in.

3. **Switch to that user**, and set up its shell:

   ```bash
   sudo -iu mpas
   ```

   ```bash
   cat >> ~/.bashrc <<'EOF'
   export USER_HOME="$HOME"
   export XDG_RUNTIME_DIR="/run/user/$(id -u)"
   EOF
   . ~/.bashrc
   ```

   `XDG_RUNTIME_DIR` lets this user manage its own background services
   (such as the harness's gateway) after `sudo -iu`.

4. **Install Node.js 22** for this user, with nvm:

   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   . ~/.bashrc
   nvm install 22
   node --version
   ```

To come back later: SSH to the machine as your admin user, then
`sudo -iu mpas`.

**You're at the starting point.** Go to [Part 2](#part-2--set-up-the-harness)
for an agent, or [Part 4](#part-4--create-the-credential-adapter) for the
Credential Adapter.

---

## Appendix B — Railway

This gets a [Railway](https://railway.com) service to the
[starting point](#part-1--get-to-the-starting-point) for the Maintainer or
the Proposer, then sends you back to Part 2. Railway isn't suitable for the
Credential Adapter; run it on a standard Linux machine (see Part 4).

On Railway, each agent is a **service** built from its harness's official
Docker image, with a **volume** for its files. The volume's mount path is
`USER_HOME`. Because the image already contains the harness, you choose the
harness here, when you create the service.

### One project, one service per agent

Put your agents in one Railway project, for example `mpas`, with one service
per agent, for example `maintainer` and `proposer`. Each service has its own
container and its own volume, so neither agent can read the other's files or
key, and you see all your agents in one place.

Keep in mind:

- **Project admins can reach every agent.** Anyone who can administer the
  project can open a shell in each service and read its signing key. If
  different people administer the Maintainer and the Proposer, give each
  agent its own project instead. The agents don't need to share a project:
  they talk through the Coordination Service and your messaging app, not to
  each other.
- **Services share a private network.** Services in one project can connect
  to each other's open ports. With the settings in this guide, neither
  harness opens one: OpenClaw's gateway listens only inside its own
  container, and Hermes's API server and dashboard are off. Keep it that way;
  don't change OpenClaw's `gateway.bind`, and don't turn on Hermes's API
  server or dashboard.
- **Volume limits.** Each service needs its own volume, and Railway limits
  volumes per project by plan (the Free plan allows one). Check your plan's
  limit, or use one project per agent.

### Settings for each harness

| Setting | OpenClaw | Hermes |
| :--- | :--- | :--- |
| Docker image | `ghcr.io/openclaw/openclaw:<version>`, OpenClaw's official image | `nousresearch/hermes-agent:<version>`, Hermes's official image |
| Version | A release tag, such as `2026.10.3`, from [OpenClaw's releases](https://github.com/openclaw/openclaw/releases). Don't use `latest`. | A version tag from [Docker Hub](https://hub.docker.com/r/nousresearch/hermes-agent/tags), such as `v0.21.6`, or a digest (`nousresearch/hermes-agent@sha256:…`), which Hermes recommends for exact deployments. Not every release gets a version tag. Don't use `latest` or `stable`, which move, or `rc.*` tags, which are release candidates. |
| Volume mount path (`USER_HOME`) | `/home/node` | `/opt/data` |
| Custom start command, for setup | `sleep infinity` | `/opt/hermes/docker/entrypoint-dispatch.sh sleep infinity` |
| Variables | `USER_HOME=/home/node`<br>`HOME=/home/node`<br>`OPENCLAW_HOME=/home/node`<br>`OPENCLAW_GATEWAY_PORT=18789`<br>`NPM_CONFIG_PREFIX=/home/node/.local`<br>`RAILWAY_RUN_UID=0` | `USER_HOME=/opt/data`<br>`MPAS_HOME=/opt/data/.mpas`<br>`NPM_CONFIG_PREFIX=/opt/data/.local` |
| Public domain | None | None |
| Memory | At least 2 GB available | At least 2 GB available |

Part 2 adds the rest: OpenClaw's two secret variables, and the start command
that runs the gateway.

Why these settings:

- **Official images.** Both come from the harness's own project, are built
  from its main repository, and have versioned releases you can pin. Neither
  adds a web setup page or proxy in front of the agent.
- **A pinned version, not `latest`.** With `latest`, any redeploy can
  silently move the agent to a new release, which can change its settings
  format, tools or defaults while it is running MPAS. Pin a tag, and update
  on purpose (see [Updates](#updates)).
- **The volume is `USER_HOME`.** Everything outside it is lost on the next
  deploy.
  - *OpenClaw* keeps its settings, model sign-in and workspace under the
    `node` user's home, `/home/node` (`.openclaw` and `.config/openclaw`).
    Mounting the volume there keeps all of it, and `HOME=/home/node` means
    `~/.mpas` and the npm cache land on the volume too. OpenClaw derives its
    state and workspace folders from `OPENCLAW_HOME`, so don't set
    `OPENCLAW_STATE_DIR` or `OPENCLAW_WORKSPACE_DIR`.
  - `OPENCLAW_GATEWAY_PORT` fixes the port the gateway listens on, so the
    gateway and the `openclaw` commands in your shell (such as
    `openclaw tui`) always agree on where to connect.
  - *Hermes* keeps its files at `/opt/data` (its `HERMES_HOME`). `MPAS_HOME`
    puts the MPAS account there too.
- **`RAILWAY_RUN_UID=0` (OpenClaw).** The OpenClaw image normally runs as its
  `node` user, but a Railway volume is owned by root, so `node` can't write
  to it. This runs the container as root, which is Railway's documented fix.
  The container is still the boundary between your agents.
- **Where `npm install -g` goes.** `NPM_CONFIG_PREFIX` puts global npm
  packages, including the `mpas` command, in the volume's `.local` folder,
  whose `bin` folder each image already has on its `PATH`. Without it,
  `mpas` would disappear on the next deploy.
- **The setup start command.** Neither harness can run its gateway before
  you sign in to a model, so the service starts idle (`sleep infinity`).
  Part 2 replaces it once the agent is set up. For Hermes, every start
  command begins with `/opt/hermes/docker/entrypoint-dispatch.sh`: Railway's
  custom start command replaces the image's entrypoint, and the dispatcher
  keeps Hermes's own startup.
- **No public domain.** The agents only make outbound connections.
- **One replica.** Railway doesn't allow replicas with volumes, and a
  redeploy has a short gap while the volume moves to the new container.

### B.1 Human: create the service in the Railway website

You need a Railway account (the Hobby plan or higher is recommended) and the
Railway CLI on your computer:

```bash
npm install -g @railway/cli
```

```bash
railway login
```

1. **Create the project** (first agent only). In the Railway dashboard, click
   **New Project** → **Empty Project**. Open the project's **Settings** and
   rename it, for example `mpas`. For each later agent, skip this step and
   open the existing project.

2. **Create the service.** In the project, click **Create** (or **+ New**) on
   the canvas, choose **Docker Image**, and enter the image from the table,
   for example `ghcr.io/openclaw/openclaw:2026.10.3`, and then hit the return key. Then click the new
   service, open its **Settings**, and rename it after its role, for example
   `maintainer` or `proposer`.

3. **Attach the volume.** Right-click the service on the project canvas →
   **Attach Volume**. (Or press ⌘K / Ctrl+K and search for "volume".) When
   Railway asks for the **mount path**, enter exactly:

   | Harness | Mount path |
   | :--- | :--- |
   | OpenClaw | `/home/node` |
   | Hermes | `/opt/data` |

   This must be the folder where the harness keeps its files. Don't use
   another path, such as `/data`: the volume would be empty and the agent
   would lose its setup on every redeploy.

4. **Set the setup start command.** Service → **Settings** → **Deploy** →
   **Custom Start Command**, and enter:

   | Harness | Start command |
   | :--- | :--- |
   | OpenClaw | `sleep infinity` |
   | Hermes | `/opt/hermes/docker/entrypoint-dispatch.sh sleep infinity` |

   This keeps the service idle until the agent is set up. Part 2 replaces
   it.

5. **Set the variables.** Open the service → **Variables** → **Raw Editor**,
   add these lines for your harness, and click **Update Variables**:

   *OpenClaw:*

   ```
   USER_HOME=/home/node
   HOME=/home/node
   OPENCLAW_HOME=/home/node
   OPENCLAW_GATEWAY_PORT=18789
   NPM_CONFIG_PREFIX=/home/node/.local
   RAILWAY_RUN_UID=0
   ```

   *Hermes:*

   ```
   USER_HOME=/opt/data
   MPAS_HOME=/opt/data/.mpas
   NPM_CONFIG_PREFIX=/opt/data/.local
   ```

   None of these is secret.

6. **Check there's no public domain.** Service → **Settings** →
   **Networking**. Railway doesn't add one for a Docker image; if one is
   listed, delete it.

7. **Deploy.** Railway collects your changes and shows a banner at the top
   of the canvas. Click **Deploy**. Then open the service → **Deployments**
   and wait until the newest deployment is **Active**. If it fails, open
   **View Logs**.

Continue with [B.3](#b3-check-the-starting-point).

### B.2 Agent: create the service with the Railway CLI

Use this instead of B.1 if a coding agent on your computer will create the
service. The agent uses the Railway CLI with your login. Railway's MCP
server (`railway setup agent`) can help, but its tools don't cover volumes or
the start command, so the agent needs the CLI either way.

Rules for the agent:

- It creates the project, service, volume, variables and start command from
  the table, and nothing else. It doesn't add secrets, sign in to a model,
  connect messaging, or install MPAS: those are Part 2 onwards, done by a
  person.
- Its Railway access is removed afterwards (Part 7).

Sign in to the Railway CLI yourself, then give the agent this prompt, filled
in for one agent:

```text
Use the Railway CLI (it is installed and I am logged in) to create one Railway
service for an MPAS agent.

- Project: <mpas>, in workspace <workspace>. Create it if it doesn't exist;
  otherwise add the service to it.
- Service name: <maintainer>
- Harness: <Hermes | OpenClaw>, image version <version>
- Create the service, volume, variables, start command and networking exactly
  as the "Settings for each harness" table in Appendix B of
  cli/guides/setup-shell.md says for that harness. The service must have no
  public domain.
- Deploy, wait for the deployment to succeed, and show me the deploy logs if
  it does not.
- Then do the checks in section B.3 and report the results.
- Stop there. Do not add secrets, set up the model or messaging, or install
  MPAS.
```

For reference, these are the commands for an OpenClaw service (Railway CLI
5.x; check flags with `railway <command> --help`). For Hermes, use its image,
mount path, variables and start command from the table.

```bash
railway init --name mpas --workspace <workspace>    # first agent only; later: railway link
railway add --image ghcr.io/openclaw/openclaw:<version> --service proposer \
  --variables "USER_HOME=/home/node" --variables "HOME=/home/node" \
  --variables "OPENCLAW_HOME=/home/node" --variables "OPENCLAW_GATEWAY_PORT=18789" \
  --variables "NPM_CONFIG_PREFIX=/home/node/.local" \
  --variables "RAILWAY_RUN_UID=0"
railway service link proposer
railway volume add --mount-path /home/node
railway environment edit --service-config proposer deploy.startCommand "sleep infinity"
railway redeploy --service proposer --yes
```

### B.3 Check the starting point

Open a shell in the service from your computer. Copy the command from the
Railway website (right-click the service → **Copy SSH Command**), or run:

```bash
railway ssh --project mpas --service maintainer
```

In the shell, run:

```bash
echo "$BASH_VERSION"
echo "$USER_HOME"
echo "$HOME"           # OpenClaw: should print /home/node
echo "$HERMES_HOME"    # Hermes: should print /opt/data
node --version
date > "$USER_HOME/.volume-check"
exit
```

You should see a bash version, the volume path, and Node 22 or later. Both
images include Node. If the variables are empty, the shell didn't get the
service variables: start each shell by `export`ing them from the table.

Restart the service, then check the file survived:

Take the SSH command you copied from Railway, change `ssh` to `restart`,
and add `--yes`:

```bash
railway restart --project=<project id> --environment=<environment id> --service=<service id> --yes
```

The confirmation names the service it restarted; check it's the one you
meant. The CLI then waits for the service to report healthy, which can take
a while or not finish. Press Ctrl+C if it keeps waiting: the restart has
already happened. To check, run the same command with `service status` in
place of `restart` (and without `--yes`); `Status: SUCCESS` means the
service is running. (Names work instead of IDs, as in
`railway restart --project mpas --environment production --service maintainer --yes`,
but `--environment` is required whenever you give `--project`.)

```bash
railway ssh --project mpas --service maintainer cat /opt/data/.volume-check
```

(Use `/home/node/.volume-check` on OpenClaw.) If the file is gone, the volume
is mounted at the wrong path. Fix that before you go on.

**You're at the starting point.** Go to
[Part 2](#part-2--set-up-the-harness).

---

## Appendix C — Proposer bridge before npm publication

The harness starts a Proposer's bridge from npm, and no application has
published its bridge yet. (The Maintainer isn't affected: its MCP server
ships inside `@oma3/mpas-cli`.) Until the bridges are published, build the
bridge under `USER_HOME` and register it yourself. Do this after Part 5,
step 3 has saved the plugin and bridge config, in the same shell.

1. **Build the bridge.** Use the same branch or tag as the application
   folder URL.

   ```bash
   NAME=<name>
   git clone --depth 1 https://github.com/oma3dao/mpas-applications "$USER_HOME/src/mpas-applications"
   cd "$USER_HOME/src/mpas-applications/applications/$NAME/bridge"
   npm ci && npm run build
   cd
   BRIDGE="$USER_HOME/src/mpas-applications/applications/$NAME/bridge/dist/index.js"
   BRIDGE_CONFIG="${MPAS_HOME:-$HOME/.mpas}/mcp-server-configs/$NAME-mcp-bridge-config.json"
   ```

2. **Register it with the harness.**

   *OpenClaw:*

   ```bash
   openclaw config set "mcp.servers.$NAME-mpas" "{\"command\":\"$(command -v node)\",\"args\":[\"$BRIDGE\",\"--config\",\"$BRIDGE_CONFIG\"]}" --strict-json
   ```

   If you limited tools (2.2, step 10), add `"<name>-mpas__*"` to the list
   that `openclaw config get tools.allow` prints, for example:

   ```bash
   openclaw config set tools.allow '["read", "<name>-mpas__*"]' --strict-json
   ```

   *Hermes:* add this under `mcp_servers:` in
   `${HERMES_HOME:-$HOME/.hermes}/config.yaml`. Replace each value with the
   output of `echo "$(command -v node)" "$BRIDGE" "$BRIDGE_CONFIG"`:

   ```yaml
   mcp_servers:
     <name>-mpas:
       command: <path to node>
       args:
         - <BRIDGE>
         - --config
         - <BRIDGE_CONFIG>
   ```

3. **Get the skill.** It ships inside the `mpas` package:

   ```bash
   cp -R "$(npm root -g)/@oma3/mpas-cli/dist/bundled/skills/mpas-proposer" "${MPAS_HOME:-$HOME/.mpas}/skills/"
   ```

   On Hermes, also copy it to `${HERMES_HOME:-$HOME/.hermes}/skills/`. Then
   continue with Part 5, step 4. The preamble is the block under
   "Prime Directive" at the top of the skill's `SKILL.md`.

When the bridge is published, run
`mpas mcp add <url> --name <name> --replace-config` with your harness flags.
It replaces this manual entry with the standard one.

---

## Appendix D — Coordination Service and Action Relay

These are two separate services, though one provider may offer both.

- **Coordination Service.** Holds Actions that are waiting for approval. The
  Maintainer and Proposer need its URL, and their DIDs must be registered
  with it.
- **Action Relay** (optional). Carries Actions from the Proposer to the
  Credential Adapter, and results back, so the two can be on different
  machines and networks. Its URL is the Action URL for both, and the
  Verifier DID must be registered with it. Without a relay, the Proposer
  connects to the adapter directly over the same machine or a private
  network (Part 4).

You can use commercial services that offer them, or run your own. There's no
`mpas` installer for either yet.

---

## Appendix E — Moving a hand-made setup

If a component was already set up by hand, with a key such as
`~/.mpas/keys/maintainer-key.json`, keep its DID rather than creating a new
identity:

1. Back up `USER_HOME` and let pending work finish.
2. Run `mpas init <role> --use-key <existing key file>` with the same flags
   as in Part 3, 4 or 5. The key is copied to `keys/signing-key.json`; the
   original file is left alone.
3. Run `mpas config validate`. It lists any bridge or signer config that
   still uses the old key file, and prints the steps to fix it. For a
   Proposer bridge, `mpas mcp add <url> --name <existing name>
   --replace-config` writes a new config. An existing Maintainer signer config
   is never overwritten: point its `agent.keyFile` at `keys/signing-key.json`
   yourself.
4. Restart, and run Part 8. Delete the old key file only after an Action has
   completed with the new layout.

---

## References

- [MPAS CLI: install and set up](../README.md#install-and-set-up)
- [Maintainer guide](maintainer.md), [Proposer guide](proposer.md),
  [Credential Adapter operator guide](credential-adapter.md)
- [macOS setup and demo](setup-macos.md)
- [Participant installer specification](../../docs/features/install-script/spec.md)
- OpenClaw: [channels](https://docs.openclaw.ai/channels),
  [cron](https://docs.openclaw.ai/cli/cron),
  [Docker](https://docs.openclaw.ai/install/docker),
  [official image](https://github.com/openclaw/openclaw/pkgs/container/openclaw)
- Hermes: [installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation),
  [messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging),
  [Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker)
- Railway: [volumes](https://docs.railway.com/reference/volumes),
  [start command](https://docs.railway.com/deployments/start-command),
  [CLI](https://docs.railway.com/reference/cli-api),
  [MCP server](https://docs.railway.com/ai/mcp-server)
