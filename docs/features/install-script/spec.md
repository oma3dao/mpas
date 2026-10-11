# MPAS Participant Installer

**Status:** Draft

**Created:** 2026-10-07

**Updated:** 2026-10-10

**Affects:** `cli/src/cli/`, `cli/package.json`, `cli/README.md`, participant guides in `cli/guides/`, the `source` field in `application-registry/README.md`

**Companion:** [plan.md](./plan.md)

**SDK:** No protocol-SDK change is required. The installer calls the published `@oma3/mpas` key and DID helpers.

---

## 1. Purpose

Provide commands that prepare a Proposer, Maintainer, or Verifier account without cloning a repository or asking an agent to follow a setup guide.

`mpas init` creates the local MPAS directory, generates one signing key, and records the service URLs. A Proposer may also record the Verifier DID at init. A Maintainer init also registers the signer MCP server. `mpas config` changes saved URLs and the Verifier DID, and `mpas config validate` checks the account's files. `mpas key rotate` replaces the signing key. `mpas mcp add <url>` registers one Proposer application bridge, or, for a Verifier, installs one application's plugin and a deployment config draft, from the URL of that application's folder (§9.5). `mpas signer` adds and removes the Proposer and Maintainer DIDs in that config, one at a time. Thresholds and approval rules stay with the Verifier's operator.

Setup order across three accounts:

1. Each participant runs `mpas init <role>`, which prints that account's DID. No `init` needs another participant's DID.
2. Participants exchange DIDs out of band.
3. The Verifier runs `mpas mcp add <url>`, adds each Proposer and Maintainer DID with `mpas signer add`, follows the application's README to set credentials, and moves the draft into `config/` once `mpas config validate` passes.
4. The Proposer stores the Verifier DID with `mpas config` (unless entered at init) and runs `mpas mcp add <url>`.
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
7. Register the Maintainer signer during `init`. Register each Proposer application bridge with `mpas mcp add`, using that harness's own CLI when it has one. Both take the URL of the application's folder, wherever its publisher hosts it (§9.5). On a Verifier, `mpas mcp add` installs one application's verified plugin and a deployment config draft, and points to the application's README for upstream setup. `mpas signer` adds and removes signer DIDs in that config, so basic signer changes need no hand edits.
8. Keep one active signing key per account. A second role on the account reuses that key and must be confirmed.
9. Print the existing role preamble for the user to paste, and install the role skill where the harness has a skills folder. Leave instruction files untouched.
10. Keep the process commands that exist today: `mpas adapter start`, `mpas coordination start`, and `mpas daemon start`. Keep every other existing command, including `mpas config validate <name>` and `mpas key generate`.
11. Install the `mpas` command with npm.

## 4. Non-goals

- Changing the MPAS specifications or the `@oma3/mpas` protocol SDK.
- Publishing application bridges, or writing application READMEs and templates. `mpas mcp add` reads the application folder described in §9.5.
- Finding applications. The CLI does not read a registry. Discovery happens elsewhere: today the registry in this repository, later perhaps an on-chain registry or a third-party directory. Each of them only supplies the URL that `mpas mcp add` takes.
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
- Staged key rotation. `mpas key rotate` switches immediately (§9.4).
- A `mpas doctor` connectivity check. That can be a later command.
- Creating or renaming signer groups, or editing thresholds, match conditions, or approval rules. That is [oma3dao/mpas#6](https://github.com/oma3dao/mpas/issues/6). `mpas signer` only adds and removes DIDs in groups that already exist.

## 5. Placement

The installer is participant tooling. It belongs in `oma3dao/mpas`, as commands on the reference `mpas` CLI under `cli/src/cli/`.

It does not belong in `mpas-applications`, `mpas-coordination-server`, or a SignerSet-specific CLI. A hosted service is just a URL the user types. This feature does not treat any vendor host as a shortcut. The package lives in `cli/` at the repository root.

## 6. Installing `mpas`

The supported install is npm. Homebrew is not part of this feature.

```sh
npm install -g @oma3/mpas-cli@alpha
mpas --help
```

`@oma3/mpas-cli` is the package this feature publishes, created from `cli`. `@oma3/mpas` remains the protocol SDK and is not the command users install. The build copies the `integrations/skills/mpas-proposer/` and `mpas-maintainer/` folders (§11) into the package. It does not bundle `application-registry/`: application changes never need a CLI release (§9.5).

A one-shot `npx -y @oma3/mpas-cli@alpha` may run `init`. The package keeps its `mpas` and `mpas-demo` commands and adds `mpas-cli`, the same program as `mpas`, because npm's one-shot form runs the command named after the package. Harness config written by these commands must not depend on a transient `npx` cache path or on the harness's `PATH` (§10). It records the absolute path of the `mpas` script that handled the command when that script is a real install. When the command itself was started through `npx`, the harness entry uses `npx` with the same pinned package version, in the form `npx -y --package @oma3/mpas-cli@<version> mpas ...`, because the package has more than one command.

## 7. Conventions for Every Command

These rules apply to `init`, `config`, `config validate`, `key rotate`, `mcp add`, and `signer`. Each command's own flags, behavior, errors, and acceptance criteria are in its section of §9.

### 7.1 Flags and prompts

Each command in §9 has a flags table. A supplied flag sets that value and skips its prompt. On a terminal, an omitted flag uses the Default column and asks only when Prompts is Yes. Pressing return accepts the default on first setup. When a saved value already exists, return keeps that value. A prompt whose default is none rejects an empty answer, except the Verifier DID row, where empty leaves the value unset or unchanged.

A non-interactive run cannot prompt. A URL row the command would ask must be supplied as a flag; `local` selects its default. The Verifier DID and the Verifier mode may be omitted. Any other omitted row that prompts exits nonzero before writing.

Every command accepts this flag:

| Parameter | Flag | Default | Prompts |
|---|---|---|---|
| MPAS home | `--home <dir>` | `$MPAS_HOME`, or `~/.mpas` | No |

The command does not ask where to put `~/.mpas`. `--home` remains available for tests and unusual layouts.

### 7.2 URLs

A URL flag or URL answer must include `http://` or `https://`. The command does not add a scheme. `api.signerset.com` is rejected; `https://api.signerset.com` is stored as typed. `localhost` and `local` still mean that prompt's default, which already includes its scheme and port. Clients append `/mpas/v1/...` themselves. These commands must not append that path.

### 7.3 Output, files, and errors

Create missing home directories with mode `0700`. Private keys and anything under `credentials/` are `0600`. Stdout may contain the public DID, config paths, and the paste block. Stdout and stderr must not contain a private JWK or credential value.

Generated configs use absolute paths. MCP servers are not launched through a shell and do not expand `~`.

Credential material is not part of `init` or `config`. No command in this feature accepts a token flag.

- Invalid DIDs, unknown suites, unknown URLs, source URLs whose folder lacks a required file, and downloads that fail their checks exit nonzero before writing that command's new files.
- A harness failure does not roll back a key, service URL, or valid application config.
- Exit 0 means the requested command completed. A requested harness write or relay bridge that did not complete is exit nonzero.

### 7.4 Printed commands

Printed commands that act on this account include `--home <home>` unless the home is `~/.mpas` and `$MPAS_HOME` is unset, so they target the same account in a new shell, for an agent, or under a different `$MPAS_HOME`. Commands meant for another participant, such as a Proposer's `mpas config --verifier-did` or a Verifier operator's `mpas signer remove`, never carry this home. Every argument in a printed command is shell-quoted when it contains spaces or shell-significant characters, so a printed command can be pasted as is. MCP harness entries are unaffected, since they pass arguments as a list without a shell.

### 7.5 One command at a time, and multi-file updates

Only one `mpas` command works on a home at a time. Every command in this feature takes `update.lock` in the home before reading or writing it, and removes it when done. A command that finds the lock held by a running process changes nothing and exits nonzero, saying another `mpas` command is updating the home. A lock left by a process that is no longer running is removed, and the interrupted update it may have left is then recovered. This also keeps two `mpas signer` commands from overwriting each other's change.

A command that changes more than one file in the home (`init`, `config`, `key rotate`, `mcp add`) first reads and parses every file it will rewrite. A malformed file stops the command before anything is written. It then writes each new file beside its target, keeps a copy of each file it replaces, records the set in `update-in-progress.json`, and commits with renames. The marker itself is always written to a temporary file and renamed into place, so it is never partly written. If the marker cannot be written, or cannot be updated to record a finished commit, the command undoes what it did. A marker that cannot be read stops every command with the paths of the kept copies, so the operator can restore them by hand. If a commit step fails, the command restores every file it already replaced and removes the files it created, so the key, `account.json`, and generated configs never describe different identities or URLs. If the process stops mid-commit, the next `mpas` command that opens the home rolls the interrupted update back, or finishes it when every rename already completed, and says which it did. Harness registration stays outside this procedure, as above.

### 7.6 Managed layout

The managed layout means every bridge and signer config in the home names this account: `agent.keyFile` is `keys/signing-key.json` and `agent.did` is the account's DID. `mpas config` and `mpas key rotate` check every config they would rewrite. If any is outside the managed layout, they change nothing, list each such file with its `agent.keyFile` or `agent.did`, and print the migration steps:

1. Back up the home and stop the processes that use it.
2. Keep the participant's existing key at `keys/signing-key.json` so its DID stays the same. `mpas init <role> --use-key <file>` does this for a home without `account.json`.
3. Point each listed config at that key and DID, or regenerate a bridge config with `mpas mcp add <url> --name <name> --replace-config`, where `<name>` is the name the existing config uses. Move a config that belongs to another participant to that participant's own home.
4. Run `mpas config validate` and restart.

A home with key files and no `account.json` gets the same steps from `init`. Once the home is compliant, rotation keeps the active file name and archives the previous key with a timestamp, as in §9.4.

### 7.7 Acceptance criteria for every command

- `npx -y @oma3/mpas-cli@alpha --help` runs the CLI, checked against a packed tarball before publishing.
- A failure while writing the update marker, or while recording a finished commit, leaves the home as it was. An unreadable marker stops commands with recovery instructions.
- With a custom home and a different default home present, every printed command that acts on the account carries `--home <custom home>`, and commands for other participants do not. A home path containing spaces, quotes, or `$` produces printed commands that a shell splits into the intended arguments.
- A command started while another holds `update.lock` exits nonzero and changes nothing, including a pending update marker. A lock left by a process that is no longer running is cleared.
- A failure injected at any step of a multi-file update leaves every file in the home as it was. A home left with `update-in-progress.json` is rolled back, or rolled forward when every rename completed, by the next command.
- In an end-to-end test across three homes, after `mpas signer add` adds the Proposer and Maintainer DIDs to the Verifier's draft and the draft is moved into `config/`, `mpas config validate` passes on all three homes, and the Credential Adapter's config loader loads the Verifier's `config/`.
- From a built package, the Maintainer's generated harness entry starts the signer server and answers an MCP `tools/list` with the four signer tools, and the Credential Adapter starts from the paths in the printed `mpas adapter start` command with the Verifier's config loaded.
- No `init`, `config`, `key`, `mcp`, or `signer` command listens on a port.
- The help text still documents `mpas adapter start`, `mpas coordination start`, `mpas daemon start`, and every other existing command, and does not document `mpas process start`.
- Tests use fixture application folders served by an injected downloader, and temporary homes. They do not print or commit private keys.

## 8. Accounts and Roles

An account is one MPAS home with exactly one active signing key, `keys/signing-key.json`. `account.json` lists the account's roles. Every role on the account signs with that key.

`init` with a role the account does not have yet adds that role and reuses the key. On a terminal it asks for confirmation, default No. Without a terminal it requires `--add-role`. Without confirmation it exits nonzero and changes nothing. Roles on one account share a DID, so MPAS treats them as one signer that cannot approve its own proposals. A single-machine demo with separate participants uses one `--home` per participant. Separate homes give separate DIDs, not isolation: every agent running as that OS user can read every home. That arrangement is for demos only; the guides state its security and reliability compromises and recommend separate user accounts, containers, or machines. Adding the Verifier role to a Proposer account, or the reverse, prints a warning that an agent running as this user can read the stored upstream credentials.

Flags that belong to no role on the account exit nonzero and change nothing. A Maintainer-only account cannot store `--verifier-did`. A Maintainer cannot take `--app` or a source URL. A Verifier cannot take `--harness`.

DIDs of other participants arrive out of band. `init` never waits for them and never fails because they are missing.

### 8.1 Files

Under the MPAS home:

| Path | Role | Mode |
|---|---|---|
| `keys/signing-key.json` | All roles | `0600` |
| `keys/signing-key.retired-<timestamp>.json` | All roles | `0600`, kept after rotation |
| `account.json` | All roles | roles, coordination URL, action URL, and stored Verifier DID |
| `mcp-server-configs/maintainer-signer-config.json` | Maintainer | config |
| `mcp-server-configs/<app>-mcp-bridge-config.json` | Proposer | config |
| `plugins/<app>-plugin-<cid>.json` | Proposer and Verifier | verified plugin copy; `<cid>` is the `artifactDid` without `did:artifact:`. Never replaced with different content. |
| `installed/<app>.json` | Proposer and Verifier | the source URL and what `mpas mcp add` installed from it (§9.5) |
| `update-in-progress.json` | All roles | present only while a multi-file update is being committed (§7.5) |
| `update.lock` | All roles | present only while an `mpas` command is working on the home (§7.5) |
| `config/drafts/<app>-adapter-config.json` | Verifier | deployment config draft |
| `config/<app>-adapter-config.json` | Verifier | live deployment config, moved in by the operator |
| `skills/mpas-<role>/` | Proposer and Maintainer | copy of the bundled skill |

`account.json` holds `version` (`"1"`), `type` (`"MpasAccount"`), `did`, `roles`, and, when set, `coordinationUrl`, `actionUrl`, `verifierMode`, and `verifierDid`. It is mode `0600`.

The relay state is `journal/verifier-relay-<hash>.json`, where `<hash>` is the first 16 characters of the base64url SHA-256 of the relay URL and the Verifier DID, joined by a newline. The CLI never moves or deletes a relay state file.

## 9. Commands

Each command below has its synopsis, its flags, what it does and writes, its errors, and its acceptance criteria. §7 applies to all of them.

### 9.1 `mpas init`

```text
mpas init maintainer [--coordination <url>] [--harness <name>|none] [--add-role] [--use-key <key-file>]
mpas init proposer [--coordination <url>] [--action <url>] [--verifier-did <did>] [--add-role] [--use-key <key-file>]
mpas init verifier [--action <url>] [--mode direct|relay] [--add-role] [--use-key <key-file>]
```

`init` takes the role on the command line: `mpas init proposer`. It asks only the Yes rows for that role.

| Parameter | Flag | Default | Prompts |
|---|---|---|---|
| Key suite | `--suite Ed25519\|P-256` | `Ed25519` | No. The first `init` uses it for the new key. |
| Coordination URL | `--coordination <url>` | `http://127.0.0.1:7545` | Yes, for a Maintainer or Proposer |
| Action URL | `--action <url>` | `http://127.0.0.1:7544` | Yes, for a Proposer or Verifier |
| Verifier mode | `--mode direct\|relay` | None. Without a mode, the printed instructions show both commands (§9.2). | No. Verifier only. |
| Add a role | `--add-role` | Off | Yes, as a yes/no question, on `init` of a role the account does not have |
| Verifier DID | `--verifier-did <did>` | None | Yes, for a Proposer. Empty leaves it unset. |
| Harness | `--harness <name>` | None | Yes, for a Maintainer. Empty is rejected. `none` is accepted. Not accepted for a Verifier. |
| Harness config location | `--harness-home <dir>` | The selected harness path in §10 | No |
| Skill handling | `--skill install\|print` | The harness default in §11 | No |
| Existing key file | `--use-key <key-file>` | None | No. The first `init` adopts it instead of generating a key. |

`init` does not accept `--app` or a source URL. Maintainer `init` does accept `--harness`.

Coordination and Action submission are different services. Which of them is asked, and which flags stay silent, is fixed by the table above. A first-time terminal session that omits the URL flags looks like this for a Proposer:

```text
Coordination URL (http://127.0.0.1:7545):
Action URL (http://127.0.0.1:7544):
Verifier DID:
```

`init` creates the home, generates the signing key, writes `account.json` with the role and service URLs, and prints the public DID. Proposer init also stores a Verifier DID when one was entered.

| Role | Also writes at init |
|---|---|
| Maintainer | Signer config, and the signer MCP server in the chosen harness. With `--harness none`, no registration; the command prints `mpas action pending --config <signer config>`. |
| Proposer | The Verifier DID, when supplied. Bridges are added later with `mpas mcp add`. |
| Verifier | Nothing more. Application files are written later by `mpas mcp add`. |

Maintainer `init` registers the signer MCP server (§10). Maintainer `mpas mcp add` registers the same server, to add it after `--harness none` or to retry a failed registration.

The Maintainer signer config:

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

A second `init` for a role the account already has always exits 0 and changes nothing. It does not prompt, it does not apply URL flags, DID flags, or `--suite`, and it does not rotate the key. It tells the user that this home is already initialized, then prints the existing public DID and the saved URLs and DIDs. It names `mpas config` and `mpas key rotate` as the commands that change them. A different role on the same account follows §8: it needs confirmation, reuses the key, and asks only the rows not already saved. `--suite` with a new role exits nonzero. A home with key files but no `account.json` exits nonzero, names those files, and changes nothing, unless `--use-key` adopts a key as described next.

`--use-key <key-file>` on a first `init` adopts an existing key instead of generating one. This is how a participant with a manual setup keeps a DID that Verifiers and the coordination operator already know. The file must be a valid MPAS key file, such as one made by `mpas key generate` or the manual guides, and it must load under the runtime's own rules (`KeyManager.fromFile` in `@oma3/mpas`): the private key must derive the stored DID and public key. A file that fails is rejected before anything changes, and the error never shows key material. The command copies it to `keys/signing-key.json` with mode `0600` and leaves the original in place, because manual configs may still point at it. It may adopt a key that sits in the same home's `keys/` folder, including one already at `keys/signing-key.json`: `mpas init <role> --use-key <home>/keys/signing-key.json` completes setup in place, without generating a replacement. Other key files in that folder are listed and left alone; they are not active. Existing manual bridge and signer configs are not changed, including a signer config already at the standard path, which `init` leaves as it is and reports. `mpas mcp add <url> --name <name> --replace-config` writes generated bridge configs. Until every config points at `keys/signing-key.json`, the commands that rewrite configs refuse to run (§7.6). `--use-key` and `--suite` cannot be combined, and `--use-key` with a role the account already has exits nonzero.

Errors:

- A second `init` for the same role exits 0, changes nothing, and states that the home is already initialized. URL flags on that second run are ignored. `mpas config` is the command that changes them.

Acceptance criteria:

- A terminal `mpas init proposer` with no URL flags prompts for Coordination, Action, and Verifier DID, and does not prompt for the home directory. Empty URL answers save `http://127.0.0.1:7545` and `http://127.0.0.1:7544`. An empty Verifier DID answer leaves that DID unset. The key is written to `keys/signing-key.json` under `~/.mpas` unless `--home` or `$MPAS_HOME` is set. The command prints the DID and writes no bridge config.
- A non-interactive Proposer `init` without `--coordination` and `--action` exits nonzero and writes nothing. With both and without `--verifier-did`, it succeeds.
- `mpas init proposer --action https://api.signerset.com --verifier-did <did>` stores that DID and does not require a later `mpas config` before the bridge can be written.
- A non-interactive `mpas init verifier --action local` succeeds without any DID or mode. Without a mode, `mpas mcp add` and `mpas config` print both the direct and the relay `mpas adapter start` commands.
- A URL without `http://` or `https://` exits nonzero. The command does not prepend `https://`.
- `mpas init maintainer --coordination http://127.0.0.1:7545 --harness cursor` creates a mode-`0600` key, a signer config, and a `mpas-coordination` entry that leaves other Cursor servers in place. It installs the maintainer skill into `~/.cursor/skills/`.
- `mpas init maintainer --coordination local --harness none` registers nothing and prints `mpas action pending`.
- A second `mpas init proposer`, even with a different `--action`, exits 0, prints the original DID and saved URLs, and does not change the key or the URLs.
- A non-interactive `mpas init maintainer` on a Proposer account without `--add-role` exits nonzero and changes nothing. With `--add-role`, it adds the role and creates no second key file.
- `mpas init proposer --use-key <file>` on a home that holds a manual `keys/proposer-key.json` and no `account.json` adopts that key, keeps the DID, and leaves the original file in place.
- `init --use-key` rejects a key file whose private key does not derive its DID, without printing key material.
- `mpas init maintainer` leaves an existing signer config byte-identical. `mpas init <role> --use-key <home>/keys/signing-key.json` completes setup in place with the same DID.

### 9.2 `mpas config`

```text
mpas config [--coordination <url>] [--action <url>] [--mode direct|relay] [--verifier-did <did>]
```

| Parameter | Flag | Default | Prompts |
|---|---|---|---|
| Coordination URL | `--coordination <url>` | The saved value | Yes, for a Maintainer or Proposer |
| Action URL | `--action <url>` | The saved value | Yes, for a Proposer or Verifier |
| Verifier mode | `--mode direct\|relay` | The saved value. Without a mode, the printed instructions show both commands. | No. Verifier only. |
| Verifier DID | `--verifier-did <did>` | The saved value | Yes, for a Proposer. Empty leaves it unchanged. |

`mpas config` with no change flags, on a terminal, asks the Yes rows for the account's roles. Without a terminal, it prints the saved settings and changes nothing. `mpas config` with one or more flags changes only those flags and does not ask about the others.

Requires an account. It does not edit a harness, the key, or a deployment config. It refuses to rewrite a bridge or signer config that is not in the managed layout (§7.6).

- Proposer: `--verifier-did` stores the designated Verifier DID and rewrites `actionEndpoint.verifierDid` in existing bridge configs. Repeating the stored DID is a no-op. A different DID replaces it.
- `--coordination` and `--action` replace the saved URLs for the roles that use them, and rewrite configs that already exist. Key rotation is `mpas key rotate` (§9.4).
- Verifier: `--mode direct|relay` replaces the saved mode.
- Without flags and without a terminal, a Verifier account's output also prints the current `mpas adapter start` command.

Invalid DIDs exit nonzero and change nothing.

Verifier `init` and `config` do not create an application file and do not choose an upstream MCP server. Creating that file is Verifier `mpas mcp add`. The Verifier's trusted DIDs live in each application's deployment config, not on the account. `mpas signer` edits them (§9.6).

A Verifier also records a mode, which says how its Action URL is used. `direct` means Proposers submit Actions to this Credential Adapter at the Action URL. `relay` means the adapter polls the relay at the Action URL. The mode, not the URL's host, decides the printed `mpas adapter start` command: relay mode adds `--verifier-relay-url` and `--verifier-relay-state`, and direct mode adds neither. The mode is optional. Without one, the output prints both commands, says which situation each is for, and names `mpas config --mode` to record the choice. A remote direct adapter and a local relay are both supported. In direct mode the adapter still listens on its own `--host` and `--port`; the operator makes the Action URL reach it.

Running processes read URLs and keys only at start. Running processes do not need to stop before `mpas config`, because none of them writes the files it changes. After `mpas config` changes a URL or mode, the output names what to restart: the harness sessions that run this account's bridges or signer server, and, for a Verifier, the Credential Adapter, with the regenerated `mpas adapter start` command. When a URL or the Verifier DID changes, the output also says to let pending work finish before restarting if the change moves the account to a different Coordination service, Action service, or Verifier. Running processes keep using the old one until they restart, so pending work can finish there. The relay state file is named for the relay URL and the Verifier DID (§8.1), so a new URL, mode, or key starts with fresh state and never touches a file a running adapter still writes.

Errors:

- `config` never rewrites a key. `mpas key rotate` replaces it and keeps the previous key file.

Acceptance criteria:

- `mpas config --verifier-did <did>` on a Proposer account stores that DID and does not change the key file.
- `mpas config` works when `--home` points at a directory that is not `~/.mpas`.
- The same `--verifier-did` command on a Maintainer-only account exits nonzero.
- After `--use-key` adoption, a bridge or signer config that still points at the old key file makes `mpas config` exit nonzero, name that file, and print the migration steps, with nothing changed.

### 9.3 `mpas config validate`

```text
mpas config validate [<app>]
mpas config validate <name> [--config-dir <dir>] [--credential-dir <dir>] [--bridge-dir <dir>]
```

`mpas config validate [<app>]` checks the account's files without network access and without changing them. It exits 0 only when every check passes. With `<app>`, it checks only that application's files.

- The key file is mode `0600`, its DID matches `account.json`, and it loads under the runtime's key rules, as in §9.1.
- The signer config's `agent` and `coordination.url` match the account.
- Each bridge config's `agent`, `coordination.url`, and `actionEndpoint` match the account, including `actionEndpoint.verifierDid` equal to the account's Verifier DID, it has no `adapter`, and its plugin copy matches the `artifactDid` recorded when the application was installed (§9.5).
- Each Verifier deployment config in `config/`, and each draft in `config/drafts/`, gets the existing schema, signer-key, and credential checks. Placeholder values in a draft are reported by field. When a draft passes, the output prints the command that moves it into `config/`.

The existing command keeps its meaning wherever it could have one. `mpas config validate` takes the original path, unchanged, when `--config-dir`, `--credential-dir`, or `--bridge-dir` is given, when `$MPAS_CONFIG_DIR` or `$MPAS_CREDENTIAL_DIR` is set, or when the selected home has no `account.json`. Otherwise it checks the account. There, `<app>` matches a file named `<app>-adapter-config.json` or `<app>-mcp-bridge-config.json`, a deployment config's file name, or its `name` field, so the names the original command accepted still select the same config. A `<app>` that matches nothing exits nonzero; it never passes by checking nothing.

Acceptance criteria:

- `mpas config validate` checks an installed plugin against the `artifactDid` recorded at install, without network access, even after the application's folder has changed at its source.
- `mpas config validate <name>` with `$MPAS_CONFIG_DIR` set, or with no `account.json`, behaves exactly as before. On an account, the deployment config's `name` and file name still select it, and a name that matches nothing exits nonzero.
- `mpas config validate` reports an active key whose private key does not derive its DID, without printing key material.
- `mpas config validate` fails for a bridge whose `actionEndpoint.verifierDid` differs from the account's Verifier DID.
- `mpas config validate <fixture>` on a Verifier draft names each placeholder. After the placeholders are filled, it passes and prints the command that moves the draft into `config/`.

### 9.4 `mpas key rotate`

```text
mpas key rotate [--suite Ed25519|P-256 | --use-key <key-file>]
```

| Parameter | Flag | Default | Prompts |
|---|---|---|---|
| Key suite | `--suite Ed25519\|P-256` | The current key's suite | No. Used for the replacement. |
| Existing key file | `--use-key <key-file>` | None | No. Used as the replacement. |

Replaces the account's signing key. The switch is immediate.

- The previous key file is moved to `keys/signing-key.retired-<UTC timestamp>.json`, mode `0600`, and is not deleted.
- The new key is generated with the current suite, or with `--suite`. With `--use-key <key-file>`, the command instead moves in a key made earlier with `mpas key generate`, after checking that it loads under the runtime's key rules (§9.1) and has a different DID. `--suite` and `--use-key` cannot be combined.
- `agent.did` is rewritten in the signer config and every bridge config. Key paths do not change, so harness entries are untouched. If any of those configs is not in the managed layout (§7.6), the command changes nothing. On a Verifier account, the next `mpas adapter start` uses a new relay state file, because that file is named for the Verifier DID (§8.1).
- The command prints the old DID, the new DID, and who must record the new DID. For a Proposer or Maintainer, that is each Verifier that lists the account and the coordination operator, for example signerset.com. For a Verifier, each Proposer runs `mpas config --verifier-did`. Until they do, signatures from the new key are rejected. Each Verifier's operator removes the old DID with `mpas signer remove` and adds the new one with `mpas signer add`.

To rotate without that gap, create the key first with `mpas key generate`, register its DID with the Verifier and the coordination operator, then run `mpas key rotate --use-key <file>`. `init` and `config` cannot rotate a key.

Running processes load the key once, at start. A bridge, signer server, or Credential Adapter that is still running keeps signing with the old key, and a running relay worker keeps writing state for the old identity. The procedure, which the command prints for the account's roles, is:

1. Let pending work finish. A Proposer waits for its submitted Actions to complete or expire. A Maintainer finishes or abandons reviews in progress. A Verifier drains in-flight relay deliveries.
2. Stop what uses the key. A Proposer or Maintainer closes the harness sessions that run this account's bridges or signer server. A Verifier stops the Credential Adapter.
3. Run `mpas key rotate`.
4. Start again. Harness sessions reload the bridges and signer server with the new key. A Verifier runs the regenerated `mpas adapter start` command, which the rotation output prints.
5. Update the other parties as above. The old DID can be removed once no pending Action depends on it.

Acceptance criteria:

- `mpas key rotate --suite P-256` on a Proposer account writes a new key, rewrites `agent.did` in every config, prints both DIDs, keeps the previous key file, and prints the stop, rotate, and restart procedure for the account's roles. `--use-key <file>` adopts a key made by `mpas key generate`.
- `key rotate --use-key` rejects a key file whose private key does not derive its DID, without printing key material.
- After `--use-key` adoption, a bridge or signer config that still points at the old key file makes `mpas key rotate` exit nonzero, name that file, and print the migration steps, with nothing changed.

### 9.5 `mpas mcp add`

```text
mpas mcp add [--role proposer] <url> [--name <name>] [--harness <name>] [--skill install|print]
mpas mcp add [--role verifier] <url> [--name <name>]
mpas mcp add [--role maintainer] [--harness <name>] [--skill install|print]
```

| Parameter | Flag | Default | Prompts |
|---|---|---|---|
| Application source | `<url>`, the first argument | None | Yes, for a Proposer or Verifier. Empty is rejected. Not accepted for a Maintainer. |
| Application name | `--name <name>` | The last folder name in the source URL | No. Proposer or Verifier only. |
| Role | `--role proposer\|maintainer\|verifier` | The account's only role | Yes, when the account has more than one role. Not accepted by other commands. |
| Harness | `--harness <name>` | None | Yes, for a Maintainer or Proposer. Empty is rejected. Not accepted for a Verifier. |
| Harness config location | `--harness-home <dir>` | The selected harness path in §10 | No |
| Skill handling | `--skill install\|print` | The harness default in §11 | No |
| Plugin file | `--plugin <path>` | `plugin.json` at the source URL | No |
| Deployment template | `--config-template <path>` | `adapter-config.example.json` at the source URL | No. Verifier only. |
| Replace existing app config | `--replace-config` | Off | No |

One invocation adds one application, from the URL of its folder. A Maintainer invocation registers the signer server (§9.1) and does not take a URL. A second application is a second `mpas mcp add`. `--app` is not accepted; the source URL and `--name` replace it.

`mpas mcp add` acts for one role. On an account with more than one role, it asks which role on a terminal and requires `--role` otherwise. No account means the command exits nonzero and tells the user to run `mpas init`. On a terminal, omitting `--harness` or the URL follows §7.1. A non-interactive invocation requires both.

#### Source URL

The URL names one application's folder. The publisher hosts that folder wherever they choose: `mpas-applications` is one home for bridges, and a publisher's own repository is another. The CLI does not read a registry and does not default to any repository. Users find the URL elsewhere. Today that is the `source` field of an entry in this repository's `application-registry/`. Later it may be an on-chain registry or a third-party directory. Because the CLI bundles no application data, adding or updating an application never needs a CLI release.

The folder has a fixed layout. Every application in `mpas-applications` already follows it:

| File | Needed by | Use |
|---|---|---|
| `plugin.json` | Proposer and Verifier | The plugin. Its `artifactDid` is computed and printed before anything is written. |
| `adapter-config.example.json` | Verifier | The deployment config template for the draft. |
| `bridge/package.json` | Proposer | `name` and `version`: the npm package and exact version the harness entry launches. |
| `README.md` | Both | Linked in the output for setup the CLI does not do, such as credentials or OAuth. Not downloaded. |

URL forms:

- A GitHub folder URL, `https://github.com/<owner>/<repo>/tree/<ref>/<path>`, is read as raw files from `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>/`. A tag or commit gives a fixed install; a branch gives whatever it holds at install time.
- Any other `https` URL is the folder itself, and each file is fetched at `<url>/<file>`.
- `http://` is accepted only for loopback hosts, for local testing.

The CLI checks that the downloaded files agree with each other. A failed check exits nonzero before writing that application's files.

- The template's `plugin.artifactDid` equals the downloaded plugin's computed `artifactDid`, and its `target.applicationDid` equals the plugin's `applicationDid`.
- `bridge/package.json` has a `name` and an exact `version`, not a range or tag, and npm has that version.
- `--plugin` and `--config-template` replace the downloaded file with one the operator chose, and get the same checks.

These checks catch mixed-up or partial folders. They do not decide whether to trust the source. Installing from a URL trusts whoever controls that URL, as `npm install <git url>` does. The output prints the source URL and the plugin's `artifactDid`, and the docs say so plainly. Independent evidence about a plugin, such as attestations bound to its `artifactDid`, is outside this feature.

#### Name

The application's local name is `--name`, or else the last folder name in the URL. It names the bridge config, the deployment config, the plugin copy, the install record, and the harness entry `<name>-mpas`, and it is the `<app>` that `mpas signer` and `mpas config validate` take later. It must be lowercase letters, digits, and hyphens.

If this home already uses the name, the command writes nothing and exits nonzero, asking the user to choose another with `--name`. A name is in use when `installed/<name>.json` exists, a bridge config, draft, or live deployment config with that name exists, or, for a Proposer, the selected harness already has a server named `<name>-mpas`. `--replace-config` is allowed in two cases. It reinstalls the same application when the install record names the same source URL, and the error says so. It also takes over an application config set up by hand, which has no install record, as the migration steps in §7.6 use it; this needs an existing bridge config, draft, or live config with the name. In both cases a harness server named `<name>-mpas` must launch this home's bridge config for that name. A server that runs anything else belongs to someone else and is never replaced. A name whose install record names a different source is a conflict even with `--replace-config`.

#### Maintainer

Maintainer `mpas mcp add` registers the signer server, as at Maintainer `init` (§9.1), to add it after `--harness none` or to retry a failed registration. It replaces the `mpas-coordination` entry in place.

#### Proposer

The command registers the bridge through the harness's own CLI when that harness has one, so it does not invent a second config format or replace unrelated servers. OpenClaw uses `openclaw config set` for the one server key. A harness with no such CLI gets a merge of the one named server into its documented config file. Existing servers with other names are left in place. An existing server with the same name is a name conflict (above), except when `--replace-config` reinstalls the same source, which updates that entry only.

- Downloads `plugin.json` and `bridge/package.json` from the URL, or copies `--plugin`, prints the source URL and the plugin's `artifactDid`, and writes the plugin to a file named for that artifact (§8.1).
- Records what it installed in `installed/<name>.json`.
- Requires a Verifier DID already stored by init or `mpas config`. If it is missing, writes nothing for that app and exits nonzero with the config command to run.
- Writes `actionEndpoint.url` and `actionEndpoint.verifierDid`. Does not write `adapter.url`.
- Registers only `<name>-mpas`. Does not register the signer server.
- Handles the proposer skill and prints the preamble for the selected harness (§11), plus the application's README link.

Proposer bridge files use one shape. `actionEndpoint.url` is the Action URL. `actionEndpoint.verifierDid` is the Verifier DID. These files omit `adapter`. A bridge file is written only after the Verifier DID is known. This feature does not change the generated bridge, which already accepts that shape. `additionalRecipients` is omitted. This feature does not accept extra recipients.

`target.applicationDid` comes from the downloaded plugin. `coordination.url` comes from `--coordination`. `workflow.dbPath` is `$MPAS_HOME/workflows/<app>.db`. The config also has `mode: "proposer"`, `plugin` set to the local plugin copy, and `agent.did` and `agent.keyFile` for the account's key.

`mpas mcp add` does not clone `mpas-applications` and does not compile a bridge.

1. `bridge/package.json` in the application folder gives the bridge's npm package name and exact version.
2. The command downloads `plugin.json` into `plugins/`. It does not download the bridge source.
3. The harness entry starts that npm package when the agent launches the server, using the launch rules in §10:

```text
npx -y <bridge-package>@<version> --config <absolute-bridge-config>
```

npm downloads the bridge at that launch. The command must resolve the package metadata enough to confirm the name and version exist. Unit tests inject that lookup and do not call the network.

If the package is not published on npm, the command still stores the plugin and bridge config when the rest of the inputs are present, and harness registration fails with the package name it could not find. It must not point the harness at a source checkout's `dist/` path.

The Maintainer server is different. It is the signer shipped inside `@oma3/mpas-cli`, not an application bridge. Its harness command is that installed `mpas` binary, or the pinned `npx` form from §6, with the signer config path.

#### Verifier

This role has no agent harness. `--harness` exits nonzero. The command makes the application visible to the Credential Adapter. It does not configure it. Each upstream server needs its own setup, such as OAuth, a token, or a container, which the application's README covers. Signer DIDs are added with `mpas signer add` (§9.6). Thresholds and approval rules are the operator's decision.

1. Download the plugin and the deployment config template from the URL and check that they agree. Print the source URL and the plugin's `artifactDid`. Do not launch the upstream server. Do not accept a credential value on the command line.
2. Write `config/drafts/<name>-adapter-config.json`: the template with `plugin.path` pointing at the local plugin copy. Leave everything else in the template unchanged, including placeholders, signer groups, signer keys, credential bindings, `executionTarget`, and policy.
3. Record what it installed in `installed/<name>.json`.

Plugin copies are named for their `artifactDid` and are never replaced with different content. A replacement draft that brings a newer plugin writes a new file beside the old one, so the live config keeps the exact plugin it was validated with until the operator moves the new draft in. Older plugin files are not deleted.

The draft stays out of `config/` because the Credential Adapter loads every `.json` file there and refuses to start if any one is invalid. The operator adds signers with `mpas signer add`, follows the README for upstream setup, then moves the draft into `config/` once `mpas config validate <app>` passes.

An application whose name is already in use exits nonzero, as above. `--replace-config` reinstalls the same source URL under the same name: it writes a new draft, renames an earlier draft with a timestamp, and never replaces a live config or a key.

After a successful write, print the README link, the `mpas signer add` commands for this application, `mpas config validate <app>`, and `mpas adapter start` with the config, credential, adapter-key, and journal paths under the home. Add `--verifier-relay-url` and `--verifier-relay-state` only in relay mode (§9.2). The adapter's own defaults ignore `$MPAS_HOME`, so the printed command passes every path. Do not run that command.

#### Install record

`installed/<name>.json` records the source URL, the URL each file came from, the plugin's `artifactDid` and `applicationDid`, the bridge package and version for a Proposer, and the install time. Later checks of that application use the record, so a change at the source never changes what `mpas config validate` expects. The update is explicit: `mpas mcp add <same url> --replace-config` installs again and replaces the record. A home without a record, such as one set up by hand, gets the existing config checks only.

#### Errors

- A name already in use in this home exits nonzero, writes nothing, and asks for a different `--name`. `--replace-config` is allowed only to reinstall the same source URL under the same name, or to take over a config with no install record, and never replaces a key file or a live config.
- A source folder without a file the role needs, or downloads that fail their checks, exit nonzero before writing that application's files.

#### Acceptance criteria

- `mpas mcp add <fixture-url> --harness cursor` without a stored Verifier DID exits nonzero and writes no bridge config, including when the Action URL is localhost.
- The same add after the DID is stored writes `actionEndpoint.url` and `actionEndpoint.verifierDid`, does not write `adapter.url`, and registers only `<fixture>-mpas` without removing other Cursor servers.
- A Verifier template whose `plugin.artifactDid` or `target.applicationDid` does not match the downloaded plugin exits nonzero and writes no file. A source folder without `plugin.json`, a Proposer source without `bridge/package.json`, or a Verifier source without `adapter-config.example.json` exits nonzero and writes no file.
- `mpas mcp add https://github.com/<owner>/<repo>/tree/<ref>/applications/railway` downloads each file from `raw.githubusercontent.com` at that ref and installs under the name `railway`. Any other `https` URL is treated as the folder itself.
- A second `mpas mcp add` whose name is already used in the home, by an install record, a config, or a `<name>-mpas` harness entry, exits nonzero, writes nothing, and names `--name`. The same command with `--name <other>` succeeds and leaves the first application unchanged. Reinstalling the same source URL under the same name succeeds only with `--replace-config`, and a different recorded source fails even with it. `--replace-config` takes over a bridge config set up by hand, which has no install record, only when its harness entry launches that bridge config, and never replaces an unrelated harness server.
- `mpas mcp add --harness cursor` on a Maintainer account registers `mpas-coordination`. A URL on a Maintainer account exits nonzero.
- `mpas mcp add --role verifier <fixture-url>` writes the plugin and `config/drafts/<fixture>-adapter-config.json`, identical to the template except `plugin.path`. It writes nothing in `config/` and no harness entry. It prints the README link, `mpas config validate <fixture>`, and `mpas adapter start` with `--verifier-relay-url` only in relay mode, including for a loopback relay, and never in direct mode, including for a remote adapter.
- A replacement draft that brings a newer plugin leaves the plugin file the live config uses unchanged, and the live config still loads.
- A harness entry named `github-mpas-mirror` whose arguments point at a bridge config blocks registering the signer in that harness location. An unrelated server named `other-mpas` does not.

#### Applications and release gate

The registry in this repository stays a directory for people. An entry gives the folder URL in an optional `source` field, documented in `application-registry/README.md`, which replaces the earlier `install` field. A registry change needs no CLI release, since the CLI never reads it.

`mpas mcp add` needs these from an application's folder: a README that explains the upstream setup, a deployment config template for Verifiers, and a bridge published on npm for Proposers. Each template has a `proposers` group and an `approvers` or `maintainers` group, so `mpas signer add` works without options. As of 2026-10-10, GitHub, Netlify, Railway, and Upstash in `mpas-applications` have a README and a template, and no application has a published bridge. Verifier installs can work for those four once this section is implemented. Proposer installs wait for a published bridge.

Release gate: the README and guides present `mpas mcp add` as the main setup path only after one real application has all three, and a test against the packed `@oma3/mpas-cli` has installed it end to end from its URL. That test runs `mpas init` and `mpas mcp add` for each role, starts the generated bridge and signer entries exactly as a harness would, completes an MCP `tools/list` on each, and starts the Credential Adapter with the printed command. Until then, the docs present `mpas mcp add` beside the manual steps, not in place of them.

### 9.6 `mpas signer`

```text
mpas signer add --app <app> --proposer <did> [--label <text>]
mpas signer add --app <app> --maintainer <did> [--group <name>] [--label <text>]
mpas signer remove --app <app> <did>
mpas signer list --app <app>
```

| Parameter | Flag | Default | Prompts |
|---|---|---|---|
| Application | `--app <name>` | None | Yes. Names an application installed under that name (§9.5). Empty is rejected. |
| Signer DID | `--proposer <did>` or `--maintainer <did>` | None | No. `mpas signer add` only. |
| Signer group | `--group <name>` | `maintainers` when present, otherwise `approvers` | No. `mpas signer add --maintainer` only. |
| Signer label | `--label <text>` | `Proposer` or `Maintainer` | No. `mpas signer add` only. |

Adds and removes the Proposer and Maintainer DIDs an application trusts, one at a time, so the Verifier's operator does not hand-edit the deployment config. Requires the Verifier role. Each command acts on the application's draft in `config/drafts/` when one exists, and otherwise on its live config in `config/`. It prints which file it changed. The Credential Adapter reads deployment configs at start, so a change to a live config takes effect after the adapter restarts.

`add`:

- A Proposer DID goes into `policy.signerGroups.proposers`. A Maintainer DID goes into `--group` when given, otherwise `maintainers` when that group exists, otherwise `approvers`. The DID is also added to `policy.signerGroups.all` and to `signerKeys`, labeled with `--label` or the default `Proposer` or `Maintainer`. A label tells several maintainers apart.
- The first DID added to a group replaces that group's placeholders. A placeholder is an entry that is not a DID, such as `REPLACE_WITH_APPROVER_DID`, or a `did:example:` DID. A placeholder is also removed from `all` and `signerKeys` once no group lists it.
- A DID already in the group is a no-op. The DID must be a valid `did:jwk`, because the command does not take a public key for other DID methods.
- The group must already exist. The command does not create or rename groups, and it does not change thresholds, match conditions, policies, or `defaultRequirement`. A missing group exits nonzero and names [oma3dao/mpas#6](https://github.com/oma3dao/mpas/issues/6).

`remove` takes the DID out of every signer group and out of `signerKeys`. It warns when a group becomes empty, because operations that need that group can no longer be approved. After a key rotation, the operator removes the old DID this way.

`list` prints each signer group with its DIDs and labels, and marks placeholders. It changes nothing.

`add` and `remove` replace the file atomically and leave every field other than the signer groups and `signerKeys` unchanged. Invalid input exits nonzero and changes nothing. After a change, the command prints `mpas config validate <app>`.

Acceptance criteria:

- `mpas signer add --app <fixture> --maintainer <did>`, run three times with three DIDs and labels, puts all three in `approvers`, `all`, and `signerKeys`, and removes the template's approver placeholder. Running it again with one of those DIDs changes nothing. `policies` and `defaultRequirement` are unchanged.
- `mpas signer add --maintainer <did> --group <missing>` exits nonzero and changes nothing. `mpas signer remove --app <fixture> <did>` removes the DID from every group and from `signerKeys`.
- `mpas signer add` on an account without the Verifier role exits nonzero.

## 10. Harness Registration

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

Registration adds one named server and preserves unrelated servers. It replaces a server of the same name only for `--replace-config` of the same source (§9.5), and for the Maintainer's `mpas-coordination` entry, which Maintainer `mpas mcp add` exists to retry (§9.1). A second Proposer application is a second `mpas mcp add`.

Generated entries do not depend on the harness's `PATH` or on a shell, because apps opened from the Dock often lack the user's shell `PATH`, and `npx`, `mpas`, and bridge binaries start with `#!/usr/bin/env node`. The entry's `command` is the absolute path of the Node executable that ran the installer (`process.execPath`). Its environment sets `PATH` with that executable's directory first. Its `args` start with the absolute path of the `npx` or `mpas` script.

Each agent has one MPAS role. Existing entries are read structurally from each harness's config, including Codex's TOML, whose table names may be bare or quoted. A config that cannot be parsed stops the command before any server is added or removed. The command identifies existing MPAS entries by the config file their arguments point to, not by their names: a `*-mcp-bridge-config.json` is a Proposer bridge, and `maintainer-signer-config.json` is the Maintainer signer. Entries added by hand under other names, such as `github-mpas-mirror`, are recognized the same way, and an unrelated server whose name happens to end in `-mpas` is not. The command refuses to register the signer in a harness location that already has a Proposer bridge, and refuses a Proposer bridge where the signer is registered. It exits nonzero and names `--harness-home` as the way to use a separate location.

An unknown harness name, a missing harness CLI, or a requested write that cannot be completed exits nonzero after any identity, service URL, or application config already saved. The error includes the server name, command, and absolute arguments.

## 11. Instruction Text and Skills

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

## 12. Process Commands

This feature does not add process commands. The CLI already has:

| Command | Process |
|---|---|
| `mpas adapter start` | Credential Adapter only. This is the Verifier process. |
| `mpas coordination start` | Coordination Service only. |
| `mpas daemon start` | Credential Adapter and Coordination Service together, for a local demo. |

`mpas daemon start` rejects a hosted relay URL. Hosted Verifier mode remains `mpas adapter start --verifier-relay-url <url>`. There is no `mpas process start` command, and this feature does not add one.

These commands do not start an OpenClaw gateway or any other agent harness.

`init`, `config`, `key`, `mcp`, and `signer` do not call any start command.

## 13. CLI README

The operator document is the opening section of `cli/README.md`, ahead of the existing architecture material. It is the README npm shows for `@oma3/mpas-cli`. It is written for a person and for an agent that is asked to run the CLI. It lists the install command, the three roles, `mpas init`, `mpas config` and `mpas config validate`, `mpas key rotate`, Proposer `mpas mcp add`, Maintainer signer registration at init, Verifier `mpas mcp add` as the command that installs the plugin and a deployment config draft, the source URL both take and where to find one, and `mpas signer` for adding and removing signer DIDs. It points to each application's README for upstream setup, and points policy-rule editing at oma3dao/mpas#6. It does not restate the HTTP profile. This feature spec stays the design record. The README is the usage record.

Acceptance criteria:

- `cli/README.md` opens with an operator section showing npm install, `mpas init`, `mpas config`, `mpas key rotate`, `mpas mcp add`, and `mpas signer` for a human or an agent that has not read this spec.
