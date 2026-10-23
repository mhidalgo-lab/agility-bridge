---
id: P4-02
title: Admin sessions, roles, CSRF and re-authentication
phase: 4
status: in-progress
priority: high
depends_on: [P4-01]
adr: ["0009"]
lessons: [L-013, L-073, L-093, L-096, L-189]
owner: "claude-agent"
---

# P4-02 — Admin sessions, roles, CSRF and re-authentication

## Goal
Safe browser sessions with roles, and a recent sign-in for high-impact actions. P4-01 ends a sign-in at `onLogin`; this
task plugs a session in there and makes the admin API accept it, as the `user` actor the guards already model.

## Scope
- **Sessions** (`packages/auth/src/identity/session.ts`, web-standard only) in the storage `kv` table, never isolate
  memory: the browser holds `<userId>.<secret>` (32 random bytes), storage only `SHA-256(secret)`. Idle 30 min /
  absolute 12 h (activity in its own row, so a refresh racing a logout cannot revive a session; the idle row is
  written at most once a minute), expiry decided against the injected clock. Cookie `__Host-ab_session` (`ab_session`
  on http loopback): `Secure`, `HttpOnly`, `SameSite=Lax` (sign-in ends in a cross-site redirect chain), `Path=/`, no
  `Domain`; a cookie named twice is no cookie (L-189).
- **Per-user cap** (default 20): sign-in number cap+1 ends the oldest. **Ending sessions in bounded calls**: a new
  storage operation `kv.deletePrefix(prefix)` (one statement on memory, SQLite and D1), so ending all of a user's
  sessions costs two calls however many there are (relic-bridge P4-17).
- **Rotation**: sign-in ends the session the browser presented, then creates a new one (no fixation).
- **Roles** come from the user row on every request, never from the session; a disabled or deleted user loses the
  session on the next request (and it is deleted, so re-enabling does not revive it). Changing a user's role,
  disabling them, or an owner/admin ending them ends their sessions.
- **Owner boundaries** stay in `guardedServices` (owner-only admin/owner management, write enablement, `/keys`,
  last-owner protection already enforced by storage); sessions only supply the actor.
- **Admin API authentication**: `Authorization: Bearer ab_admin_…` is the break-glass path and unchanged; a request
  with an `Authorization` header never falls back to a cookie. Otherwise the session cookie authenticates, with
  fetch-metadata (`Sec-Fetch-Site`) and `Origin` checks, and on every unsafe method the CSRF token (header
  `X-CSRF-Token`, synchronizer token bound to the session, constant-time compare). The admin API is available when
  sign-in is configured even without `AB_ADMIN_TOKEN`.
- **New admin API routes**: `GET /session` (who am I, role, `recentAuth`, expiry, the CSRF token), `POST
  /users/{id}/sessions/revoke` (end all of a user's sessions: yourself; an owner anyone; an admin members; the
  break-glass token anyone).
- **Auth routes**: `POST /auth/logout` (POST only, CSRF token as form field or header, same-origin; deletes the
  session; `Clear-Site-Data: "cookies"` unless `AB_LOGOUT_CLEAR_SITE_DATA=off`; `everywhere=1` ends all of the
  user's sessions); `GET /auth/account` (a minimal server-rendered page naming the user, with the sign-out form and
  the re-authentication link; P4-03 replaces it with the panel); `GET /auth/reauth?next=` (re-authentication).
  The default post-login landing is `/auth/account` until the panel exists.
- **Re-authentication**: `recentAuth` is true only within 10 minutes of the session's sign-in. `GET /auth/reauth`
  starts a sign-in with the session's provider (OIDC/Google send `prompt=login&max_age=0`), bound to the current user:
  it must resolve to the same user, an `auth_time` the IdP reports must be recent, and a Cloudflare Access assertion
  must have been issued within the window; the result is a new session (rotation) and a return to `next`. A refused
  guard answers `403 reauth_required`. Required for: instance retarget, master-key retirement, setup links (already),
  creating, promoting, demoting or disabling owners and admins, replacing a credential's token, write enablement
  (workspace write policy and write tools, grants with write tools). There is no import yet (note for later).
- **Audit and logs**: `session.create` (sign-in or re-auth, rotated, evicted), `session.revoke` (logout),
  `session.revoke_all` (self, by whom, role change, disable), and refusals (`admin.forbidden` with the reason: cross
  site, origin, CSRF) as `admin` rows. Session secrets, CSRF tokens and cookies are never logged or audited; the
  redaction patterns are extended where a value could appear.
- **Settings** (both hosts through `parseServerSettings`): `AB_SESSION_IDLE_MINUTES` (5–1440, default 30),
  `AB_SESSION_MAX_HOURS` (1–168, default 12), `AB_SESSION_MAX_PER_USER` (1–100, default 20),
  `AB_LOGOUT_CLEAR_SITE_DATA` (`cookies` default | `off`).

## Acceptance criteria
- [ ] Session lifecycle with an injected clock: idle and absolute expiry (boundaries), activity never extends the
  absolute lifetime, cap eviction of the oldest, rotation at sign-in (the old cookie is dead), end-all (self, owner,
  admin over members only), `deletePrefix` on memory, SQLite and D1.
- [ ] Cookie attributes on https and http loopback; a duplicated cookie, a malformed value and a cookie for another
  user's id are refused before or without a session; storage and logs hold no session secret or CSRF token.
- [ ] CSRF: missing and wrong token, cross-site `Origin`, `Origin: null`, `Sec-Fetch-Site` cross-site and same-site,
  on every unsafe admin API method and on logout; a cross-site navigation GET is allowed, a cross-site fetch GET is
  not; the bearer token path needs none and never falls back to the cookie.
- [ ] Role matrix through real sessions (owner, admin, member): owner-only routes, admins cannot touch admins or owners,
  last owner cannot be demoted or disabled; a disabled user and a role change take effect on the next request.
- [ ] Re-authentication: window boundaries (just inside, just outside), reauth must resolve to the same user, stale
  `auth_time` refused, every action listed above answers `403 reauth_required` without a recent sign-in and succeeds
  after `/auth/reauth`; the break-glass token is exempt.
- [ ] Logout: POST only (GET is 404/405), CSRF-checked, deletes the session, sends `Clear-Site-Data: "cookies"`; a
  cross-site logout form changes nothing.
- [ ] Negative authorization tests: denial causes no side effect and returns no data.
- [ ] A session-authenticated admin request works on the Worker (workerd), and on `serve` over a real socket.
- [ ] Key security tests are mutation-checked (L-121), recorded under Outcome.
- [ ] `docs/guide/admin-access.md` (commands run, L-133), THREAT_MODEL T13 and T14, the configuration reference, the
  generated admin API and CLI references, new lessons, and a changeset are done.

## Security notes
THREAT_MODEL T13, T14. From relic-bridge's Phase 4 reviews, folded in up front: sessions rotate at sign-in; the role
is read per request; a cookie named twice is no cookie; a session whose user is disabled is deleted; ending sessions
is a bounded number of calls (P4-17); session cap per user; owner-only management of admins (P4-21 there, already in
the guards here); last-owner protection in storage (P4-16 there, P2-17 here); open redirect after sign-in re-checked
at the `Location` header (P4-01).

## Lessons applied
- L-013 — No request data in module state.
- L-073 — One-time state is consumed atomically (the re-authentication transaction is the login transaction).
- L-093 — Re-authenticate before high-impact actions.
- L-096 — No shared in-flight I/O between requests on Workers (no module-level session or user cache).
- L-189 — A cookie named twice is no cookie.

## Docs to update
- docs/guide/admin-access.md (new)
- docs/guide/configuration.md, docs/guide/identity-providers.md, docs/THREAT_MODEL.md, docs/RESEARCH.md,
  docs/reference/admin-api.md (generated)

## Out of scope
- The panel itself and its CSS (P4-03+); a session list screen; unbind (P4-12); `cf:setup` prompts (P4-13).
- OAuth for MCP clients (Phase 5).
