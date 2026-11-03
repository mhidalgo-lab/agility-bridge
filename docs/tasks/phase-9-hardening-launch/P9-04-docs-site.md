---
id: P9-04
title: Documentation site
phase: 9
status: review
priority: medium
depends_on: [P8-12]
adr: []
lessons: [L-133, L-135]
owner: "claude (lane C)"
---

# P9-04 — Documentation site

> Refined 2026-11-03 (tasks/README rule 7). Owner decision: Astro Starlight in `site/`, deployed to GitHub Pages.

## Goal
A searchable site built from `docs/`, with every link checked.

## Scope
- `site/`: Astro Starlight (exact versions), a standalone pnpm workspace so the existing CI jobs neither install nor build it.
- `docs/` stays the source of truth: a sync step (`scripts/docs-site.ts`) copies it into the site's content folder at build
  time (gitignored), adds the front matter Starlight needs and rewrites relative `.md` links to site links (and links that
  leave `docs/` to GitHub). No markdown is duplicated by hand.
- Sidebar grouping mirrors `docs/` (guide, reference, dev, security, architecture and ADRs, project). `tasks/` and
  `pending-decisions/` stay out of the site (links to them point at GitHub).
- Built-in Pagefind search; the project disclaimer in the footer of every page.
- Link checks: `docs/` relative links and anchors (in `pnpm lint`) and the built site's internal links and anchors
  (`starlight-links-validator`, fails the build).
- Workflow `.github/workflows/docs-site.yml`: build and link check on pull requests that touch the docs or the site;
  deploy to GitHub Pages only on `main`, with the official Pages actions pinned by SHA and minimal permissions.
- README links to the expected Pages URL.

## Acceptance criteria
- [x] `site/` builds from `docs/` with Starlight (versions pinned) and does not run in the existing CI jobs.
- [x] Sync step rewrites doc links; `tasks/` and `pending-decisions/` excluded (decision recorded).
- [x] Sidebar groups mirror `docs/`; Pagefind search works; disclaimer on every page.
- [x] `docs/` relative links and anchors are checked in `pnpm lint`; the built site's links and anchors are checked in CI.
- [x] Pull-request job builds and link-checks; deploy job runs only on `main` and does not fail `main` while Pages is off.
- [x] README links to the site; `docs/dev` page explains how to build and preview it.
- [x] *owner:* enable Pages (Settings, Pages, Source: GitHub Actions); site live at https://mhidalgo-lab.github.io/agility-bridge/ (the first run on main after that deploys it). Done 2026-11-03: Pages enabled, the deploy job ran on main and the site is live.

## Security notes
T18 (actions and artifacts): the deploy job holds only pages write and id-token write, runs no project code and gets an artifact built by a job without those scopes; actions pinned by SHA; pages joins the workflow write allowlist; the site is a separate workspace with the same release-age and build-script rules. Decisions D-361 to D-365.

## Lessons applied
- L-133 — Execute the documentation.
- L-135 — README and docs are release artifacts.

## Docs to update
- README.md
- site/ (new), docs/dev/docs-site.md (new)

## Out of scope
- Anything not listed under Scope.
