---
id: P3-02
title: D1 adapter and shared migration runner
phase: 3
status: todo
priority: high
depends_on: [P3-01]
adr: ["0006"]
lessons: [L-071, L-072, L-073]
owner: ""
---

# P3-02 — D1 adapter and shared migration runner

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
D1 passes the same storage contract as SQLite, with the same migrations.

## Scope
- D1 adapter: conditional single statements, `batch()` for multi-statement atomicity, constraint-name error mapping.
- Embedded migrations applied at first request (single-flight, concurrent-boot safe); SQLite `PRAGMA`s skipped where D1 ignores them.
- Access resolution in one `batch()`.

## Acceptance criteria
- [ ] The full storage contract suite passes on local D1; concurrent first boots tested.

## Security notes
THREAT_MODEL T7.

## Lessons applied
- L-071 — One schema, one migration history.
- L-072 — No read-decide-write in application code on D1.
- L-073 — One-time state is consumed atomically.

## Docs to update
- docs/dev/storage.md

## Out of scope
- Anything not listed under Scope.
