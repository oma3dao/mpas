# MPAS Repository Reorganization Plan

**Status:** Draft  
**Scope:** Consolidate MPAS repositories (including Wivity's) into a single monorepo; preserve Wivity as an independent implementation provider  
**Goal:** Establish @oma3dao as the canonical home of the MPAS standard and reference implementation

---

## 1. Current State

```
OMA3
    mpas-docs           # Specification documents
    mpas-sdk            # SDK packages (MCP bridge, etc.)

Wivity
    mpas-local          # Credential Adapter, Coordination Service, CLI
```

Three repositories across two organizations, no single entry point for
someone evaluating the MPAS standard.

---

## 2. Target State

```
OMA3
    mpas                # Canonical MPAS repository (standard + community implementation)

Wivity (and others)
    Commercial implementations
```

The new `mpas` repository becomes the single OMA3-owned home for the
MPAS protocol. `mpas-local` is discontinued and its content migrates
into `examples/demo/`. All future adapter and protocol work happens in
the OMA3 repository.

Wivity and other ecosystem participants may build commercial
implementations on top of the MPAS standard. They contribute to the
OMA3 repo like any other participant.

---

## 3. OMA3 Repository Responsibilities

The OMA3 repository represents the MPAS standard. It contains:

- MPAS specifications
- SDK packages (MCP Bridge, core utilities)
- Example implementation demonstrating the full flow
- Application registry
- Conformance framework
- Developer and site documentation

OMA3 does **not** become the home for production implementations.

---

## 4. Commercial Implementations

Wivity and other ecosystem participants may build commercial products
on top of the MPAS standard. These are independent of the OMA3
repository and may include:

- Managed coordination services
- Enterprise adapters with custom policy engines
- Hosted bridge infrastructure
- Audit and certification services
- Autonomous bridge/plugin generation tools

Commercial implementers contribute upstream to the OMA3 repository
like any other participant.

---

## 5. Repository Structure

```
mpas/
├── README.md
│
├── specs/
│   MPAS specification documents.
│   JSON schemas remain embedded in specification documents as
│   appendices. No separate schema files at this stage.
│
├── sdk/
│   SDK packages for building MPAS implementations.
│   This is where mpas-sdk content migrates to.
│
│   Packages may include:
│   - MCP Bridge
│   - Core utilities (types, verification helpers, signing)
│   - Shared libraries consumed by implementations
│
├── examples/
│   │   Example implementations of the MPAS protocol. Each example
│   │   lives in its own subfolder and is self-contained with its own
│   │   build tooling. No top-level monorepo orchestrator is required.
│   │
│   │   These are ways to implement MPAS, not the only ways.
│   │   Alternative implementations (different policy engines,
│   │   different languages, different transports) are valid.
│   │
│   └── demo/
│       │   Community-maintained implementation demonstrating each
│       │   MPAS component working together. Initially developed by
│       │   Wivity and contributed to OMA3. Demonstrates the full
│       │   flow: propose → approve → dispatch.
│       │
│       │   The demo is the expected target for community
│       │   contributions (bug fixes, improvements, new features).
│       │   It may grow beyond mpas-local over time.
│       │
│       ├── bridge/
│       ├── credential-adapter/
│       ├── coordination-service/
│       ├── plugins/
│       ├── profiles/
│       └── guides/
│           └── setup-macos.md
│
│   The demo credential adapter uses a JSON policy format and includes
│   OMATrust attestation verification to demonstrate what all verifiers
│   should be doing. Production implementations may use OPA, Cedar, or
│   any other policy engine that satisfies the MPAS specification
│   requirements.
│
├── application-registry/
│   ├── README.md
│   ├── github.json
│   ├── slack.json
│   └── ...
│
│       One JSON file per application. Filenames are lowercase,
│       hyphenated, with no version numbers (versioning lives
│       inside the JSON).
│
│       Schema is TBD — format intentionally remains flexible until
│       sufficient ecosystem experience has been gained.
│
│       Each file may include:
│       - application overview
│       - version (of the registry entry)
│       - MPAS-relevant actions
│       - implementation repositories
│       - maintainers
│       - optional did:artifact identifiers
│       - implementation status
│       - future certification status
│
│       A single application entry may reference multiple implementations
│       (e.g., Wivity GitHub Bridge, future native implementation, future
│       enterprise implementation).
│
├── conformance/
│   └── README.md
│
│   Describes the conformance model and the three official test roles:
│
│   - Conformance proposer: submits well-formed action packages and
│     verifies the adapter handles them correctly
│   - Conformance approver: exercises the approval flow against a
│     coordination service implementation
│   - Conformance verifier: validates signatures, policy evaluation,
│     and dispatch behavior
│
│   Subfolder structure will be defined when the conformance tools
│   are implemented. Placeholder until then.
│
└── docs/
    ├── README.md       # Describes the docs subfolders
    ├── features/       # Per-feature spec + implementation notes
    │   └── reorg/      # This document lives here
    ├── setup/          # Getting started, build guides, migration guides
    └── site/           # Website-ready content (static site generator root)
        ├── concepts/
        ├── tutorials/
        └── reference/
```

---

## 6. Documentation Structure

The `docs/` folder serves all documentation needs:

| Subfolder | Audience | Purpose |
|---|---|---|
| `docs/features/` | Contributors, implementers | Per-feature specs, architecture, implementation plans |
| `docs/setup/` | Developers | Getting started guides, build instructions, environment setup |
| `docs/site/` | Adopters, ecosystem | Content root for a documentation website (Docusaurus, VitePress, etc.) |

The `docs/site/` subfolder is the content root for any static site
generator. It draws from the broader docs folder but curates content
for external consumption.

---

## 7. Design Principles

- OMA3 owns the standard.
- OMA3 provides a community-maintained example implementation.
- The example demo is the expected target for community contributions.
- Each example implementation owns its own build tooling.
- Production implementations remain independent but may diverge by
  focus area rather than by capability.
- The application registry references MPAS-compliant applications (one JSON file per application).  The JSON format is TBD. 
- The coordination service is optional infrastructure, documented as
  such — not a protocol requirement.
- JSON schemas remain embedded in the specifications until there is a
  compelling reason to separate them.
- Conformance tools (proposer, approver, verifier) are the authority
  for correctness — the example implementation passes the same
  conformance suite as everyone else.
- The credential adapter should eventually demonstrate OMATrust attestation
  verification as a model for what verifiers should do.
- The example credential adapter uses a JSON policy format as a
  pragmatic choice. Alternative policy engines (OPA, Cedar, etc.)
  are valid for production implementations.

---

---

## 8. Migration Plan

### 8.1 Steps

1. Create the `mpas` repository under OMA3
2. Migrate specification content from `mpas-docs` into `specs/`
3. Migrate SDK packages from `mpas-sdk` into `sdk/`
4. Migrate `mpas-local` into `examples/demo/`
5. Set up `application-registry/` with initial application JSON stubs
6. Create `conformance/README.md` describing the three-tool model
7. Set up `docs/` with feature docs, setup guides, and site skeleton
8. Archive `mpas-docs`, `mpas-sdk`, and `mpas-local` with deprecation
   notices and redirect links to the new repository

### 8.2 Migration Constraints

- Existing repositories remain untouched until migration is verified
- Preserve git history where feasible (subtree merge or filter-branch)
- `mpas-local` is fully absorbed — no ongoing parallel development
- Old repositories get archived with clear pointers to the new location

---

## 9. Future Work

Not part of this migration:

- Conformance test suite implementation
- Certification program
- Registry schema specification
- Application descriptor schema
- Registry automation
- did:artifact integration
- Automated bridge/plugin discovery
- Autonomous bridge/plugin generation

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Demo grows unwieldy as community contributes | Keep the conformance suite as the quality gate; PRs must pass conformance |
| Old repositories linger and confuse newcomers | Archive promptly after migration; add deprecation banners and redirect links |
| Community contributions conflict with Wivity's coordination service | They operate at different layers — adapter (OMA3) vs. coordination (Wivity). No conflict expected |
| Registry becomes stale without automation | Accept this risk initially; plan automation as future work once the schema stabilizes |
| Coordination service optionality confuses newcomers | Document explicitly in the demo guides; demo includes a local coordination service but marks it optional |
| Alternative policy engines fragment the adapter ecosystem | Document the policy engine as a pluggable layer; the JSON policy engine is the default, others are forks |
