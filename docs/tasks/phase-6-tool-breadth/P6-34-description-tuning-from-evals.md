---
id: P6-34
title: Tune tool descriptions from the eval misses
phase: 6
status: todo
priority: low
depends_on: [P6-33]
adr: ["0015"]
lessons: [L-124, L-309, L-310]
owner: ""
---

# P6-34 — Tune tool descriptions from the eval misses

## Goal
Raise tool-choice accuracy where the LLM eval and the lexical router agree a description misleads, without growing `tools/list`.

## Scope
- Start from the misses in the P6-10 triage table (get_conversations, get_asset_history, list_my_work, "open defects" questions) and the P6-33 report.
- Change wording only, inside the description lints and the default `tools/list` budget (40 KB); trade words, not features.
- Raise the router baseline with the change (`pnpm eval:router --write-baseline`).

## Acceptance criteria
- [ ] Router top-1 and top-3 do not fall and the baseline is raised where they improved.
- [ ] The LLM eval is rerun on the changed descriptions and its report attached.
- [ ] Lints and the `tools/list` size test stay green; tool reference regenerated.

## Security notes
Descriptions never carry instructions about other content (conventions).

## Lessons applied
- L-031, L-124, L-309.

## Docs to update
- docs/dev/evals.md, docs/reference/tools.md (generated)

## Out of scope
- Renaming tools or arguments (a breaking change).
