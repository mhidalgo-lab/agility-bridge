---
id: P3-11
title: Phase 3 review and staging verification
phase: 3
status: todo
priority: high
depends_on: [P3-04, P3-06, P3-07, P3-08, P3-09, P3-10]
adr: []
lessons: [L-002, L-004]
owner: ""
---

# P3-11 — Phase 3 review and staging verification

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Verify the Worker deployment for real before adding identity and OAuth.

## Scope
- Staging deployment with smoke tests; multi-isolate behaviour; client checks over HTTPS; review; findings → tasks.

## Acceptance criteria
- [ ] `docs/reviews/phase-3-review.md`; staging smoke workflow green; go for Phase 4.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-002 — A spike is done only when it ran in production-like conditions.
- L-004 — End every phase with a review and a live pass, and reserve capacity for follow-ups.

## Docs to update
- docs/reviews/phase-3-review.md (new)

## Out of scope
- Anything not listed under Scope.
