---
id: P9-22
title: Per-tool and per-command pages on the documentation site
phase: 9
status: todo
priority: low
depends_on: [P9-04]
adr: []
lessons: [L-133, L-495]
owner: ""
---

# P9-22 — Per-tool and per-command pages on the documentation site

## Goal
A reader can link to and search for one tool, command or admin endpoint instead of one long reference page.

## Scope
- Generate one page per tool (from the tool registry) next to the existing generated references, with the schema, annotations, examples and costs.

## Acceptance criteria
- [ ] Each registered tool has a page; the generated references stay in sync (L-133) and the link check covers them.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.
- L-495 — The site is built from `docs/`; nothing is copied by hand.

## Docs to update
- docs/dev/docs-site.md

## Out of scope
- Anything not listed under Scope.
