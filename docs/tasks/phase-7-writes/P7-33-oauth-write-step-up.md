---
id: P7-33
title: "Step-up consent for mcp:write instead of reconnecting"
phase: 7
status: todo
priority: low
depends_on: [P7-24, P7-10]
adr: ["0013"]
lessons: [L-010]
owner: ""
---

# P7-33 — Step-up consent for `mcp:write`

> Filed by [P7-24](P7-24-oauth-write-scope.md) (D-202). Refine scope and acceptance criteria before starting.

## Goal
Today a person who connected an app read-only disconnects and connects again to add `mcp:write`. If the real-client runs
(P7-10) show clients that handle `insufficient_scope` and re-authorize, offer a step-up: a tool refused for lack of the scope
answers with the scope in the challenge, and the new consent replaces the device's scope after a fresh, non-remembered consent.

## Scope
- Decide from the P7-10 client runs whether step-up is worth building (a design note and an ADR amendment if so).
- The challenge for a missing scope, the consent bound to the existing device, and tests that a refresh still cannot widen.

## Acceptance criteria
- [ ] Decision recorded from real client behaviour; if built, negative tests for every layer as in P7-24.

## Out of scope
- Anything before real clients have run the P7-24 consent.
