---
id: P9-04
title: Documentation site
phase: 9
status: todo
priority: medium
depends_on: [P8-12]
adr: []
lessons: [L-133, L-135]
owner: ""
---

# P9-04 — Documentation site

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
A searchable site built from `docs/`, with every link checked.

## Scope
- Static site (e.g. Astro Starlight) built from `docs/`; link checker in CI; deployed from `main`; disclaimer on every page.

## Acceptance criteria
- [ ] Site live; link check green; README links to it.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.
- L-135 — README and docs are release artifacts.

## Docs to update
- README.md
- site/ (new)

## Out of scope
- Anything not listed under Scope.
