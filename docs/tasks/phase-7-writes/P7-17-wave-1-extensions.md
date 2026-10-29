---
id: P7-17
title: "Wave-1 extensions: clear the sprint, effort for others, to-do"
phase: 7
status: review
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
Each is an argument of an existing tool (no new tool, the catalogue count is unchanged); the canonical mutation shows old and new for it; every request shape is *unverified* until P7-07 and is on its checklist.
- `move_to_sprint` takes `to_backlog: true` (a typed boolean, exclusive with `sprint`) to take an item out of its sprint. The mutation shows `Timebox`: the sprint now, then `null`; the request is `<Relation name="Timebox" act="set"/>` with no child. An item that is in no sprint is a no-op.
- `log_effort` takes an optional `member` to log for someone else. Policy (D-236): the narrowest that is useful, the member must already be an **owner of that item** (the person who works on it); anyone else is refused before any approval. The approval shows the member as `Actual.Member`, so the person who approves sees who the hours are logged for. A cross-member log needs nothing else than the existing layers (the person's own token, the approval); Agility's own permissions still apply.
- Remaining to-do (D-237): not a second write inside `log_effort` (two requests behind one approval could leave half a change, and writes are never retried). It is the `todo` argument of `update_fields` for a task or test (hours, one request, old and new in the approval, the same conflict and no-op rules).

## Acceptance criteria
- [x] Each extension has dry run, approval, conflict, no-op and refusal tests, and the request body asserted.
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
