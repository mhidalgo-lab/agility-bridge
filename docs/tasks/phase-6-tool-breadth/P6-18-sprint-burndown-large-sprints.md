---
id: P6-18
title: Burndown for sprints with hundreds of items
phase: 6
status: done
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
Refined 2026-10-28 (no live access in this change; the aggregation route needs live measurements and is split off):
- Raise the bounds deliberately and inside tested limits: the sprint's contents are read up to 1,000 items (five to ten pages
  by page size, the pages beyond the first two in one batched request), the history queries per call stay at 60 and 20 per
  request, so a bigger sprint gets fewer burndown points instead of none; past 1,000 items the totals stay lower bounds and
  the result is `partial` with the reason (as today).
- Aggregations over `Timebox.Workitems` (remaining estimate per status category without reading rows) need a compiler
  extension (one relation hop, no bracket filter on a status category today) and live measurements: [P6-52](P6-52-sprint-burndown-by-aggregation.md).
- The new request shapes need a live check before release: added to [P6-51](P6-51-live-check-of-the-sprint-read-shapes.md).

## Acceptance criteria
- [x] Refined with the chosen approach (the live measurements move to P6-52).
- [x] A fixture sprint above today's bound reads fully, or is reported as partial with the reason (tests for both).

## Out of scope
- Anything not about the size bound of the sprint burndown.
