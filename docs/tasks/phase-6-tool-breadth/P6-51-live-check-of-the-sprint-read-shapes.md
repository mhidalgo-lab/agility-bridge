---
id: P6-51
title: Live check of the get_sprint read shapes
phase: 6
status: todo
priority: low
depends_on: [P6-41, P6-42]
adr: []
lessons: [L-279, L-330]
owner: ""
---

# P6-51 — Live check of the get_sprint read shapes

## Goal
P6-41 and P6-42 changed how `get_sprint` sends its reads (concurrent history requests, a two-query first request, a smaller
batch when the page size is large). The fakes cannot show whether the real tenant accepts them within its time limits (L-330).

## Scope
- Run `get_sprint` on the live suite for a running and a past sprint: the call finishes, request count and wall time are no worse than before (levels only).
- With `AB_MAX_ROWS` above 250, check that the oversized-chunk path (P6-42) still answers with a note and not an error.
- On the sandbox, check whether `query.v1` accepts one shared `with` for the scope list across the queries of a batch (unverified); if so, build it.

## Acceptance criteria
- [ ] Live results recorded as shapes and levels only in the task and docs/RESEARCH.md.
- [ ] A shared `with` is built or declared unsupported.

## Security notes
No tenant content, names or ids in the record.

## Lessons applied
- L-279
- L-330

## Docs to update
- docs/RESEARCH.md; the task file.

## Out of scope
- Anything not about the request shapes of `get_sprint`.
