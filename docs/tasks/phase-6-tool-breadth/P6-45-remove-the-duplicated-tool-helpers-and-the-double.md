---
id: P6-45
title: Remove the duplicated tool helpers and the double meaning of `minimal_output`
phase: 6
status: todo
priority: low
depends_on: [P6-13, P6-12]
adr: []
lessons: [L-317]
owner: ""
---

# P6-45 — Remove the duplicated tool helpers and the double meaning of `minimal_output`

## Goal
`num()` exists five times with different meaning for booleans, `text()` four times, `round`/`round1` twice; `ACCEPTANCE_RE` and the inline acceptance regex in `quality.ts` must agree; `get_work_item` declares `minimal_output` locally and `query_assets` and `get_work_item` give one argument two meanings under one description key. (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- Move `num`, `text` and `round1` to `tools/common.ts`; export one acceptance-attribute test; give the two `minimal_output` meanings two vocabulary entries (or rename one) so the lint keeps its no-exceptions rule.

## Acceptance criteria
- [ ] One definition each; behaviour of every tool unchanged (existing tests).
- [ ] The conventions lint passes with no exception.

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-317

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
