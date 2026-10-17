---
id: P6-10
title: Tool evaluations
phase: 6
status: todo
priority: medium
depends_on: [P6-07]
adr: ["0015"]
lessons: [L-031, L-124]
owner: ""
---

# P6-10 — Tool evaluations

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Check that agents pick the right tool and resist injected content.

## Scope
- Description lint; a lexical router baseline in CI over a dataset of realistic questions (find B-/S- items, defects in a project, my tasks, sprint status, quality review); an LLM eval before releases with the exact `tools/list` and hostile results, using invented fixtures only.

## Acceptance criteria
- [ ] Baseline committed; CI fails on regressions; eval report attached to the release checklist.

## Security notes
THREAT_MODEL A1.

## Lessons applied
- L-031 — Descriptions are prompts.
- L-124 — Evaluate tools the way an agent sees them.

## Docs to update
- docs/dev/evals.md (new)

## Out of scope
- Anything not listed under Scope.
