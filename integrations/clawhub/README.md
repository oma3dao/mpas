# ClawHub Publishing Guide

This directory contains the ClawHub-specific versions of the MPAS skills,
packaged for publishing to [clawhub.ai](https://clawhub.ai). The canonical
harness-agnostic skills live in `../skills/`.

## Setup: Get a token and log in

1. Install the ClawHub CLI:

   ```sh
   npm i -g clawhub
   ```

2. Log in with GitHub OAuth:

   ```sh
   clawhub login
   clawhub whoami   # confirms your publisher handle (e.g. alftom)
   ```

3. For CI publishing (optional), generate an API token from the ClawHub web UI
   (account settings → API tokens). Store it as `CLAWHUB_TOKEN` in your
   GitHub repo's Actions secrets (Settings → Secrets → Actions).

## How SKILL.md maps to the ClawHub UI

| Frontmatter field | Where it appears on clawhub.ai |
|---|---|
| `name` | Skill card title and listing header |
| `description` | Card subtitle / summary text (keep short — long descriptions get truncated on cards) |
| `version` | Version badge on the detail page |
| `homepage` | May appear as a source link on the detail page (not always visible) |
| `metadata.openclaw.emoji` | Icon on the skill card |

The `--owner` flag during publish sets the **publisher** shown as `@oma3` (or
whatever handle you use). This comes from the workflow, not from frontmatter.

## Categories and topics

Categories and topics are set at publish time via the workflow (not in
SKILL.md frontmatter). They control how skills appear in ClawHub's browse and
search:

```yaml
categories: "security,governance,mcp,compliance"
topics: "multi-party-authorization,credential-separation,soc2,hipaa"
```

These are passed as inputs to the reusable `skill-publish.yml` workflow. To
change them, edit `.github/workflows/clawhub-skill-publish.yml`.

## Skill cards (auto-generated)

ClawHub automatically generates a **skill card** after publish. You do not
write `skill-card.md` yourself. The card is produced server-side by ClawHub's
Skill Card Worker (uses Codex + NVIDIA Trustworthy AI scanner) from your
SKILL.md content.

What influences the generated card:

- Clear, structured SKILL.md content (headings, bullet points)
- The `name` and `description` frontmatter
- Declared `requires.env` and `requires.bins` (if any)

If the generated card looks wrong, improve the SKILL.md structure and
republish.

## Publishing

### Manual (CLI)

```sh
clawhub skill publish ./mpas-proposer \
  --owner oma3 \
  --changelog "Initial release" \
  --dry-run
```

Remove `--dry-run` to publish for real.

### Automated (GitHub Actions)

The workflow at `.github/workflows/clawhub-skill-publish.yml` handles
publishing:

- **On PR** touching `integrations/skills/**` or `integrations/clawhub/**` →
  dry-run only (validates the publish would succeed, no token needed).
- **On workflow_dispatch** → manual trigger for real publish. Set `dry_run` to
  `false` and optionally provide a changelog.

To trigger: Actions → "ClawHub Skill Publish" → Run workflow.

## Updating skills

1. Edit the canonical skill in `../skills/mpas-proposer/SKILL.md` or
   `../skills/mpas-maintainer/SKILL.md`.
2. Copy the updated content into the corresponding file in this directory
   (`integrations/clawhub/mpas-proposer/SKILL.md`). Keep the ClawHub-specific
   frontmatter (emoji, description tuned for the card UI).
3. Bump the `version` field.
4. Commit and push. The PR will dry-run automatically.
5. Dispatch the publish workflow when ready.

## Versioning

- New skills start at `1.0.0`.
- The publish workflow auto-increments the patch version if you don't specify
  one. Use `--version` to set an explicit version for breaking changes.
- ClawHub keeps all published versions; `latest` tag points to the newest.

## Files in this directory

```
integrations/clawhub/
├── README.md                        ← this file (not published)
├── mpas-proposer/
│   └── SKILL.md                     ← ClawHub-packaged proposer skill
└── mpas-maintainer/
    └── SKILL.md                     ← ClawHub-packaged maintainer skill
```

The README is not published to ClawHub (it's outside the skill folders).
Only the contents of each skill folder (`mpas-proposer/`, `mpas-maintainer/`)
are uploaded.
