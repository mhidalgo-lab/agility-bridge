---
id: P6-17
title: Sprint capacity, velocity and hour-based burndown
phase: 6
status: review
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
Refined 2026-10-28 (no writable sandbox and no live access in this change; capacity has no data on the read-only tenant, D-83):
- Built: velocity, the new read tool `get_velocity` (planning group): the completed estimate of the last N (at most 10) past sprints of a
  team or Agility project, each read as it ended in one batched request, bounded by `maxAsOfAgeDays`, with the sprints that
  could not be read named in `notes` (D-139 style bounds, L-060, L-279, P6-42). The default catalogue target moves to 37.6 KB (D-140).
- Hour-based burndown: `Task` has `ToDo`, `DetailEstimate` and `Timebox` in the metadata snapshot, so it can be built, but it adds a
  second family of per-point `asof` queries (L-330: a live check first). Not built here; needs a follow-up task id.
- Capacity: not built, as D-83 decided; becomes a sandbox follow-up when an instance with capacity data is available.

## Acceptance criteria
- [x] Refined with the evidence available (the snapshot has the task hour attributes; capacity has no data).
- [x] Fixtures and negative authorization tests for velocity (`velocity.test.ts`).
- [ ] A live check (shapes and levels only), the hour-based burndown and capacity: not done, see Scope.

## Out of scope
- Forecasting beyond what the data shows; anything that writes.
