# mpas

> [!WARNING]
> **Experimental alpha.** MPAS is not production-ready or independently
> audited. Breaking changes are expected. The current reference integration is
> GitHub; other integrations are planned.

Canonical repository for the MPAS (Multi-Party Action Security) standard and reference implementation.

MPAS is a protocol for multi-party approval of high-impact digital actions.
In this document, **Agent** means any entity that can hold a private key and
participate as a Proposer or Signer — a human, AI agent, device, service, or
organization — not only an LLM-driven process.

Instead of giving agents direct access to privileged APIs, MPAS routes actions
through a Credential Adapter that enforces policy-based approval workflows
before execution. No single agent can both propose and approve the same action.

MCP is one execution profile and the path used by the bridge generator and
demo in this repository. The protocol itself is not limited to MCP; other
execution profiles can carry MPAS Action Packages for non-MCP environments.

For a higher-level overview of the problem space and approach, see
[MPAS in oma3-projects](https://github.com/oma3dao/oma3-projects/blob/main/mpas.md).

## Architecture

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│  Proposer Agent  │       │  MCP Bridge      │       │  Credential Adapter  │       │  MCP/API        │
│                  │──MCP─▶│  (proposer mode) │─HTTP─▶│  (port 7544)         │──MCP─▶│  (GitHub, etc.) │
│  Sees normal MCP │       │  Signs envelopes │       │  Verifies signatures │ /API  │                 │
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

The Application Plugin plus the deployment policy define the **governed set** of operations. An operation in that set gets schema validation and policy evaluation (thresholds, signer groups, `defaultRequirement`). An operation outside that set is routed as **pass-through**: after proposer gating and signature verification it executes with the adapter's credential on the proposer's signature alone — `defaultRequirement` does not apply to it. This reflects the plugin-anchored trust model: the plugin publisher — typically the party that knows the target API best, attested via OMATrust, decides which operations need governance. Operators ratify that decision by trusting the publisher. If you care about an operation, put it in the policy entry; power users who want unlisted operations refused entirely can set `passThrough: "deny"` in the deployment config.

## What This Repository Contains

This repository is the OMA3-owned home of the MPAS standard:

- **Specifications** — the MPAS protocol documents (core, profiles, schemas)
- **SDK** — `@oma3/mpas` protocol library (types, verification, policy engine, receipts, proposer primitives, protocol clients)
- **Bridge generator** — development-time tool that generates a static MCP bridge (and plugin scaffold) from a running MCP server
- **Reference implementation** — a runnable implementation of the full MPAS flow (propose → review/approve → dispatch), including operator services, signer tooling, and a human Maintainer CLI
- **Application registry** — per-application descriptors referencing known implementations
- **Conformance model** — the conformance roles and test model (official test tools planned; see `conformance/`)
- **Documentation** — developer guides, architecture docs, and website content
- **Agent skills** — reusable proposer and maintainer skill packages (`integrations/skills/`)

## What This Repository Does Not Contain

- A vendor-supported production distribution or hosted operations bundle
- Production bridges or plugins
- A guarantee that the reference implementation is production-hardened or
  independently audited

The reference credential adapter uses a JSON policy format as a pragmatic,
fully runnable implementation choice. Production implementations may use OPA,
Cedar, or any other policy engine that satisfies the MPAS specification
requirements.

Production implementations are maintained independently — reference implementations live in `oma3/mpas-applications`, and third-party or vendor implementations live in their publishers' repositories. The application registry in this repo is the index that points to all of them. This split is deliberate: this repository is the normative home (specifications, SDK, conformance, registry, teaching examples); implementations people deploy in production live elsewhere.

## Build and Verify

MPAS requires Node.js 22 or later. From the repository root, install the locked
dependencies, build each package, and run the test suites in dependency order:

```sh
npm ci --prefix sdk/protocol
npm run build --prefix sdk/protocol
npm test --prefix sdk/protocol

npm ci --prefix bridge-generator
npm run build --prefix bridge-generator
npm test --prefix bridge-generator

npm ci --prefix examples/demo
npm run build --prefix examples/demo
npm test --prefix examples/demo
npm run test:e2e:mcp-bridge --prefix examples/demo
```

For the complete local governed-action walkthrough, including proposer,
maintainer, Credential Adapter, policy, and agent-harness configuration, follow
the [macOS demo setup guide](examples/demo/guides/setup-macos.md).

## Repository Layout

```
specs/                          MPAS specification documents
bridge-generator/               Dev-time generator for static MCP bridge servers
sdk/
  protocol/                     @oma3/mpas — protocol SDK (types, verification,
                                policy engine, receipts, proposer primitives,
                                protocol clients)
examples/
  demo/                         Runnable reference implementation of the full MPAS flow
    src/
      adapter/                  Credential Adapter daemon (Fastify HTTP server)
      coordination/             Coordination Service (in-memory, Fastify)
      signer-server/            MPAS Signer MCP Server (standalone, per-agent)
      core/                     Re-exports from @oma3/mpas (thin barrel files)
      cli/                      Operator commands and human Maintainer review CLI
    tests/                      330+ tests (unit, integration, e2e)
application-registry/
  *.json                        One JSON file per application
conformance/
  README.md                     Conformance model and test roles (tools planned)
docs/
  README.md                     Describes the docs subfolders
  features/                     Per-feature specs and implementation notes
integrations/
  skills/                       Agent skill packages (proposer, maintainer)
```

Each example in `examples/` is self-contained with its own build tooling. The demo depends on the SDK via `"@oma3/mpas": "file:../../sdk/protocol"`.

## Documentation

- Higher-level overview: [oma3-projects/mpas.md](https://github.com/oma3dao/oma3-projects/blob/main/mpas.md)
- Specifications: `specs/`
- Feature documentation: `docs/features/`
- Demo setup guide: `examples/demo/guides/`
- Human Maintainer CLI: [`examples/demo/guides/maintainer.md`](examples/demo/guides/maintainer.md#human-maintainer-cli)
- Agent skills: `integrations/skills/`
- Credential Adapter operator guide: [`examples/demo/guides/credential-adapter.md`](examples/demo/guides/credential-adapter.md)
- Application registry: `application-registry/`
- Application plugins and bridges: [oma3dao/mpas-applications](https://github.com/oma3dao/mpas-applications)

## License and participation

Software and other contributions to this repository are licensed under the
[Apache License 2.0](./LICENSE).

By submitting material for inclusion in this repository, contributors agree
that it may be distributed under the Apache License 2.0.

Final OMA3 Specifications are separately governed by
[OMA3's Intellectual Property Rights Policy](https://www.oma3.org/intellectual-property-rights-policy)
and applicable OMA3 review and approval processes.
