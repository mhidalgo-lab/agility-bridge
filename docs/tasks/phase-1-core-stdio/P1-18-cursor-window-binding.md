---
id: P1-18
title: Bind the cursor's time window and fix sprint timing per first page
phase: 1
status: todo
priority: low
depends_on: [P1-16]
adr: ["0015"]
lessons: [L-061]
owner: ""
---

# P1-18 — Bind the cursor's time window and fix sprint timing per first page

## Goal
A cursor cannot carry a widened time window, and a paged list keeps the "now" of its first page (Phase 1 review, low
finding).

## Scope
- Include the resolved window in the binding hash (or authenticate the cursor), and re-validate it against
  `maxTimeRangeDays` on decode.
- `list_sprints` stores the first call's "now" in the cursor and evaluates `timing` against it on later pages.

## Acceptance criteria
- [ ] A cursor with an edited window is refused before any request.
- [ ] Paging `list_sprints` across a sprint boundary neither skips nor repeats a sprint.

## Security notes
THREAT_MODEL T4 (input integrity).

## Lessons applied
- L-061 — One time model for the whole server.

## Docs to update
- docs/dev/tool-conventions.md (Paging)

## Out of scope
- New `time_range` tools (Phase 6).
