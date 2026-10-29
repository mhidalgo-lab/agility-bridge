---
id: P4-28
title: "Panel list screens: cost grows with the number of users"
phase: 4
status: done
priority: low
depends_on: [P4-14]
adr: ["0010"]
lessons: [L-097]
owner: ""
---

# P4-28 — Panel list screens: cost grows with the number of users

> Found while building P4-14: `/admin/users` (100 users) and `/admin/audit` (200 rows) cost about 12-13 ms of CPU warm, above
> the Free plan's 10 ms; the overview, form POSTs and assets fit.

## Goal
The two list screens fit the Free plan's CPU budget at a few hundred users, without weakening the admin API's authorization.

## Scope
- Profile both screens (`--cpu-prof` on the benchmark's scenarios) and write down where the time goes before changing code.
- The audit page loads every workspace and every user only to turn ids into names (`loadNames`): fetch the names of the ids on the
  page, or cache them per request, if the admin API can answer that without widening what the caller may see.
- The users list parses and validates the whole list for a 25-row page: page on the server side if the profile says so.

## Acceptance criteria
- [x] The profile is recorded under Outcome and `warm: admin: users list` and `warm: admin: audit` improve in the baseline.
- [x] Negative authorization tests of both screens and of any changed admin API route still pass.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- Moving the panel off the in-process admin API.

## Outcome
- Where the time went (by request breakdown; `--cpu-prof` was not usable, the machine ran several test suites at once and
  timings moved 4x between runs): the audit page made three in-process admin API calls (audit rows, every workspace, every
  user) and the users screen parsed and validated all users for a 25-row page. The costs that grow with users are the two
  full-user parses.
- Built: `GET /users` takes `limit`, `offset` and `ids` (D-127); the users screen asks for one page plus one row; the audit
  page loads at most 100 users and names the rest by id (D-128). Authorization is unchanged (tests: a member still gets only
  their own row, bad paging is a 422).
- Benchmark: relative to the overview in the same run, users list went from 3.0x to about 1.2x and audit from 2.5x to about
  1.7x. The baseline entries were set from those ratios, not from absolute numbers (this machine was too busy for a clean
  `--update`); refresh them from CI.

## Baseline correction (2026-10-29)
The two baseline entries were first set from ratios measured under heavy local load. Six CI runs of the Worker benchmark put
`warm: admin: users list` at 0.84× to 1.76× calibration (median about 1.25×, about 2.5× the overview page) and `warm: admin:
audit` at about 1.1×, so the first entries (0.58×, 0.82×) flagged a regression on half the runs. The baseline now holds the CI
medians; the users list improved less than the first estimate said.
