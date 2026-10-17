---
id: P3-10
title: CPU benchmark and cost check
phase: 3
status: todo
priority: low
depends_on: [P3-03]
adr: ["0010"]
lessons: [L-020, L-097]
owner: ""
---

# P3-10 — CPU benchmark and cost check

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Know the CPU and request cost of each tool on Workers and catch regressions.

## Scope
- Benchmarks for `tools/list`, cold start and representative tool calls with Agility-shaped fixtures; non-required CI job with history.

## Acceptance criteria
- [ ] Numbers published in docs/guide/cloudflare-limits.md; regressions above a threshold flagged.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-020 — Cache converted tool schemas.
- L-097 — Design for the Free plan's limits, not its tolerance.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- Anything not listed under Scope.
