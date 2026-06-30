# mpas

Canonical repository for the MPAS (Multi-Party Action Security) standard and reference implementation.

MPAS is a protocol for multi-party approval of AI agent actions. Instead of giving agents direct access to privileged APIs, MPAS routes actions through a Credential Adapter that enforces policy-based approval workflows before execution. No single agent can both propose and approve the same action.

## License and Participation

- Code is licensed under [MIT](./LICENSE)
- Contributor terms are defined in [CONTRIBUTING.md](./CONTRIBUTING.md)

This initial version is MIT-licensed to maximize transparency and adoption. OMA3 standards and schemas remain governed by [OMA3's IPR Policy](https://www.oma3.org/intellectual-property-rights-policy).

## What This Repository Contains

This repository is the OMA3-owned home of the MPAS standard:

- **Specifications** — the MPAS protocol documents (core, profiles, schemas)
- **SDK** — packages for building MPAS implementations (MCP Bridge, core utilities)
- **Example implementation** — a working implementation demonstrating the full MPAS flow (propose → approve → dispatch)
- **Application registry** — per-application descriptors referencing known implementations
- **Conformance tools** — official test tools for validating MPAS implementations
- **Documentation** — developer guides, architecture docs, and website content

## What This Repository Does Not Contain

- Production implementations (these belong to implementation providers)
- Production bridges or plugins
- Enterprise features
- Autonomous bridge/plugin generation tooling
- Anything beyond the example path demonstrating the full MPAS protocol flow

The example credential adapter uses a JSON policy format as a pragmatic choice for demonstration. Production implementations may use OPA, Cedar, or any other policy engine that satisfies the MPAS specification requirements.

Production implementations are maintained independently. See the application registry for known implementations.

## Architecture

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│  Proposer Agent  │       │  MCP Bridge      │       │  Credential Adapter  │       │  Target         │
│                  │──MCP─▶│  (proposer mode) │─HTTP─▶│  (port 7544)         │──API─▶│  (GitHub, etc.) │
│  Sees normal MCP │       │  Signs envelopes │       │  Verifies signatures │       │                 │
│  tools           │       │  Waits for       │       │  Evaluates policy    │       │                 │
│                  │       │  approval        │       │  Dispatches action   │       │                 │
└──────────────────┘       └────────┬─────────┘       └──────────────────────┘       └─────────────────┘
                                    │
                                    │ HTTP (submit/poll)
                                    ▼
                           ┌──────────────────┐
                           │  Coordination    │
                           │  Service         │
                           │  (optional)      │
                           │  Approval queue  │
                           └────────▲─────────┘
                                    │
                                    │ HTTP (list/approve/reject)
                                    │
┌──────────────────┐       ┌────────┴─────────┐
│  Maintainer Agent│       │  MCP Bridge      │
│                  │──MCP─▶│ (maintainer mode)│
│  Sees approval   │       │  Signs approvals │
│  tools           │       │                  │
└──────────────────┘       └──────────────────┘
```

### How It Works

1. An agent calls an MCP tool (e.g., `delete_branch`)
2. The MCP Bridge constructs and signs an Action Package, submits it to the Credential Adapter
3. The Credential Adapter verifies the signature and evaluates policy:
   - If auto-approved: dispatches immediately to the target and returns the result
   - If approval required: returns `additionalApprovalsRequired`
4. The bridge submits the pending action to the Coordination Service and polls for resolution
5. A maintainer agent approves (or rejects) the action
6. The bridge resubmits the completed Action Package to the adapter
7. The adapter verifies full policy satisfaction, dispatches, and returns an Execution Receipt

### Key Security Properties

- Agents hold no privileged credentials — all writes route through the adapter
- The adapter verifies cryptographic signatures and evaluates policy before dispatching
- Self-approval is prevented at both coordination and policy engine levels
- The Coordination Service is optional infrastructure, not a protocol requirement

## Repository Layout

```
specs/                          MPAS specification documents
sdk/                            SDK packages (MCP Bridge, core utilities)
examples/
  demo/                         Minimal demo of the full MPAS flow
    bridge/                     Example MCP Bridge
    credential-adapter/         Example Credential Adapter (JSON policy)
    coordination-service/       Example Coordination Service
    plugins/                    Example application plugins
    profiles/                   Example profiles
    guides/
      setup-macos.md            macOS setup guide for running the demo
application-registry/
  applications/                 One JSON file per application
conformance/
  README.md                     Conformance model and test roles
docs/
  README.md                     Describes the docs subfolders
  features/                     Per-feature specs and implementation notes
  setup/                        Getting started and build guides
  site/                         Documentation website content
```

Each example in `examples/` is self-contained with its own build tooling. There is no top-level monorepo orchestrator.

## Related Repositories

| Repository | Description |
|---|---|
| [mpas-docs](https://github.com/oma3dao/mpas-docs) | MPAS specifications (archived — migrated to `specs/`) |
| [mpas-sdk](https://github.com/oma3dao/mpas-sdk) | SDK packages (archived — migrated to `sdk/`) |
| [mpas-local](https://github.com/alftom/mpas-local) | Original adapter implementation (archived — migrated to `examples/demo/`) |

## Documentation

- Specifications: `specs/`
- Feature documentation: `docs/features/`
- Setup guides: `docs/setup/`
- Website content: `docs/site/`
- Application registry: `application-registry/`

## License and Participation

- Code is licensed under [MIT](./LICENSE)
- Contributor terms are defined in [CONTRIBUTING.md](./CONTRIBUTING.md)

This repository is MIT-licensed to maximize transparency and adoption. OMA3 standards and schemas remain governed by [OMA3's IPR Policy](https://www.oma3.org/intellectual-property-rights-policy).
