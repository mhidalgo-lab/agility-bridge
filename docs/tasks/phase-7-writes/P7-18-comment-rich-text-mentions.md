---
id: P7-18
title: "Comments: rich text and mentions"
phase: 7
status: todo
priority: low
depends_on: [P7-04, P7-07]
adr: ["0013"]
lessons: [L-393]
owner: ""
---

# P7-18 — Comments: rich text and mentions

> Filed by P7-04 ([writes wave 1](P7-04-writes-wave-1.md)). Refine scope and acceptance criteria before starting.

## Goal
Let a comment mention people and carry basic formatting once the sandbox shows how Agility stores them.

## Scope
- Decide from the P7-07 evidence whether `Expression.Content` is plain text or HTML on this product, and what `Mentions` of members does.
- If rich text is supported: a typed subset (no raw HTML from the caller), shown in full in the approval.

## Acceptance criteria
- [ ] The sandbox evidence is recorded in RESEARCH.
- [ ] Tests for the chosen subset, including hostile markup and hidden characters.

## Security notes
THREAT_MODEL A2, T31.

## Lessons applied
- L-108 — Validate fully, then ask, then re-check, then apply once.

## Docs to update
- docs/reference/tools.md (generated)
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
