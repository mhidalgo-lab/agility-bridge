---
id: P7-26
title: "Approval policy: page only, per workspace or grant"
phase: 7
status: todo
priority: medium
depends_on: [P7-02]
adr: ["0013"]
lessons: [L-106]
owner: ""
---

# P7-26 — Approval policy: page only, per workspace or grant

> Filed by the Phase 7 review ([P7-09](P7-09-phase-7-review.md)). Refine scope and acceptance criteria before starting.

## Goal
A client that auto-accepts elicitation proves no human answered (review M3). Let an owner require the out-of-band page for writes, per workspace or grant; the owner decides the default (D-11 allowed elicitation).

## Scope
- A setting on the workspace write policy and the grant: approval channel `any` (today) or `page_only`; with `page_only` the pipeline never asks by elicitation and answers `AB_WRITE_APPROVAL_PENDING` with the link.
- Admin API, CLI and panel screen for it; `whoami` and the dry run report the channel.
- Document the residual risk for browser-driving agents that hold the person's session (the recent sign-in is the barrier; check the window is short).

## Acceptance criteria
- [ ] A `page_only` workspace or grant never sends an elicitation (test), and a client that can elicit still gets the link.
- [ ] Negative test: a client that auto-accepts cannot approve under `page_only`.
- [ ] Owner decision on the default for OAuth clients that are not allowlisted.

## Security notes
THREAT_MODEL T31, A2, A13.

## Lessons applied
- L-106 — Show the whole change, never a summary.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
