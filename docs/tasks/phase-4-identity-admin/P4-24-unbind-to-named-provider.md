---
id: P4-24
title: "Unbind to a named provider: narrow who can claim the account"
phase: 4
status: todo
priority: low
depends_on: [P4-12]
adr: ["0009"]
lessons: [L-092, L-093, L-220]
owner: ""
---

# P4-24 — Unbind to a named provider: narrow who can claim the account

> Found while building P4-12: after an unbind the next verified sign-in with the user's email binds the account at any
> configured provider, so a provider with weaker email checks is a way in during that window.

## Goal
Let the owner say which provider the next binding must come from (and optionally for how long), so the window is as narrow as
the move the owner intended.

## Scope
- An optional `provider` (and `ttlMinutes`) in `POST /users/{id}/unbind`, `--to <provider>` on the CLI and a select in the panel,
  stored as a pending claim in `kv` (expiring); `resolveLoginUser` binds an unbound user only from that provider while the claim
  lasts; the claim is cleared by the bind or its expiry.
- Audit: the provider asked for. Tests: another provider is refused with `identity_conflict`-like denial, expiry, race with
  a sign-in on every adapter.

## Acceptance criteria
- [ ] With a provider named, a verified sign-in at another provider cannot bind the account; without one, behaviour is as in P4-12.
- [ ] Negative authorization tests for the new fields; documented in the identity-providers guide.

## Docs to update
- docs/guide/identity-providers.md, docs/reference/admin-api.md, docs/reference/cli.md, docs/THREAT_MODEL.md

## Out of scope
- Several identities per user (D-30).
