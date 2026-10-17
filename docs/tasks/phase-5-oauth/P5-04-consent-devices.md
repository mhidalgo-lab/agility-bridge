---
id: P5-04
title: Consent screen and device handling
phase: 5
status: todo
priority: high
depends_on: [P5-01]
adr: ["0009"]
lessons: [L-090, L-091]
owner: ""
---

# P5-04 — Consent screen and device handling

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Users knowingly choose which workspace and grant a client gets, on desktop and phone.

## Scope
- Consent shows the client name (marked unverified), redirect host and requested access; the user picks the grant; separate, never-remembered write consent (`mcp:write`).
- Remembered read consent opt-in (30 days, capped); a device is replaced only after a successful code exchange.
- Mobile-friendly CSP that allows the callback origin for `form-action`.

## Acceptance criteria
- [ ] Silent authorization cannot revoke an existing device; consent works in mobile browsers (manual check recorded).

## Security notes
THREAT_MODEL T9, T10.

## Lessons applied
- L-090 — Never revoke or replace a device on a GET an attacker can trigger.
- L-091 — Validate redirect targets after parsing.

## Docs to update
- docs/guide/oauth-phone.md (new)

## Out of scope
- Anything not listed under Scope.
