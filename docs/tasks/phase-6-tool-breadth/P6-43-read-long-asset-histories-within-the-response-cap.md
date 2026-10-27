---
id: P6-43
title: Read long asset histories within the response cap
phase: 6
status: todo
priority: medium
depends_on: [P6-13, P6-21]
adr: []
lessons: [L-146, L-122]
owner: ""
---

# P6-43 — Read long asset histories within the response cap

## Goal
`rest-1.v1/Hist` answers every version in one body; an asset with about 500 versions reaches the 512 KiB cap and the call now fails with an explanation (P6-13) but cannot be read at all. (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- Probe on the sandbox whether `Hist` accepts a `where` on `ChangeDate` or paging; if so use it (RESEARCH 1.4 marks it unverified).
- If not: select only the changed attributes first (a second narrow request per field group), and drop `ChangedBy.Name` unless asked, so more versions fit; keep the specific error as the last resort.

## Acceptance criteria
- [ ] A recorded probe result in RESEARCH.md with date and source.
- [ ] A test with 800 synthetic versions reads the window or fails with the specific message.

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-146
- L-122

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
