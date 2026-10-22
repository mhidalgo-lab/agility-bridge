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

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
Verify the Worker deployment for real before adding identity and OAuth.

## Scope
- An independent adversarial review of the Phase 3 code; findings fixed with mutation-checked regression tests, turned
  into tasks, or documented.
- Staging verification on `agility-bridge-staging`: smoke checks over HTTPS (`scripts/staging-smoke.ts` and a
  hand-run *Staging smoke* workflow that takes the address as input and needs no secret), MCP Inspector over HTTPS in
  both eras, multi-isolate behaviour observed; real clients are owner steps.
- `docs/reviews/phase-3-review.md`, threat-model statuses after Phase 3, go for Phase 4 (D-28).

## Acceptance criteria
- [ ] `docs/reviews/phase-3-review.md`; every finding fixed or documented, with tests.
- [ ] Staging smoke checks green (script against staging; the workflow added and tested).
- [ ] Go for Phase 4 recorded (D-28); owner steps listed.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-002 — A spike is done only when it ran in production-like conditions.
- L-004 — End every phase with a review and a live pass, and reserve capacity for follow-ups.

## Docs to update
- docs/reviews/phase-3-review.md (new), docs/THREAT_MODEL.md, docs/pending-decisions/phase-3.md

## Out of scope
- P3-12 (optional), D-27 (owner decision).
