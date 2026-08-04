# Application Registry

This folder contains one JSON file per MPAS implementation for a given application.

## Purpose

Registry entries describe MPAS-compatible implementations — bridges, native MCP servers, or native applications — that users can install to get MPAS protection for a particular application.

Each entry points to the plugin for that implementation. The registry is a discovery and identity document; launch and runtime configuration belong in the implementation's own repository.

## File Naming Convention

Files are named `{application}-{github-org}.json`:

- `{application}` — the target application, lowercase, hyphens for multi-word names
- `{github-org}` — the GitHub organization or user handle of the publisher

Examples: `github-demo-oma3dao.json`, `github-wivity.json`, `slack-wivity.json`, `kubernetes-acme-corp.json`

Multiple implementations of the same application get separate files because they have different publishers (and different application DIDs if they differ materially).

## Schema (v1)

Each JSON file has the following structure:

### Top-Level Fields

| Field            | Required | Description                                                                 |
| :--------------- | :------: | :-------------------------------------------------------------------------- |
| `version`        | Yes      | Registry entry schema version. Currently `"1"`.                             |
| `application`    | Yes      | Identity and description of this MPAS integration.                          |
| `native`         | Yes      | `true` if the application natively verifies MPAS. `false` if it requires a bridge. |
| `protocol`       | Yes      | The protocol/API format: `"mcp"`, `"openapi"`, `"a2a"`, `"evm"`, etc.      |
| `upstream`       | No       | The upstream server being wrapped. Present only when `native` is `false`.   |
| `plugin`         | Yes      | Where to find the `MpasApplicationPlugin` for this application.             |
| `publisher`      | Yes      | Who publishes and maintains this implementation.                            |
| `status`         | Yes      | Implementation status: `"active"`, `"beta"`, `"planned"`, or `"deprecated"`. |

### `application` Object

| Field            | Required | Description                                            |
| :--------------- | :------: | :----------------------------------------------------- |
| `name`           | Yes      | Human-readable application name.                       |
| `description`    | Yes      | Brief description of what this MPAS integration does.  |
| `applicationDid` | Yes      | DID of the target application (matches the plugin's `applicationDid`). |

### `upstream` Object (bridges only)

Present when `native` is `false`. The object format depends on the `protocol` field.

**For `"mcp"` protocol:**

| Field             | Required | Description                                         |
| :---------------- | :------: | :-------------------------------------------------- |
| `name`            | Yes      | Human-readable name of the upstream MCP server.     |
| `protocolVersion` | Yes      | MCP protocol revision observed for this integration. Discovery hint only; the installed plugin is authoritative at runtime. |
| `repository`      | No       | Upstream source repository URL. Omit when private or unknown. |
| `distributionUrl` | No       | Page where a human can obtain the pinned upstream artifact (versioned npm/PyPI/release/commit URL, or hosted endpoint). Launch pins live in the implementation repo. |
| `toolSurface`     | No       | Digest of the discovered upstream tool surface (`{ "alg": "sha-256", "value": "<base64url>" }`). Advisory drift signal, not a runtime control. |

Future protocols (OpenAPI, EVM, A2A) will define their own upstream object formats.

### `plugin` Object

| Field         | Required | Description                                                    |
| :------------ | :------: | :------------------------------------------------------------- |
| `repository`  | Yes      | URL locating the plugin file (or its directory).               |
| `pluginDid`   | No       | Stable DID of the plugin line across versions.                 |
| `artifactDid` | No       | Content-addressed identity of these plugin bytes (`did:artifact:<cidv1>`). |

`pluginDid` is the stable line identity (follow for updates). `artifactDid` is the hash of one exact `plugin.json` (verify on install). Recompute `artifactDid` in the same change that edits the plugin — a stale value fails verification. Derived by RFC 8785 (JCS) canonicalization, SHA-256, CIDv1 (raw codec), base32lower.

### `publisher` Object

| Field          | Required | Description                                      |
| :------------- | :------: | :----------------------------------------------- |
| `name`         | Yes      | Human-readable publisher name.                   |
| `githubOrg`    | Yes      | GitHub organization or user handle.              |
| `publisherDid` | No       | Publisher's DID.                                 |
| `repository`   | No       | Publisher's primary repository for this implementation. |

## Integration Types

### Bridge (`native: false`)

A bridge wraps an existing non-MPAS application and adds MPAS approval enforcement. The user runs it instead of (or in front of) the upstream server. Bridges need a credential adapter at runtime; which adapter is out of scope for the registry entry.

### Native (`native: true`)

MPAS verification is built in — no bridge or credential adapter. The application still needs a plugin describing its operation surface.

## Adding an Entry

1. Create a JSON file named `{application}-{your-github-org}.json`
2. Follow the schema above
3. Ensure your plugin exists at the referenced location
4. If you set `plugin.artifactDid`, confirm it matches the plugin as published
5. Submit a pull request

## Keeping an Entry Current

Treat the registry entry as part of the implementation change, not follow-up:

- `plugin.artifactDid` — recompute when `plugin.json` changes
- `upstream.toolSurface` — recapture when the upstream tool surface changes

Both are optional. Omit either if you will not keep it current — a stale value looks verified but is wrong. Consumers can compute the artifact DID from the plugin themselves.

## Notes

- The plugin is authoritative for the operation surface; the registry does not duplicate action lists.
- Runtime configuration (launch command, env, pins) belongs in the implementation repository.
- Credential adapters are infrastructure and are not specified per application.
