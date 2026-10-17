---
id: P6-12
title: Consistency pass (arguments, outputs, paging, tool count)
phase: 6
status: todo
priority: medium
depends_on: [P6-07, P6-08, P6-09]
adr: ["0015"]
lessons: [L-030, L-032, L-155]
owner: ""
---

# P6-12 — Consistency pass (arguments, outputs, paging, tool count)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
The whole surface reads like one API, within the client tool caps.

## Scope
- Review every tool against the conventions; fix drift with aliases where needed; re-check counts against the 40-tool cap with every group enabled.

## Acceptance criteria
- [ ] Lints clean without exceptions; counts and `tools/list` size recorded.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-030 — One name per concept, enforced by a lint.
- L-032 — One paging contract.
- L-155 — Keep the tool count small.

## Docs to update
- docs/reference/tool-catalogue.md

## Out of scope
- Anything not listed under Scope.
