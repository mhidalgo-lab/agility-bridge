---
id: P7-25
title: "Keep the write guide equal to the registry and the approval renderer"
phase: 7
status: todo
priority: low
depends_on: [P7-08]
adr: ["0013"]
lessons: [L-133]
owner: ""
---

# P7-25 — Keep the write guide equal to the registry and the approval renderer

> Filed by [P7-08](P7-08-write-docs-threat-model.md) (D-190). Refine scope and acceptance criteria before starting.

## Goal
The write guide lists the nine tools and shows an approval text by hand. A test should fail when a write tool is added or renamed, or when the approval layout changes, without the guide changing (L-133).

## Scope
- A docs test (`scripts/test/docs.test.ts` style) that reads the write tools from the core registry and checks each name appears in `docs/guide/write-tools.md` and in the approval table, and that the guide's example approval text equals what `renderApproval` produces for the same input (the layout, with the random envelope id fixed).
- No change to product code.

## Acceptance criteria
- [ ] Adding a write tool to the registry without a guide row fails the test.
- [ ] Changing the approval layout without updating the guide example fails the test.
- [ ] The test runs in the normal `pnpm test`.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
