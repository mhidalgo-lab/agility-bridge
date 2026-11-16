---
id: P9-26
title: Admin panel says which opt-in switches still hide tools
phase: 9
status: review
priority: low
depends_on: [P9-24]
adr: ["0019"]
lessons: [L-475]
owner: "claude (agent)"
---

# P9-26 — Admin panel says which opt-in switches still hide tools

## Goal
"Every read tool" chooses tools; it does not turn on the opt-in groups. On 2026-11-16 an owner ticked "Every read tool"
for a workspace and expected `get_embedded_image`, which stays hidden until *Images pasted into descriptions* is on under
Limits. The panel now says so where the choice is made and where the result is read.

## Scope
- `switchNotes(list, groupsOff, tools, where)`: one fixed sentence per opt-in group whose switch is off (attachments,
  images, reports) naming the read tools of the list (every read tool when null) it hides and the switch to turn on.
- Shown under Notes on the workspace page and the grant page (for a grant: off in the workspace or in the grant).
- The "Every read tool" hint names the three switches.
- Admin panel guide updated.

## Acceptance criteria
- [x] With every switch off, "every read tool" yields one note per switch naming its tools; a switch that is on, or a
      list naming none of the group's tools, yields none (tests).
- [x] The grant variant names where the switch lives; existing budget notes are unchanged (tests).
- [x] Notes are fixed text plus tool names from the server's catalogue (no Agility data, escaped by JSX).

## Security notes
None: display only; the resolver still decides what is listed (THREAT_MODEL T3 unchanged).

## Lessons applied
- L-475 — "every read tool" is judged by the groups that are on, here as well as in the budget notes.

## Docs to update
- `docs/guide/admin-panel.md`.

## Out of scope
- Changing what "every read tool" includes (the opt-in switches stay explicit, ADR-0019, D-08, D-101).
