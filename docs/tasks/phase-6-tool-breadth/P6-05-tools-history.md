---
id: P6-05
title: History and activity tools
phase: 6
status: todo
priority: medium
depends_on: [P2-17]
adr: ["0011"]
lessons: [L-060, L-146]
owner: ""
---

# P6-05 — History and activity tools

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Answer "what changed and when" from the authoritative history.

## Scope
- `get_asset_history` (bounded window, from `rest-1.v1/Hist` or `asof`) and `list_recent_changes` for an Agility project or team; activity stream only as a hint.

## Acceptance criteria
- [ ] History matches known edits on the sandbox; windows bounded; costs within budget.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-060 — Bound time and history before the request.
- L-146 — The activity stream is not authoritative.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
