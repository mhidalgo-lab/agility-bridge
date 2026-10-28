---
id: P6-32
title: Prompt argument completion
phase: 6
status: done
priority: low
depends_on: [P6-08]
adr: ["0015"]
lessons: [L-305]
owner: ""
---

# P6-32 — Prompt argument completion

## Goal
Let clients autocomplete prompt arguments (`completion/complete`) for `sprint`, `team` and `project` from what the workspace
allows.

## Scope
- Implement completion for the `sprint`, `team` and `project` arguments through the existing list tools' handlers (same
  scope rules, budget and envelope), only for prompts that are available.
- Completions are plain values passing the same argument rules as the prompts (L-305); anything else is dropped.

## Acceptance criteria
- [x] Completion offers only names the caller may see, none for a prompt that is not offered, and no upstream request on a
  denied prompt.
- [x] Every completed value is accepted by the prompt's argument schema.
- [x] Cost is bounded and stated in the prompt reference.

## Security notes
THREAT_MODEL T3: completion must not reveal projects, teams or sprints outside the workspace.

## Lessons applied
- L-305 — Prompt arguments are caller input.

## Docs to update
- docs/reference/prompts.md (generated)

## Out of scope
- Completion for resource templates.
