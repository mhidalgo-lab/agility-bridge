---
id: P8-10
title: MCP Tasks for long-running reports
phase: 8
status: todo
priority: low
depends_on: [P6-13]
adr: ["0005"]
lessons: [L-016, L-073]
owner: ""
---

# P8-10 — MCP Tasks for long-running reports

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Long reports and large exports survive client timeouts.

## Scope
- Tasks extension (`io.modelcontextprotocol/tasks`) advertised in `server/discover` and used only for requests that declare it (2026-07-28).
- Methods `tasks/get`, `tasks/update` and `tasks/cancel`, each authenticated and authorised against the task's owner device and workspace; statuses `working`, `input_required`, `completed`, `failed`, `cancelled` with the extension's result and error shapes.
- Sealed task records (hashed 256-bit ids, encrypted results) with a 15-minute TTL; at most one Agility poll per `tasks/get`, within that request's budget; no background work after a response.
- `AB_TASKS=off` kill switch; inline results or an explicit continuation handle when the extension is absent.

## Acceptance criteria
- [ ] Lifecycle, cancellation, `input_required`, isolation (another device or workspace) and kill-switch tests; verified with MCP Inspector.

## Security notes
THREAT_MODEL T32.

## Lessons applied
- L-016 — Advertise only what works on that transport.
- L-073 — One-time state is consumed atomically.

## Docs to update
- docs/guide/tasks.md (new)

## Out of scope
- Anything not listed under Scope.
