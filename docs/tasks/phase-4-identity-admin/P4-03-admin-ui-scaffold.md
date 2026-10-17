---
id: P4-03
title: Admin UI scaffold
phase: 4
status: todo
priority: high
depends_on: [P4-02]
adr: ["0004"]
lessons: [L-095]
owner: ""
---

# P4-03 — Admin UI scaffold

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
A server-rendered, phone-friendly panel that is safe by construction.

## Scope
- `packages/admin-ui` with Hono JSX, auto-escaping only, no inline scripts or styles, hashed assets with SRI, strict CSP.
- Page and form kit: fetch-metadata checks, CSRF, role checks; data and changes through in-process calls to the admin API.
- An escaping check script in CI.

## Acceptance criteria
- [ ] CSP and escaping checks pass; a test proves the panel's changes go through the admin API (same audit rows).

## Security notes
THREAT_MODEL T13.

## Lessons applied
- L-095 — Server-rendered, script-light, and calling its own API.

## Docs to update
- docs/dev/admin-ui.md (new)

## Out of scope
- Anything not listed under Scope.
