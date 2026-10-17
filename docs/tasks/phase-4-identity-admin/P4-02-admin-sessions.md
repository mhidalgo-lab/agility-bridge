---
id: P4-02
title: Admin sessions, roles, CSRF and re-authentication
phase: 4
status: todo
priority: high
depends_on: [P4-01]
adr: ["0009"]
lessons: [L-073, L-093]
owner: ""
---

# P4-02 — Admin sessions, roles, CSRF and re-authentication

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Safe browser sessions with roles, and a recent sign-in for high-impact actions.

## Scope
- Sessions in `kv` (hashed secret), `__Host-` cookie, `SameSite=Lax`, idle 30 min / absolute 12 h, session cap per user, end-all-sessions.
- Roles owner / admin / member; only owners manage admins and enable writes.
- CSRF synchronizer token plus Origin and Fetch-Metadata checks on unsafe methods.
- Re-authentication within 10 minutes for key rotation, owner/admin changes, credential replacement, imports and write enablement.

## Acceptance criteria
- [ ] Session, CSRF, role and re-auth tests; logout sends `Clear-Site-Data`.

## Security notes
THREAT_MODEL T13, T14.

## Lessons applied
- L-073 — One-time state is consumed atomically.
- L-093 — Re-authenticate before high-impact actions.

## Docs to update
- docs/guide/admin-access.md (new)

## Out of scope
- Anything not listed under Scope.
