---
id: P6-61
title: "Show the server's call budget in the limits form hint"
phase: 6
status: todo
priority: low
depends_on: [P6-58]
adr: ["0010"]
lessons: [L-475]
owner: ""
---

# P6-61 — Show the server's call budget in the limits form hint

> Filed by [P6-58](P6-58-panel-inherited-call-budget-note.md) (D-337).

## Goal
The "Agility requests per tool call" field of the workspace and grant forms says what blank means in numbers ("the server's default is 45, and the plan's ceiling 45") instead of only "inherit".

## Scope
- Use `GET /limits` (P6-58) in the form pages and put the two numbers in the field hint; nothing when the answer is missing.

## Acceptance criteria
- [ ] The hint shows the default and the ceiling on a Workers Free world, and nothing on a world that does not say.
- [ ] A hostile value in the answer is not shown.

## Security notes
Our own numbers only (THREAT_MODEL T13).

## Lessons applied
- L-475 — Ask the server; say nothing when it does not answer.

## Docs to update
- docs/dev/admin-ui.md

## Out of scope
- Anything not listed under Scope.
