---
id: P6-16
title: Portfolio tree for very large epics (per-child roll-ups)
phase: 6
status: done
priority: low
depends_on: [P6-01]
adr: ["0015"]
lessons: [L-033, L-170, L-272, L-360]
owner: ""
---

# P6-16 — Portfolio tree for very large epics (per-child roll-ups)

> Refined 2026-10-28 (D-144): the continuation cursor is built; server-side aggregates were ruled out by P6-15 (D-143).

## Goal
When an epic has more backlog items than `get_portfolio_tree` reads in one call (three pages per type), give an exact
answer anyway instead of an `incomplete` one, without raising the per-call cost for everyone.

## Scope
- A cursor continues the item scan across calls (D-144): the totals per epic (compact text) and the item offsets travel in
  a workspace-bound cursor; each step re-reads the tree and refuses the cursor when the epics changed (fingerprint).
- Trees of more than 60 epics, or whose totals would not fit the cursor's length limit, keep the "get a sub-epic" answer.
- Until the last step every roll-up is `incomplete` and the result `partial`; the last step has no `nextCursor` and is exact.
- Cursor rules from tool conventions apply (bound to workspace, arguments and tree; re-validated; checked before any request).

## Acceptance criteria
- [x] A fixture with more items than one call reads gives the same roll-ups as the single-call result on a smaller one.
- [x] A forged or foreign cursor is refused before any request.

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
