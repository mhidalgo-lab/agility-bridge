---
id: P7-28
title: "Do not burn an approval on a later refusal"
phase: 7
status: review
priority: low
depends_on: [P7-02]
adr: ["0013"]
lessons: [L-106]
owner: ""
---

# P7-28 — Do not burn an approval on a later refusal

> Filed by the Phase 7 review ([P7-09](P7-09-phase-7-review.md)). Refined 2026-10-29 (lane A, owner direction: keep the
> approval until the send is attempted).

## Goal
The approval (page grant or elicitation round) is taken before the limiter, the re-read and the intent audit, so a limiter refusal, a conflict or an audit outage makes the person approve again (review quality 8). Decide whether to keep the grant until the send is attempted, or document it.

## Scope
- The pipeline order becomes: approval found (not consumed) -> limiter -> re-read -> intent audit -> **approval consumed**
  -> send once -> outcome. Consuming is an atomic `take` (ledger `take`), done after the last step that can refuse; if the
  take finds nothing (a concurrent call used it) the call is refused and nothing is sent. One approval can therefore never
  send twice, and a limiter refusal, a conflict or an audit outage leave it usable until it expires.
- Page grants and multi round-trip rounds are only *read* (`peek`) when found; a decline, a denial and a forged or
  expired state still behave as before.
- A push elicitation answer (stdio, same call) has no stored record: when a later step refuses, the pipeline stores it as
  a grant (`via: elicitation`) so the repeated identical call is not asked again.
- A re-read that finds the values already applied consumes the approval (nothing left to approve).
- The guide and the audit docs say that an intent row without an outcome means the process died or the outcome write
  failed. A reconciliation list is a follow-up task, not built here.

## Acceptance criteria
- [x] A decision recorded (D-204).
- [x] A limiter refusal, a conflict and an audit outage each leave the approval usable once (page grant, round and push
      elicitation), tested.
- [x] One approval never sends twice: sequential replay and two concurrent calls on one grant send exactly once.
- [x] Docs: guide and threat model updated; the order is in ARCHITECTURE 6.6.

## Security notes
THREAT_MODEL T31, A2, A13.

## Lessons applied
- L-106 — Show the whole change, never a summary.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
