---
id: P6-48
title: Forward sibling facts in composites as codes, with a lint
phase: 6
status: todo
priority: low
depends_on: [P6-13, P6-07]
adr: []
lessons: [L-038]
owner: ""
---

# P6-48 — Forward sibling facts in composites as codes, with a lint

## Goal
`sprint_health` forwards its sibling's notes as untrusted text (P6-13), which is safe but shows them as data. A future sibling note that names a sprint or team would still be better as a fixed code the composite words itself. (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- Map the sibling notes the composites use to fixed codes and wording of our own; a lint or test that composite notes come only from that allowlist or are enveloped.

## Acceptance criteria
- [ ] A test adds a sibling note with an Agility name and checks it never appears as our own text.
- [ ] No change to the numbers a report returns.

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-038

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
