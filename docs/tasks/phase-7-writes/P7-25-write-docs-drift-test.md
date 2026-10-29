---
id: P7-25
title: "Keep the write guide equal to the registry and the approval renderer"
phase: 7
status: done
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
- `scripts/test/write-guide.test.ts`: the write tools (every registry tool whose kind is not `read`) equal the rows of the guide's tool table (name and kind), the heading's count word equals their number, every tool except `update_status` (shown in full) has a row in the approval table, and the guide's example approval text equals `renderApproval` for the same input with the envelope id fixed.
- No change to product code.

## Acceptance criteria
- [x] Adding a write tool to the registry without a guide row fails the test.
- [x] Changing the approval layout without updating the guide example fails the test.
- [x] The test runs in the normal `pnpm test`.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
