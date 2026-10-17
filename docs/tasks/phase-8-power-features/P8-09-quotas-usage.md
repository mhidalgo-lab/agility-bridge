---
id: P8-09
title: Per-grant quotas and usage
phase: 8
status: todo
priority: low
depends_on: [P6-13]
adr: ["0010"]
lessons: [L-116, L-080]
owner: ""
---

# P8-09 — Per-grant quotas and usage

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Protect the customer's Agility tenant over days, not only per call.

## Scope
- Daily and monthly quotas per grant (UTC), counting logical Agility requests; warning at 80%; `AB_LIMIT_QUOTA`; usage in the panel and `whoami`; documented fail-open on counter outage.

## Acceptance criteria
- [ ] Quota tests including counter outage.

## Security notes
THREAT_MODEL T5, A10.

## Lessons applied
- L-116 — Quotas count logical upstream calls.
- L-080 — Decide fail-open vs fail-closed for each control, and test it.

## Docs to update
- docs/guide/query-limits.md (new)

## Out of scope
- Anything not listed under Scope.
