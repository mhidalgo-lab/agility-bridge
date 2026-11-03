---
id: P9-02
title: External security review
phase: 9
status: in-progress
priority: high
depends_on: [P9-01]
adr: []
lessons: [L-010, L-483]
owner: "claude (phase 9 lane A)"
---

# P9-02 — External security review

> Refined 2026-11-03 (tasks/README rule 7). Depends on P8-12 only through P9-01, waived by the owner on 2026-11-03 (live
> pass pending). Choosing and engaging the reviewer, and publishing the review summary, are owner steps.

## Goal
An independent reviewer examines the riskiest areas before 1.0, and we arrive at that review with our own pre-review done.

## Scope
- A call for reviewers (`docs/security/call-for-reviewers.md`): scope (OAuth, approval and write path, query compiler,
  access model, key handling, admin panel and API), a reviewer map to code, tests, ADRs and guides, how to run the project,
  safe-harbour and coordinated-disclosure terms, what is already known, how to report, what is published. `SECURITY.md`
  links it and carries the terms.
- An internal read-only pre-review of the six areas (`docs/reviews/phase-9-pre-review.md`): real findings get a fix and a
  regression test that fails without it; larger or policy-shaped ones become task files or owner decisions.
- Triage and fixes of the external findings, and the published summary, after the reviewer reports.

## Acceptance criteria
- [x] The call for reviewers exists with the six areas, the reviewer map, safe-harbour and disclosure terms, the known
      residual risks and the reporting channel; SECURITY.md carries the terms and links the call.
- [x] The internal pre-review of the six areas is written up with each finding's disposition (fixed with a test, task, or
      decision) and what was checked and found defended.
- [x] Every real finding is fixed with a regression test that fails without the fix, or has a task or a recorded decision.
- [x] `THREAT_MODEL.md` updated for the change; lessons and decisions recorded; `pnpm lint && pnpm typecheck && pnpm test` green.
- [ ] *owner:* An external reviewer is chosen and engaged, using the call for reviewers.
- [ ] *owner:* The review report is received; every finding is fixed or accepted (with regression tests) and the summary
      is published (`docs/reviews/`, linked from SECURITY.md).

## Security notes
Touches T11, T20 (CIMD document eviction), T14, A14 (recorded decisions). The call tells reviewers which residual risks are
known.

## Lessons applied
- L-010 — Every security claim needs evidence.
- L-483 — Evidence maps are read by a test (reviewers start from the map).

## Docs to update
- docs/security/call-for-reviewers.md (new), docs/reviews/phase-9-pre-review.md (new), SECURITY.md, docs/THREAT_MODEL.md

## Out of scope
- Fixing findings that need a design decision from the owner: they become tasks (P9-10 to P9-12).
