---
id: P4-15
title: "Panel follow-ups: enable a disabled user, list every device token, edit number prefixes"
phase: 4
status: todo
priority: low
depends_on: [P4-04]
adr: ["0008"]
lessons: [L-065, L-197]
owner: ""
---

# P4-15 — Panel follow-ups: enable a disabled user, list every device token, edit number prefixes

> Found while building P4-04: three things the screens cannot do because the admin API has no endpoint for them.

## Goal
Close the gaps P4-04 left on purpose, each through a new admin API endpoint with negative authorization tests (no screen
bypasses the API).

## Scope
- `POST /users/{id}/enable` (owner for owners and admins, admin for members, recent sign-in as for disabling) and a button
  on the user's page. Today a disabled user stays disabled.
- `GET /tokens` (all device tokens the caller may see, filterable by grant) and a panel list with the grant's name, so a lost
  device can be found without opening every grant.
- Editing an instance's `numberPrefixes` (a small "Type=PREFIX" form), validated against the allowed asset-type names.

## Acceptance criteria
- [ ] Each endpoint is guarded like its sibling (role matrix, re-authentication, audit row) and documented in the reference.
- [ ] Each panel control matches the API for every role (the role matrix test covers it).

## Docs to update
- docs/guide/admin-panel.md, docs/reference/admin-api.md

## Out of scope
- Anything not listed under Scope.
