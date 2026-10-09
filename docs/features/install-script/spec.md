# MPAS Participant Installer

**Status:** Draft

**Created:** 2026-10-07

**Updated:** 2026-10-08

**Affects:** `examples/demo/src/cli/`, participant guides in `examples/demo/guides/`

**Companion:** [plan.md](./plan.md)

**SDK:** No protocol-SDK change is required. The installer calls the published `@oma3/mpas` key and DID helpers.

---

## 1. Purpose

Provide commands that prepare a Proposer, Maintainer, or Verifier account without cloning a repository or asking an agent to follow a setup guide.

`mpas init` creates the local MPAS directory, generates one signing key, and records the service URLs. Any role may also record the other participants' DIDs at init. A Maintainer init also registers the signer MCP server. `mpas config` changes saved URLs and DIDs, rotates the key when `--suite` is passed, and, for a Verifier, appends a DID to the matching signer group in each application config that already exists. `mpas mcp add` registers one Proposer application bridge, or, for a Verifier, installs one upstream MCP server and fills that server's signer groups from the stored DIDs.

## 2. Problem

Getting started currently means cloning `mpas` and `mpas-applications`, building from source, and pasting a long prompt into an agent harness. The prompt performs directory creation, key generation, JSON templating, and path substitution. Those steps are deterministic. An agent with filesystem access is a poor installer: it can mix roles, invent a DID exchange, or expose a private key.

Participants use different service URLs. A local demo uses loopback. SignerSet uses `https://api.signerset.com`. Another operator may use private URLs. Coordination and Action submission are separate URLs. The installer prompts for each one the role needs. Pressing return selects the localhost default for that prompt.

## 3. Goals

1. Add `mpas init`, `mpas config`, and `mpas mcp add` to the existing `mpas` executable.
2. Create `~/.mpas` (or `--home`) and one role key. Print only the public `did:jwk`.
3. Prompt separately for the Coordination URL and the Action URL. Pressing return selects that prompt's localhost default. The user types a full URL, including the scheme.
4. Write every Proposer bridge with `actionEndpoint.url` and `actionEndpoint.verifierDid`. The same shape is used for a local adapter and a relay. Do not write `adapter.url`.
5. Let each role record the other participants' DIDs at `init` or later with `mpas config`.
6. Change saved URLs, DIDs, and the signing key with `mpas config`. `init` does not rotate a key or replace saved URLs.
7. Register the Maintainer signer during `init`. Register each Proposer application bridge with `mpas mcp add`, using that harness's own CLI when it has one. On a Verifier, `mpas mcp add` installs one upstream MCP server into that application's deployment config and places stored DIDs into the proposer and maintainer signer groups.
8. Accept `--role` on every command. Detect the role from the home only when exactly one role key is present and `--role` was omitted.
9. Print the existing role preamble for the user to paste. Leave instruction files untouched.
10. Keep the process commands that exist today: `mpas adapter start`, `mpas coordination start`, and `mpas daemon start`.
11. Install the `mpas` command with npm.

## 4. Non-goals

- Changing the MPAS specifications or the `@oma3/mpas` protocol SDK.
- Publishing every application bridge. `mpas mcp add` uses a package name the registry already records.
- A Homebrew formula.
- A non-MCP CLI package command. `mpas mcp` is the MCP command group so a later command group can install other client packages.
- Detecting which harness is running, or offering a checkbox list of bridges.
- Editing `AGENTS.md`, `CLAUDE.md`, or any other instruction file.
- Installing skill directories.
- Adding more than one application in a single `mpas mcp add` invocation.
- Adding `mpas process start` or a new `mpas start` command. Those commands do not exist today.
- Starting the Credential Adapter, Coordination Service, or an agent gateway from `init`, `config`, or `mcp`.
- Exchanging DIDs, calling a portal, or creating SignerSet organization bindings.
- Storing upstream credentials given on the command line.
- Combining Proposer and Maintainer on one account by default.
- A `mpas doctor` connectivity check. That can be a later command.
- Editing approval rules, thresholds, match conditions, or signer groups other than `proposers` and the maintainer group. That is [oma3dao/mpas#6](https://github.com/oma3dao/mpas/issues/6).

## 5. Placement

The installer is participant tooling. It belongs in `oma3dao/mpas`, as commands on the reference `mpas` CLI under `examples/demo/src/cli/`.

It does not belong in `mpas-applications`, `mpas-coordination-server`, or a SignerSet-specific CLI. A hosted service is just a URL the user types. This feature does not treat any vendor host as a shortcut. The long-term package directory is `cli/`; moving the current tree is tracked separately and is not part of this feature.

## 6. Installing `mpas`

The supported install is npm. Homebrew is not part of this feature.

```sh
npm install -g @oma3/mpas-cli@alpha
mpas --help
```

`@oma3/mpas-cli` is the package this feature publishes. `@oma3/mpas` remains the protocol SDK and is not the command users install.

A one-shot `npx -y @oma3/mpas-cli@alpha` may run `init`. Harness config written by `mpas mcp add` must not depend on a transient `npx` cache path. It records the absolute path of the `mpas` binary that handled the command when that binary is a real install. When the command itself was started through `npx`, the harness entry uses `npx` with the same pinned package version.

## 7. Flags and Prompts

A supplied flag sets that value and skips its prompt. On a terminal, an omitted flag uses the Default column and asks only when Prompts is Yes. Pressing return accepts the default on first setup. When a saved value already exists, return keeps that value. A prompt whose default is none rejects an empty answer, except the DID rows, where empty leaves the value unset or unchanged.

A non-interactive run cannot prompt. Omitted rows with a default still use it. An omitted row that prompts exits nonzero before writing.

`init` asks only the Yes rows for that role. `mpas config` with no change flags, on a terminal, asks the Yes rows for `--role`, or for the single role key when `--role` is omitted. `mpas config` with one or more flags changes only those flags and does not ask about the others. Passing `--suite` rotates the key and does not ask for a suite.

| Parameter | Flag | Default | Prompts |
|---|---|---|---|
| MPAS home | `--home <dir>` | `$MPAS_HOME`, or `~/.mpas` | No |
| Key suite | `--suite Ed25519\|P-256` | `Ed25519` | No. `init` uses it for a new key. `config` uses it to rotate an existing key. |
| Coordination URL | `--coordination <url>` | `http://127.0.0.1:7545` | Yes, for a Maintainer or Proposer |
| Action URL | `--action <url>` | `http://127.0.0.1:7544` | Yes, for a Proposer or Verifier |
| Role | `--role proposer\|maintainer\|verifier` | The only role key in the home | Yes, when the home has more than one role key. Always accepted when supplied. |
| Verifier DID | `--verifier-did <did>` | None | Yes, for a Proposer. Empty leaves it unset. |
| Proposer DID | `--proposer-did <did>` | None | Yes, for a Verifier on `init` and `mpas config`. Repeatable. |
| Maintainer DID | `--maintainer-did <did>` | None | Yes, for a Verifier on `init` and `mpas config`. Repeatable. |
| Application | `--app <name>` | None | Yes, on Proposer or Verifier `mpas mcp add`. Empty is rejected. Not accepted by `init`. |
| Harness | `--harness <name>` | None | Yes, on Maintainer `init` and Proposer `mpas mcp add`. Empty is rejected. Not accepted for a Verifier. |
| Harness config location | `--harness-home <dir>` | The selected harness path in §13 | No |
| Plugin file | `--plugin <path>` | The registry plugin download | No |
| Deployment template | `--config-template <path>` | The registry template download | No. Verifier `mpas mcp add` only. |
| Replace existing app config | `--replace-config` | Off | No |

A URL flag or URL answer must include `http://` or `https://`. The command does not add a scheme. `api.signerset.com` is rejected; `https://api.signerset.com` is stored as typed. `localhost` and `local` still mean that prompt's default, which already includes its scheme and port. Clients append `/mpas/v1/...` themselves. These commands must not append that path.

`init` does not accept `--app`. Maintainer `init` does accept `--harness`. Verifier `init` accepts proposer and maintainer DIDs.

```text
mpas init maintainer [--coordination <url>] [--harness <name>]
mpas init proposer [--coordination <url>] [--action <url>] [--verifier-did <did>]
mpas init verifier [--action <url>] [--proposer-did <did>] [--maintainer-did <did>]

mpas config [--role <role>] [--suite Ed25519|P-256] [--coordination <url>] [--action <url>] [--verifier-did <did>]
mpas config [--role verifier] [--proposer-did <did>] [--maintainer-did <did>]

mpas mcp add [--role proposer] [--app <name>] [--harness <name>]
mpas mcp add [--role verifier] [--app <name>]

mpas adapter start
mpas coordination start
mpas daemon start
```

`--role` is optional when the home contains exactly one role key. It is required when detection cannot choose, including a home passed with `--home` that contains more than one role key. `--proposer-did` and `--maintainer-did` are repeatable.

## 8. Service URLs

Coordination and Action submission are different services. Which of them is asked, and which flags stay silent, is fixed by the table in §7. A first-time terminal session that omits the URL flags looks like this for a Proposer:

```text
Coordination URL (http://127.0.0.1:7545):
Action URL (http://127.0.0.1:7544):
Verifier DID:
```

The command does not ask where to put `~/.mpas`. `--home` remains available for tests and unusual layouts. `--role` remains available for every command so a non-default home does not have to be guessed.

Proposer bridge files use one shape. `actionEndpoint.url` is the Action URL. `actionEndpoint.verifierDid` is the Verifier DID. These files omit `adapter`. A bridge file is written only after the Verifier DID is known. This feature does not change the generated bridge, which already accepts that shape.

`mpas config --coordination` and `mpas config --action` replace the saved URLs and rewrite configs that already exist. Key rotation is a separate `mpas config --suite` action.

## 9. Role

`init` takes the role on the command line because it is creating that key: `mpas init proposer`.

`mpas config` and `mpas mcp add` accept `--role`. When `--role` is omitted and the home contains exactly one of `keys/proposer-key.json`, `keys/maintainer-key.json`, or `keys/adapter-key.json`, that file selects the role. The Verifier key file keeps the name `adapter-key.json` because that key signs Execution Receipts. The role name remains Verifier.

`--role` is how a caller selects a role when the home is not the default path, or when more than one role key is present. Detection is not required. More than one role key and no `--role` prompts on a terminal and exits nonzero when non-interactive. No role key means the command exits nonzero and tells the user to run `mpas init`.

Flags that belong to another role exit nonzero and change nothing. A Proposer cannot store `--proposer-did`. A Maintainer cannot take `--app`. A Verifier cannot take `--harness`.

## 10. What Each Command Writes

DIDs of other participants arrive out of band. `init` never waits for them and never fails because they are missing.

### 10.1 `mpas init`

Creates the home, generates the role key, stores the service URLs, and prints the public DID. Proposer init also stores a Verifier DID when one was entered.

| Role | Also writes at init |
|---|---|
| Maintainer | Signer config, and the signer MCP server in the chosen harness. |
| Proposer | The Verifier DID, when supplied. Bridges are added later with `mpas mcp add`. |
| Verifier | Proposer and Maintainer DIDs, when supplied. The per-application file is written later by `mpas mcp add`. |

Maintainer `init` is the only Maintainer command that registers an MCP server. There is one signer server for that account, so `mpas mcp add` does not apply to a Maintainer.

A second `init` for a role that already has a key always exits 0 and changes nothing. It does not prompt, it does not apply URL flags, DID flags, or `--suite`, and it does not rotate the key. It tells the user that this home is already initialized, then prints the existing public DID and the saved URLs and DIDs. It names `mpas config` as the command that changes them. A different role in the same home is still a first `init` for that role. The command says which other role keys already exist and creates only the new one.

### 10.2 `mpas config`

Requires an existing role key. It does not edit a harness.

- `--suite` rotates the key. The previous key file is moved aside, mode `0600`, and is not deleted. Configs that pointed at it are updated to the new file. The command prints the old DID and the new DID. Omitting `--suite` does not touch the key. `init` cannot rotate a key.
- Proposer: `--verifier-did` stores the designated Verifier DID. Repeating the stored DID is a no-op. A different DID replaces it.
- Verifier: `--proposer-did` and `--maintainer-did` append public DIDs. Repeating a stored DID is a no-op. When `config/<app>-adapter-config.json` already exists, the same command adds the DID to that file using the simple group rule in §10.4. It does not change `executionTarget`, `policies`, `defaultRequirement`, or any other signer group.
- `--coordination` and `--action` replace the saved URLs for the roles that use them.

Invalid DIDs exit nonzero and change nothing.

Verifier `init` and `config` do not create an application file and do not choose an upstream MCP server. Creating that file is Verifier `mpas mcp add`. Until that command has run, DID changes are stored on the account and applied to the signer groups when the application is added.

Credential material is not part of `init` or `config`. No command in this feature accepts a token flag.

### 10.3 `mpas mcp add`

One invocation adds one application. A Maintainer invocation exits nonzero and tells the user that `mpas init maintainer` already registers the signer.

Proposer:

The command registers the bridge through the harness's own CLI when that harness has one, so it does not invent a second config format or replace unrelated servers. OpenClaw uses `openclaw config set` for the one server key. A harness with no such CLI gets a merge of the one named server into its documented config file. Existing servers with other names are left in place. Replacing the same MPAS server name updates that entry only.

On a terminal, omitting `--harness` or `--app` follows §7. A non-interactive invocation requires those flags.

- Resolves one registry entry.
- Downloads `plugin.json`, or copies `--plugin`.
- Requires a Verifier DID already stored by init or `mpas config`. If it is missing, writes nothing for that app and exits nonzero with the config command to run.
- Writes `actionEndpoint.url` and `actionEndpoint.verifierDid`. Does not write `adapter.url`.
- Registers only `<app>-mpas`. Does not register the signer server.

Verifier:

This role has no agent harness. `--harness` exits nonzero. The command writes `config/<app>-adapter-config.json` and does two things to that file:

1. Integrate the upstream MCP server. Copy `executionTarget` from the deployment template: the command, arguments, and credential placeholders that launch that application's MCP server. Do not launch the server. Do not accept a credential value on the command line.
2. Place stored DIDs into the simple signer groups in §10.4. Point `plugin.path` at the local plugin copy. Leave `policies`, `defaultRequirement`, thresholds, match conditions, plugin DID, version, artifact DID, application DID, and execution profile unchanged.

Both writes are skipped, and the command exits nonzero, when either DID list is empty, or when the template does not have the simple groups in §10.4. The error names the `mpas config` invocation that records the missing DIDs, or [oma3dao/mpas#6](https://github.com/oma3dao/mpas/issues/6) when the template's groups are not the simple pair. An application config that already exists exits nonzero unless `--replace-config` is set. `--replace-config` rewrites that application file and never replaces a key. A second application is a second `mpas mcp add`.

After a successful write, print `mpas adapter start` with the config, credential, and adapter-key paths. Add `--verifier-relay-url` only when the Action URL is not the local adapter. Do not run that command.

### 10.4 Simple signer groups

The CLI does not ask how a DID relates to policy. A proposer DID is appended to `signerGroups.proposers`. A maintainer DID is appended to the maintainer group. Every added DID is also appended to `signerGroups.all` and to `signerKeys`, with label `Proposer` or `Maintainer`. A DID already present in that group is left as it is.

The maintainer group is `maintainers` when that key exists, and otherwise `approvers`, which is the name in the current application templates. The command does not create a group, rename a group, or add a DID to any other group, including `humanApprovers`. It does not change which group `defaultRequirement` names.

If `proposers` is missing, or neither `maintainers` nor `approvers` is present, the command exits nonzero and changes nothing. Richer policy editing, including a local web view of what the policy says, is [oma3dao/mpas#6](https://github.com/oma3dao/mpas/issues/6). This feature does not add `mpas policy`.

## 11. Files

Under the MPAS home:

| Path | Role | Mode |
|---|---|---|
| `keys/proposer-key.json` | Proposer | `0600` |
| `keys/maintainer-key.json` | Maintainer | `0600` |
| `keys/adapter-key.json` | Verifier | `0600` |
| `services.json` | All roles | coordination URL, action URL, and stored Verifier DID |
| `mcp-server-configs/maintainer-signer-config.json` | Maintainer | config |
| `mcp-server-configs/<app>-mcp-bridge-config.json` | Proposer | config |
| `plugins/<app>-plugin.json` | Proposer and Verifier | plugin copy |
| `config/<app>-adapter-config.json` | Verifier | deployment config |

Create missing home directories with mode `0700`. Private keys and anything under `credentials/` are `0600`. Stdout may contain the public DID, config paths, and the paste block. Stdout and stderr must not contain a private JWK or credential value.

Generated configs use absolute paths. MCP servers are not launched through a shell and do not expand `~`.

### 11.1 Maintainer config

```json
{
  "agent": {
    "did": "did:jwk:...",
    "keyFile": "/absolute/path/keys/maintainer-key.json"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  }
}
```

The coordination URL comes from `--coordination`.

### 11.2 Proposer config

Every Proposer bridge config uses `actionEndpoint` and omits `adapter`. `actionEndpoint.url` is the Action URL. `actionEndpoint.verifierDid` is the Verifier DID. `additionalRecipients` is omitted. This feature does not accept extra recipients.

`target.applicationDid` comes from the selected registry entry. `coordination.url` comes from `--coordination`. `workflow.dbPath` is `$MPAS_HOME/workflows/<app>.db`.

## 12. How a Proposer Bridge Is Installed

`mpas mcp add` does not clone `mpas-applications` and does not compile a bridge.

1. The application registry names the bridge's npm package and version.
2. The command downloads only `plugin.json` into `plugins/`.
3. The harness entry starts that npm package when the agent launches the server:

```text
npx -y <bridge-package>@<version> --config <absolute-bridge-config>
```

npm downloads the bridge at that launch. The command must resolve the package metadata enough to confirm the name and version exist. Unit tests inject that lookup and do not call the network.

If the registry entry has no published package, the command still stores the plugin and bridge config when the rest of the inputs are present, and harness registration fails with the package name it could not find. It must not point the harness at a source checkout's `dist/` path.

The Maintainer server is different. It is the signer shipped inside `@oma3/mpas-cli`, not an application bridge. Its harness command is that installed `mpas` binary, or the pinned `npx` form from §6, with the signer config path.

## 13. Harness Registration

An MCP server entry in a harness is a record that tells the agent which program to start. Maintainer `init` writes the signer entry. Proposer `mpas mcp add` writes one application-bridge entry. Neither command replaces servers it did not create. Verifier `mpas mcp add` does not write a harness entry. It writes the adapter deployment config for that upstream MCP server.

These commands do not inspect the parent process or guess among installed harnesses. When the harness has a CLI for adding one MCP server, that CLI is the write path. OpenClaw is `openclaw config set` for the one server key. A harness without that CLI gets a merge of the one named server into the file below. Other server names stay as they are.

| Name | Config written | Instruction file named in the paste hint |
|---|---|---|
| `codex` | `config.toml` under the harness home | `AGENTS.md` |
| `openclaw` | one server key through `openclaw config set` | workspace `AGENTS.md` |
| `claude-desktop` | `claude_desktop_config.json` on macOS | the desktop app's project or user instructions |
| `hermes` | `mcp_servers` in `~/.hermes/config.yaml` | `AGENTS.md` |
| `cursor` | `mcpServers` in `~/.cursor/mcp.json` | `AGENTS.md` |

Hermes uses the stdio shape documented by Hermes: `command` plus `args` under `mcp_servers`. See the [Hermes MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp). Cursor uses `mcpServers` in `~/.cursor/mcp.json`.

The default Codex home is role-specific: `~/.codex-proposer` or `~/.codex-maintainer`. The installer does not write `~/.codex` unless `--harness-home` points there. Claude Desktop uses `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS. On any other operating system, that harness prints the JSON and does not guess a path.

Registration adds or replaces one named server and preserves unrelated servers. A second Proposer application is a second `mpas mcp add`.

An unknown harness name, or a requested write that cannot be completed, exits nonzero after any identity, service URL, or application config already saved. The error includes the server name, command, and absolute arguments.

## 14. Instruction Text

After a successful Proposer init, print a fenced block containing only that role's existing prime directive from `integrations/skills/mpas-proposer/SKILL.md`. Name `AGENTS.md`, the Claude Desktop instruction field, and the OpenClaw workspace file, because Proposer init does not select a harness.

After a successful Maintainer init, print the same kind of block from `integrations/skills/mpas-maintainer/SKILL.md` and name the instruction file for the harness that was just selected.

`init verifier` prints the Verifier DID and the next operator steps. It prints no agent preamble.

These commands must not create or edit those instruction files, and they must not copy a skill directory.

## 15. Starting Processes

This feature does not add process commands. The CLI already has:

| Command | Process |
|---|---|
| `mpas adapter start` | Credential Adapter only. This is the Verifier process. |
| `mpas coordination start` | Coordination Service only. |
| `mpas daemon start` | Credential Adapter and Coordination Service together, for a local demo. |

`mpas daemon start` rejects a hosted relay URL. Hosted Verifier mode remains `mpas adapter start --verifier-relay-url <url>`. There is no `mpas process start` command, and this feature does not add one.

These commands do not start an OpenClaw gateway or any other agent harness.

`init`, `config`, and `mcp` do not call any start command.

## 16. Idempotency and Errors

- A second `init` for the same role exits 0, changes nothing, and states that the home is already initialized. URL flags on that second run are ignored. `mpas config` is the command that changes them.
- `config` appends new DIDs. It rewrites a key only when `--suite` is passed, and then it keeps the previous key file.
- `mpas mcp add` for a Verifier application that already has a config exits nonzero unless `--replace-config` is set. `--replace-config` never replaces a key file.
- Invalid DIDs, unknown suites, unknown apps, and unknown URLs exit nonzero before writing that command's new files.
- A harness failure does not roll back a key, service URL, or valid application config.
- Exit 0 means the requested command completed. A requested harness write or relay bridge that did not complete is exit nonzero.

## 17. Acceptance Criteria

- A terminal `mpas init proposer` with no URL flags prompts for Coordination, Action, and Verifier DID, and does not prompt for the home directory. Empty URL answers save `http://127.0.0.1:7545` and `http://127.0.0.1:7544`. An empty Verifier DID answer leaves that DID unset. The key is written under `~/.mpas` unless `--home` or `$MPAS_HOME` is set. The command prints the DID and writes no bridge config.
- A non-interactive Proposer `init` without `--coordination` and `--action` exits nonzero and writes nothing.
- `mpas init proposer --action https://api.signerset.com --verifier-did <did>` stores that DID and does not require a later `mpas config` before the bridge can be written.
- `mpas init verifier --proposer-did <did> --maintainer-did <did>` stores both DIDs. An empty answer at the prompt leaves that list unset.
- A URL without `http://` or `https://` exits nonzero. The command does not prepend `https://`.
- `mpas init maintainer --coordination http://127.0.0.1:7545 --harness cursor` creates a mode-`0600` key, a signer config, and a `mpas-coordination` entry that leaves other Cursor servers in place.
- A second `mpas init proposer`, even with a different `--action`, exits 0, prints the original DID and saved URLs, and does not change the key or the URLs.
- `mpas config --suite P-256` on a Proposer home writes a new key, prints both DIDs, and keeps the previous key file.
- `mpas config --verifier-did <did>` on a home that contains only the Proposer key stores that DID and does not change the key file.
- `mpas config --role proposer` works when `--home` points at a directory that is not `~/.mpas`.
- The same `--verifier-did` command on a Maintainer home exits nonzero.
- `mpas mcp add --app <fixture> --harness cursor` without a stored Verifier DID exits nonzero and writes no bridge config, including when the Action URL is localhost.
- The same add after the DID is stored writes `actionEndpoint.url` and `actionEndpoint.verifierDid`, does not write `adapter.url`, and registers only `<fixture>-mpas` without removing other Cursor servers.
- `mpas mcp add` on a Maintainer home exits nonzero.
- `mpas mcp add --role verifier --app <fixture>` without stored signer DIDs exits nonzero and writes no application config.
- After both DID lists are stored, the same command writes `executionTarget` from the template and appends the DIDs to `proposers` or `approvers`, `all`, and `signerKeys`. It does not change `policies` or `defaultRequirement`, and it does not write a harness entry. It prints `mpas adapter start` with `--verifier-relay-url` only when the Action URL is not the local adapter.
- `mpas config --proposer-did <did>` after that file exists appends that DID to `proposers` and `all` and leaves `executionTarget` and `policies` unchanged.
- `mpas config --maintainer-did <did>` appends that DID to `approvers` or `maintainers`, and to `all`, and does not add it to `humanApprovers`.
- A home with both a Proposer key and a Maintainer key, and no `--role`, makes `mpas config` prompt for the role. Non-interactive, it exits nonzero. `--role` skips that prompt.
- No `init`, `config`, or `mcp` command listens on a port.
- The help text still documents `mpas adapter start`, `mpas coordination start`, and `mpas daemon start`, and does not document `mpas process start`.
- Tests use fixture registry entries and temporary homes. They do not print or commit private keys.
- `cli/README.md` shows npm install, `mpas init`, `mpas config`, and `mpas mcp add` for a human or an agent that has not read this spec.

## 18. CLI README

`cli/README.md` is the operator document. It is written for a person and for an agent that is asked to run the CLI. It lists the install command, the three roles, `mpas init`, `mpas config` including `--suite` for key rotation, Proposer `mpas mcp add`, Maintainer signer registration at init, and Verifier `mpas mcp add` as the command that installs one upstream MCP server and places DIDs in the proposer and maintainer groups. It points policy-rule editing at oma3dao/mpas#6. It does not restate the HTTP profile. This feature spec stays the design record. The README is the usage record.
