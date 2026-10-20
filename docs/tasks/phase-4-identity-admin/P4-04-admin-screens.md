---
id: P4-04
title: "Admin screens: instances, credentials, workspaces, grants, tokens, users"
phase: 4
status: todo
priority: high
depends_on: [P4-03]
adr: ["0008"]
lessons: [L-065, L-073]
owner: ""
---

# P4-04 — Admin screens: instances, credentials, workspaces, grants, tokens, users

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Everything manageable from the browser, including a phone.

## Scope
- Screens for instances (owner/admin only), credentials (personal and shared, validation status, hint only), workspaces (Agility projects, asset types, tool groups, limits, write policy), grants, device tokens (shown once, issue-once/claim-once), users and roles.
- Destructive actions confirmed; owner-only actions guarded server-side; instance origin and TLS changes owner-only with re-authentication, showing that every credential of the instance will be revoked.
- When refining, split into separate tasks per domain: instances and credentials, workspaces and grants, device tokens, users and roles.

## Acceptance criteria
- [ ] Reloads never mint a second token (test).
- [ ] Server-side guards tested for every owner-only action, including instance origin changes.

## Security notes
THREAT_MODEL T3, T13, A5.

## Lessons applied
- L-065 — Every alternate writer is an authorization boundary.
- L-073 — One-time state is consumed atomically.

## Docs to update
- docs/guide/admin-panel.md (new)

## Out of scope
- Anything not listed under Scope.
