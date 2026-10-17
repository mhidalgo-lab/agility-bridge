---
id: P6-02
title: Planning tools (sprints, schedules, capacity)
phase: 6
status: todo
priority: high
depends_on: [P2-17]
adr: ["0015"]
lessons: [L-033, L-060, L-061]
owner: ""
---

# P6-02 — Planning tools (sprints, schedules, capacity)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Sprint-level answers: what was committed, what is done, what changed.

## Scope
- `get_sprint`: dates, committed vs done estimates, items by status category, carry-over, burndown points from bounded history; schedules and capacity where the instance exposes them.

## Acceptance criteria
- [ ] Fixtures for running, finished and future sprints; burndown reconciles with item totals; history window bounded.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-033 — Never turn missing data into zeros or confident claims.
- L-060 — Bound time and history before the request.
- L-061 — One time model for the whole server.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
