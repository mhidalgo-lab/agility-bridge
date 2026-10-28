---
id: P6-56
title: Check whether a sprint is still current on its end date
phase: 6
status: todo
priority: low
depends_on: [P6-47, P6-27]
adr: []
lessons: [L-276, L-033]
owner: ""
---

# P6-56 — Check whether a sprint is still current on its end date

## Goal
`get_sprint` calls a sprint `current` while `begin <= now < end` (UTC). If Agility treats the end date as inclusive (the sprint
is still running on its last day), `timing` is wrong for the last day and the ideal burndown line ends a day early. Split from
[P6-47](P6-47-polish-defect-triage-standup-and-get-sprint-output.md): it needs a sandbox.

## Scope
- On a sandbox with a sprint that ends today, read the sprint in Agility's UI/API and record whether it is current on its last day.
- If it is, fix `timing`, `resolveSprint('current')` and the ideal line; otherwise record the result and close.

## Acceptance criteria
- [ ] The finding is in docs/RESEARCH.md with its date (shapes only, no tenant content).
- [ ] If inclusive: tests for the last day in `get_sprint` and `resolveSprint`; if not: a note only.

## Security notes
None.

## Lessons applied
- L-276
- L-033

## Docs to update
- docs/RESEARCH.md; the get_sprint page when behaviour changes.

## Out of scope
- Anything beyond the end-date boundary.
