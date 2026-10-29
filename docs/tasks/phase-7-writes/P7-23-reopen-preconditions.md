---
id: P7-23
title: "Reopen preconditions: closed parent and per-type operations"
phase: 7
status: todo
priority: low
depends_on: [P7-06, P7-07]
adr: ["0013"]
lessons: [L-108]
owner: ""
---

# P7-23 — Reopen preconditions: closed parent and per-type operations

> Filed by P7-06 ([lifecycle operations](P7-06-lifecycle-operations.md), D-187). Refine scope and acceptance criteria before starting.

## Goal
Agility may refuse a reopen when the parent is closed, and the close and reopen operation names differ per type. Check before approval what the sandbox shows Agility checks.

## Scope
- From P7-07 evidence: the real operation per type, the order of preference for close, and the validators' refusals.
- Refuse in the plan, with a hint naming the parent, a reopen whose parent is closed, if Agility does; fix the metadata-driven choice if the order was wrong.

## Acceptance criteria
- [ ] Each confirmed precondition has a refusal test with no approval and no request.

## Security notes
THREAT_MODEL A2.

## Lessons applied
- L-108 — Validate fully, then ask, then re-check, then apply once.

## Docs to update
- docs/guide/write-tools.md
- docs/RESEARCH.md

## Out of scope
- Anything not listed under Scope.
