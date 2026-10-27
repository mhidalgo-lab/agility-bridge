---
id: P6-42
title: Let a burndown chunk that is too large mark its points incomplete
phase: 6
status: todo
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
- [ ] A test with an oversized chunk answers with the other points, `partial` and a note, and no error.
- [ ] Declared cost and the 60-query bound are unchanged.

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-033
- L-279

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
