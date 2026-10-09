# MPAS Participant Installer

**Status:** Draft

**Created:** 2026-10-07

**Updated:** 2026-10-08

**Affects:** `examples/demo/src/cli/`, `examples/demo/package.json`, `examples/demo/README.md`, participant guides in `examples/demo/guides/`, the registry schema in `application-registry/`

**Companion:** [plan.md](./plan.md)

**SDK:** No protocol-SDK change is required. The installer calls the published `@oma3/mpas` key and DID helpers.

---

## 1. Purpose

Provide commands that prepare a Proposer, Maintainer, or Verifier account without cloning a repository or asking an agent to follow a setup guide.

`mpas init` creates the local MPAS directory, generates one signing key, and records the service URLs. A Proposer may also record the Verifier DID at init. A Maintainer init also registers the signer MCP server. `mpas config` changes saved URLs and the Verifier DID, and `mpas config validate` checks the account's files. `mpas key rotate` replaces the signing key. `mpas mcp add` registers one Proposer application bridge, or, for a Verifier, installs one application's plugin and a deployment config draft. `mpas signer` adds and removes the Proposer and Maintainer DIDs in that config, one at a time. Thresholds and approval rules stay with the Verifier's operator.

Setup order across three accounts:

1. Each participant runs `mpas init <role>`, which prints that account's DID. No `init` needs another participant's DID.
2. Participants exchange DIDs out of band.
3. The Verifier runs `mpas mcp add`, adds each Proposer and Maintainer DID with `mpas signer add`, follows the application's README to set credentials, and moves the draft into `config/` once `mpas config validate` passes.
4. The Proposer stores the Verifier DID with `mpas config` (unless entered at init) and runs `mpas mcp add`.
5. Each agent's operator pastes the printed role preamble into the harness instruction file.

## 2. Problem

Getting started currently means cloning `mpas` and `mpas-applications`, building from source, and pasting a long prompt into an agent harness. The prompt performs directory creation, key generation, JSON templating, and path substitution. Those steps are deterministic. An agent with filesystem access is a poor installer: it can mix roles, invent a DID exchange, or expose a private key.

Participants use different service URLs. A local demo uses loopback. SignerSet uses `https://api.signerset.com`. Another operator may use private URLs. Coordination and Action submission are separate URLs. The installer prompts for each one the role needs. Pressing return selects the localhost default for that prompt.

## 3. Goals

1. Add `mpas init`, `mpas config`, `mpas key rotate`, `mpas mcp add`, and `mpas signer` to the existing `mpas` executable. Extend `mpas config validate` to check the account's files.
2. Create `~/.mpas` (or `--home`) and one signing key. Print only the public `did:jwk`.
3. Prompt separately for the Coordination URL and the Action URL. Pressing return selects that prompt's localhost default. The user types a full URL, including the scheme. Without a terminal, the URLs are required flags.
4. Write every Proposer bridge with `actionEndpoint.url` and `actionEndpoint.verifierDid`. The same shape is used for a local adapter and a relay. Do not write `adapter.url`.
5. Let a Proposer record the Verifier DID at `init` or later with `mpas config`.
6. Change saved URLs and the Verifier DID with `mpas config`. Replace the signing key with `mpas key rotate`. `init` does not rotate a key or replace saved URLs.
7. Register the Maintainer signer during `init`. Register each Proposer application bridge with `mpas mcp add`, using that harness's own CLI when it has one. On a Verifier, `mpas mcp add` installs one application's verified plugin and a deployment config draft, and points to the application's README for upstream setup. `mpas signer` adds and removes signer DIDs in that config, so basic signer changes need no hand edits.
8. Keep one active signing key per account. A second role on the account reuses that key and must be confirmed.
9. Print the existing role preamble for the user to paste, and install the role skill where the harness has a skills folder. Leave instruction files untouched.
10. Keep the process commands that exist today: `mpas adapter start`, `mpas coordination start`, and `mpas daemon start`. Keep every other existing command, including `mpas config validate <name>` and `mpas key generate`.
11. Install the `mpas` command with npm.

## 4. Non-goals

- Changing the MPAS specifications or the `@oma3/mpas` protocol SDK.
- Publishing application bridges, or writing application install manifests, READMEs, and templates. `mpas mcp add` reads the install data in §19.
- A Homebrew formula.
- A non-MCP CLI package command. `mpas mcp` is the MCP command group so a later command group can install other client packages.
- Detecting which harness is running, or offering a checkbox list of bridges.
- Editing `AGENTS.md`, `CLAUDE.md`, or any other instruction file.
- Adding more than one application in a single `mpas mcp add` invocation.
- Adding `mpas process start` or a new `mpas start` command. Those commands do not exist today.
- Starting the Credential Adapter, Coordination Service, or an agent gateway from `init`, `config`, `key`, `mcp`, or `signer`.
- Exchanging DIDs, calling a portal, or creating SignerSet organization bindings.
- Storing upstream credentials given on the command line.
- More than one active signing key per account.
- Staged key rotation. `mpas key rotate` switches immediately (§10.4).
- A `mpas doctor` connectivity check. That can be a later command.
- Creating or renaming signer groups, or editing thresholds, match conditions, or approval rules. That is [oma3dao/mpas#6](https://github.com/oma3dao/mpas/issues/6). `mpas signer` only adds and removes DIDs in groups that already exist.

## 5. Placement

The installer is participant tooling. It belongs in `oma3dao/mpas`, as commands on the reference `mpas` CLI under `examples/demo/src/cli/`.

It does not belong in `mpas-applications`, `mpas-coordination-server`, or a SignerSet-specific CLI. A hosted service is just a URL the user types. This feature does not treat any vendor host as a shortcut. The long-term package directory is `cli/`; moving the current tree is tracked separately and is not part of this feature.

## 6. Installing `mpas`

The supported install is npm. Homebrew is not part of this feature.

```sh
npm install -g @oma3/mpas-cli@alpha
mpas --help
```

`@oma3/mpas-cli` is the package this feature publishes, created from `examples/demo`. `@oma3/mpas` remains the protocol SDK and is not the command users install. The build copies a snapshot of `application-registry/` (§19) and the `integrations/skills/mpas-proposer/` and `mpas-maintainer/` folders (§14) into the package.

A one-shot `npx -y @oma3/mpas-cli@alpha` may run `init`. Harness config written by these commands must not depend on a transient `npx` cache path or on the harness's `PATH` (§13). It records the absolute path of the `mpas` script that handled the command when that script is a real install. When the command itself was started through `npx`, the harness entry uses `npx` with the same pinned package version, in the form `npx -y --package @oma3/mpas-cli@<version> mpas ...`, because the package has more than one command.

## 7. Flags and Prompts

A supplied flag sets that value and skips its prompt. On a terminal, an omitted flag uses the Default column and asks only when Prompts is Yes. Pressing return accepts the default on first setup. When a saved value already exists, return keeps that value. A prompt whose default is none rejects an empty answer, except the Verifier DID row, where empty leaves the value unset or unchanged.

A non-interactive run cannot prompt. A URL row the command would ask must be supplied as a flag; `local` selects its default. The Verifier DID may be omitted. Any other omitted row that prompts exits nonzero before writing.

`init` asks only the Yes rows for that role. `mpas config` with no change flags, on a terminal, asks the Yes rows for the account's roles. Without a terminal, it prints the saved settings and changes nothing. `mpas config` with one or more flags changes only those flags and does not ask about the others.

| Parameter | Flag | Default | Prompts |
|---|---|---|---|
| MPAS home | `--home <dir>` | `$MPAS_HOME`, or `~/.mpas` | No |
| Key suite | `--suite Ed25519\|P-256` | `Ed25519` | No. The first `init` uses it for the new key. `mpas key rotate` uses it for the replacement. |
| Coordination URL | `--coordination <url>` | `http://127.0.0.1:7545` | Yes, for a Maintainer or Proposer |
| Action URL | `--action <url>` | `http://127.0.0.1:7544` | Yes, for a Proposer or Verifier |
| Add a role | `--add-role` | Off | Yes, as a yes/no question, on `init` of a role the account does not have |
| Role | `--role proposer\|maintainer\|verifier` | The account's only role | Yes, on `mpas mcp add` when the account has more than one role. Not accepted by other commands. |
| Verifier DID | `--verifier-did <did>` | None | Yes, for a Proposer. Empty leaves it unset. |
| Application | `--app <name>` | None | Yes, on Proposer or Verifier `mpas mcp add` and on `mpas signer`. Empty is rejected. Not accepted by `init`. |
| Signer DID | `--proposer <did>` or `--maintainer <did>` | None | No. `mpas signer add` only. |
| Signer group | `--group <name>` | `maintainers` when present, otherwise `approvers` | No. `mpas signer add --maintainer` only. |
| Signer label | `--label <text>` | `Proposer` or `Maintainer` | No. `mpas signer add` only. |
| Harness | `--harness <name>` | None | Yes, on Maintainer `init`, Maintainer `mpas mcp add`, and Proposer `mpas mcp add`. Empty is rejected. `none` is accepted on Maintainer `init`. Not accepted for a Verifier. |
| Harness config location | `--harness-home <dir>` | The selected harness path in §13 | No |
| Skill handling | `--skill install\|print` | The harness default in §14 | No |
| Plugin file | `--plugin <path>` | The manifest download (§19) | No |
| Deployment template | `--config-template <path>` | The manifest download (§19) | No. Verifier `mpas mcp add` only. |
| Replace existing app config | `--replace-config` | Off | No |
| Replacement key | `--use <key-file>` | None | No. `mpas key rotate` only. |

A URL flag or URL answer must include `http://` or `https://`. The command does not add a scheme. `api.signerset.com` is rejected; `https://api.signerset.com` is stored as typed. `localhost` and `local` still mean that prompt's default, which already includes its scheme and port. Clients append `/mpas/v1/...` themselves. These commands must not append that path.

`init` does not accept `--app`. Maintainer `init` does accept `--harness`.

```text
mpas init maintainer [--coordination <url>] [--harness <name>|none] [--add-role]
mpas init proposer [--coordination <url>] [--action <url>] [--verifier-did <did>] [--add-role]
mpas init verifier [--action <url>] [--add-role]

mpas config [--coordination <url>] [--action <url>] [--verifier-did <did>]
mpas config validate [<app>]

mpas key rotate [--suite Ed25519|P-256 | --use <key-file>]

mpas mcp add [--role proposer] [--app <name>] [--harness <name>] [--skill install|print]
mpas mcp add [--role verifier] [--app <name>]
mpas mcp add [--role maintainer] [--harness <name>] [--skill install|print]

mpas signer add --app <app> --proposer <did> [--label <text>]
mpas signer add --app <app> --maintainer <did> [--group <name>] [--label <text>]
mpas signer remove --app <app> <did>
mpas signer list --app <app>

mpas adapter start
mpas coordination start
mpas daemon start
```

`--role` applies only to `mpas mcp add`. It is required when the account has more than one role and no terminal is available.

## 8. Service URLs

Coordination and Action submission are different services. Which of them is asked, and which flags stay silent, is fixed by the table in §7. A first-time terminal session that omits the URL flags looks like this for a Proposer:

```text
Coordination URL (http://127.0.0.1:7545):
Action URL (http://127.0.0.1:7544):
Verifier DID:
```

The command does not ask where to put `~/.mpas`. `--home` remains available for tests and unusual layouts.

Proposer bridge files use one shape. `actionEndpoint.url` is the Action URL. `actionEndpoint.verifierDid` is the Verifier DID. These files omit `adapter`. A bridge file is written only after the Verifier DID is known. This feature does not change the generated bridge, which already accepts that shape.

`mpas config --coordination` and `mpas config --action` replace the saved URLs and rewrite configs that already exist. On a Verifier account, a changed Action URL also moves the relay state aside (§11), because that state is tied to the relay URL. Key rotation is `mpas key rotate` (§10.4).

## 9. Role

`init` takes the role on the command line: `mpas init proposer`.

An account is one MPAS home with exactly one active signing key, `keys/signing-key.json`. `account.json` lists the account's roles. Every role on the account signs with that key.

`init` with a role the account does not have yet adds that role and reuses the key. On a terminal it asks for confirmation, default No. Without a terminal it requires `--add-role`. Without confirmation it exits nonzero and changes nothing. Roles on one account share a DID, so MPAS treats them as one signer that cannot approve its own proposals. A single-machine demo with separate participants uses one `--home` per participant. Adding the Verifier role to a Proposer account, or the reverse, prints a warning that an agent running as this user can read the stored upstream credentials.

`mpas mcp add` acts for one role. On an account with more than one role, it asks which role on a terminal and requires `--role` otherwise. No account means the command exits nonzero and tells the user to run `mpas init`.

Flags that belong to no role on the account exit nonzero and change nothing. A Maintainer-only account cannot store `--verifier-did`. A Maintainer cannot take `--app`. A Verifier cannot take `--harness`.

## 10. What Each Command Writes

DIDs of other participants arrive out of band. `init` never waits for them and never fails because they are missing.

### 10.1 `mpas init`

Creates the home, generates the signing key, writes `account.json` with the role and service URLs, and prints the public DID. Proposer init also stores a Verifier DID when one was entered.

| Role | Also writes at init |
|---|---|
| Maintainer | Signer config, and the signer MCP server in the chosen harness. With `--harness none`, no registration; the command prints `mpas action pending --config <signer config>`. |
| Proposer | The Verifier DID, when supplied. Bridges are added later with `mpas mcp add`. |
| Verifier | Nothing more. Application files are written later by `mpas mcp add`. |

Maintainer `init` registers the signer MCP server. Maintainer `mpas mcp add` registers the same server, to add it after `--harness none` or to retry a failed registration.

A second `init` for a role the account already has always exits 0 and changes nothing. It does not prompt, it does not apply URL flags, DID flags, or `--suite`, and it does not rotate the key. It tells the user that this home is already initialized, then prints the existing public DID and the saved URLs and DIDs. It names `mpas config` and `mpas key rotate` as the commands that change them. A different role on the same account follows §9: it needs confirmation, reuses the key, and asks only the rows not already saved. `--suite` with a new role exits nonzero. A home with key files but no `account.json` exits nonzero, names those files, and changes nothing.

### 10.2 `mpas config`

Requires an account. It does not edit a harness, the key, or a deployment config.

- Proposer: `--verifier-did` stores the designated Verifier DID and rewrites `actionEndpoint.verifierDid` in existing bridge configs. Repeating the stored DID is a no-op. A different DID replaces it.
- `--coordination` and `--action` replace the saved URLs for the roles that use them.

Invalid DIDs exit nonzero and change nothing.

Verifier `init` and `config` do not create an application file and do not choose an upstream MCP server. Creating that file is Verifier `mpas mcp add`. The Verifier's trusted DIDs live in each application's deployment config, not on the account. `mpas signer` edits them (§10.5).

Credential material is not part of `init` or `config`. No command in this feature accepts a token flag.

`mpas config validate [<app>]` checks the account's files without network access and without changing them. It exits 0 only when every check passes. With `<app>`, it checks only that application's files.

- The key file is mode `0600` and its DID matches `account.json`.
- The signer config's `agent` and `coordination.url` match the account.
- Each bridge config's `agent`, `coordination.url`, and `actionEndpoint` match the account, it has no `adapter`, and its plugin copy matches the registry `artifactDid`.
- Each Verifier deployment config in `config/`, and each draft in `config/drafts/`, gets the existing schema, signer-key, and credential checks. Placeholder values in a draft are reported by field. When a draft passes, the output prints the command that moves it into `config/`.

The existing form `mpas config validate <name> --config-dir <dir>` keeps working.

### 10.3 `mpas mcp add`

One invocation adds one application. A Maintainer invocation registers the signer server (§10.1) and does not take `--app`.

Proposer:

The command registers the bridge through the harness's own CLI when that harness has one, so it does not invent a second config format or replace unrelated servers. OpenClaw uses `openclaw config set` for the one server key. A harness with no such CLI gets a merge of the one named server into its documented config file. Existing servers with other names are left in place. Replacing the same MPAS server name updates that entry only.

On a terminal, omitting `--harness` or `--app` follows §7. A non-interactive invocation requires those flags.

- Resolves one registry entry and its install manifest (§19).
- Downloads `plugin.json`, or copies `--plugin`, and checks it against the registry `artifactDid`.
- Requires a Verifier DID already stored by init or `mpas config`. If it is missing, writes nothing for that app and exits nonzero with the config command to run.
- Writes `actionEndpoint.url` and `actionEndpoint.verifierDid`. Does not write `adapter.url`.
- Registers only `<app>-mpas`. Does not register the signer server.
- Handles the proposer skill and prints the preamble for the selected harness (§14), plus the application's README link.

Verifier:

This role has no agent harness. `--harness` exits nonzero. The command makes the application visible to the Credential Adapter. It does not configure it. Each upstream server needs its own setup, such as OAuth, a token, or a container, which the application's README covers. Signer DIDs are added with `mpas signer add` (§10.5). Thresholds and approval rules are the operator's decision.

1. Download and verify the plugin and the deployment config template (§19). Do not launch the upstream server. Do not accept a credential value on the command line.
2. Write `config/drafts/<app>-adapter-config.json`: the template with `plugin.path` pointing at the local plugin copy. Leave everything else in the template unchanged, including placeholders, signer groups, signer keys, credential bindings, `executionTarget`, and policy.

The draft stays out of `config/` because the Credential Adapter loads every `.json` file there and refuses to start if any one is invalid. The operator adds signers with `mpas signer add`, follows the README for upstream setup, then moves the draft into `config/` once `mpas config validate <app>` passes.

An application that already has a draft or a live config exits nonzero unless `--replace-config` is set. `--replace-config` writes a new draft, renames an earlier draft with a timestamp, and never replaces a live config or a key. A second application is a second `mpas mcp add`.

After a successful write, print the README link, the `mpas signer add` commands for this application, `mpas config validate <app>`, and `mpas adapter start` with the config, credential, adapter-key, and journal paths under the home. Add `--verifier-relay-url` and `--verifier-relay-state` only when the Action URL's host is not loopback (`localhost`, `127.0.0.0/8`, or `::1`). The adapter's own defaults ignore `$MPAS_HOME`, so the printed command passes every path. Do not run that command.

### 10.4 `mpas key rotate`

Replaces the account's signing key. The switch is immediate.

- The previous key file is moved to `keys/signing-key.retired-<UTC timestamp>.json`, mode `0600`, and is not deleted.
- The new key is generated with the current suite, or with `--suite`. With `--use <key-file>`, the command instead moves in a key made earlier with `mpas key generate`, after checking that it is valid and has a different DID. `--suite` and `--use` cannot be combined.
- `agent.did` is rewritten in the signer config and every bridge config. Key paths do not change, so harness entries are untouched. On a Verifier account, the relay state is moved aside (§11), because it is tied to the Verifier DID.
- The command prints the old DID, the new DID, and who must record the new DID. For a Proposer or Maintainer, that is each Verifier that lists the account and the coordination operator, for example signerset.com. For a Verifier, each Proposer runs `mpas config --verifier-did`. Until they do, signatures from the new key are rejected. Each Verifier's operator removes the old DID with `mpas signer remove` and adds the new one with `mpas signer add`.

To rotate without that gap, create the key first with `mpas key generate`, register its DID with the Verifier and the coordination operator, then run `mpas key rotate --use <file>`. `init` and `config` cannot rotate a key.

### 10.5 `mpas signer`

Adds and removes the Proposer and Maintainer DIDs an application trusts, one at a time, so the Verifier's operator does not hand-edit the deployment config. Requires the Verifier role. Each command acts on the application's draft in `config/drafts/` when one exists, and otherwise on its live config in `config/`. It prints which file it changed. The Credential Adapter reads deployment configs at start, so a change to a live config takes effect after the adapter restarts.

`add`:

- A Proposer DID goes into `policy.signerGroups.proposers`. A Maintainer DID goes into `--group` when given, otherwise `maintainers` when that group exists, otherwise `approvers`. The DID is also added to `policy.signerGroups.all` and to `signerKeys`, labeled with `--label` or the default `Proposer` or `Maintainer`. A label tells several maintainers apart.
- The first DID added to a group replaces that group's placeholders. A placeholder is an entry that is not a DID, such as `REPLACE_WITH_APPROVER_DID`, or a `did:example:` DID. A placeholder is also removed from `all` and `signerKeys` once no group lists it.
- A DID already in the group is a no-op. The DID must be a valid `did:jwk`, because the command does not take a public key for other DID methods.
- The group must already exist. The command does not create or rename groups, and it does not change thresholds, match conditions, policies, or `defaultRequirement`. A missing group exits nonzero and names [oma3dao/mpas#6](https://github.com/oma3dao/mpas/issues/6).

`remove` takes the DID out of every signer group and out of `signerKeys`. It warns when a group becomes empty, because operations that need that group can no longer be approved. After a key rotation, the operator removes the old DID this way.

`list` prints each signer group with its DIDs and labels, and marks placeholders. It changes nothing.

`add` and `remove` replace the file atomically and leave every field other than the signer groups and `signerKeys` unchanged. Invalid input exits nonzero and changes nothing. After a change, the command prints `mpas config validate <app>`.

## 11. Files

Under the MPAS home:

| Path | Role | Mode |
|---|---|---|
| `keys/signing-key.json` | All roles | `0600` |
| `keys/signing-key.retired-<timestamp>.json` | All roles | `0600`, kept after rotation |
| `account.json` | All roles | roles, coordination URL, action URL, and stored Verifier DID |
| `mcp-server-configs/maintainer-signer-config.json` | Maintainer | config |
| `mcp-server-configs/<app>-mcp-bridge-config.json` | Proposer | config |
| `plugins/<app>-plugin.json` | Proposer and Verifier | verified plugin copy |
| `config/drafts/<app>-adapter-config.json` | Verifier | deployment config draft |
| `config/<app>-adapter-config.json` | Verifier | live deployment config, moved in by the operator |
| `skills/mpas-<role>/` | Proposer and Maintainer | copy of the bundled skill |

`account.json` holds `version` (`"1"`), `type` (`"MpasAccount"`), `did`, `roles`, and, when set, `coordinationUrl`, `actionUrl`, and `verifierDid`. It is mode `0600`.

The relay state is `journal/verifier-relay.json`. Moving it aside renames it to `journal/verifier-relay.<timestamp>.json`.

Create missing home directories with mode `0700`. Private keys and anything under `credentials/` are `0600`. Stdout may contain the public DID, config paths, and the paste block. Stdout and stderr must not contain a private JWK or credential value.

Generated configs use absolute paths. MCP servers are not launched through a shell and do not expand `~`.

### 11.1 Maintainer config

```json
{
  "agent": {
    "did": "did:jwk:...",
    "keyFile": "/absolute/path/keys/signing-key.json"
  },
  "coordination": {
    "url": "http://127.0.0.1:7545"
  }
}
```

The coordination URL comes from `--coordination`.

### 11.2 Proposer config

Every Proposer bridge config uses `actionEndpoint` and omits `adapter`. `actionEndpoint.url` is the Action URL. `actionEndpoint.verifierDid` is the Verifier DID. `additionalRecipients` is omitted. This feature does not accept extra recipients.

`target.applicationDid` comes from the selected registry entry. `coordination.url` comes from `--coordination`. `workflow.dbPath` is `$MPAS_HOME/workflows/<app>.db`. The config also has `mode: "proposer"`, `plugin` set to the local plugin copy, and `agent.did` and `agent.keyFile` for the account's key.

## 12. How a Proposer Bridge Is Installed

`mpas mcp add` does not clone `mpas-applications` and does not compile a bridge.

1. The application's install manifest (§19) names the bridge's npm package and exact version.
2. The command downloads only `plugin.json` into `plugins/` and checks it against the registry `artifactDid`.
3. The harness entry starts that npm package when the agent launches the server, using the launch rules in §13:

```text
npx -y <bridge-package>@<version> --config <absolute-bridge-config>
```

npm downloads the bridge at that launch. The command must resolve the package metadata enough to confirm the name and version exist. Unit tests inject that lookup and do not call the network.

If the package is not published on npm, the command still stores the plugin and bridge config when the rest of the inputs are present, and harness registration fails with the package name it could not find. It must not point the harness at a source checkout's `dist/` path.

The Maintainer server is different. It is the signer shipped inside `@oma3/mpas-cli`, not an application bridge. Its harness command is that installed `mpas` binary, or the pinned `npx` form from §6, with the signer config path.

## 13. Harness Registration

An MCP server entry in a harness is a record that tells the agent which program to start. Maintainer `init` and Maintainer `mpas mcp add` write the signer entry. Proposer `mpas mcp add` writes one application-bridge entry. Neither command replaces servers it did not create. Verifier `mpas mcp add` does not write a harness entry. It writes the adapter deployment config for that upstream MCP server.

These commands do not inspect the parent process or guess among installed harnesses. When the harness has a CLI for adding one MCP server, that CLI is the write path. OpenClaw is `openclaw config set` for the one server key. A harness without that CLI gets a merge of the one named server into the file below. Other server names stay as they are.

| Name | Config written | Instruction file named in the paste hint |
|---|---|---|
| `codex` | `codex mcp add` with `CODEX_HOME` set to the harness home | `AGENTS.md` |
| `openclaw` | one server key through `openclaw config set`, and `<name>__*` added to an existing `tools.allow` | workspace `AGENTS.md` |
| `claude-desktop` | `claude_desktop_config.json` on macOS | the desktop app's project or user instructions |
| `claude-code` | `claude mcp add-json --scope user` with the entry as one JSON value, which avoids `-e` option-ordering ambiguity; `--harness-home` sets `CLAUDE_CONFIG_DIR` | `CLAUDE.md` |
| `hermes` | `mcp_servers` in `~/.hermes/config.yaml` | `AGENTS.md` |
| `cursor` | `mcpServers` in `~/.cursor/mcp.json` | `AGENTS.md` |
| `none` | nothing; Maintainer `init` only | none |

Hermes uses the stdio shape documented by Hermes: `command` plus `args` under `mcp_servers`. See the [Hermes MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp). Cursor uses `mcpServers` in `~/.cursor/mcp.json`.

The default Codex home is role-specific: `~/.codex-proposer` or `~/.codex-maintainer`. The installer does not write `~/.codex` unless `--harness-home` points there. Claude Desktop uses `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS. On any other operating system, that harness prints the JSON and does not guess a path. Claude Desktop is the chat app. Claude Code is the coding agent, including the desktop app's Code tab. They do not share MCP settings.

OpenClaw hides MCP tools that are not in `tools.allow` when an allowlist is set. The command adds `<name>__*` to an existing `tools.allow` list and keeps its other entries. When `tools.allow` is unset, it stays unset, because setting it would hide every other tool. The command prints `openclaw gateway restart` and does not run it.

Registration adds or replaces one named server and preserves unrelated servers. A second Proposer application is a second `mpas mcp add`.

Generated entries do not depend on the harness's `PATH` or on a shell, because apps opened from the Dock often lack the user's shell `PATH`, and `npx`, `mpas`, and bridge binaries start with `#!/usr/bin/env node`. The entry's `command` is the absolute path of the Node executable that ran the installer (`process.execPath`). Its environment sets `PATH` with that executable's directory first. Its `args` start with the absolute path of the `npx` or `mpas` script.

Each agent has one MPAS role. The command identifies existing MPAS entries by the config file their arguments point to, not by their names: a `*-mcp-bridge-config.json` is a Proposer bridge, and `maintainer-signer-config.json` is the Maintainer signer. Entries added by hand under other names, such as `github-mpas-mirror`, are recognized the same way, and an unrelated server whose name happens to end in `-mpas` is not. The command refuses to register the signer in a harness location that already has a Proposer bridge, and refuses a Proposer bridge where the signer is registered. It exits nonzero and names `--harness-home` as the way to use a separate location.

An unknown harness name, a missing harness CLI, or a requested write that cannot be completed exits nonzero after any identity, service URL, or application config already saved. The error includes the server name, command, and absolute arguments.

## 14. Instruction Text and Skills

After a successful Proposer `mpas mcp add`, print a fenced block containing only that role's existing prime directive from `integrations/skills/mpas-proposer/SKILL.md`. Name the instruction file for the harness that was just selected. Proposer `init` does not select a harness, so it prints no preamble.

After a successful Maintainer init, print the same kind of block from `integrations/skills/mpas-maintainer/SKILL.md` and name the instruction file for the harness that was just selected. With `--harness none`, print no preamble.

`init verifier` prints the Verifier DID and the next operator steps. It prints no agent preamble.

These commands must not create or edit those instruction files.

When a harness is selected, the command copies the role's bundled skill folder to `<home>/skills/mpas-<role>/`. With `--skill install`, it also copies the folder into the harness skills folder below, replacing only an earlier copy of the same skill. With `--skill print`, it prints where the skill goes and writes nothing more.

| Harness | Skills folder | Default |
|---|---|---|
| `claude-code` | `~/.claude/skills/` | `install` |
| `codex` | `<codex home>/skills/` | `install` |
| `cursor` | `~/.cursor/skills/` | `install` |
| `hermes` | `~/.hermes/skills/` | `install` |
| `openclaw` | `<agent workspace>/skills/`; the workspace belongs to the agent, so the command does not choose it | `print` |
| `claude-desktop` | Upload in Settings. The command writes `<home>/skills/mpas-<role>.zip` and prints the upload steps. | `print` |

`--skill install` is accepted only for the harnesses whose default is `install`.

## 15. Starting Processes

This feature does not add process commands. The CLI already has:

| Command | Process |
|---|---|
| `mpas adapter start` | Credential Adapter only. This is the Verifier process. |
| `mpas coordination start` | Coordination Service only. |
| `mpas daemon start` | Credential Adapter and Coordination Service together, for a local demo. |

`mpas daemon start` rejects a hosted relay URL. Hosted Verifier mode remains `mpas adapter start --verifier-relay-url <url>`. There is no `mpas process start` command, and this feature does not add one.

These commands do not start an OpenClaw gateway or any other agent harness.

`init`, `config`, `key`, `mcp`, and `signer` do not call any start command.

## 16. Idempotency and Errors

- A second `init` for the same role exits 0, changes nothing, and states that the home is already initialized. URL flags on that second run are ignored. `mpas config` is the command that changes them.
- `config` never rewrites a key. `mpas key rotate` replaces it and keeps the previous key file.
- `mpas mcp add` for a Verifier application that already has a draft or a live config exits nonzero unless `--replace-config` is set. `--replace-config` never replaces a key file or a live config.
- Invalid DIDs, unknown suites, unknown apps, unknown URLs, and downloads that fail verification exit nonzero before writing that command's new files.
- A harness failure does not roll back a key, service URL, or valid application config.
- Exit 0 means the requested command completed. A requested harness write or relay bridge that did not complete is exit nonzero.

## 17. Acceptance Criteria

- A terminal `mpas init proposer` with no URL flags prompts for Coordination, Action, and Verifier DID, and does not prompt for the home directory. Empty URL answers save `http://127.0.0.1:7545` and `http://127.0.0.1:7544`. An empty Verifier DID answer leaves that DID unset. The key is written to `keys/signing-key.json` under `~/.mpas` unless `--home` or `$MPAS_HOME` is set. The command prints the DID and writes no bridge config.
- A non-interactive Proposer `init` without `--coordination` and `--action` exits nonzero and writes nothing. With both and without `--verifier-did`, it succeeds.
- `mpas init proposer --action https://api.signerset.com --verifier-did <did>` stores that DID and does not require a later `mpas config` before the bridge can be written.
- A non-interactive `mpas init verifier --action local` succeeds without any DID.
- A URL without `http://` or `https://` exits nonzero. The command does not prepend `https://`.
- `mpas init maintainer --coordination http://127.0.0.1:7545 --harness cursor` creates a mode-`0600` key, a signer config, and a `mpas-coordination` entry that leaves other Cursor servers in place. It installs the maintainer skill into `~/.cursor/skills/`.
- `mpas init maintainer --coordination local --harness none` registers nothing and prints `mpas action pending`.
- A second `mpas init proposer`, even with a different `--action`, exits 0, prints the original DID and saved URLs, and does not change the key or the URLs.
- A non-interactive `mpas init maintainer` on a Proposer account without `--add-role` exits nonzero and changes nothing. With `--add-role`, it adds the role and creates no second key file.
- `mpas key rotate --suite P-256` on a Proposer account writes a new key, rewrites `agent.did` in every config, prints both DIDs, and keeps the previous key file. `--use <file>` adopts a key made by `mpas key generate`.
- `mpas config --verifier-did <did>` on a Proposer account stores that DID and does not change the key file.
- `mpas config` works when `--home` points at a directory that is not `~/.mpas`.
- The same `--verifier-did` command on a Maintainer-only account exits nonzero.
- `mpas mcp add --app <fixture> --harness cursor` without a stored Verifier DID exits nonzero and writes no bridge config, including when the Action URL is localhost.
- The same add after the DID is stored writes `actionEndpoint.url` and `actionEndpoint.verifierDid`, does not write `adapter.url`, and registers only `<fixture>-mpas` without removing other Cursor servers.
- A plugin that does not match the registry `artifactDid` exits nonzero and writes no file.
- `mpas mcp add --harness cursor` on a Maintainer account registers `mpas-coordination`. `--app` on a Maintainer account exits nonzero.
- `mpas mcp add --role verifier --app <fixture>` writes the plugin and `config/drafts/<fixture>-adapter-config.json`, identical to the template except `plugin.path`. It writes nothing in `config/` and no harness entry. It prints the README link, `mpas config validate <fixture>`, and `mpas adapter start` with `--verifier-relay-url` only when the Action URL is not loopback.
- `mpas config validate <fixture>` on that draft names each placeholder. After the placeholders are filled, it passes and prints the command that moves the draft into `config/`.
- `mpas signer add --app <fixture> --maintainer <did>`, run three times with three DIDs and labels, puts all three in `approvers`, `all`, and `signerKeys`, and removes the template's approver placeholder. Running it again with one of those DIDs changes nothing. `policies` and `defaultRequirement` are unchanged.
- `mpas signer add --maintainer <did> --group <missing>` exits nonzero and changes nothing. `mpas signer remove --app <fixture> <did>` removes the DID from every group and from `signerKeys`.
- `mpas signer add` on an account without the Verifier role exits nonzero.
- A harness entry named `github-mpas-mirror` whose arguments point at a bridge config blocks registering the signer in that harness location. An unrelated server named `other-mpas` does not.
- In an end-to-end test across three homes, after `mpas signer add` adds the Proposer and Maintainer DIDs to the Verifier's draft and the draft is moved into `config/`, `mpas config validate` passes on all three homes, and the Credential Adapter's config loader loads the Verifier's `config/`.
- No `init`, `config`, `key`, `mcp`, or `signer` command listens on a port.
- The help text still documents `mpas adapter start`, `mpas coordination start`, `mpas daemon start`, and every other existing command, and does not document `mpas process start`.
- Tests use fixture registry entries, manifests, and temporary homes. They do not print or commit private keys.
- `examples/demo/README.md` opens with an operator section showing npm install, `mpas init`, `mpas config`, `mpas key rotate`, `mpas mcp add`, and `mpas signer` for a human or an agent that has not read this spec.

## 18. CLI README

The operator document is the opening section of `examples/demo/README.md`, ahead of the existing architecture material. It is the README npm shows for `@oma3/mpas-cli`, and it moves with the package to `cli/`. It is written for a person and for an agent that is asked to run the CLI. It lists the install command, the three roles, `mpas init`, `mpas config` and `mpas config validate`, `mpas key rotate`, Proposer `mpas mcp add`, Maintainer signer registration at init, Verifier `mpas mcp add` as the command that installs the plugin and a deployment config draft, and `mpas signer` for adding and removing signer DIDs. It points to each application's README for upstream setup, and points policy-rule editing at oma3dao/mpas#6. It does not restate the HTTP profile. This feature spec stays the design record. The README is the usage record.

## 19. Application Install Data

The CLI reads the registry snapshot bundled in the package (§6). A registry change reaches users with the next CLI release. An installable registry entry adds a pointer to a manifest in the implementation's repository:

```json
"install": {
  "manifestUrl": "https://.../applications/github/install.json",
  "manifestDigest": { "alg": "sha-256", "value": "<base64url>" }
}
```

The manifest names what `mpas mcp add` downloads:

```json
{
  "version": "1",
  "type": "MpasInstallManifest",
  "applicationDid": "did:web:wivity.com:applications:github-mcp-server",
  "bridge": { "package": "<npm package>", "version": "<exact version>" },
  "plugin": { "url": "https://.../plugin.json" },
  "adapterConfigTemplate": {
    "url": "https://.../adapter-config.example.json",
    "digest": { "alg": "sha-256", "value": "<base64url>" }
  },
  "readme": "https://.../README.md"
}
```

Every download is checked against a value that chains back to the bundled registry. A failed check exits nonzero before writing that application's files.

- The manifest matches `manifestDigest`, and its `applicationDid` matches the registry entry.
- The plugin matches the registry entry's `plugin.artifactDid`. An entry without `artifactDid` cannot be installed. `--plugin` is checked the same way.
- The template matches `adapterConfigTemplate.digest`. `--config-template` is a file the operator chose and skips the digest check.
- `bridge.version` is an exact version, not a range or tag.

`mpas mcp add` needs these from `mpas-applications`: a manifest, a README that explains the upstream setup, a deployment config template for Verifiers, and a bridge published on npm for Proposers. Each template has a `proposers` group and an `approvers` or `maintainers` group, so `mpas signer add` works without options. As of 2026-10-08, no application has a manifest or a published bridge, 4 of 24 have a README, and 3 have a template. Until one application has all four, `mpas mcp add` is exercised only with test fixtures.
