---
id: P6-16
title: Portfolio tree for very large epics (per-child roll-ups)
phase: 6
status: todo
priority: low
depends_on: [P6-01]
adr: ["0015"]
lessons: [L-033, L-170, L-272]
owner: ""
---

# P6-16 — Portfolio tree for very large epics (per-child roll-ups)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
When an epic has more backlog items than `get_portfolio_tree` reads in one call (three pages per type), give an exact
answer anyway instead of an `incomplete` one, without raising the per-call cost for everyone.

## Scope
- Decide between a cursor that continues the item scan across calls (sums carried in a signed, workspace-bound cursor),
  and a documented "get each sub-epic" walk; implement the cheaper one the tests can prove exact.
- Cursor rules from tool conventions apply (bound to workspace, filters and tree; re-validated).

## Acceptance criteria
- [ ] A fixture with more items than one call reads gives the same roll-ups as the single-call result on a smaller one.
- [ ] A forged or foreign cursor is refused before any request.

## Security notes
THREAT_MODEL A4: a continuation carries sums, never items or scope.

## Lessons applied
- L-033 — Honest `partial`.
- L-170 — Offsets count upstream positions.
- L-272 — Say when a roll-up is not exact.

## Docs to update
- docs/dev/tool-conventions.md (paging of non-list tools, if a cursor is added), docs/reference/tools.md (generated).

## Out of scope
- Server-side aggregates ([P6-15](P6-15-portfolio-aggregate-rollups.md)).
