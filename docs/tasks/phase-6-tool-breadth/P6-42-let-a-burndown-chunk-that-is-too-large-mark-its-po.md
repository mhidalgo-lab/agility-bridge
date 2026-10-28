---
id: P6-42
title: Let a burndown chunk that is too large mark its points incomplete
phase: 6
status: done
priority: low
depends_on: [P6-13, P6-02]
adr: []
lessons: [L-033, L-279]
owner: ""
---

# P6-42 — Let a burndown chunk that is too large mark its points incomplete

## Goal
One batched burndown request carries up to 20 queries; with `maxRows` near 1,000 on the Workers 512 KiB response cap a single chunk can exceed the cap and the whole `get_sprint` call fails with `AB_LIMIT_RESPONSE_TOO_LARGE` instead of leaving out those points. (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- Catch the size error per chunk, mark its points incomplete (as for a point with more items than the pages read), say so in `notes` and set `partial`; fewer queries per chunk when the page size is large.

## Acceptance criteria
- [x] A test with an oversized chunk answers with the other points, `partial` and a note, and no error.
- [x] Declared cost and the 60-query bound are unchanged.

## Result
A chunk that hits the response cap (`AB_LIMIT_RESPONSE_TOO_LARGE`) leaves out its points, with a note and `partial`. The queries
per batched request are `min(20, floor(2000 / maxRows))`, so a large page size sends fewer queries per request; the total
stays at most 60 queries, and declared cost is unchanged (the budget cap still applies). The extra requests this makes only
happen with a page size above 100 (non-default); a live check of a big `maxRows` is a follow-up for the next live pass.

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-033
- L-279

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
