---
id: P3-03
title: Workers limits presets and per-call budgets
phase: 3
status: todo
priority: high
depends_on: [P3-01]
adr: ["0010"]
lessons: [L-049, L-097, L-101, L-115]
owner: ""
---

# P3-03 — Workers limits presets and per-call budgets

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Tool calls fit the plan they run on, and tools that cannot fit are hidden.

## Scope
- `AB_PLAN=free|paid` presets: call budget (45 / 1,000), response caps (512 KiB / 8 MiB), concurrency ≤ 6.
- Tools whose declared cost exceeds the budget are not registered.
- Budget usage recorded in audit rows, not headers.

## Acceptance criteria
- [ ] Cost tests on the Free preset; a too-expensive tool is absent from `tools/list`.

## Security notes
THREAT_MODEL T5, A10.

## Lessons applied
- L-049 — Cap bytes before parsing.
- L-097 — Design for the Free plan's limits, not its tolerance.
- L-101 — Count budgets in audit records, not headers.
- L-115 — Hide what cannot fit.

## Docs to update
- docs/guide/cloudflare-limits.md (new)

## Out of scope
- Anything not listed under Scope.
