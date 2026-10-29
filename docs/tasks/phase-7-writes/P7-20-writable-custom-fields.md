---
id: P7-20
title: "Workspace-enabled writable custom fields"
phase: 7
status: todo
priority: low
depends_on: [P7-05]
adr: ["0013"]
lessons: [L-397, L-399]
owner: ""
---

# P7-20 — Workspace-enabled writable custom fields

> Filed by P7-05 ([writes wave 2](P7-05-writes-wave-2.md)). Refine scope and acceptance criteria before starting.

## Goal
Let an owner name the custom attributes an agent may write on create and update, per workspace (D-181 refused them in wave 2).

## Scope
- A per-workspace allowlist of custom attribute names (admin UI and API), validated against the instance metadata (writable, simple type, text length) and never named in a tool description.
- `create_work_item` and `update_fields` accept them as typed values in one `custom` argument; the approval shows each as old to new; values are plain text or a number, checked against the attribute type.

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
