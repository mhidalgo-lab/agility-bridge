---
id: P9-21
title: Accessibility and performance checks for the documentation site
phase: 9
status: todo
priority: low
depends_on: [P9-04]
adr: []
lessons: [L-133, L-495]
owner: ""
---

# P9-21 — Accessibility and performance checks for the documentation site

## Goal
The site stays accessible and fast as pages are added.

## Scope
- An axe and Lighthouse run against a sample of built pages in the docs-site workflow with agreed thresholds; the landing page gets a hero and quick links.

## Acceptance criteria
- [ ] The checks run on pull requests that touch the site and fail below the thresholds.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.
- L-495 — The site is built from `docs/`; nothing is copied by hand.

## Docs to update
- docs/dev/docs-site.md

## Out of scope
- Anything not listed under Scope.
