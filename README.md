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
- **Bridge generator** — development-time tool that generates a static MCP bridge (and plugin scaffold) from a running MCP server
- **SDK** — `@oma3/mpas` protocol library (types, verification, policy engine, receipts, proposer primitives, protocol clients)
- **Example implementation** — a working implementation demonstrating the full MPAS flow (propose → approve → dispatch)
- **Application registry** — per-application descriptors referencing known implementations
- **Conformance model** — the conformance roles and test model (official test tools planned; see `conformance/`)
- **Documentation** — developer guides, architecture docs, and website content

## What This Repository Does Not Contain

- Production implementations (these belong to implementation providers)
- Production bridges or plugins
- Enterprise features
- Runtime/autonomous bridge or plugin generation (the `bridge-generator/` tool is development-time only: it emits static, reviewable code that is checked in before use)
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
┌──────────────────┐       ┌──────────────────┐
│  Maintainer Agent│       │  Signer Server   │
│                  │──MCP─▶│  (MCP server)    │
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

### The Governance Boundary

The Application Plugin plus the deployment policy define the **governed set** of operations. An operation in that set gets schema validation and policy evaluation (thresholds, signer groups, `defaultRequirement`). An operation outside that set is routed as **pass-through**: after proposer gating and signature verification it executes with the adapter's credential on the proposer's signature alone — `defaultRequirement` does not apply to it. This reflects the plugin-anchored trust model: the plugin publisher — typically the party that knows the target API best, attested via OMATrust — decides which operations need governance, and operators ratify that decision by trusting the publisher. If you care about an operation, put it in the plugin or give it a policy entry; power users who want unlisted operations refused entirely can set `passThrough: "deny"` in the deployment config.

## Repository Layout

```
specs/                          MPAS specification documents
bridge-generator/               Dev-time generator for static MCP bridge servers
sdk/
  protocol/                     @oma3/mpas — protocol SDK (types, verification,
                                policy engine, receipts, proposer primitives,
                                protocol clients)
examples/
  demo/                         Reference implementation of the full MPAS flow
    src/
      adapter/                  Credential Adapter daemon (Fastify HTTP server)
      coordination/             Coordination Service (in-memory, Fastify)
      signer-server/            MPAS Signer MCP Server (standalone, per-agent)
      core/                     Re-exports from @oma3/mpas (thin barrel files)
      cli/                      CLI commands (daemon management, trace inspection)
    tests/                      280+ tests (unit, integration, e2e)
application-registry/
  *.json                        One JSON file per application
conformance/
  README.md                     Conformance model and test roles (tools planned)
docs/
  README.md                     Describes the docs subfolders
  features/                     Per-feature specs and implementation notes
```

Each example in `examples/` is self-contained with its own build tooling. The demo depends on the SDK via `"@oma3/mpas": "file:../../sdk/protocol"`.

## Documentation

- Specifications: `specs/`
- Feature documentation: `docs/features/`
- Demo setup guide: `examples/demo/guides/`
- Application registry: `application-registry/`

## License and Participation

- Code is licensed under [MIT](./LICENSE)
- Contributor terms are defined in [CONTRIBUTING.md](./CONTRIBUTING.md)

This repository is MIT-licensed to maximize transparency and adoption. OMA3 standards and schemas remain governed by [OMA3's IPR Policy](https://www.oma3.org/intellectual-property-rights-policy).
