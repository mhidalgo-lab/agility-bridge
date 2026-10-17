---
id: P9-03
title: Performance and cost review
phase: 9
status: todo
priority: medium
depends_on: [P8-12]
adr: ["0010"]
lessons: [L-097, L-114]
owner: ""
---

# P9-03 — Performance and cost review

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Publish realistic latency, request and cost numbers per tool and deployment mode.

## Scope
- Benchmarks with Agility-shaped data on Node and Workers (Free and Paid); budgets and caps re-tuned; numbers documented.

## Acceptance criteria
- [ ] Per-tool budget table published; regressions tracked.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-097 — Design for the Free plan's limits, not its tolerance.
- L-114 — Declared costs cover the worst case.

## Docs to update
- docs/guide/cloudflare-limits.md
- docs/guide/query-limits.md

## Out of scope
- Anything not listed under Scope.
