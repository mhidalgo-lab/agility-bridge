---
id: P6-30
title: Priority and severity in defect triage
phase: 6
status: done
priority: low
depends_on: [P6-07]
adr: ["0015"]
lessons: [L-033, L-148]
owner: ""
---

# P6-30 — Priority and severity in defect triage

## Goal
Let `defect_triage` order defects by priority and show severity where the instance has it, instead of saying neither is
read.

## Scope
- Read `Priority` (and a severity-like attribute when the type has one, found through metadata, never by name guess) with
  the defect rows, through the sibling's internals or a compiler query that keeps the scope predicate.
- Order flagged defects by priority rank (the list's own order), and say when the instance has no priority list.

## Acceptance criteria
- [x] Flagged defects carry their priority when the instance has one; an instance without it says so and is unchanged.
- [x] No attribute name is hard-coded beyond `Priority`; a single severity-like attribute is discovered from metadata (live check: [P6-57](P6-57-verify-defect-severity-discovery-live.md), D-149).
- [x] Cold cost, negative authorization and poisoned-text tests still pass; `pnpm docs:tools` refreshed.

## Security notes
THREAT_MODEL T3, A12: instance field names never reach tool definitions.

## Lessons applied
- L-033 — Never turn missing data into zeros or confident claims.
- L-148 — Verify new attribute forms live.

## Docs to update
- docs/reference/tools.md (generated), docs/reference/tool-catalogue.md

## Out of scope
- Duplicate detection beyond name similarity.
