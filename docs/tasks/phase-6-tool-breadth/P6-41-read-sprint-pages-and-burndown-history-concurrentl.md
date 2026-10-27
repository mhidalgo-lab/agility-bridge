---
id: P6-41
title: Read sprint pages and burndown history concurrently
phase: 6
status: todo
priority: low
depends_on: [P6-13, P6-02]
adr: []
lessons: [L-279]
owner: ""
---

# P6-41 — Read sprint pages and burndown history concurrently

## Goal
`get_sprint` reads up to five item pages and three history requests one after another, and repeats the project scope list in every one of up to 60 queries. (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- Send the history chunks together (three requests, under the connection limit); read pages 0 and 1 of the current contents in one batched request; compile the page template once and vary `offset` and `asOf`.
- Check on the sandbox whether `query.v1` accepts one shared `with` for the scope list in a batch (unverified).

## Acceptance criteria
- [ ] Request counts and results are unchanged on the shared sprint worlds; wall time falls with a slow fake.
- [ ] The 20-queries-per-request and response-cap reasoning of L-279 still holds (test).

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-279

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
