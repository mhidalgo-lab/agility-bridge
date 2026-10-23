---
id: P4-12
title: "Move a user to another identity on purpose (owner-only unbind)"
phase: 4
status: todo
priority: medium
depends_on: [P4-02]
adr: ["0009"]
lessons: [L-092, L-093]
owner: ""
---

# P4-12 — Move a user to another identity on purpose (owner-only unbind)

> Found while building P4-01 (relic-bridge Phase 4 task P4-09): an email bound to another identity is refused, so a
> person who changes provider account is locked out until an owner clears the binding.

## Goal
An owner can clear a user's `(idp, idp_subject)` so they can sign in with another provider account, without opening an
account-takeover path.

## Scope
- Admin API `POST /users/{id}/unbind` and `agility-bridge user unbind <id>`: owner only (the break-glass token counts),
  recent sign-in, never your own account through a session, a confirmation that repeats the user's current email,
  audited as `user.unbind` (previous provider id only, never the subject), and the user's sessions end.
- The panel button comes with the users screen (P4-04).

## Acceptance criteria
- [ ] Owner-only, confirmed, audited, ends the user's sessions; negative authorization tests for every other actor.
- [ ] Documented in `docs/guide/identity-providers.md`.

## Security notes
THREAT_MODEL T14.

## Lessons applied
- L-092 — One identity per user.
- L-093 — Re-authenticate before high-impact actions.

## Docs to update
- docs/guide/identity-providers.md, docs/reference/cli.md, docs/reference/admin-api.md

## Out of scope
- Several identities per user (pending decision D-30).
