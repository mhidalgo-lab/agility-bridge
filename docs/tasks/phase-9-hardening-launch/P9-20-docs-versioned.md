---
id: P9-20
title: Versioned documentation per release
phase: 9
status: todo
priority: low
depends_on: [P9-04]
adr: []
lessons: [L-133, L-495]
owner: ""
---

# P9-20 — Versioned documentation per release

## Goal
Readers of an older release can read the docs that match it.

## Scope
- Keep the site for the latest release and for the previous minor (built from release tags), with a version switcher; main shows as next.

## Acceptance criteria
- [ ] The site shows the docs of the latest tag and of main; links between versions are checked.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.
- L-495 — The site is built from `docs/`; nothing is copied by hand.

## Docs to update
- docs/dev/docs-site.md

## Out of scope
- Anything not listed under Scope.
