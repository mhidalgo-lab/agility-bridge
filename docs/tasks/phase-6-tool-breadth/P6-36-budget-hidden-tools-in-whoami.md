---
id: P6-36
title: Name the tools hidden by the per-call budget
phase: 6
status: done
priority: low
depends_on: [P6-11]
adr: ["0010"]
lessons: [L-114, L-115]
owner: ""
---

# P6-36 — Name the tools hidden by the per-call budget

## Goal
A caller or operator who lowers `callBudget` below a tool's declared cost (a report costs 20 to 54) sees why the tool is
not listed, instead of a silent gap (L-115 hides it; nothing says so).

## Scope
- `whoami` lists, in one fixed note and a structured `hiddenByBudget` field (only when non-empty), the granted tools whose
  declared cost exceeds the per-call budget.
- The grant and workspace pages show the same note when the effective `callBudget` (limits inherited) is below the cost
  of a tool in the effective list.

## Acceptance criteria
- [x] `whoami` names the hidden tools and the budget; nothing is added when none is hidden.
- [x] The panel notes match, with negative tests; `tools/list` size unchanged (open output schema).

## Security notes
None beyond the shared rules in AGENTS.md (our own tool names and numbers only).

## Lessons applied
- L-114 — Declared costs cover the worst case.
- L-115 — Hide what cannot fit, and say so.

## Docs to update
- docs/dev/tool-conventions.md

## Notes
The panel notes cover an explicit `callBudget` on the workspace or grant; a budget inherited from the host default is [P6-58](P6-58-panel-inherited-call-budget-note.md).

## Out of scope
- Changing which tools the budget hides.
