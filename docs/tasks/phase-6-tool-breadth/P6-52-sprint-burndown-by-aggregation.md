---
id: P6-52
title: Sprint burndown by aggregation for very large sprints
phase: 6
status: todo
priority: low
depends_on: [P6-18]
adr: ["0011", "0012"]
lessons: [L-033, L-279, L-330]
owner: ""
---

# P6-52 — Sprint burndown by aggregation for very large sprints

## Goal
Past 1,000 items `get_sprint` still reports lower bounds and no burndown ([P6-18](P6-18-sprint-burndown-large-sprints.md)). Find out whether `query.v1` aggregations over `Timebox.Workitems` (count and estimate sum with an `asof`, per status category) give the remaining estimate without reading rows.

## Scope
- Measure on a sandbox or the live suite (levels only) whether such an aggregation works, answers within the request budget and respects `asof`; selecting `AssetState` per point made the tenant time out once (L-330), so measure before building.
- If it works: a compiler extension (bracket filter on a status category, one relation hop) with its own safety tests (ADR-0012), used for sprints above the row bound.
- If not: record the finding in docs/RESEARCH.md and close.

## Acceptance criteria
- [ ] Measurements recorded (levels only).
- [ ] The extension with safety tests and a fixture sprint above 1,000 items, or the finding and the closure.

## Security notes
A compiler change: THREAT_MODEL T3/T4 updated in the same PR.

## Lessons applied
- L-033
- L-279
- L-330

## Docs to update
- docs/RESEARCH.md; get_sprint notes.

## Out of scope
- Anything not about sprints above the row bound.
