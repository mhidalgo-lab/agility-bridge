---
id: P5-08
title: "Admin: connected apps and devices"
phase: 5
status: done
priority: medium
depends_on: [P5-05]
adr: ["0009", "0013"]
lessons: [L-090, L-097, L-121, L-190, L-191, L-192, L-193, L-218]
owner: "claude-agent"
---

# P5-08 — Admin: connected apps and devices

> Refined 2026-10-24 (tasks/README rule 7), after P5-04 (My access, device cap, revoke), P5-03 (client registrations,
> `oauth.client.*` audit rows, `HttpApp.oauthRegistrations`) and P5-05 (revocation checked on every refresh, tombstones).

## Goal
Owners and admins see who connected which app and disconnect it; owners see the registered clients (dynamic and
metadata-document), judge them by where they send people, and revoke one so that every device of it ends and nothing
new is authorized. Disconnecting always takes effect within the access-cache lifetime, and a refresh fails at once.

## Scope
- **Connected apps of everyone** (`GET /oauth/devices`, panel `/admin/oauth/devices`, owners and admins): a page at a
  time (10 in the panel, at most 50 per call), in storage order, each with the person (name, email, role), the app's
  name (untrusted, escaped, never a link), device name, workspace, redirect host, connected and end times. Never a token.
  - **Disconnect** (`POST /oauth/devices/{id}/revoke` with the person's id in the body; panel POST, CSRF, `Origin`,
    fetch metadata, never a GET, L-090). Same rule as ending a session (`authorizeEndSessions`): an **owner** ends
    anyone's, an **admin** a member's only (an owner's or another admin's, or one of a removed person, is an owner's
    call), a member nothing. A device that is not that person's answers 404 and nothing changes. No recent sign-in:
    disconnecting only removes access (L-093).
  - Audit: the device row `oauth.device.revoke` (an `auth` row for the person, `details.via = admin`, `by` = the
    administrator) and the administrator's `oauth_device.revoke` row. No token material in either.
- **Registered clients** (`GET /oauth/clients`, panel `/admin/oauth/clients`, **owners only**: a client is shared by the
  whole server): kind (dynamic registration or metadata document), name (untrusted, **not verified**, escaped), redirect
  hosts, registered time, "last approved" (the newest approval among the devices counted; there is no per-token
  last-used time until P5-14, so the column does not claim one) and how many devices use it.
  - **Counting is bounded** (L-097): the grants are keyed by person, so counting reads at most 100 of them; beyond that the
    page says the counts are lower bounds, and when the reads fail the counts read "unknown" instead of the page failing.
  - **Revoke a client** (`POST /oauth/clients/revoke`, body `clientId`; confirmation in the panel): the client is
    **blocked first** (`oauth-client-blocked:<sha256 of the id>`), then its record is deleted and every device of it
    revoked (tombstone first, like any revoke), then audited (`oauth.client.revoked`, one `oauth.device.revoke` per device).
    A blocked client gets no authorization, no token request, no refresh (the device is revoked on the attempt) and its
    access tokens stop at the MCP route, so a revoke that was cut short (more grants than one call reads: 1,000) already
    refuses everything and pressing it again ends the rest.
  - **Revoked clients** are listed with **Allow again** (`POST /oauth/clients/restore`) for metadata-document clients,
    whose id is a URL anyone can present again. A dynamic client's record is gone and a new registration is a new client:
    nothing to restore, and its block row expires once every token it could hold has (D-74).
- Admin API routes under the tag `oauth`, with the same guard as the panel (`guardedServices(...).oauth`), `404` when
  OAuth is off, audit rows through the route's own spec (`oauth_device.revoke`, `oauth_client.revoke`,
  `oauth_client.restore`; `clientId` and `userId` recorded, nothing else).
- **Disconnect takes effect within the access-cache lifetime**: the MCP route validates an OAuth access token against
  the provider's store (the revoked grant and its tokens are deleted, so on a cache miss it fails at once) and caches the
  decision per token for `AB_ACCESS_CACHE_TTL` (default 30 s, at most 60 s, `AccessCache`). The process that revoked
  clears its cache; other processes (Node replicas, Worker isolates) honour it within the TTL. The refresh path has no
  cache: tombstone and grant are read on every refresh, so it fails immediately everywhere. A test proves both with two
  app instances over one store.
- Panel: nav "Connected apps" (admin) and "OAuth apps" (owner), at 1280 and 320 px with no horizontal scroll; strict
  CSP, no inline script or style; "OAuth is off" page (404) when OAuth is not enabled.
- Docs: `docs/guide/admin-panel.md`, `docs/guide/admin-guide.md` (role matrix row), `docs/dev/oauth.md`,
  `docs/guide/audit-log.md`, `docs/security/logging.md` if it lists actions, THREAT_MODEL (T15, §8e), generated admin API
  reference, `docs/guide/cloudflare-limits.md` (the bounded reads), a changeset.

## Acceptance criteria
- [x] Owners and admins list every person's connected apps and disconnect one; an admin cannot end an owner's or an
  admin's device; a member, an unauthenticated caller and the break-glass token's absence are refused with no data and no
  effect; a device under another person's id is 404 and stays connected.
- [x] Owners list registered clients (kind, escaped name, redirect hosts, dates, device counts) and revoke one: its
  devices' access and refresh tokens end, a new authorization, token request and refresh are refused, the record is gone;
  a metadata-document client can be allowed again; admins and members get nothing.
- [x] Every change is a POST through the panel's CSRF, `Origin` and fetch-metadata checks; a GET, a missing or wrong
  CSRF token and a cross-site post change nothing; audit rows exist and hold no token material.
- [x] Disconnect: the refresh fails immediately; the access token stops working within the access-cache TTL (tested with
  a second process sharing the store) and at once in the process that revoked.
- [x] Hostile client, device and person names render inert at 1280 and 320 px (E2E), the CSP holds, axe is clean.
- [x] The admin suite runs on memory (both shapes), SQLite and workerd/D1; negative authorization tests for every route;
  security tests are mutation-checked (L-121), recorded under Outcome.
- [x] Docs, THREAT_MODEL, decisions D-74 and D-75, lessons and a changeset are done.

## Outcome
- Built as scoped. Decisions D-74 (a revoked dynamic client may register again as a new client; a revoked metadata-document
  client stays refused until allowed) and D-75 (owners and admins list devices; an admin ends a member's, an owner anyone's;
  clients are owners') are built at the recommended default. Lessons L-259 to L-261. No new task files were needed.
- Deviation from the brief: "last used" of a client is "last approved" (newest approval among its devices) because no per-token
  last-used time exists until P5-14; the column says so.
- Cache proof: the second process is simulated by changing the shared store (tombstone, grant and token rows) without
  clearing the cache, in `defineOAuthCacheSuite` (memory only: time cannot move on SQLite or workerd). Refresh failing at once
  and the revoking process refusing at once are asserted in the same test.
- Tests: `admin-suite.ts` (7 cases) on memory (both shapes), SQLite and workerd/D1; `admin-oauth.test.ts` (9 cases: roles, 401,
  CSRF, cross-site, GET, panel forms, hostile names, OAuth off); role-matrix rows; E2E `oauth-consent.spec.ts` new test at
  1280 and 320 px (axe, no horizontal scroll, CSP watch) passed in local Chromium; ZAP (`pnpm scan:zap`, with `AB_OAUTH=on`
  added to its server) ran: login, admin and API scans each 0 new alerts, no `.zap/rules.tsv` change.
- Mutation checks (L-121), each reverted: devices list without a role check (killed, 2 failing), admin may end an owner's or an
  admin's device (1), device revoke without any role check (1), clients open to admins (1), revoke route / clients route /
  device list skipping the guard (2 each), device revoke ending no tokens (3), client revoke writing no block (4), block not
  checked at authorize and token (6), at the MCP route (2), client revoke keeping the record (2), ending no devices (survived
  first, killed after asserting the device list afterwards: 2), device found without matching the person (2), panel Disconnect
  offered to everyone (1). Survived, equivalent: block not checked in the refresh issuance check (the token endpoint refuses
  the blocked client earlier in `resolveClient`; kept as a second line), and the panel's own role gate on the clients page and
  its revoke form (the admin API refuses an admin anyway; kept as a first line).

## Security notes
THREAT_MODEL T15 (device and client revocation), §8e; T9 and T10 touched (a revoked client stays refused); T3, T21, T23
unchanged (no new request state, no secret).

## Lessons applied
- L-090 — Never revoke or replace a device on a GET an attacker can trigger.
- L-097 — Design for the Free plan's limits (bounded reads, counts degrade instead of failing).
- L-121 — Negative authorization is first-class.
- L-190 to L-193 — Panel CSRF, fetch metadata and referrer rules apply to every form here.
- L-218 — Long unbreakable text must not overflow a 320 px page.

## Docs to update
- docs/guide/admin-panel.md, docs/guide/admin-guide.md, docs/dev/oauth.md, docs/guide/audit-log.md,
  docs/guide/cloudflare-limits.md, docs/THREAT_MODEL.md, docs/reference/admin-api.md (generated)

## Out of scope
- Per-token "last used" and idle expiry of devices (P5-14); remembered consent (P5-13).
- Bulk revoke across people other than "revoke a client"; editing or verifying a client's name or logo.
- An allowlist or denylist of redirect hosts managed in the panel (the `AB_OAUTH_*` redirect host allowlist exists).
- Anything not listed under Scope.
