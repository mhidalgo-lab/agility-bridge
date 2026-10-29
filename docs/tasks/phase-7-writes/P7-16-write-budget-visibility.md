---
id: P7-16
title: Show the remaining write budget
phase: 7
status: todo
priority: low
depends_on: [P7-03]
adr: ["0013"]
lessons: [L-080, L-111]
owner: ""
---

# P7-16 — Show the remaining write budget

> Filed by P7-03 ([write limiter](P7-03-write-limiter.md)). Refine scope and acceptance criteria before starting.

## Goal
A caller and an owner can see how many writes are left this hour, without taking a unit.

## Scope
- `whoami` and the dry run report the grant's remaining writes and the next window (a read of the counter; no secret, no other grant's count).
- The admin overview shows the deployment's use this hour.
- Reading the counter failing shows "unknown", never "unlimited" (the write itself still fails closed).

## Acceptance criteria
- [ ] Remaining count after N writes, a new window, and a failing store (unknown), on memory and SQLite.
- [ ] A member sees only their own grant's count.

## Security notes
THREAT_MODEL T31.

## Lessons applied
- L-080 — Decide fail-open vs fail-closed for each control, and test it.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
