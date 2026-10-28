---
id: P1-20
title: Live check of the UTC date variants and the zone of the plain ones
phase: 1
status: todo
priority: low
depends_on: [P1-19]
adr: ["0015"]
lessons: [L-149, L-335]
owner: ""
---

# P1-20 — Live check of the UTC date variants and the zone of the plain ones

## Goal
P1-19 was built and unit-tested without a live run. Confirm on the live tenant that the compiler's `…UTC` mapping returns
the same instants as `get_work_item`, and find out which zone the plain `ChangeDate` / `CreateDate` use.

## Scope
- A live case: `query_assets` and `get_assets` with `fields: ["ChangeDate", "CreateDate"]` against `get_work_item` for the
  same asset; a `ChangeDate` filter with a UTC bound against the same filter on `ChangeDateUTC`.
- Work out the zone of the plain variant (server, instance setting or member preference) from the offset between the two
  variants, and record it in RESEARCH.md (Dates) with the date. Report shapes and offsets only, never tenant content.

## Acceptance criteria
- [ ] The live suite checks the instants agree (shapes only, no tenant values in the assertion text).
- [ ] RESEARCH.md (Dates) records the finding with the date, marking the zone's origin verified or *unverified*.

## Security notes
None. Read-only.

## Lessons applied
- L-149, L-335.

## Docs to update
- docs/RESEARCH.md (Dates)

## Out of scope
- Showing times in the caller's zone.
