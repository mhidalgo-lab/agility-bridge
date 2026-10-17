---
id: P5-09
title: Abuse controls for unauthenticated endpoints
phase: 5
status: todo
priority: medium
depends_on: [P5-03]
adr: ["0010"]
lessons: [L-079, L-081, L-089]
owner: ""
---

# P5-09 — Abuse controls for unauthenticated endpoints

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Public OAuth endpoints cannot be used to exhaust storage or budgets.

## Scope
- Per-IP and deployment-wide limits for authorization, registration and CIMD fetches; shared limiter on Workers where needed.

## Acceptance criteria
- [ ] Flood tests stay within storage and fetch budgets.

## Security notes
THREAT_MODEL T10, T20.

## Lessons applied
- L-079 — Separate abuse controls per surface.
- L-081 — Per-process limits are not deployment-wide.
- L-089 — Dynamic registration is a compatibility path.

## Docs to update
- docs/guide/oauth.md

## Out of scope
- Anything not listed under Scope.
