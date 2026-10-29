---
id: P7-15
title: Per-grant write limit set by an owner
phase: 7
status: todo
priority: low
depends_on: [P7-03, P4-05]
adr: ["0013"]
lessons: [L-081, L-111]
owner: ""
---

# P7-15 — Per-grant write limit set by an owner

> Filed by P7-03 ([write limiter](P7-03-write-limiter.md), D-169 (c)). Refine scope and acceptance criteria before starting.

## Goal
An owner can lower (never raise above the deployment setting) the hourly write limit of one grant.

## Scope
- A `writeRate.perHour` field on the grant (storage, admin API, CLI, panel), validated against the deployment's `AB_WRITE_RATE_PER_GRANT_HOURLY`.
- The write runtime passes the lower of the two to the limiter; audit row for the change.

## Acceptance criteria
- [ ] A grant limit below the deployment's applies; one above it is refused when set.
- [ ] Owner-only, recent sign-in, audited; negative authorization tests.
- [ ] Generated admin API and CLI references refreshed.

## Security notes
THREAT_MODEL T31, A2.

## Lessons applied
- L-111 — Write limits are deployment-wide.

## Docs to update
- docs/guide/write-tools.md, docs/guide/admin-panel.md

## Out of scope
- Anything not listed under Scope.
