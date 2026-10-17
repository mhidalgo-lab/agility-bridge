---
id: P8-11
title: Lazy auth and public tool catalogue
phase: 8
status: todo
priority: low
depends_on: [P6-13]
adr: ["0009"]
lessons: [L-016]
owner: ""
---

# P8-11 — Lazy auth and public tool catalogue

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Registries and clients can discover the read-only catalogue without credentials, when the operator wants it.

## Scope
- `AB_PUBLIC_TOOL_CATALOG=on` (off by default): unauthenticated `initialize`, `server/discover`, `ping`, `tools/list` answered from the static read-only catalogue; everything else requires authentication; stdio lists tools without configuration.

## Acceptance criteria
- [ ] Tests: identical response for every slug, no storage reads, writes never listed.

## Security notes
THREAT_MODEL T33.

## Lessons applied
- L-016 — Advertise only what works on that transport.

## Docs to update
- docs/guide/configuration.md

## Out of scope
- Anything not listed under Scope.
