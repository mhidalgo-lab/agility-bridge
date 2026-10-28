---
id: P6-26
title: Revisit a typed quality tool after the tool evals
phase: 6
status: done
priority: low
depends_on: [P6-03, P6-10]
adr: ["0012"]
lessons: [L-155, L-294]
owner: ""
---

# P6-26 — Revisit a typed quality tool after the tool evals

## Goal
Decide with evidence whether agents answer quality questions (test status of a backlog item, defect triage) from the P6-03
recipes, or whether a typed tool (for example a test-status roll-up per backlog item) now pays off (D-95).

## Scope
- Read the P6-10 eval results for the quality questions; list the cases where agents failed or took more than two calls.
- If a case needs a join or roll-up `query_assets` cannot express in one call, design the typed tool against the tool-count
  budget (what is dropped or merged to fit); otherwise record "keep recipes" and close.

## Evidence (P6-33, 2026-10-28)
Release runs of the LLM eval (Sonnet 5.5 and Opus 5.5, `docs/dev/eval-reports/`): the quality and defect questions (Q017 –
Q020, Q061 – Q063) passed in 12 of 14 answers allowing one lookup, through `search_work_items` or `query_assets`; both misses
were a second lookup, not a wrong tool. Points to "keep recipes"; the decision is this task's.

## Acceptance criteria
- [x] Decision recorded in the tool catalogue and D-95 answered, with the eval evidence: keep recipes, no typed quality tool.
- [x] If a tool is added: conventions, negative authorization tests, catalogue size test within budget (no tool added).

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-155 — Keep the tool count small.
- L-294 — A typed tool must beat one query_assets call.

## Docs to update
- docs/reference/tool-catalogue.md

## Out of scope
- Write tools.
