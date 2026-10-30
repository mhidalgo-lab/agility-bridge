---
id: P8-21
title: "Stop the OAuth abuse tests timing out on busy CI runners"
phase: 8
status: done
priority: low
depends_on: []
adr: []
lessons: [L-382, L-446]
owner: ""
---

# P8-21 — Stop the OAuth abuse tests timing out on busy CI runners

## Goal
`packages/http-app/test/oauth/abuse.test.ts` fails with "Test timed out in 5000ms" on a loaded CI runner and passes on a rerun
(seen on three Phase 8 pull requests in one afternoon: "authorize: a flood from one address is cut at the limit…", "the operator
view shows the caps…", "token: failed exchanges are cut at the limit per address…"). A required check that flakes costs every
pull request a rerun.

## Scope
- Find out where the time goes (the tests send hundreds of requests through the memory store) and make them cheaper, or give
  them a justified explicit timeout, without lowering what they assert.

## Acceptance criteria
- [x] The three tests finish well inside the default timeout: the cause was not load but the suite's own wait for a window boundary (up to 20 s inside a 5 s test, so about one start in thirty timed out); the memory-storage suites now move `Date` past the boundary instead (regression test: a host started 3 s before a boundary returns in under a second). The workerd and SQLite suites keep the wait, under 60 s and 30 s timeouts.
- [x] The assertions are unchanged.

## Security notes
none: test timing only; the limits under test are unchanged.

## Lessons applied
- L-382 — fixed-window tests start at the beginning of their window.
- L-446 — move the clock, do not sleep inside the test timeout.

## Docs to update
- none

## Out of scope
- Changing the abuse limits.
