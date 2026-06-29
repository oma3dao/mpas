# Application Registry

This folder contains one JSON file per application that has known MPAS implementations.

## Purpose

Registry entries describe applications — not individual implementation artifacts. A single application entry may reference multiple implementations from different providers.

## Structure

```
application-registry/
├── README.md
├── github.json
├── slack.json
├── jira.json
└── ...
```

## File Naming Convention

- One file per application, named after the application
- Lowercase
- Hyphens for multi-word names (not underscores, not camelCase)
- No version numbers in filenames — versioning lives inside the JSON

Examples: `github.json`, `slack.json`, `x-twitter.json`, `google-drive.json`

## Entry Contents

Each JSON file may include:

- Application overview
- Version (of the registry entry schema)
- MPAS-relevant actions
- Implementation repositories
- Maintainers
- Optional `did:artifact` identifiers
- Implementation status
- Future certification status

## Schema

The registry schema is intentionally undefined at this stage. The format will remain flexible until sufficient ecosystem experience has been gained.

## Adding an Application

To register a new application, create a JSON file named after the application (e.g., `slack.json`). Follow the structure of existing entries.
