---
id: P9-01
title: Threat model final review and evidence map
phase: 9
status: todo
priority: high
depends_on: [P8-12]
adr: []
lessons: [L-010]
owner: ""
---

# P9-01 — Threat model final review and evidence map

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Every threat-model claim is backed by code, a test or a named residual risk.

## Scope
- Map every T and A row to code and tests; fuzz the remaining parsers; record accepted risks.

## Acceptance criteria
- [ ] No row without evidence or an explicit accepted risk.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-010 — Every security claim needs evidence.

## Docs to update
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
