---
id: P6-06
title: Requests, issues and other asset types
phase: 6
status: todo
priority: medium
depends_on: [P2-17]
adr: ["0012"]
lessons: [L-035, L-155]
owner: ""
---

# P6-06 — Requests, issues and other asset types

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Make issues, requests, goals, themes and retrospectives first-class without growing the catalogue needlessly.

## Scope
- Recipes, resources and field tiers for these types through the generic tools; typed tools only where usage shows the need.

## Acceptance criteria
- [ ] Each type verified on the sandbox through `query_assets`/`get_assets` with sensible default tiers.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-035 — Validate at the domain level before calling upstream.
- L-155 — Keep the tool count small.

## Docs to update
- docs/reference/tool-catalogue.md

## Out of scope
- Anything not listed under Scope.
