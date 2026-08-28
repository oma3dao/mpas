# Releasing `@oma3/mpas`

## Ownership and access

- npm organization/scope: `oma3` / `@oma3`
- Package: `@oma3/mpas`
- Current publisher: Alfred Tom (`oma3-ops`)

The `oma3` organization owns the package namespace. Each publisher uses an
individually controlled npm account added to the organization. Accounts and
credentials must not be shared.

Every publisher must enable npm 2FA for authorization and writes. Passkeys are
preferred. Never commit npm tokens or `.npmrc` authentication values, and keep
account recovery credentials secure.

Access requests should include the npm username, OMA3 email, required role,
and reason for access. Publishers normally need Member access plus package or
team write access. Admin and Owner access should be limited to people who
manage access, organization settings, or billing.

## Alpha release process

Alpha versions use the `0.1.0-alpha.N` format and the npm `alpha` dist-tag.
From the directory containing the `mpas` repository, run the following,
replacing `N` with the next alpha number:

```sh
cd sdk/protocol
npm ci
npm version 0.1.0-alpha.N --no-git-tag-version
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm pack
```

Inspect the pack output before continuing. It must contain only the compiled
`dist/` output, `package.json`, `README.md`, and `LICENSE`. Install the packed
tarball in a clean consumer project—or preferably a freshly generated MPAS
bridge—and verify that it builds without a local SDK path.

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
npm dist-tag add @oma3/mpas@0.1.0-alpha.N latest
```

Confirm the published version and dist-tags:

```sh
npm view @oma3/mpas@alpha version
npm dist-tag ls @oma3/mpas
```

Stable releases use the `latest` dist-tag instead of `alpha`.
