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

## Notes from P4-03 (the scaffold) and relic-bridge's reviews
- Build screens in `packages/admin-ui/src/screens/` with `kit.page` / `kit.form` / `kit.callAdmin` / `kit.fail` ([admin panel
  guide](../../dev/admin-ui.md)); a screen never imports storage or auth.
- The "shown once" token page needs a single-use form handle, which P4-03 does not provide. relic-bridge keeps handles in
  `kv`, bounded per user; writing one on every GET let any member spend D1 writes (its review L6), so issue it only for the
  page that shows a form, cap the open ones, and write nothing for HEAD.
- Admins get `403 owner` from the API for an owner's keys, grants and tokens: hide those controls from admins instead of
  offering a button that leads to the 403 page (relic-bridge review L9).

## Out of scope
- Anything not listed under Scope.
