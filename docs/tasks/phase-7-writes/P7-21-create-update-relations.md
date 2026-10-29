---
id: P7-21
title: "Create and update with owners, team, sprint and defaults from New"
phase: 7
status: review
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
Built now, on fakes; every request shape is *unverified* and on the P7-07 checklist. No new tool (the catalogue count is unchanged).
- `create_work_item` takes `owners` (at most three members, resolved like `assign_owners`; more are added with `assign_owners`), `team` and `sprint` (the sprint of the new item's project schedule, open). Each is a relation the type must let this instance write (`Owners`, `Team`, `Timebox`; a type or an instance where the relation is not writable is refused), shown in the approval as a new value, and sent in the same single create request. The sprint is checked again at the re-read.
- `update_fields` takes `parent` (re-parent: a story, defect or epic under an epic; a task or test under a story or defect **of its own project**, never itself, never closed) and `project` (move a story, defect or epic to another open project of the workspace; a task or test follows its parent and is never moved). The new parent or project is resolved inside the workspace's projects like any target, the old and new value are shown (`Super` or `Parent`, `Scope`) and bound, and the re-read compares them. A move is refused while the item is in a sprint (take it out first with `move_to_sprint`, `to_backlog`, D-240), because the sprint belongs to the old project's schedule.
- Declared costs and the worst-case fixtures of both tools cover the new paths (L-114).

Not doable now (left as unchecked items):
- Showing the defaults Agility applies on create (`rest-1.v1/New`, D-180) in the approval: the response of that endpoint is unknown until the sandbox. Left for P7-07.
- Whether Agility accepts the move (open children, other validators) and a re-parent across projects: sandbox (P7-07).

## Acceptance criteria
- [x] Each addition has dry run, approval, conflict, no-op and refusal tests, negative authorization tests and the request body asserted.
- [ ] *Defaults from `rest-1.v1/New` shown in the approval (D-180):* needs the writable sandbox (P7-07).
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
