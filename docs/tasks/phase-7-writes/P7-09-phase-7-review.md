---
id: P7-09
title: Phase 7 review
phase: 7
status: todo
priority: high
depends_on: [P7-08, P5-10]
adr: []
lessons: [L-004, L-112]
owner: ""
---

# P7-09 — Phase 7 review

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Independent-minded review of the write path before release.

## Scope
- Adversarial review (approval binding, replay, alternate writers of write settings, limits); real-client write checks; findings → tasks.

## Acceptance criteria
- [ ] `docs/reviews/phase-7-review.md`; release v0.7.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-004 — End every phase with a review and a live pass, and reserve capacity for follow-ups.
- L-112 — Rehearse writes in a sandbox before enabling them anywhere.

## Docs to update
- docs/reviews/phase-7-review.md (new)

## Out of scope
- Anything not listed under Scope.
