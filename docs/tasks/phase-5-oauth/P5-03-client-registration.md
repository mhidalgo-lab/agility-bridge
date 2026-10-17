---
id: P5-03
title: Client registration: CIMD and DCR
phase: 5
status: todo
priority: high
depends_on: [P5-01]
adr: ["0009"]
lessons: [L-088, L-089]
owner: ""
---

# P5-03 — Client registration: CIMD and DCR

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Real clients register safely.

## Scope
- CIMD fetched by the server: HTTPS only, no redirects, size and time limits, connect-time IP checks (or disabled on a runtime that cannot), cache bounds, exact `client_id` match.
- DCR with per-IP and per-deployment caps, 24-hour expiry of unused clients, optional redirect-host allowlist, switch to turn it off.

## Acceptance criteria
- [ ] SSRF tests (private, loopback, link-local, metadata ranges, DNS rebinding); registration caps tested.

## Security notes
THREAT_MODEL T10, T11.

## Lessons applied
- L-088 — Client metadata fetching is an SSRF surface.
- L-089 — Dynamic registration is a compatibility path.

## Docs to update
- docs/guide/oauth.md

## Out of scope
- Anything not listed under Scope.
