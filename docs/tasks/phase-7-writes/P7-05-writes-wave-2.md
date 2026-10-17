---
id: P7-05
title: Writes wave 2: create work items and update fields
phase: 7
status: todo
priority: medium
depends_on: [P7-04]
adr: ["0011", "0013"]
lessons: [L-044, L-108]
owner: ""
---

# P7-05 — Writes wave 2: create work items and update fields

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Create backlog items, defects, tasks and tests, and update allowlisted fields.

## Scope
- `create_work_item` (per-type field allowlists, defaults from `rest-1.v1/New`, parent required for tasks) and `update_fields` (name, description, estimate, priority, workspace-enabled custom fields); created assets read back.

## Acceptance criteria
- [ ] Round-trip tests read every created or updated asset back through the read tools.

## Security notes
THREAT_MODEL A2, A1 (no content from tool results copied into writes without approval).

## Lessons applied
- L-044 — Round-trip what you create.
- L-108 — Validate fully, then ask, then re-check, then apply once.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
