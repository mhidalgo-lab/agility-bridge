---
id: P7-21
title: "Create and update with owners, team, sprint and defaults from New"
phase: 7
status: todo
priority: low
depends_on: [P7-05]
adr: ["0013"]
lessons: [L-397, L-399]
owner: ""
---

# P7-21 — Create and update with owners, team, sprint and defaults from New

> Filed by P7-05 ([writes wave 2](P7-05-writes-wave-2.md)). Refine scope and acceptance criteria before starting.

## Goal
The next requests after wave 2: set owners, team and sprint when creating, show the defaults Agility will apply, and re-parent or move an item.

## Scope
- `create_work_item` with `owners`, `team` and `sprint` (the same resolvers and approval text as the wave-1 tools), and the defaults read from `rest-1.v1/New` shown in the approval (D-180).
- `update_fields` for re-parenting and moving an item to another project of the workspace (each a typed field, never a free attribute; the target project checked in scope).

## Acceptance criteria
- [ ] Each addition has dry run, approval, conflict, no-op and refusal tests, negative authorization tests and the request body asserted.
- [ ] *Sandbox (P7-07):* each against a writable instance.

## Security notes
THREAT_MODEL A2, A12, T4, T31.

## Lessons applied
- L-108 — Validate fully, then ask, then re-check, then apply once.
- L-397 — A create's one target is the container.

## Docs to update
- docs/reference/tools.md (generated)
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
