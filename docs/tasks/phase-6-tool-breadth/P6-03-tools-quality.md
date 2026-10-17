---
id: P6-03
title: Quality views (tests, regression assets, defects)
phase: 6
status: todo
priority: medium
depends_on: [P2-17]
adr: ["0012"]
lessons: [L-035, L-155]
owner: ""
---

# P6-03 — Quality views (tests, regression assets, defects)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Cover test and defect questions mostly through existing tools, adding a typed tool only where it pays off.

## Scope
- Recipes (resources and prompt guidance) for tests, regression tests/plans/suites, test sets and defects through `query_assets` and `search_work_items`.
- Decide (with the tool-count budget) whether a typed tool such as test status for a backlog item is worth adding; if yes, add it here.

## Acceptance criteria
- [ ] Live verification of each recipe on the sandbox; decision recorded in the tool catalogue.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-035 — Validate at the domain level before calling upstream.
- L-155 — Keep the tool count small.

## Docs to update
- docs/reference/tool-catalogue.md

## Out of scope
- Anything not listed under Scope.
