---
id: P7-06
title: "Lifecycle operations: close and reopen"
phase: 7
status: todo
priority: medium
depends_on: [P7-04]
adr: ["0013"]
lessons: [L-105, L-108]
owner: ""
---

# P7-06 — Lifecycle operations: close and reopen

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Close and reopen work items as destructive, separately enabled operations.

## Scope
- `close_asset` (Close or QuickClose per metadata validators) and `reopen_asset` (Reactivate); `destructive` kind; separate enablement in the workspace.

## Acceptance criteria
- [ ] Validators checked before approval; tests for each operation and refusal.

## Security notes
THREAT_MODEL A2.

## Lessons applied
- L-105 — Writes are a separate product.
- L-108 — Validate fully, then ask, then re-check, then apply once.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
