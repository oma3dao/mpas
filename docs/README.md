# Documentation

This folder contains all MPAS documentation organized by audience and purpose.

## Subfolders

### features/

Per-feature specifications, architecture documents, and implementation plans. Each feature gets its own subfolder with a `plan.md` and optionally a `spec.md`.

Audience: contributors and implementers.

#### Feature-document lifecycle

Feature documents are chronological design and implementation records, not
living normative specifications.

- A feature document SHOULD include a `Created` date.
- When the feature is completed, it SHOULD include an `Implemented` date.
- A later feature MUST NOT rewrite an earlier feature's design, plan, or
  assumptions merely because the later feature changes them.
- A later feature MAY cite an earlier feature as historical context from the
  new feature's own documents.
- Normative behavior belongs in `specs/`. Normative profiles may evolve through
  versioned changes, while `docs/features/` preserves why and when each change
  was introduced.

Dependencies between normative specifications flow from higher layers to lower
layers. A higher-layer interface profile identifies the Core, transport, and
execution profiles it uses. Lower-layer specifications define their own scope
and extension points; they do not enumerate or link to every upper-layer
consumer.

### setup/ (planned)

Getting started guides, build instructions, environment setup, and migration guides. Not yet populated — see `examples/demo/guides/` for the current setup guide.

Audience: developers setting up MPAS locally or deploying components.

### site/ (planned)

Content root for the MPAS documentation website. A static site generator (Docusaurus, VitePress, etc.) will point at this folder as its source. Not yet populated.

Audience: adopters and ecosystem participants.

Subfolders:

- `concepts/` — protocol concepts and mental models
- `tutorials/` — step-by-step walkthroughs
- `reference/` — API and configuration reference
