---
id: P4-12
title: "Move a user to another identity on purpose (owner-only unbind)"
phase: 4
status: in-progress
priority: medium
depends_on: [P4-02, P4-04]
adr: ["0009"]
lessons: [L-065, L-092, L-093, L-121, L-133, L-185, L-220, L-221, L-222]
owner: "claude-agent"
---

# P4-12 — Move a user to another identity on purpose (owner-only unbind)

> Found while building P4-01 (relic-bridge Phase 4 task P4-09): an email bound to another identity is refused, so a
> person who changes provider account is locked out until an owner clears the binding. relic-bridge shipped this as P4-09 and
> P4-14 (panel) with a read-then-write update; here the clear is a compare-and-set like the bind (L-185).

## Goal
An owner can clear a user's `(idp, idp_subject)` so the next verified sign-in with that user's email binds again, at
whichever configured provider asserts it, without opening an account-takeover path for anyone else.

## Scope

**Storage** (`UserRepository.unbind(id, expected)`: memory, SQLite, D1)
- One conditional statement: `UPDATE users SET idp = NULL, idp_subject = NULL WHERE id = ? AND idp = ? AND idp_subject = ?
  RETURNING`; no row means "did not apply" (missing, already clear, or bound to another identity since the caller read it).
  Contract-tested on every adapter, raced (several unbinds, an unbind against a first sign-in).

**Services and guards** (`guardedServices(...).users.unbind(id, confirmEmail)`, so API and CLI share the rules)
- Owner only; the break-glass token counts as an owner. Admins and members: `403`.
- Recent sign-in for a session (`reauth_required`); the break-glass token is exempt (L-093).
- Never your own account through a session (`403`, "ask another owner or use the admin token"). This also covers the last
  owner: the only owner cannot lock themselves out, and unbinding another owner needs a second signed-in owner or the token.
- The caller repeats the user's current email (compared after trim and lowercase, as stored; never echoed): `422` on a
  mismatch with `field: confirm`. A user with no binding is `409`, an unknown user `404`.
- The write is the compare-and-set against the binding the guard just read; a lost race is `409` and writes nothing.

**Admin API** `POST /users/{id}/unbind` `{ confirm }`
- Audit `user.unbind` (ok, error, or denied by the generic path), details `previousIdp` only: never the subject, never the typed
  email (a hash of a numeric provider subject can be guessed, so none is stored either: D-45).
- After the compare-and-set the user's sessions end (`session.revoke_all`, reason `unbind`), so a session open at that moment
  and any created since is gone. Device tokens, grants, role and credentials are untouched.

**CLI** `agility-bridge user unbind <user-id> --confirm <email>` (local database or `AB_ADMIN_URL`; the email is not a secret).

**Panel** `/admin/users/{id}/unbind` (owner only, same call as the API)
- A "Move to another provider…" control on the user page, offered exactly when the API would allow it (owner, not yourself, user
  bound); a warning page that states the takeover consequence and asks for the email again; a wrong or missing email re-renders
  with a fixed message and never echoes the typed value; a flash "identity cleared" afterwards; a stale sign-in gets the
  re-authentication page.

## Acceptance criteria
- [ ] Owner-only, re-authenticated, confirmed, audited (previous provider id only), ends the user's sessions; negative
  authorization tests for every other actor (admin, member, stale owner, stranger, yourself), each leaving no change.
- [ ] The clear is a compare-and-set: concurrent unbinds yield exactly one winner and a stale confirmation never undoes a new
  binding, on memory, SQLite (two connections) and D1.
- [ ] The panel control matches the API for every viewer and target, and the page never shows the subject or echoes input.
- [ ] Documented in `docs/guide/identity-providers.md`, the admin panel and admin access guides, the CLI and admin API
  references, and THREAT_MODEL T14.

## Security notes
THREAT_MODEL T11/T14: unbinding is an account-takeover primitive by design (L-092): the next verified sign-in whose email matches
binds the account at any configured provider, so it is owner-only, re-authenticated, confirmed and audited. Residual risk and
a way to narrow it (bind to a named provider next) are in P4-24 and D-46.

## Lessons applied
- L-092 — One identity per user.
- L-093 — Re-authenticate before high-impact actions.
- L-185 — Bind an identity with one compare-and-set (here: clear with one).
- L-121 — Negative authorization tests that fail when the fix is reverted.

## Docs to update
- docs/guide/identity-providers.md, docs/guide/admin-panel.md, docs/guide/admin-access.md, docs/guide/cli.md,
  docs/reference/cli.md, docs/reference/admin-api.md, docs/THREAT_MODEL.md, docs/dev/admin-ui.md

## Out of scope
- Several identities per user, linking by email (pending decision D-30, recommended: one identity per user).
- Choosing the provider the next sign-in must use (P4-24).
- Ending OAuth grants of the user (Phase 5 adds them; its tasks must end them on unbind).
