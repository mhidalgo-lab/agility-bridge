---
id: P4-05
title: Audit viewer and usage statistics
phase: 4
status: todo
priority: medium
depends_on: [P4-03]
adr: []
lessons: [L-041]
owner: ""
---

# P4-05 — Audit viewer and usage statistics

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Owners see what happened; members see their own activity.

## Scope
- Paged, filtered audit viewer; CSV export with formula neutralisation; usage per workspace, grant and tool.

## Acceptance criteria
- [ ] Members see only their own rows; exports neutralise formulas (test).

## Security notes
THREAT_MODEL T13, T17.

## Lessons applied
- L-041 — Neutralise spreadsheet formulas.

## Docs to update
- docs/guide/audit-log.md

## Out of scope
- Anything not listed under Scope.
