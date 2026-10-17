---
id: P6-11
title: Cost accounting and composite grants
phase: 6
status: todo
priority: medium
depends_on: [P6-07]
adr: ["0010"]
lessons: [L-037, L-114, L-115]
owner: ""
---

# P6-11 — Cost accounting and composite grants

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Every tool's declared cost is honest and composites respect grants.

## Scope
- Worst-case cost tests for every tool; panel warnings when a composite is granted without its sibling tools.

## Acceptance criteria
- [ ] Cost test covers 100% of tools; warning shown in the panel and in `whoami`.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-037 — Composite tools need their own authorization and cost model.
- L-114 — Declared costs cover the worst case.
- L-115 — Hide what cannot fit.

## Docs to update
- docs/dev/tool-conventions.md

## Out of scope
- Anything not listed under Scope.
