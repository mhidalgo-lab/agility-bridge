---
id: P6-02
title: Planning tools (get_sprint)
phase: 6
status: review
priority: high
depends_on: [P2-17]
adr: ["0011", "0012", "0015"]
lessons: [L-033, L-060, L-061, L-064, L-114]
owner: "agent (P6-02)"
---

# P6-02 — Planning tools (`get_sprint`)

## Goal
Sprint-level answers: what was committed, what is done, what changed.

## Scope
`get_sprint` (group `planning`, kind `read`, not paged). Arguments: `sprint` (OID token, exact name, or `current` /
`previous` / `next`; default `current`), `team` and `project` (narrow the relative lookups, as in `list_sprints`),
`burndown` (boolean, default true), `format`.

The result, all of it inside the untrusted-data envelope and the shaper (ADR-0015):

- **Sprint**: OID, name, `state`, `timing` (`past` / `current` / `future`, UTC), `beginDate`, `endDate`, and its
  **schedule** (OID and name) when the sprint has one.
- **Totals** over the sprint's backlog items and defects (`PrimaryWorkitem` with `Timebox` = the sprint): item count,
  `estimate` total, **done** (status category `completed`), **remaining**, and the number of **unestimated** items; the
  estimate is a sum of the items' `Estimate` and never counts an item without one as zero.
- **By status category** (`not_started`, `in_progress`, `completed`, and `unknown` when the status has no category on
  this instance, L-142): items and estimate per category; the item list (capped) with the category of each.
- **Committed vs done**: *committed* is the estimate of the items in the sprint **at its begin date** (an `asof` read,
  ADR-0011), so later additions do not inflate it; `addedAfterStart` and `removedSinceStart` count the scope change.
  A future sprint has no start yet: its planned total is reported as `planned`, not `committed`.
- **Carry-over**: for a past sprint, the items not completed at its end (count, estimate, the items); a running or
  future sprint has none and says so.
- **Burndown**: remaining estimate (items whose status is not `completed`) at **bounded history points**: one per day
  from the begin date up to the end date or now, at most 15 points (the step widens for longer sprints), each point at
  most `maxAsOfAgeDays` old, all points in a few batched `query.v1` requests (one page of items per query, 20 queries per request), with the ideal line when `committed` is
  known. A point that cannot be read (older than the history limit, too many items) is left out and named in `notes`.
- **Capacity**: the Agility schema that ships with the product has no capacity model in the sprint (no `Capacity`
  asset type in the metadata snapshot), so capacity is **not reported**; a note says so (D-83).

Missing data is never turned into zeros (L-033): `partial: true` plus `notes` whenever items were capped, history was
unavailable, or the instance does not expose a value. The workspace's Agility-project restriction is added by the
compiler to every query and every row is rechecked (THREAT_MODEL T3).

## Acceptance criteria
- [x] The task is refined (this scope), status `in-progress`, in its own commit.
- [x] `get_sprint` in `packages/core/src/tools/planning/sprint.ts`, registered in the catalogue; name, description,
      cost and schema pass the lints; the cost test holds on a cold cache; `docs/reference/tools.md` regenerated.
- [x] Fixtures for a running, a finished and a future sprint: committed vs done, categories, carry-over, scope change,
      burndown points that reconcile with the item totals (the last point of a finished sprint equals its remaining
      estimate; a running sprint's last point equals the current remaining), history bounded (15 points, age limit,
      never in the future), history in a few batched requests (20 queries each, D-84).
- [x] Missing data: no estimates, no status category, no history, a sprint with more items than fit: `partial` and
      notes, never zeros.
- [x] Negative authorization: a sprint outside the workspace answers `AB_NOT_FOUND` with no item query and no data; items
      outside the workspace are dropped even when the upstream ignores filters; a denied tool is not callable.
- [x] Poisoned upstream text (sprint, status, item, schedule names) stays inside the envelope on every output path.
- [x] Live test (`live/sprint.live.test.ts`) under the read-only guard: shapes and coarse levels only.
- [x] Docs updated, lessons recorded, decisions recorded in `docs/pending-decisions/phase-6.md`; changeset added.

## Security notes
Read-only. Every value that reaches Agility is a bound parameter (the sprint OID is a resolved, trusted filter); history
dates are computed by the server from the sprint's own dates and bounded before the request (L-060).

## Lessons applied
- L-033 — Never turn missing data into zeros or confident claims.
- L-060 — Bound time and history before the request.
- L-061 — One time model for the whole server.
- L-064 — Recheck scope on every row.
- L-114 — Declared cost covers the worst case.

## Docs to update
- docs/reference/tools.md (generated), docs/reference/tool-catalogue.md, docs/guide (tools overview, if it lists tools)

## Out of scope
- Velocity across sprints, team capacity and availability (follow-up P6-17; sprints of several hundred items, P6-18), the `sprint_health` report (P6-07), MCP
  Apps burndown view (Phase 8), hour-based (task-level) burndown.

## Outcome
- Built as scoped; decisions D-83 (no capacity), D-84 (`asof` queries, not `Hist`), D-85 (status rollup category) in
  [pending decisions](../../pending-decisions/phase-6.md). Lessons L-276 to L-279. Follow-ups P6-17 and P6-18.
- Sprint name and OID resolution now include closed sprints, and `category()` no longer maps a missing rollup to
  "not started" (both shared code, covered by the new tests and the existing suites).
- Live (2026-10-27, read-only tenant): past and current sprints read, categories add up, history bounded and ordered;
  sprints hold hundreds of items, so some points are left out and named (P6-18).
