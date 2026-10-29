---
id: P6-49
title: Hour-based sprint burndown from task ToDo
phase: 6
status: todo
priority: low
depends_on: [P6-17]
adr: ["0011"]
lessons: [L-330]
owner: ""
---

# P6-49 — Hour-based sprint burndown from task ToDo

## Goal
Teams that burn down hours, not points, see remaining task hours per day next to `get_sprint`'s estimate burndown. Split out
of [P6-17](P6-17-sprint-capacity-velocity.md), which built velocity only.

## Scope
- `Task` carries `ToDo`, `DetailEstimate` and `Timebox` in the metadata snapshot; read the sprint's tasks `asof` the same
  burndown points as the estimate burndown, within the existing 60-query history bound (trade points, never exceed it).
- Report remaining hours per point, with `incomplete` points named, as `get_sprint` does for estimates.
- This is a second family of per-point `asof` queries: run it on the live suite before it ships (L-330).

## Acceptance criteria
- [ ] Hour burndown in `get_sprint` (or a documented sibling), bounded and honest about cut points.
- [ ] Live run recorded as levels only; cost stays declared and the worst-case test covers it.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-330 — A query that runs once per burndown point needs a live run before it ships.

## Docs to update
- docs/reference/tools.md (generated), docs/reference/tool-catalogue.md

## Out of scope
- Capacity (P6-50).
