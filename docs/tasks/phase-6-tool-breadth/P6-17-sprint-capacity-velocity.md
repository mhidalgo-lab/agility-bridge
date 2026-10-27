---
id: P6-17
title: Sprint capacity, velocity and hour-based burndown
phase: 6
status: todo
priority: low
depends_on: [P6-02]
adr: ["0011"]
lessons: [L-033, L-060, L-279]
owner: ""
---

# P6-17 — Sprint capacity, velocity and hour-based burndown

> Created by P6-02 ([D-83](../../pending-decisions/phase-6.md)). Later-phase task: **refine scope and acceptance criteria
> before starting** (tasks/README rule 7).

## Goal
Answer "how much can the team take" and "how fast do they go" next to `get_sprint`, from data the instance really holds.

## Scope
- Find out, on an instance that has them, where capacity (per member or per team, per sprint) is stored; verify against
  a writable sandbox (the read-only tenant shows nothing). Report it in `get_sprint` or a sibling tool, never estimated.
- Velocity: completed estimate of the last N sprints of a team or Agility project, bounded history (L-060), with sprints
  that could not be read named in `notes`.
- Hour-based burndown from task `ToDo` and `DetailEstimate` at the same bounded points.

## Acceptance criteria
- [ ] Refined with the instance evidence (what exists, where, how it is read).
- [ ] Fixtures, negative authorization tests and a live check (shapes and levels only).

## Out of scope
- Forecasting beyond what the data shows; anything that writes.
