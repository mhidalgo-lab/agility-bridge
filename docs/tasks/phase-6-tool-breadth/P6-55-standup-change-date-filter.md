---
id: P6-55
title: Filter standup_summary on the change date instead of reading the newest page
phase: 6
status: todo
priority: low
depends_on: [P6-40, P6-27]
adr: []
lessons: [L-033, L-034]
owner: ""
---

# P6-55 — Filter standup_summary on the change date instead of reading the newest page

## Goal
`standup_summary` reads the 50 most recently changed items of a member and keeps those inside the window, so a busy member's
window can exceed one page (the report then says the list is not complete). Filtering on `ChangeDateUTC >= since` in the
query would return exactly the window. Split from [P6-40](P6-40-run-independent-report-sections-together-and-share.md): it
needs a sandbox check that the filter works on Story, Defect, Task and Test, which could not be made there.

## Scope
- Confirm on a sandbox that a `ChangeDateUTC` comparison filter is accepted by `query.v1` on all four work item types.
- If it is, add a `changed_since` filter to the work-item search path (a bound value, never a string: ADR-0012) and use it in the
  `changed` section; keep the completeness note for a window larger than one page.

## Acceptance criteria
- [ ] The sandbox result is recorded in docs/RESEARCH.md with its date.
- [ ] The `changed` section asks only for items changed since the window start; a window larger than a page is still reported as incomplete.
- [ ] Output on the shared worlds is unchanged for windows that fit one page.

## Security notes
The value is a bound variable; the scope restriction stays at the top level.

## Lessons applied
- L-033
- L-034

## Docs to update
- docs/RESEARCH.md, the standup_summary page.

## Out of scope
- Other report sections.
