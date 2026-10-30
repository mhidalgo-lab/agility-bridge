---
id: P8-21
title: "Stop the OAuth abuse tests timing out on busy CI runners"
phase: 8
status: todo
priority: low
depends_on: []
adr: []
lessons: []
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
- [ ] The three tests finish well inside the default timeout on a loaded runner (measure on CI, several runs).
- [ ] The assertions are unchanged.

## Security notes
none: test timing only; the limits under test are unchanged.

## Lessons applied
- none

## Docs to update
- none

## Out of scope
- Changing the abuse limits.
