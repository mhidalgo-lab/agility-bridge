---
id: P6-01
title: Portfolio tools (epics and portfolio items)
phase: 6
status: todo
priority: high
depends_on: [P2-17]
adr: ["0015"]
lessons: [L-035, L-043, L-148]
owner: ""
---

# P6-01 — Portfolio tools (epics and portfolio items)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
See the portfolio tree and its progress without hand-written queries.

## Scope
- `list_portfolio_items` (categories such as Feature or Initiative are values of the `Epic` type field) and `get_portfolio_tree` (depth-bounded descendants, roll-ups of estimates, done percentage and open defects).
- Honest `partial` when depth, budget or permissions cut the tree.

## Acceptance criteria
- [ ] Fixtures with three portfolio levels; roll-ups exclude dead assets; costs declared and tested.

## Security notes
THREAT_MODEL A4.

## Lessons applied
- L-035 — Validate at the domain level before calling upstream.
- L-043 — Keep identity on every row.
- L-148 — Learn the model from metadata, then verify relations live.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
