---
id: P4-07
title: "Member self-service: bring your own Agility token"
phase: 4
status: todo
priority: high
depends_on: [P4-04]
adr: ["0008"]
lessons: [L-069, L-147]
owner: ""
---

# P4-07 — Member self-service: bring your own Agility token

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Members add, validate, rotate and revoke their own Agility tokens and see their access, without admins handling their secrets.

## Scope
- "My access": personal credentials per instance (validated, hint only), my grants, my devices, my audit.
- Guidance with screenshots for creating an access token on the Agility Applications page.
- Caps: personal credentials per user, live tokens per grant.

## Acceptance criteria
- [ ] A member cannot see or use another member's credential; caps enforced; audit rows written.

## Security notes
THREAT_MODEL A5, A6.

## Lessons applied
- L-069 — Prefer bring-your-own-token.
- L-147 — Access tokens are full delegation and never expire.

## Docs to update
- docs/guide/admin-panel.md
- docs/guide/quickstart-remote.md (new)

## Out of scope
- Anything not listed under Scope.
