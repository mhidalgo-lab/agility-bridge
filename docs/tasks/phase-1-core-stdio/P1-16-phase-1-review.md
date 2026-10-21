---
id: P1-16
title: Phase 1 review and live verification
phase: 1
status: done
priority: high
depends_on: [P1-15]
adr: []
lessons: [L-003, L-004, L-010, L-023, L-169, L-170, L-171]
owner: "Matias Hidalgo"
---

# P1-16 — Phase 1 review and live verification

## Goal
Find what Phase 1 got wrong before building on it.

## Scope
- Adversarial review of the core, query compiler, output shaper and CLI.
- Live suite and manual checks against the sandbox; real-client check of v0.1 in every stdio-capable primary client (hosted Claude clients are verified in Phase 5).
- Threat-model statuses updated with evidence; findings become new Phase 1 tasks.

## Acceptance criteria
- [x] `docs/reviews/phase-1-review.md` written.
- [x] Client matrix updated; follow-up tasks created; go recorded for Phase 2. *(Inspector verified; owner client runs
  pending; P1-17 and P1-18 created; go recommended and recorded as D-21 for the owner)*

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-003 — Plan live verification from Phase 0, not at the end.
- L-004 — End every phase with a review and a live pass, and reserve capacity for follow-ups.
- L-010 — Every security claim needs evidence.
- L-023 — SDK conformance does not prove client compatibility.

## Docs to update
- docs/reviews/phase-1-review.md (new)
- docs/THREAT_MODEL.md
- docs/LESSONS-LEARNED.md

## Out of scope
- Anything not listed under Scope.
