---
id: P6-38
title: Run the consistency checks on an empty and a denied world
phase: 6
status: todo
priority: low
depends_on: [P6-12]
adr: ["0015"]
lessons: [L-032, L-318]
owner: ""
---

# P6-38 — Run the consistency checks on an empty and a denied world

## Goal
The consistency test (P6-12) runs every tool on the shared world, where lists have rows. The drift it found last
(`list_members` skipping the cursor check when its project list was empty, L-318) hid in a branch that only an empty or
restricted world reaches. Cover those branches the same way.

## Scope
- Run the shared checks (cursor refused first, shared result keys declared, `partial` says why, identity columns) on a world
  with no rows, with a workspace whose allowed projects list no members, and with a grant that denies a project, an asset
  type or a sibling tool.
- Negative authorization cases stay in each tool's own tests; this adds only the cross-tool contract.

## Acceptance criteria
- [ ] One parametrised test over `CORE_TOOLS` and at least three worlds; a branch that returns before validating input fails.
- [ ] Any drift found is fixed or filed as a task.

## Security notes
No new surface; confirms that a denial returns no data and makes no upstream call for every tool.

## Lessons applied
- L-032 — One paging contract.
- L-318 — Decode the cursor before anything that can return early.

## Docs to update
- docs/dev/tool-conventions.md (testing note)

## Out of scope
- New tools or arguments.
