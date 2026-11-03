---
id: P9-19
title: Scheduled external link check for the documentation
phase: 9
status: todo
priority: low
depends_on: [P9-04]
adr: []
lessons: [L-133, L-495]
owner: ""
---

# P9-19 — Scheduled external link check for the documentation

## Goal
Dead links to third-party pages are found within a week, without failing unrelated pull requests (D-364).

## Scope
- A scheduled workflow that crawls the built site's external links (an allowlist for rate-limited hosts) and opens or updates one issue with the broken ones.

## Acceptance criteria
- [ ] A weekly run reports a planted dead external link and stays green when none exist.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.
- L-495 — The site is built from `docs/`; nothing is copied by hand.

## Docs to update
- docs/dev/docs-site.md

## Out of scope
- Anything not listed under Scope.
