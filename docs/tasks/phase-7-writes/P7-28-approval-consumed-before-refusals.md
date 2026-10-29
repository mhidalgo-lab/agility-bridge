---
id: P7-28
title: "Do not burn an approval on a later refusal"
phase: 7
status: todo
priority: low
depends_on: [P7-02]
adr: ["0013"]
lessons: [L-106]
owner: ""
---

# P7-28 — Do not burn an approval on a later refusal

> Filed by the Phase 7 review ([P7-09](P7-09-phase-7-review.md)). Refine scope and acceptance criteria before starting.

## Goal
The approval (page grant or elicitation round) is taken before the limiter, the re-read and the intent audit, so a limiter refusal, a conflict or an audit outage makes the person approve again (review quality 8). Decide whether to keep the grant until the send is attempted, or document it.

## Scope
- Options: take the approval last (after the intent audit) with the limiter and re-read first, or keep it and describe it in the guide.
- Note in the audit docs that an intent without an outcome means the process died or the outcome write failed; consider a reconciliation list.

## Acceptance criteria
- [ ] A decision recorded; if changed, a test that a limiter refusal, a conflict and an audit outage leave the approval usable once.

## Security notes
THREAT_MODEL T31, A2, A13.

## Lessons applied
- L-106 — Show the whole change, never a summary.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
