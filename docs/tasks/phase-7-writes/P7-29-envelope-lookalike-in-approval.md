---
id: P7-29
title: "Approval text: values that contain the envelope phrase"
phase: 7
status: todo
priority: low
depends_on: [P7-02]
adr: ["0013"]
lessons: [L-106]
owner: ""
---

# P7-29 — Approval text: values that contain the envelope phrase

> Filed by the Phase 7 review ([P7-09](P7-09-phase-7-review.md)). Refine scope and acceptance criteria before starting.

## Goal
`neutralise()` rewrites `untrusted data` to `untrusted~data` inside the approval, so a title or comment containing that phrase is shown differently from what is sent (review L7).

## Scope
- Reject such values in the mutation check (like hidden characters) for caller text, and show Agility text unchanged outside the rewritten form, or mark the rewrite visibly.

## Acceptance criteria
- [ ] What is read is what is sent for a value containing the phrase (test), or the value is refused with a reason.

## Security notes
THREAT_MODEL T31, A2, A13.

## Lessons applied
- L-106 — Show the whole change, never a summary.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
