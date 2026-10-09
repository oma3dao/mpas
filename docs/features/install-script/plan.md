# Implementation Plan: MPAS Participant Installer

**Spec:** [spec.md](./spec.md)

**Created:** 2026-10-07

**Updated:** 2026-10-08

**Status:** Draft

Behavior is defined in the spec. This plan is the build order and the tests. Tests use a temporary `--home`, an injectable prompt, and injectable harness and registry runners. They do not call the network, listen on a port, or print a private JWK.

Each phase starts by writing that phase's tests from the list below and running them red. Implementation of the phase then turns that file green. Do not write a separate commit per test. A later phase may add tests, and it does not rewrite an earlier phase's tests to match the code.

---

## Phase 1: `mpas init`

Exit criterion: every test in this phase passes.

- Proposer, terminal, no flags: prompts for coordination, action, and verifier DID. Does not prompt for home, suite, app, or harness. Empty URL answers store `http://127.0.0.1:7545` and `http://127.0.0.1:7544`. Empty verifier DID leaves it unset. No bridge file.
- Proposer, non-interactive, missing `--coordination`, `--action`, or `--verifier-did`: exit nonzero, no files.
- Proposer, flags supplied: stores those values, including `https://api.signerset.com`, and does not prompt.
- Verifier, terminal: prompts for action and both DID lists. Does not prompt for coordination or harness. Empty DID answer leaves that list unset. No application config file.
- Verifier, non-interactive, missing `--action`, `--proposer-did`, or `--maintainer-did`: exit nonzero, no files.
- Verifier, both DID flags set: stores both lists. Repeatable flags append each DID once.
- Maintainer, terminal: prompts for coordination and harness. Empty harness answer is rejected. Empty coordination answer stores the localhost default. No proposer bridge.
- Maintainer, non-interactive, missing `--coordination` or `--harness`: exit nonzero, no files.
- Maintainer, `--harness cursor` with a pre-existing unrelated server: writes the signer config and one `mpas-coordination` entry. The other server is unchanged. No application bridge.
- `--suite` omitted writes Ed25519. `--suite P-256` writes P-256. An unknown suite exits nonzero before any write. Suite is not prompted.
- `--home` and `$MPAS_HOME` select the directory and are not prompted. Key files are mode `0600`. New home directories are mode `0700`. The verifier key file is `keys/adapter-key.json`.
- `api.signerset.com`, `localhost` without a scheme, and any other scheme-less host exit nonzero and write nothing. `localhost` and `local` as the whole answer store that prompt's default. A URL that already contains `/mpas/v1` is stored unchanged.
- `--app` on init exits nonzero and writes nothing.
- Second init of the same role, with different URL, DID, and `--suite` flags: exit 0, no prompt, key bytes and saved values unchanged. Stdout says the home is already initialized and names `mpas config`.
- Init of a second role in the same home creates only the new key and says which role key already exists.
- Proposer stdout contains the proposer prime directive and names the three paste destinations. Maintainer stdout contains the maintainer prime directive and names the selected harness file. Verifier stdout has the public DID and no prime directive. None of the three create or edit an instruction file or a skill directory.
- Stdout and stderr contain no private JWK. The command exits without listening.

## Phase 2: `mpas config`

Exit criterion: every test in this phase passes. Requires a home created by Phase 1.

- No role key: exit nonzero, names `mpas init`, writes nothing.
- One role key and no `--role`: that role is selected, including when `--home` is not `~/.mpas`.
- Two role keys, terminal, no `--role`: prompts for the role. Non-interactive: exit nonzero, no write. `--role` skips the prompt and changes only that role.
- A flag for another role (`--proposer-did` on a proposer, `--verifier-did` or `--app` on a maintainer, `--harness` on a verifier) exits nonzero and leaves the home unchanged.
- Invalid DID or unknown suite: exit nonzero, home unchanged.
- `--suite` omitted: key bytes unchanged. `--suite P-256`, and `--suite` equal to the current suite: new key, both DIDs printed, previous key file kept at mode `0600`, signer or bridge configs retargeted to the new file.
- No change flags, terminal: prompts only the Yes rows for that role. Return keeps a saved value. One or more flags: those flags change, and the other rows are not prompted.
- Proposer: a new `--verifier-did` replaces the stored one. The same DID is a no-op. `--coordination` and `--action` replace saved URLs and rewrite an existing bridge file.
- Maintainer: `--coordination` rewrites the signer config URL and does not edit the harness.
- Verifier, no application file yet: DID flags are stored and no `config/<app>-adapter-config.json` is created.
- Verifier, application file present, template group `approvers`: `--proposer-did` appends to `proposers`, `all`, and `signerKeys` only. `--maintainer-did` appends to `approvers`, `all`, and `signerKeys` only. A repeated DID is a no-op.
- Same file with group `maintainers` and no `approvers`: the maintainer DID is appended to `maintainers` instead.
- `humanApprovers`, `executionTarget`, `policies`, and `defaultRequirement` are byte-for-byte unchanged. A second application file receives the same DID append.
- Template missing `proposers`, or missing both `maintainers` and `approvers`: exit nonzero, file unchanged.
- The command does not edit a harness, does not listen, and rejects a credential or token flag.

## Phase 3: `mpas mcp add`

Exit criterion: every test in this phase passes. Registry, plugin, template, package lookup, and harness CLI are injected.

Proposer:

- Maintainer home: exit nonzero, no new file, stdout names `mpas init maintainer`.
- Terminal, missing `--app` or `--harness`: prompts. Empty answer rejected. Non-interactive omission: exit nonzero, no file.
- No stored verifier DID, with either the localhost Action URL or a hosted one: exit nonzero, no bridge file, stdout names `mpas config --verifier-did`.
- Stored verifier DID: bridge file has `actionEndpoint.url` and `actionEndpoint.verifierDid`, no `adapter`, no `additionalRecipients`. Harness gains only `<app>-mpas`. A pre-existing unrelated server remains. The same server name is replaced in place.
- A second application adds a second bridge and a second server. The same application without `--replace-config` exits nonzero. With `--replace-config`, the app file is rewritten and the key file is not.
- Unknown application: exit nonzero before any write.
- Fixture names a package and version: harness command is `npx -y <package>@<version> --config <absolute path>`. Fixture has no package: plugin and bridge config are kept, harness registration fails, and the command does not point at a `dist/` path.
- `--config-template` on a proposer exits nonzero.
- Paths in the written config are absolute. The launch entry is not a shell command and does not contain `~`.

Verifier:

- `--harness`: exit nonzero, no file.
- Missing proposer list or missing maintainer list: exit nonzero, no file, stdout names the `mpas config` flags that record them.
- Both lists present, template uses `approvers`: `executionTarget` is copied, including credential placeholders and no credential value. DIDs land in `proposers`, `approvers`, `all`, and `signerKeys`. `humanApprovers`, `policies`, `defaultRequirement`, plugin DID, version, artifact DID, application DID, and execution profile are unchanged. `plugin.path` is the local copy.
- Template uses `maintainers` and not `approvers`: maintainer DID lands in `maintainers`.
- Template lacks `proposers`, or lacks both maintainer group names: exit nonzero, no file, stdout names oma3dao/mpas#6.
- Local Action URL: stdout prints `mpas adapter start` without `--verifier-relay-url`. Any other Action URL: the same command plus `--verifier-relay-url`. The process is not spawned and no harness file is written.
- Existing application without `--replace-config`: exit nonzero. With it: the application file is rewritten and the key is not. A second application is a second invocation.
- `--plugin` and `--config-template` supply the files the test injected.

Harness, shared by maintainer init and proposer add:

- Codex writes `config.toml` under the role-specific home. It does not write `~/.codex` unless `--harness-home` points there.
- OpenClaw calls the injected `openclaw config set` for one server key.
- Claude Desktop writes the macOS path. On any other OS it prints JSON and writes no guessed path.
- Hermes writes one `mcp_servers` entry with `command` and `args`. Cursor writes one `mcpServers` entry.
- Unknown harness: exit nonzero after the identity and application config are saved. The error includes the server name, command, and absolute arguments. The key and service file are still present.
- A failed harness write does not remove a key, service URL, or valid application config.
- No instruction file or skill directory is written. No command listens.

## Phase 4: Help text and operator docs

Exit criterion: every test in this phase passes.

- `mpas --help` lists `adapter start`, `coordination start`, and `daemon start`.
- `mpas --help` does not list `process start` or a bare `start`.
- `cli/README.md` tells a person or an agent the npm install, `init`, `config` with `--suite`, proposer `mcp add`, maintainer registration at init, verifier `mcp add`, and oma3dao/mpas#6 for approval rules.
- `examples/demo/guides/proposer.md`, `maintainer.md`, and `credential-adapter.md` lead with those commands.

## Done

- The tests above pass, and the existing CLI tests and `examples/demo` typecheck pass.
- `sdk/protocol/` has no diff. If `generateMpasKey` or `isDidJwk` cannot do the job, stop before adding an SDK export.
- Do not publish `@oma3/mpas-cli` from this plan unless the repository release process is explicitly invoked.
