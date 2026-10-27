---
id: P6-18
title: Burndown for sprints with hundreds of items
phase: 6
status: todo
priority: medium
depends_on: [P6-02]
adr: ["0011"]
lessons: [L-033, L-060, L-279]
owner: ""
---

# P6-18 — Burndown for sprints with hundreds of items

> Created by P6-02. Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
`get_sprint` reads history points as pages of items, at most five pages per point and 60 queries per call
([L-279](../../LESSONS-LEARNED.md)). Live, sprints of several hundred items lose points (named in `notes`) and, past 500
items, lose the history altogether. Make the burndown work for them.

## Scope
- Measure whether `query.v1` aggregations over `Timebox.Workitems` (count and estimate sum, with an `asof`) can give the
  remaining estimate per status category without reading rows; the compiler today allows one relation hop and no bracket
  filter on a status category, so this may need a compiler extension with its own safety tests (ADR-0012).
- Otherwise raise the bounds deliberately (rows per call, response cap on the Node and Worker hosts) and say so in the docs.

## Acceptance criteria
- [ ] Refined with the live measurements (levels only) and the chosen approach.
- [ ] A fixture sprint above today's bound reads fully, or is reported as partial with the reason.

## Out of scope
- Anything not about the size bound of the sprint burndown.
