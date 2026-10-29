---
id: P7-17
title: "Wave-1 extensions: clear the sprint, effort for others, to-do"
phase: 7
status: todo
priority: low
depends_on: [P7-04]
adr: ["0013"]
lessons: [L-393]
owner: ""
---

# P7-17 — Wave-1 extensions: clear the sprint, effort for others, to-do

> Filed by P7-04 ([writes wave 1](P7-04-writes-wave-1.md)). Refine scope and acceptance criteria before starting.

## Goal
The wave-1 tools cover the common case; these are the next requests people will make.

## Scope
- `move_to_sprint` with a way to take an item out of its sprint (back to the backlog), as a typed value, not an empty string.
- `log_effort` for another member (needs a policy on who may log for whom) and an optional remaining `ToDo` update in the same mutation.
- Each is a field or argument of an existing tool; the canonical mutation shows old and new for it.

## Acceptance criteria
- [ ] Each extension has dry run, approval, conflict, no-op and refusal tests, and the request body asserted.
- [ ] *Sandbox (P7-07):* each against a writable instance.

## Security notes
THREAT_MODEL A2, T31.

## Lessons applied
- L-108 — Validate fully, then ask, then re-check, then apply once.

## Docs to update
- docs/reference/tools.md (generated)
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
