---
id: P6-31
title: Prompt fallbacks without the reports group
phase: 6
status: todo
priority: low
depends_on: [P6-08]
adr: ["0015"]
lessons: [L-307]
owner: ""
---

# P6-31 — Prompt fallbacks without the reports group

## Goal
Offer `standup`, `triage_defects` and `review_backlog_item_quality` to workspaces that have not turned the `reports` group
on, by composing the same workflow from the base tools (D-105).

## Scope
- A prompt entry may declare `uses` (always required) and `prefers` (tools that change the text when allowed); the text
  names a report tool only when it is allowed, otherwise the base-tool steps (`search_work_items`, `get_work_item`,
  `list_recent_changes`).
- The manifest tests read the text in every branch (L-306) and the "without reports" test is updated.

## Acceptance criteria
- [ ] With `reports` off the three prompts are offered with base-tool steps; with it on the text is unchanged.
- [ ] No branch names a tool outside `uses` plus the allowed `prefers`.
- [ ] `pnpm docs:prompts` refreshed; D-105 updated.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-307 — Decide the fallback of a prompt on an opt-in group.

## Docs to update
- docs/reference/prompts.md (generated)

## Out of scope
- Changing which tools are in the `reports` group.
