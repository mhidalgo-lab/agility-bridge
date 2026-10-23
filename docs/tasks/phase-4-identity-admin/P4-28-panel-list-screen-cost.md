---
id: P4-28
title: "Panel list screens: cost grows with the number of users"
phase: 4
status: todo
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
- [ ] The profile is recorded under Outcome and `warm: admin: users list` and `warm: admin: audit` improve in the baseline.
- [ ] Negative authorization tests of both screens and of any changed admin API route still pass.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- Moving the panel off the in-process admin API.
