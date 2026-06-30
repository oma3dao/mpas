# Application Registry

This folder contains one JSON file per MPAS implementation for a given application.

## Purpose

Registry entries describe MPAS-compatible implementations — bridges, native MCP servers, or native applications — that users can install to get MPAS protection for a particular application.

Each entry points to the source code and plugin needed to use MPAS with that application. The registry is a discovery and identity document; runtime configuration belongs in the implementation's own repository.

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
| `application`    | Yes      | Identity and description of the target application.                         |
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
| `website`        | No       | Application website URL.                               |

### `upstream` Object (bridges only)

Present when `native` is `false`. The object format depends on the `protocol` field.

**For `"mcp"` protocol:**

| Field        | Required | Description                                         |
| :----------- | :------: | :-------------------------------------------------- |
| `name`       | Yes      | Human-readable name of the upstream MCP server.     |
| `repository` | No       | Source repository URL.                              |
| `package`    | No       | Package identifier (npm, pip, etc.).                |

Future protocols (OpenAPI, EVM, A2A) will define their own upstream object formats.

### `plugin` Object

| Field        | Required | Description                                                    |
| :----------- | :------: | :------------------------------------------------------------- |
| `repository` | Yes      | URL to the plugin file or its containing directory (full path included in the URL). |
| `pluginDid`  | No       | Stable DID of the plugin line (if assigned).                   |

### `publisher` Object

| Field          | Required | Description                                      |
| :------------- | :------: | :----------------------------------------------- |
| `name`         | Yes      | Human-readable publisher name.                   |
| `githubOrg`    | Yes      | GitHub organization or user handle.              |
| `publisherDid` | No       | Publisher's DID.                                 |
| `repository`   | No       | Publisher's primary repository for this implementation. |

## Integration Types

### Bridge (`native: false`)

A bridge wraps an existing non-MPAS application and adds MPAS approval enforcement. The bridge is a drop-in replacement that the user runs instead of (or in front of) the upstream server. Bridges require a credential adapter at runtime, but the choice of credential adapter is independent of the application and is not specified in the registry entry.

### Native (`native: true`)

A native application has MPAS verification built in. No bridge or credential adapter is needed. The application directly verifies Action Packages before executing operations. Native applications still need a plugin to describe their operation surface.

## Adding an Entry

1. Create a JSON file named `{application}-{your-github-org}.json`
2. Follow the schema above
3. Ensure your plugin exists at the referenced location
4. Submit a pull request

## Notes

- The plugin is the authoritative source for the application's operation surface. The registry entry does not duplicate action lists.
- Runtime configuration (how to start the server, environment variables, etc.) belongs in the implementation's repository, not in the registry.
- Credential adapters are infrastructure and are not specified per-application.
