---
id: P6-35
title: Live composite warnings in the workspace and grant forms
phase: 6
status: done
priority: low
depends_on: [P6-11]
adr: ["0010"]
lessons: [L-037, L-314, L-316]
owner: ""
---

# P6-35 — Live composite warnings in the workspace and grant forms

## Goal
Tell the operator about a composite granted without its siblings while the tool list is being edited, not only after it
is saved (P6-11 shows the warning on the detail pages).

## Scope
- Show the same fixed sentences (`compositeNotes`) on the workspace and grant edit forms after a failed or successful
  preview, without script (the panel works without JavaScript): a "check" step that re-renders the form with the notes, or
  the notes under the tool checklist on the next render.
- Optionally an enhancement in `assets/admin.js` that toggles the notes while ticking boxes (no inline script, L-095).

## Acceptance criteria
- [x] The edit and create forms of workspaces and grants show the notes for the list being posted, escaped, with no
  change to what is stored.
- [x] Browser (Playwright) spec covers the form with a composite ticked without a sibling.

## Security notes
THREAT_MODEL T13: fixed sentences, tool names from the catalogue only.

## Lessons applied
- L-037 — Composite tools need their own authorization and cost model.
- L-314 — Sibling dependencies are data with one source.
- L-316 — The panel gets catalogue facts through the admin API.

## Docs to update
- docs/dev/admin-ui.md, docs/guide/admin-guide.md

## Out of scope
- Blocking a save because of a warning.
