# Implementation Plan: MPAS Participant Installer

**Spec:** [spec.md](./spec.md)

**Created:** 2026-10-07

**Updated:** 2026-10-08

**Status:** Draft

Behavior is defined in the spec. This plan is the build order and the tests. Tests use a temporary `--home`, an injectable prompt, an injectable `process.execPath`, and injectable harness, registry, manifest, download, and npm-lookup runners. They do not call the network, listen on a port, or print a private JWK.

Each phase starts by writing that phase's tests from the list below and running them red. Implementation of the phase then turns that file green. Do not write a separate commit per test. A later phase may add tests, and it does not rewrite an earlier phase's tests to match the code.

---

## Phase 0: Package and bundled inputs

Exit criterion: every test in this phase passes, and the existing CLI tests and `examples/demo` typecheck still pass.

- `examples/demo/package.json` is named `@oma3/mpas-cli`, is not private, keeps the `mpas` bin, and lists `dist/`, the registry snapshot, and the skills in `files`. It has `publishConfig` with `"access": "public"` and the npm registry, `repository.directory` set to `examples/demo`, and a `prepack` script that runs the build, matching `sdk/protocol/package.json`.
- `npm pack --dry-run --json` lists only `dist/`, the registry snapshot, the skills, `package.json`, `README.md`, `LICENSE`, and `NOTICE`. It lists nothing under `tests/`, because the test fixtures include committed private keys.
- The build copies `application-registry/*.json` and `integrations/skills/mpas-proposer/` and `mpas-maintainer/` into the package, byte-identical to the sources.
- The bundled registry loads. An entry with `install` has `manifestUrl` and a `sha-256` `manifestDigest`. `application-registry/README.md` documents `install`.
- The preamble extractor returns the fenced prime-directive block from each bundled `SKILL.md`. A `SKILL.md` without that block fails the test.

## Phase 1: `mpas init`

Exit criterion: every test in this phase passes.

- Proposer, terminal, no flags: prompts for coordination, action, and verifier DID. Does not prompt for home, suite, app, or harness. Empty URL answers store `http://127.0.0.1:7545` and `http://127.0.0.1:7544`. Empty verifier DID leaves it unset. No bridge file.
- Proposer, non-interactive, missing `--coordination` or `--action`: exit nonzero, no files. Both present without `--verifier-did`: succeeds with the DID unset.
- Proposer, flags supplied: stores those values, including `https://api.signerset.com`, and does not prompt.
- Verifier, terminal: prompts for action only. Does not prompt for coordination, harness, or any DID. No application config file.
- Verifier, non-interactive, missing `--action`: exit nonzero, no files. `--action local` alone succeeds. `--proposer-did` and `--maintainer-did` exit nonzero.
- Maintainer, terminal: prompts for coordination and harness. Empty harness answer is rejected. `none` is accepted. Empty coordination answer stores the localhost default. No proposer bridge.
- Maintainer, non-interactive, missing `--coordination` or `--harness`: exit nonzero, no files.
- Maintainer, `--harness none`: writes the signer config, calls no harness runner, prints no preamble, and prints `mpas action pending --config <absolute signer config>`. The `--harness cursor` case is in Phase 3, with the harness writers.
- `--suite` omitted writes Ed25519. `--suite P-256` writes P-256. An unknown suite exits nonzero before any write. Suite is not prompted.
- `--home` and `$MPAS_HOME` select the directory and are not prompted. The key file is `keys/signing-key.json`, mode `0600`, for every role. New home directories are mode `0700`. `account.json` lists the role.
- `api.signerset.com`, `localhost` without a scheme, and any other scheme-less host exit nonzero and write nothing. `localhost` and `local` as the whole answer store that prompt's default. A URL that already contains `/mpas/v1` is stored unchanged.
- `--app` on init exits nonzero and writes nothing.
- Second init of the same role, with different URL, DID, and `--suite` flags: exit 0, no prompt, key bytes and saved values unchanged. Stdout says the home is already initialized and names `mpas config` and `mpas key rotate`.
- Init of a second role on the same account, terminal: the confirmation defaults to No, and No changes nothing. Yes adds the role, keeps the key bytes, and asks only the rows not already saved. Non-interactive: `--add-role` is required. No second key file is ever created. `--suite` with a new role exits nonzero. Adding Verifier to a Proposer account, or the reverse, prints the credential warning.
- A home with key files and no `account.json`: exit nonzero, names the files, changes nothing.
- Proposer and Verifier stdout have the public DID and no prime directive. No `init` creates or edits an instruction file.
- Stdout and stderr contain no private JWK. The command exits without listening.

## Phase 2: `mpas config`, `mpas config validate`, `mpas key rotate`, and `mpas signer`

Exit criterion: every test in this phase passes. Requires a home created by Phase 1.

- No account: exit nonzero, names `mpas init`, writes nothing.
- `mpas config` works when `--home` is not `~/.mpas`. `--role` on `mpas config` exits nonzero.
- `--verifier-did` on a Maintainer-only account, and `--suite`, `--proposer-did`, `--maintainer-did`, `--app`, or `--harness` on `mpas config`, exit nonzero and leave the home unchanged.
- Invalid DID or URL: exit nonzero, home unchanged.
- `mpas config` never changes key bytes.
- No change flags, terminal: prompts only the Yes rows for the account's roles. Return keeps a saved value. No change flags, non-interactive: prints the saved settings, exits 0, home unchanged. One or more flags: those flags change, and the other rows are not prompted.
- Proposer: a new `--verifier-did` replaces the stored one and rewrites `actionEndpoint.verifierDid` in an existing bridge file. The same DID is a no-op. `--coordination` and `--action` replace saved URLs and rewrite an existing bridge file.
- Maintainer: `--coordination` rewrites the signer config URL and does not edit the harness.
- Verifier: a changed `--action` renames `journal/verifier-relay.json` with a timestamp. An unchanged URL leaves it.
- The command does not edit a harness, does not listen, and rejects a credential or token flag.

`mpas config validate`:

- A new account of each role passes.
- Each failure names its file: key mode not `0600`, an `agent.did` that differs from the key, a bridge config with `adapter`, and a plugin copy that does not match the registry `artifactDid`.
- A Verifier draft with placeholders fails and names each placeholder field. A filled draft passes and prints the move command.
- Live deployment configs get the existing checks, and the existing `config validate <name> --config-dir` tests still pass.
- The home is byte-identical after validation, and no network call is made.

`mpas key rotate`:

- No account: exit nonzero.
- The old key's bytes are in `keys/signing-key.retired-<timestamp>.json` at mode `0600`. The new key is at `keys/signing-key.json`. `agent.did` is rewritten in the signer config and every bridge config. No harness runner is called.
- The default suite is the current key's suite. `--suite P-256` changes it.
- `--use <file>` moves a key made by `mpas key generate` into place. A file with the current DID, a malformed file, or `--use` together with `--suite` exits nonzero with the home unchanged.
- On a Verifier account, the relay state is renamed with a timestamp.
- Stdout has both DIDs and who must record the new one. Stdout and stderr contain no private JWK.

`mpas signer` (fixture drafts and live configs are written directly by the test, since `mcp add` is Phase 3):

- An account without the Verifier role: exit nonzero, nothing changed. Missing `--app` without a terminal: exit nonzero.
- `add --proposer` puts the DID in `proposers`, `all`, and `signerKeys` with label `Proposer`. Three `add --maintainer` calls with three DIDs and labels put all three in `approvers`, `all`, and `signerKeys` with those labels.
- The first add to a group removes that group's `REPLACE_WITH_*` and `did:example:` placeholders. A placeholder still listed by another group stays in `all` and `signerKeys`.
- A fixture with both `maintainers` and `approvers` puts a maintainer DID in `maintainers`. `--group humanApprovers` on a fixture that has that group puts it there. A missing group exits nonzero, names oma3dao/mpas#6, and changes nothing.
- A DID already in the group is a no-op. A DID that is not a valid `did:jwk` exits nonzero and changes nothing.
- `remove` takes the DID out of every group and `signerKeys`, and warns when a group becomes empty.
- `list` prints groups, DIDs, labels, and placeholders, and the file is byte-identical afterwards.
- With a draft and a live config for the same application, the draft changes and the live config is byte-identical. With only a live config, the live config changes and stdout says the adapter must restart.
- Every field other than the signer groups and `signerKeys` is unchanged after `add` and `remove`.

## Phase 3: `mpas mcp add`

Exit criterion: every test in this phase passes. Registry, manifest, plugin, template, package lookup, and harness CLI are injected.

- A manifest that does not match `manifestDigest`, a plugin that does not match `artifactDid` (downloaded or from `--plugin`), or a template that does not match its digest: exit nonzero, no files. A `bridge.version` range or tag exits nonzero.
- Account with more than one role: a terminal asks for the role. Non-interactive without `--role`: exit nonzero, no files.

Maintainer:

- `--app`: exit nonzero, no new file.
- `--harness cursor` after `init --harness none`: registers `mpas-coordination`.

Proposer:

- Terminal, missing `--app` or `--harness`: prompts. Empty answer rejected. Non-interactive omission: exit nonzero, no file.
- No stored verifier DID, with either the localhost Action URL or a hosted one: exit nonzero, no bridge file, stdout names `mpas config --verifier-did`.
- Stored verifier DID: bridge file has `actionEndpoint.url` and `actionEndpoint.verifierDid`, no `adapter`, no `additionalRecipients`. Harness gains only `<app>-mpas`. A pre-existing unrelated server remains. The same server name is replaced in place. Stdout has the proposer prime directive, names the selected harness's instruction file, and includes the README link.
- A second application adds a second bridge and a second server. The same application without `--replace-config` exits nonzero. With `--replace-config`, the app file is rewritten and the key file is not.
- Unknown application: exit nonzero before any write.
- Fixture names a package and version: harness command is `npx -y <package>@<version> --config <absolute path>`. Fixture has no package: plugin and bridge config are kept, harness registration fails, and the command does not point at a `dist/` path.
- `--config-template` on a proposer exits nonzero.
- Paths in the written config are absolute. The launch entry is not a shell command and does not contain `~`. Its `command` is the injected `process.execPath`, and its `PATH` starts with that file's directory.

Verifier:

- `--harness`: exit nonzero, no file.
- Writes the plugin and `config/drafts/<app>-adapter-config.json`, deep-equal to the template except `plugin.path`. Nothing is written in `config/`.
- A manifest without a template: plugin kept, no draft, exit nonzero with the README link.
- Loopback Action URL (`localhost`, `127.0.0.1`, `[::1]`): stdout prints the README link, the `mpas signer add` commands for the application, `mpas config validate <app>`, and `mpas adapter start` without `--verifier-relay-url`. Any other Action URL: the same command plus `--verifier-relay-url` and `--verifier-relay-state`. Every printed path is under the home. The process is not spawned and no harness file is written.
- Existing draft or live config without `--replace-config`: exit nonzero. With it: a new draft, the earlier draft renamed with a timestamp, and the live config and key unchanged. A second application is a second invocation.
- `--plugin` is still checked against `artifactDid`. `--config-template` skips the digest check.

Harness, shared by maintainer init and proposer add:

- Maintainer `init --harness cursor` with a pre-existing unrelated server: writes the signer config and one `mpas-coordination` entry. The other server is unchanged. No application bridge. Stdout has the maintainer prime directive and names the selected harness file.
- Codex calls the injected `codex mcp add` with `CODEX_HOME` set to the role-specific home. It does not target `~/.codex` unless `--harness-home` points there.
- Claude Code calls the injected `claude mcp add-json --scope user`. `--harness-home` sets `CLAUDE_CONFIG_DIR`.
- OpenClaw calls the injected `openclaw config set` for one server key. An existing `tools.allow` list gains `<name>__*` and keeps its other entries. An unset `tools.allow` stays unset. Stdout names `openclaw gateway restart`, and it is not run.
- Claude Desktop writes the macOS path. On any other OS it prints JSON and writes no guessed path.
- Hermes writes one `mcp_servers` entry with `command` and `args`. Cursor writes one `mcpServers` entry.
- An entry whose arguments point at a `*-mcp-bridge-config.json` blocks registering the signer in that harness location, including one named `github-mpas-mirror`. An entry pointing at `maintainer-signer-config.json` blocks a Proposer bridge. An unrelated server named `other-mpas` blocks neither. Each refusal exits nonzero and names `--harness-home`.
- Skills: the role skill is copied to `<home>/skills/mpas-<role>/`. `install` also copies it into the harness skills folder, replacing only that skill's earlier copy. `print` writes nothing more. Claude Desktop writes `<home>/skills/mpas-<role>.zip`. `--skill install` with `openclaw` or `claude-desktop` exits nonzero.
- Unknown harness or missing harness CLI: exit nonzero after the identity and application config are saved. The error includes the server name, command, and absolute arguments. The key and account file are still present.
- A failed harness write does not remove a key, service URL, or valid application config.
- No instruction file is written. No command listens.

## Phase 4: End-to-end

Exit criterion: the test passes. Three temporary homes, one fixture application, non-interactive, no network.

- `init maintainer --harness cursor` into a temporary Cursor home, `init verifier --action local`, and `init proposer --coordination local --action local`. No DIDs are passed.
- `mpas config --verifier-did` on the Proposer, then Proposer `mcp add` and Verifier `mcp add`.
- On the Verifier, `mpas signer add --proposer` and `mpas signer add --maintainer` add the two DIDs to the draft. The test moves the draft into `config/`, standing in for the operator.
- `mpas config validate` passes on all three homes, and the Credential Adapter's `loadDeploymentConfigs` loads the Verifier's `config/`.
- `mpas key rotate` on the Proposer, then `mpas signer remove` of the old DID and `mpas signer add` of the new one on the Verifier: `mpas config validate` still passes on both homes, and the old DID is gone from the Verifier's config.
- No process was started and no port was opened.

## Phase 5: Help text and operator docs

Exit criterion: every test in this phase passes.

- `mpas --help` lists `adapter start`, `coordination start`, `daemon start`, the new commands, and every other existing command, including `config validate` and `key generate`.
- `mpas --help` does not list `process start` or a bare `start`.
- The opening section of `examples/demo/README.md` tells a person or an agent the npm install, `init`, `config` and `config validate`, `key rotate`, proposer `mcp add`, maintainer registration at init, verifier `mcp add`, `signer add`, `remove`, and `list`, and oma3dao/mpas#6 for approval rules.
- `examples/demo/guides/proposer.md`, `maintainer.md`, and `credential-adapter.md` lead with those commands. `setup-macos.md` uses one `--home` per participant for the single-machine demo.
- `examples/demo/RELEASING.md` exists, modeled on `sdk/protocol/RELEASING.md`, and contains the steps in the Release section below.

## Release (performed by a person)

Publishing needs an npm account with 2FA in the `oma3` organization, so a person does it. The implementing agent does not publish. These steps follow `sdk/protocol/RELEASING.md`.

First release only:

- Confirm the publisher's npm account can create packages in the `@oma3` scope. Access requests go to the `oma3` organization's admins, as described in `sdk/protocol/RELEASING.md`.
- Confirm the name is unclaimed: `npm view @oma3/mpas-cli` returns 404.

Each alpha release, replacing `N` with the next alpha number:

```sh
cd examples/demo
npm ci
npm version 0.1.0-alpha.N --no-git-tag-version
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm pack
```

Inspect the pack output. It must contain only the files listed in Phase 0, and no `tests/` directory or key file. The registry snapshot in the package is whatever `application-registry/` holds at this commit, so registry changes ship with this release.

Install the tarball into a temporary prefix and check that it runs without the repository:

```sh
tmp=$(mktemp -d)
npm install -g --prefix "$tmp" ./oma3-mpas-cli-0.1.0-alpha.N.tgz
"$tmp/bin/mpas" --help
"$tmp/bin/mpas" init proposer --home "$tmp/home" --coordination local --action local
```

Commit the version and lockfile changes, complete review, and publish from the reviewed commit:

```sh
npm login --auth-type=web
npm whoami
npm publish --access public --tag alpha
npm dist-tag add @oma3/mpas-cli@0.1.0-alpha.N latest
```

Confirm the published version, the dist-tags, and a one-shot run:

```sh
npm view @oma3/mpas-cli@alpha version
npm dist-tag ls @oma3/mpas-cli
npx -y @oma3/mpas-cli@alpha --help
```

## Done

- The tests above pass, and the existing CLI tests and `examples/demo` typecheck pass.
- `sdk/protocol/` has no diff. If `generateMpasKey` or `isDidJwk` cannot do the job, stop before adding an SDK export.
- Do not publish `@oma3/mpas-cli` while implementing this plan. A person publishes it by following the Release section.
- The `mpas-applications` work in spec §19 is tracked in that repository. Until a real application has a manifest, `mcp add` is exercised only with fixtures.
