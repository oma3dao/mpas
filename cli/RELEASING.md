# Releasing `@oma3/mpas-cli`

`@oma3/mpas-cli` is published from `cli`. A person publishes it,
because publishing needs an npm account with 2FA in the `oma3` organization.
This process follows [`sdk/protocol/RELEASING.md`](../sdk/protocol/RELEASING.md),
which also covers organization access and account rules.

## First release only

- Confirm that your npm account can create packages in the `@oma3` scope.
  Access requests go to the `oma3` organization's admins, as described in
  `sdk/protocol/RELEASING.md`.
- Confirm the name is unclaimed: `npm view @oma3/mpas-cli` returns 404.

## Alpha release process

Alpha versions use the `0.1.0-alpha.N` format and the npm `alpha` dist-tag.
From the directory containing the `mpas` repository, run the following,
replacing `N` with the next alpha number:

```sh
cd cli
npm ci
npm version 0.1.0-alpha.N --no-git-tag-version
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm pack
```

Inspect the pack output. It must contain only `dist/` (including
`dist/bundled/registry/` and `dist/bundled/skills/`), `package.json`,
`README.md`, `LICENSE`, and `NOTICE`. It must not contain `tests/` or any key
file. The registry snapshot in the package is whatever `application-registry/`
holds at this commit, so registry changes ship with this release.

Install the tarball into a temporary prefix and check that it runs without the
repository:

```sh
tmp=$(mktemp -d)
npm install -g --prefix "$tmp" ./oma3-mpas-cli-0.1.0-alpha.N.tgz
"$tmp/bin/mpas" --help
"$tmp/bin/mpas" init proposer --home "$tmp/home" --coordination local --action local
npm_config_cache="$tmp/cache" npx -y ./oma3-mpas-cli-0.1.0-alpha.N.tgz --help
```

The last line checks the one-shot form users run with `npx -y @oma3/mpas-cli@alpha`. It works because the package has a `mpas-cli` command named after the package.

Commit the version and lockfile changes, complete review, and publish from the
reviewed commit. Authenticate with npm using the web/passkey flow and verify
the active identity:

```sh
npm login --auth-type=web
npm whoami
```

Publish the prerelease:

```sh
npm publish --access public --tag alpha
npm dist-tag add @oma3/mpas-cli@0.1.0-alpha.N latest
```

Confirm the published version, the dist-tags, and a one-shot run:

```sh
npm view @oma3/mpas-cli@alpha version
npm dist-tag ls @oma3/mpas-cli
npx -y @oma3/mpas-cli@alpha --help
```

Stable releases use the `latest` dist-tag instead of `alpha`.
