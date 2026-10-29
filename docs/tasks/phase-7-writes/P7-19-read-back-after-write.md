---
id: P7-19
title: Optional read-back after a write
phase: 7
status: todo
priority: low
depends_on: [P7-04, P7-07]
adr: ["0013"]
lessons: [L-051]
owner: ""
---

# P7-19 — Optional read-back after a write

> Filed by P7-04 ([writes wave 1](P7-04-writes-wave-1.md)). Refine scope and acceptance criteria before starting.

## Goal
After a write the answer could show what Agility now holds, instead of only saying that it may lag.

## Scope
- A bounded read-back of the changed fields after the send, reported as `confirmed`, `not yet visible` or `unknown` (never an error: the write already happened), sized by what P7-07 measures about read lag.
- One extra read per write, so every write tool declares its cost with it.

## Acceptance criteria
- [ ] Fixture tests for confirmed, lagging and failing read-back; no retry of the write in any case.
- [ ] *Sandbox (P7-07):* measured lag recorded.

## Security notes
THREAT_MODEL A2, T31.

## Lessons applied
- L-108 — Validate fully, then ask, then re-check, then apply once.

## Docs to update
- docs/reference/tools.md (generated)
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
