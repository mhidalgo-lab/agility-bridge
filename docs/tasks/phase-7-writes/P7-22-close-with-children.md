---
id: P7-22
title: "Close an item together with its open children"
phase: 7
status: todo
priority: low
depends_on: [P7-06, P7-07]
adr: ["0013"]
lessons: [L-400]
owner: ""
---

# P7-22 — Close an item together with its open children

> Filed by P7-06 ([lifecycle operations](P7-06-lifecycle-operations.md), D-186). Refine scope and acceptance criteria before starting.

## Goal
`close_asset` refuses an item with open children. Once the sandbox (P7-07) shows what `QuickClose` and the validators do, decide whether a person may close a story with its open tasks and tests in one approved change.

## Scope
- Record what Agility does (cascade or refusal) per type from the sandbox evidence.
- If worthwhile: an explicit argument that lists the children in the approval (numbers and states, up to a stated cap) and binds them in the hash, one operation per child plus the parent, each audited, never retried; or keep the refusal. More than one asset per approval changes ADR-0013 and needs a new ADR.

## Acceptance criteria
- [ ] Decision recorded with the evidence; if built, the approval shows every child, a changed child set is a conflict, and every path has tests.

## Security notes
THREAT_MODEL A2.

## Lessons applied
- L-400 — Put a fact the person relies on into the mutation.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
