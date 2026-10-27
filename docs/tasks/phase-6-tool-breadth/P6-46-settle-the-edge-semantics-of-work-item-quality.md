---
id: P6-46
title: Settle the edge semantics of `work_item_quality`
phase: 6
status: todo
priority: low
depends_on: [P6-13, P6-03]
adr: []
lessons: [L-033]
owner: ""
---

# P6-46 — Settle the edge semantics of `work_item_quality`

## Goal
An estimate of 0 scores as sized; `readPriority` hides a budget or permission failure behind 'could not be read'; the description is cut by the item shaper at 4,000 characters and the report does not say so. (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- Decide and document the zero estimate (recommended: not estimated); report a budget or permission failure as such, not as unreadable; say when the description was cut.

## Acceptance criteria
- [ ] Tests for each case; the rubric resource states the zero-estimate rule; D-103 updated.

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-033

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
