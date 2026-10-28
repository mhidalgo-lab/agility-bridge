---
id: P6-28
title: Decide on typed tools for issues and requests from usage and evals
phase: 6
status: todo
priority: low
depends_on: [P6-06, P6-10]
adr: ["0012"]
lessons: [L-155]
owner: ""
---

# P6-28 — Decide on typed tools for issues and requests from usage and evals

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
P6-06 serves issues, requests, goals, themes and retrospectives through recipes and the generic tools (D-98). Decide, from
the P6-10 evals and observed use, whether any of them needs a typed tool.

## Scope
- Add eval cases for the five types (find unowned issues, requests in a status, themes of a team, retrospectives of a
  sprint) and record how often an agent completes them with the generic route and the recipes.
- Only where the generic route fails repeatedly: propose one typed tool (its output contract, cost and the tool it would
  replace in the cap) as a new decision; otherwise record "no typed tools" and close.

## Evidence (P6-33, 2026-10-28)
Release runs of the LLM eval (Sonnet 5.5 and Opus 5.5, `docs/dev/eval-reports/`): the generic questions for requests,
issues, goals and regression tests (Q070 – Q073) passed in 4 of 8 answers allowing one lookup; every miss was a second lookup
(`list_asset_types` or `list_projects`), never a wrong tool. Themes and retrospectives have no eval question yet (this task's
scope). Points to "no typed tools"; the cost is an extra call.

## Acceptance criteria
- [ ] Eval results for the five types are recorded.
- [ ] A decision (typed tool or none) is recorded in the pending decisions with the evidence.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-155 — Keep the tool count small.

## Docs to update
- docs/pending-decisions/phase-6.md

## Out of scope
- Write tools for these types.
