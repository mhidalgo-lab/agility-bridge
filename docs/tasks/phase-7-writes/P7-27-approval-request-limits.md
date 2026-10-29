---
id: P7-27
title: "Limit approval prompts and stop pending approvals evicting each other"
phase: 7
status: done
priority: medium
depends_on: [P7-02]
adr: ["0013"]
lessons: [L-106]
owner: ""
---

# P7-27 — Limit approval prompts and stop pending approvals evicting each other

> Filed by the Phase 7 review ([P7-09](P7-09-phase-7-review.md)). Refined 2026-10-29 (lane A).

## Goal
A prompt-injected agent can call a write tool with `confirm: true` and varying values without limit: unbounded elicitation prompts (approval fatigue) and, on the page, it can push the pending approval a person is about to open out of the 20-entry list (review L3).

## Scope
- **Request counter.** The write limiter gets a second purpose, `approval_request`: before a fresh approval is asked (a
  push elicitation, the first round of a multi round-trip, a new page record) the pipeline takes one unit from a per-grant
  hourly counter (`wl:q:<grant>:<window>`, default 30, not configurable yet). Past it the call is `AB_LIMIT_RATE` with
  scope `approval_requests`, "nothing was asked", and neither a prompt, a ledger round nor a pending record exists. A call
  that finds a grant or a round already answered asks nothing and costs nothing. A store that fails refuses (fail closed,
  `AB_WRITE_LIMIT_UNAVAILABLE`), like the write counter.
- **Pending cap.** The page channel refuses a new pending request when the person already has `MAX_PENDING_PER_USER` (20)
  open: `AB_LIMIT_RATE` with scope `approvals_pending`, nothing stored, the older requests untouched. The same change asked
  again still returns its existing link (that lookup comes first).
- Not in scope: a deployment-wide request counter (the per-grant counter and the write limit bound a flood; the deployment
  write cap already bounds sends), configuration by environment variable, a "decline all" control (P7-14 lists requests).

## Acceptance criteria
- [x] Over the request counter: no prompt, no ledger round and no pending record (tests for elicitation, round and page).
- [x] A full pending list refuses the new request and keeps the old ones (test), and an existing change still gets its link.
- [x] The counter fails closed and a grant that already exists is not counted (tests).
- [x] Docs and threat model updated; decisions recorded (D-205, D-206).

## Security notes
THREAT_MODEL T31, A2, A13.

## Lessons applied
- L-106 — Show the whole change, never a summary.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
