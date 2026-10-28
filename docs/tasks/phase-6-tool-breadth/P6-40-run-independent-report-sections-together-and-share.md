---
id: P6-40
title: Run independent report sections together and share resolution within a request
phase: 6
status: done
priority: medium
depends_on: [P6-13, P6-07]
adr: []
lessons: [L-033, L-096]
owner: ""
---

# P6-40 — Run independent report sections together and share resolution within a request

## Goal
`standup_summary` and `sprint_health` await two independent sibling calls one after the other and resolve the same member, team or sprint twice, so wall time is the sum of both and 1 to 3 requests are repeated. (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- Run the independent sections with `Promise.all`; section request counts come from a child budget per section (not `budget.used` before and after, which mis-attributes under concurrency), and results stay in a fixed order.
- A per-request memo for `resolveMember/Team/Project/Sprint` keyed by kind and text (never shared across requests).
- `sprint_health` passes the sprint it was given to the open-work search so both run at once; `standup_summary` filters on `ChangeDateUTC >= since` instead of reading the newest 50 by recency, if the sandbox confirms the filter on all four types (P6-27). *Not built: it needs a sandbox, moved to [P6-55](P6-55-standup-change-date-filter.md) (D-147).*

## Acceptance criteria
- [x] Cold request counts do not rise beyond the declared costs; the section requests are attributed correctly and the output is identical to the sequential run on the shared worlds.
- [x] A test with a slow fake shows the two sections overlapping.
- [x] The memo is per request: a second request resolves again (L-096 test).

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-033
- L-096

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
