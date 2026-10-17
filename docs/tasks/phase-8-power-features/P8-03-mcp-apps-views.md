---
id: P8-03
title: MCP Apps views
phase: 8
status: todo
priority: low
depends_on: [P6-13]
adr: ["0015"]
lessons: [L-016, L-023]
owner: ""
---

# P8-03 — MCP Apps views

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Charts in clients that support MCP Apps, text everywhere else.

## Scope
- `ui://agility-bridge/sprint-burndown` and `ui://agility-bridge/status-distribution`: dependency-free pages, `textContent`/SVG only, CSP `connect-src 'none'`; offered only to clients that declare Apps; `AB_MCP_APPS=off` switch.

## Acceptance criteria
- [ ] Rendering verified in at least two clients (VS Code, Claude); injection tests on labels.

## Security notes
THREAT_MODEL T27.

## Lessons applied
- L-016 — Advertise only what works on that transport.
- L-023 — SDK conformance does not prove client compatibility.

## Docs to update
- docs/guide/charts.md (new)

## Out of scope
- Anything not listed under Scope.
