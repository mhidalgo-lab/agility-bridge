---
id: P7-08
title: Write documentation and threat-model update
phase: 7
status: todo
priority: medium
depends_on: [P7-07]
adr: ["0013"]
lessons: [L-133, L-010]
owner: ""
---

# P7-08 — Write documentation and threat-model update

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Operators and users understand what writes do, how approval works per client, and the remaining risks.

## Scope
- Write-tools guide, per-client approval channels, operator checklist for enabling writes; THREAT_MODEL statuses for T31, A2, A6, A13 with evidence.

## Acceptance criteria
- [ ] Guide walked through on staging; threat-model rows updated.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.
- L-010 — Every security claim needs evidence.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md
- docs/reference/client-compatibility.md

## Out of scope
- Anything not listed under Scope.
