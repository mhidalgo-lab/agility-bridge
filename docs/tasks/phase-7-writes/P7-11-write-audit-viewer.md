---
id: P7-11
title: Write rows in the audit viewer, CSV and statistics
phase: 7
status: todo
priority: low
depends_on: [P7-01, P4-05]
adr: ["0013"]
lessons: [L-109, L-125]
owner: ""
---

# P7-11 — Write rows in the audit viewer, CSV and statistics

> Filed by P7-01 ([write framework](P7-01-write-framework.md)). Refine scope and acceptance criteria before starting.

## Goal
People can read what was written: intent and outcome of every write, paired, in the panel and the CSV export.

## Scope
- The audit viewer filters `kind: write` and `details.phase`, pairs an intent with its outcome (`details.intentId`) and shows the tool, target, field names, approval channel and result.
- Statistics count writes by tool, channel and outcome; a write with an intent and no outcome (a crash between them) is flagged.
- CSV columns for phase, hash and field names; no values exist to leak.

## Acceptance criteria
- [ ] Viewer, CSV and statistics tests with intent-only, intent+ok and intent+error pairs.
- [ ] A member sees only their own write rows (same scope rule as tool calls).
- [ ] The audit guide describes the pair and what an unpaired intent means.

## Security notes
THREAT_MODEL T17.

## Lessons applied
- L-109 — Audit the intent before the mutation.
- L-125 — Keep live-verification evidence and recipes.

## Docs to update
- docs/guide/audit-log.md
- docs/guide/admin-panel.md

## Out of scope
- Anything not listed under Scope.
