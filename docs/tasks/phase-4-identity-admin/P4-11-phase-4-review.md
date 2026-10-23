---
id: P4-11
title: Phase 4 review
phase: 4
status: todo
priority: high
depends_on: [P4-08, P4-09, P4-10]
adr: []
lessons: [L-004, L-096, L-117]
owner: ""
---

# P4-11 — Phase 4 review

> Refined 2026-10-23 (tasks/README rule 7).

## Goal
Close Phase 4 with evidence: an independent read of what the admin security review (P4-09) did not centre on, a
live pass on staging, and a go or no-go for Phase 5.

## Scope
- A fresh adversarial read of the cross-cutting concerns of the Phase 4 surface: request isolation in the new code
  (L-013, L-096), the lazy panel load and the Worker's cold start, the web-standard-only rule, redaction of every new
  secret type in logs, untrusted-data rendering in the panel (ADR-0015), storage contract parity, migrations, docs
  against code, task bookkeeping, and lesson and decision numbering. Every claim is reproduced with a throwaway test
  against local fakes; only reproduced issues are findings, fixed with mutation-checked regression tests or recorded
  as follow-up tasks or decisions.
- Live verification on `agility-bridge-staging` (smoke checks, the sign-in routes, the lazily loaded panel); real
  sign-in with an identity provider and client runs are owner steps.
- `docs/reviews/phase-4-review.md`, threat-model touch-ups, the go for Phase 5 recorded as a decision.
- P4-09 set from `review` to `done` (its PR #100 is merged).

## Acceptance criteria
- [ ] `docs/reviews/phase-4-review.md`; every finding fixed or recorded, with tests.
- [ ] Staging checks recorded (the coordinator ran them); owner steps listed.
- [ ] Go for Phase 5 recorded as a decision with options and a recommendation.
- [ ] Every Phase 4 task is `done` or an open follow-up; no unticked box left in a done task.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-004 — End every phase with a review and a live pass, and reserve capacity for follow-ups.
- L-096 — Never share in-flight I/O between requests on Workers.
- L-117 — Redact in one place, for every new secret shape.

## Docs to update
- docs/reviews/phase-4-review.md (new)
- docs/pending-decisions/phase-4.md (go for Phase 5)
- docs/LESSONS-LEARNED.md, docs/THREAT_MODEL.md (as findings require)

## Out of scope
- Re-doing the admin security review (docs/reviews/phase-4-admin-security-review.md).
- Anything not listed under Scope.
