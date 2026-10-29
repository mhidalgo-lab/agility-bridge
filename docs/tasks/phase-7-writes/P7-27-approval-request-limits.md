---
id: P7-27
title: "Limit approval prompts and stop pending approvals evicting each other"
phase: 7
status: todo
priority: medium
depends_on: [P7-02]
adr: ["0013"]
lessons: [L-106]
owner: ""
---

# P7-27 — Limit approval prompts and stop pending approvals evicting each other

> Filed by the Phase 7 review ([P7-09](P7-09-phase-7-review.md)). Refine scope and acceptance criteria before starting.

## Goal
A prompt-injected agent can call a write tool with `confirm: true` and varying values without limit: unbounded elicitation prompts (approval fatigue) and, on the page, it can push the pending approval a person is about to open out of the 20-entry list (review L3).

## Scope
- Count approval requests per grant (a small counter, for example 30 an hour) before asking; refuse past it with a clear error that nothing was asked.
- On the page channel, refuse new pending requests past the cap instead of dropping the oldest.

## Acceptance criteria
- [ ] Over the request counter: no prompt, no pending record (test).
- [ ] A full pending list refuses the new request and keeps the old ones (test).

## Security notes
THREAT_MODEL T31, A2, A13.

## Lessons applied
- L-106 — Show the whole change, never a summary.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
