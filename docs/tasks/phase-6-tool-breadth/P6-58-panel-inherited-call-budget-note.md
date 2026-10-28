---
id: P6-58
title: Show the budget-hidden tools note for an inherited call budget in the panel
phase: 6
status: todo
priority: low
depends_on: [P6-36]
adr: ["0010"]
lessons: [L-114, L-115]
owner: ""
---

# P6-58 — Show the budget-hidden tools note for an inherited call budget in the panel

## Goal
P6-36 notes a tool the per-call budget hides on a workspace or grant page, but only when a `callBudget` is set on the
workspace or the grant. Most workspaces inherit the host default (Workers Free: 45 requests, so every report at 54 is
hidden), and the panel does not know that default, so it says nothing there.

## Scope
- Expose the host's default `callBudget` to the admin API (a read-only field of an existing settings or tools answer),
  and use it in `budgetNotes` when neither the workspace nor the grant sets one.
- Decide how a `null` tool list ("every read tool") is judged: the groups that are off by default (reports) should not
  be reported as hidden.

## Acceptance criteria
- [ ] A workspace on a 45-request host that enables a report shows the note without setting `callBudget`.
- [ ] A negative test: a default of 1000 adds no note; hostile values in the API answer are not shown.

## Security notes
Our own tool names and numbers only (THREAT_MODEL T13).

## Lessons applied
- L-115 — Hide what cannot fit, and say so.

## Docs to update
- docs/dev/admin-ui.md

## Out of scope
- Changing which tools the budget hides.
