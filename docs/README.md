# Documentation

This folder contains all MPAS documentation organized by audience and purpose.

## Subfolders

### features/

Per-feature specifications, architecture documents, and implementation plans. Each feature gets its own subfolder with a `plan.md` and optionally a `spec.md`.

Audience: contributors and implementers.

### setup/

Getting started guides, build instructions, environment setup, and migration guides.

Audience: developers setting up MPAS locally or deploying components.

### site/

Content root for the MPAS documentation website. A static site generator (Docusaurus, VitePress, etc.) points at this folder as its source.

Audience: adopters and ecosystem participants.

Subfolders:

- `concepts/` — protocol concepts and mental models
- `tutorials/` — step-by-step walkthroughs
- `reference/` — API and configuration reference
