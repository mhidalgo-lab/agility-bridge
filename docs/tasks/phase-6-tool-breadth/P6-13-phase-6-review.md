---
id: P6-13
title: Phase 6 review and live verification
phase: 6
status: review
priority: high
depends_on: [P6-03, P6-04, P6-06, P6-10, P6-11, P6-12]
adr: []
lessons: [L-003, L-004, L-033, L-060, L-121]
owner: "agent"
---

# P6-13 — Phase 6 review and live verification

> Refined 2026-10-27 (tasks/README rule 7).

## Goal
Close Phase 6 with evidence: a security, a quality and a performance review of everything Phase 6 added, every confirmed
finding fixed or recorded, the two flaky tests fixed at their root, a live pass over every new tool, resource and prompt,
and the owner's list for the release.

## Scope
- Three independent read-only reviews of the Phase 6 range (`cfeeab3..636cd4a`): security, quality and correctness,
  performance and cost. Each finding is verified (reproduced with a failing test where practical) before it is fixed; what
  does not hold is dropped or downgraded in the review document, with the reason.
- Fix every confirmed high and medium finding and the cheap low ones, each with a regression test. Behaviour changes to
  tools of this unreleased version are fine; the default `tools/list` stays under the contract test's limits and the router
  eval baseline does not regress. Larger or unsure work becomes tasks P6-39 … P6-48.
- Fix the two flaky-test roots: the worker OAuth "one 401" test (a response body read late across a second request) and
  the property tests that hit the default 5 s timeout under load.
- Live pass (`pnpm test:live`, guarded, read-only, one request at a time): every tool, resource and prompt of Phase 6
  exercised; results recorded as shapes, counts and levels only, never tenant content, names, ids or URLs.
- `docs/reviews/phase-6-review.md`; an "Owner steps" section in `docs/pending-decisions/phase-6.md`; P6-01 … P6-12 set to
  `done` (their work is merged, the review closes them).
- Not in scope: the real OAuth client runs (P6-14), the LLM eval run (P6-33), the v0.6 release (the owner merges the
  Version Packages PR).

## Acceptance criteria
- [x] Every high and medium finding of the three reviews is fixed with a regression test, or dropped or downgraded with a
      reason in the review document; every deferred finding has a task.
- [x] The two flaky tests are fixed at their root (late body read; property test time) and recorded as lessons.
- [x] `pnpm test:live` passes with every Phase 6 tool, resource and prompt exercised; results recorded without tenant data.
- [x] `docs/reviews/phase-6-review.md` with scope, method, every finding and verdict, sizes, eval numbers, live results and
      the owner's steps; `docs/pending-decisions/phase-6.md` has an "Owner steps" section.
- [x] THREAT_MODEL, logging docs and RESEARCH updated where the fixes or live facts require; lessons and decisions numbered
      consistently; generated references current; a patch changeset is included.
- [x] P6-01 … P6-12 are `done`; `pnpm lint && pnpm typecheck && pnpm test && pnpm build` are green.
- [ ] Release v0.6 (owner: merges the Version Packages PR after P6-14 and P6-33).

## Outcome
- [docs/reviews/phase-6-review.md](../../reviews/phase-6-review.md): three high, five medium and about twenty low findings from three reviews;
  all high and medium fixed or narrowed with regression tests (one reviewer fix, `AssetState` on every `asof` query, made the real tenant
  time out and was replaced by a note), two flaky tests fixed at their roots, ten deferred items filed as P6-39 to P6-48.
- Live pass: 11 files, 33 tests passed on the real tenant (levels only); the resource list and the prompts make no upstream request.
- New: lessons L-321 to L-330, decisions D-117 to D-122, tasks P6-39 to P6-48. P6-01 to P6-12 are `done`. The release (v0.6) is the owner's,
  after P6-14 and P6-33.

## Security notes
Security-relevant fixes (attachment error text, history age limit and scope paths, resource listing) update THREAT_MODEL in
the same PR.

## Lessons applied
- L-003 — Plan live verification from Phase 0, not at the end.
- L-004 — End every phase with a review and a live pass, and reserve capacity for follow-ups.
- L-033 — No plausible number from partial data.
- L-060 — A limit named for a date applies to every path that reads at that date.
- L-121 — A regression test must fail with the fix reverted.

## Docs to update
- docs/reviews/phase-6-review.md (new)
- docs/pending-decisions/phase-6.md
- docs/LESSONS-LEARNED.md, docs/THREAT_MODEL.md, docs/RESEARCH.md (as findings require)

## Out of scope
- Anything not listed under Scope.
