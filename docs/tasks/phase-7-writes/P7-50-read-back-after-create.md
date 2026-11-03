---
id: P7-50
title: Read-back after create_work_item
phase: 7
status: todo
priority: low
depends_on: [P7-19]
adr: ["0013"]
lessons: [L-481]
owner: ""
---

# P7-50 — Read-back after create_work_item

> Filed by [P7-19](P7-19-read-back-after-write.md) (D-343). Refine scope and acceptance criteria before starting.

## Goal
`create_work_item` answers with what Agility holds for the new item, like the other write tools.

## Scope
- A `readBack` for the create: read the new item by the OID the response gave (`resultOid`) and compare the title, project and parent; `unknown` when the response had no OID.
- Declare the extra read in the tool's cost.

## Acceptance criteria
- [ ] Fixture tests for confirmed, not yet visible, no OID and failing read; no retry of the create.
- [ ] Declared cost keeps the D-199 margin.

## Security notes
THREAT_MODEL A2, T31: one read of the new item through the scope-checked reader.

## Lessons applied
- L-481 — A check after an irreversible step reports; it never fails the step.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
