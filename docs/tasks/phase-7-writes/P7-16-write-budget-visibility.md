---
id: P7-16
title: Show the remaining write budget
phase: 7
status: in-progress
priority: low
depends_on: [P7-03]
adr: ["0013"]
lessons: [L-080, L-111]
owner: ""
---

# P7-16 — Show the remaining write budget

> Filed by P7-03 ([write limiter](P7-03-write-limiter.md)). Refine scope and acceptance criteria before starting.

## Goal
A caller and an owner can see how many writes are left this hour, without taking a unit.

## Scope
Refined 2026-10-29.

- `WriteLimiter.budget` (optional method): a **read** of the grant's counter, and of the deployment's where there is one, for the current window; it never takes a unit and never throws (a store that fails or answers something other than a count gives `unknown`, never "unlimited"; the write itself still fails closed). The window is the limiter's clock hour, `windowEndsAt` is when it resets. The grant's limit is the lower of the configured value and the grant's own cap (P7-15).
- **Caller** (`whoami` and the dry run of every write tool): `writes.budget` / `writeBudget` with `limit`, `used`, `remaining`, `resetsAt` of the caller's **own grant** only, and `deploymentFull: true` when the deployment's counter is spent (the number of the deployment is not shown to a caller). A dry run with nothing left says that a real call would be refused. `whoami` shows it only when writes are enabled for the caller.
- **Admin API**: `GET /api/admin/v1/writes/budget` (owner, admin): the deployment's use this hour; `GET /api/admin/v1/grants/{id}/write-budget`: one grant's use (a manager for any grant, a member only for their own, anyone else gets the same "no grant" answer). Both answer `{ enabled: false }` when write tools are off.
- **Panel**: the overview shows the deployment's use this hour to owners and admins; a grant's page shows its writes this hour. A failing read shows "unknown".
- No change to what a write spends or refuses; stdio (process counters, no deployment limit) gets the grant part.

## Acceptance criteria
- [x] Remaining count after N writes, a new window, and a failing store (unknown), on the memory counters and the storage `kv` (memory; SQLite and D1 run the shared limiter contract).
- [x] Reading takes no unit (the next write is admitted at the same count), and a refused deployment is shown without its number to a caller.
- [x] A member sees only their own grant's count (API) and never another grant's or the deployment's.
- [x] `whoami`, the dry run, the admin routes and the panel are tested; generated references and the tool contract refreshed.

## Security notes
THREAT_MODEL T31.

## Lessons applied
- L-080 — Decide fail-open vs fail-closed for each control, and test it.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
