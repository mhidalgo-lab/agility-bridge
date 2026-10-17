---
id: P8-02
title: Deep links to the Agility UI
phase: 8
status: todo
priority: low
depends_on: [P6-13]
adr: ["0011"]
lessons: [L-056]
owner: ""
---

# P8-02 — Deep links to the Agility UI

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Every result links to the item in Agility, privately.

## Scope
- `url` fields built from the pinned instance origin with `assetdetail.v1?number=` / `?oid=`; never share links.

## Acceptance criteria
- [ ] Links validated for every asset type on the sandbox.

## Security notes
THREAT_MODEL T26.

## Lessons applied
- L-056 — Reads never create public links.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
