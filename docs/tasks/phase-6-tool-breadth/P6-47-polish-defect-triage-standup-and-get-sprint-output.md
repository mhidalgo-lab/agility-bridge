---
id: P6-47
title: Polish defect triage, standup and get_sprint output details
phase: 6
status: todo
priority: low
depends_on: [P6-13]
adr: []
lessons: [L-033]
owner: ""
---

# P6-47 — Polish defect triage, standup and get_sprint output details

## Goal
Small honesty and ordering gaps found by the review: defect triage lists the first 10 duplicate pairs in index order, not the most similar, with no note that the list was cut, and counts 3-letter words; `get_sprint` finds the items block by position; the sprint end date may be inclusive (unverified). (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- List the most similar pairs first, say when pairs or `flagged` were cut, drop a small stop-word list; look the items block up by `source`; check on the sandbox whether a sprint ending today is still current on its last day and fix `timing` and the ideal line if so (L-276).

## Acceptance criteria
- [ ] Tests for the ordering, the cut notes and the block lookup; a recorded live check for the end date.

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-033

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
