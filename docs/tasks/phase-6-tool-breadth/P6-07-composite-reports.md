---
id: P6-07
title: Composite reports
phase: 6
status: todo
priority: high
depends_on: [P6-01, P6-02, P6-05]
adr: ["0015"]
lessons: [L-033, L-037, L-114]
owner: ""
---

# P6-07 — Composite reports

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
One-call reports that save agents many round trips and stay honest about gaps.

## Scope
- `sprint_health`, `standup_summary`, `release_readiness`, `defect_triage`, `work_item_quality` (versioned rubric); sections skipped with notes when sibling tools are not granted; worst-case costs declared.

## Acceptance criteria
- [ ] Each report tested with missing grants, empty data, budget exhaustion and partial upstream failures; no plausible zeros.

## Security notes
THREAT_MODEL T3, A1.

## Lessons applied
- L-033 — Never turn missing data into zeros or confident claims.
- L-037 — Composite tools need their own authorization and cost model.
- L-114 — Declared costs cover the worst case.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
