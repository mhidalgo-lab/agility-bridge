---
id: P6-08
title: MCP prompts (workflows)
phase: 6
status: todo
priority: medium
depends_on: [P6-07]
adr: ["0015"]
lessons: [L-153]
owner: ""
---

# P6-08 — MCP prompts (workflows)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Ready-made workflows for common agile tasks.

## Scope
- Prompts from the catalogue (`review_backlog_item_quality`, `sprint_review`, `standup`, `triage_defects`, `draft_release_notes`, `refine_backlog`, `explain_asset`), registered from one manifest and only when their tools are allowed.

## Acceptance criteria
- [ ] Each prompt tested with its tools allowed and disallowed; arguments follow the naming lint.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-153 — Register prompts and resources from one manifest.

## Docs to update
- docs/reference/prompts.md (new, generated)

## Out of scope
- Anything not listed under Scope.
