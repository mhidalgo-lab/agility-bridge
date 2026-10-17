---
id: P5-08
title: Admin: connected apps and devices
phase: 5
status: todo
priority: medium
depends_on: [P5-05]
adr: []
lessons: [L-090]
owner: ""
---

# P5-08 — Admin: connected apps and devices

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Users and owners see and disconnect OAuth apps and devices.

## Scope
- Per-user connected apps with per-device disconnect; owner view of registered clients with revoke.

## Acceptance criteria
- [ ] Disconnect takes effect within the access-cache TTL; audit rows written.

## Security notes
THREAT_MODEL T15.

## Lessons applied
- L-090 — Never revoke or replace a device on a GET an attacker can trigger.

## Docs to update
- docs/guide/admin-panel.md

## Out of scope
- Anything not listed under Scope.
