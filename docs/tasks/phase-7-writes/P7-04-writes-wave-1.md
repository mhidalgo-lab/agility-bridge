---
id: P7-04
title: Writes wave 1: comment, status, effort, owners, sprint
phase: 7
status: todo
priority: high
depends_on: [P7-01, P7-03]
adr: ["0011", "0013"]
lessons: [L-051, L-108, L-142]
owner: ""
---

# P7-04 — Writes wave 1: comment, status, effort, owners, sprint

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
The everyday changes: `add_comment`, `update_status`, `log_effort`, `assign_owners`, `move_to_sprint`.

## Scope
- Typed inputs validated against metadata (status names per type and team workflow, writable attributes); API per ADR-0011; idempotent no-op detection; read-lag notes.

## Acceptance criteria
- [ ] Fixture and sandbox tests for each tool: dry run, approval, conflict, no-op repeat, refusal.

## Security notes
THREAT_MODEL A2.

## Lessons applied
- L-051 — Expect read-after-write lag.
- L-108 — Validate fully, then ask, then re-check, then apply once.
- L-142 — Status, AssetState and rollup category are different things.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
