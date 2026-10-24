---
id: P5-04
title: Consent screen and device handling
phase: 5
status: todo
priority: high
depends_on: [P5-01]
adr: ["0009", "0013"]
lessons: [L-073, L-090, L-091, L-093, L-121, L-190, L-191, L-192, L-193, L-218]
owner: "claude-agent"
---

# P5-04 — Consent screen and device handling

> Refined 2026-10-24 (tasks/README rule 7), after P5-01's consent seam and relic-bridge's P5-04, P5-11, P5-12 and its
> Phase 5 review (H1, M2, L7, L8).

## Goal
Users knowingly choose which of their access a client gets, on desktop and phone, and can see and disconnect every app
they approved. Operators turn OAuth on with `AB_OAUTH=on`.

## Scope
- **Built-in consent step** (`oauth.consent` becomes optional; tests keep injecting a stand-in). `AB_OAUTH=on` now boots
  on both hosts when sign-in is configured (it needs a session to approve with); D-60 is implemented and superseded.
  - `GET /oauth/authorize` (validated by P5-01) → no session: `303 /auth/login?next=<the authorize URL>` (same-origin
    path, validated by `safeNextPath`, cap raised to 2048 characters; a longer URL gets a 400 page). `prompt=none` never
    shows a page: `login_required` / `consent_required` redirect to the validated redirect URI (OIDC Core §3.1.2.6).
  - Signed in: the consent page in the panel layout, strict panel CSP plus the redirect origin in `form-action`
    (browsers apply it to the redirect after the post), `frame-ancestors 'none'`, no inline script, `no-store`; only
    top-level navigations from other sites (fetch metadata). It names the client (untrusted `client_name`, escaped,
    "Unnamed app" when absent, marked **not verified**: registration is open), the **redirect host** prominently, a
    warning for loopback redirects, the workspace (the `resource`), the grant the token will use (the user's own live
    grant on that workspace: tools, projects, expiry; a choice only when there are several) and how long the access lasts.
    No live grant on the workspace, or a workspace that does not exist → one refusal page (the same answer for both:
    no slug probing), Deny still offered, no token.
  - `POST /oauth/consent`: session + fetch metadata/`Origin` + `_csrf` (exactly one) + urlencoded ≤ 16 KiB, and a
    **single-use handle bound to the exact request**: the page stores `oauth-consent:<user>:<handle>` = SHA-256 of the
    canonical authorization request (client, redirect URI, PKCE challenge and method, resource, scope, state, response
    type), and the post takes it atomically (`kv.take`, L-073) and compares it with the request it re-validates from
    the form's own query. A replayed, swapped, cross-user or expired form approves nothing. Open handles per user are
    bounded.
  - Approve needs a grant id from the user's own usable list (`approve()` re-runs the resolver anyway); Deny → `303`
    with `error=access_denied` (`state`, `iss`) to the validated redirect URI only (L-091). An `http://[::1]` redirect
    is answered by a same-origin page that navigates (no scheme-wide `form-action`, relic P5-12/L8).
  - Not built (kept off the screen): remembered "don't ask again" consent and `mcp:write` consent (D-66 and Phase 7).
    Every authorization shows the page, so a silent navigation can never issue a code.
- **Devices** = approved client + user + workspace (a provider grant). The label the user types on the consent page
  (optional, 60 characters) is stored as grant metadata with the access grant id and workspace id, never personal data.
  - **Silent authorization cannot revoke a device** (relic H1, L-090): `approve()` passes `revokeExistingGrants: false`.
    After a **successful code exchange**, the user's earlier devices of the same client, workspace and redirect URI are
    revoked (tombstone first) and audited (`oauth.device.replaced`); nothing else ends a device except the user, an
    administrator action or the access decision.
  - **Cap per user** (relic M2, D-67): at most 25 devices; `approve()` refuses with `device_limit` before the code is
    minted and **re-counts after the insert** (concurrent approvals), revoking the new device when over the cap. Listing
    reads exactly that bound, so "disconnect all" and the list agree.
  - **My access** shows the user's connected apps (client, workspace, label, connected, ends) with **Disconnect** (POST,
    CSRF, own devices only) and Disconnect all; revocation kills the access token and refresh token at once (provider
    revoke, access cache cleared) and writes `oauth.device.revoke` rows. Admin API: `GET /me/oauth-devices`,
    `POST /me/oauth-devices/{id}/revoke` (any signed-in role; no route takes a user id).
- Docs: the consent and device sections of `docs/dev/oauth.md`, `docs/guide/oauth-phone.md` (new: connecting from a
  phone), the admin guide, configuration reference, THREAT_MODEL (T9, T10, T13), generated admin API reference.

## Acceptance criteria
- [ ] Sign-in round trip: signed out → sign-in → back on the same authorize request → consent page → approve → code at
  the redirect URI → token → MCP call; deny returns `access_denied` with `state` and `iss`.
- [ ] Consent POST refusals (negative, L-121): no session, cross-site and missing `Origin`, wrong or repeated CSRF,
  wrong media type; a replayed form, a form for another request (swapped client, redirect, challenge, resource, state),
  another user's form and an expired handle approve nothing and issue no code.
- [ ] No live grant on the workspace (revoked, expired, other user's, service grant, disabled user, missing workspace)
  gives the refusal page and no code; hostile client names and redirect hosts render inert.
- [ ] A silent authorization (`prompt=none`, a repeated authorize navigation) revokes nothing; a device is replaced only
  after a successful code exchange; the device cap holds under concurrent approvals; revoking a device ends its access
  and refresh tokens; Disconnect cannot touch another user's device.
- [ ] `AB_OAUTH=on` boots on both hosts (Node `serve`, Worker); the consent page works in a real browser (Playwright, 1280
  and 320 px, no CSP violations).
- [ ] Security tests are mutation-checked (L-121), recorded under Outcome.
- [ ] Docs, THREAT_MODEL, decisions (D-60 implemented, D-66, D-67), lessons and a changeset are done.

## Security notes
THREAT_MODEL T9, T10, T13 (T14, T15, T25 touched).

## Lessons applied
- L-073 — One-time state is consumed atomically.
- L-090 — Never revoke or replace a device on a GET an attacker can trigger.
- L-091 — Validate redirect targets after parsing.
- L-093 — Sensitive changes ask for a recent sign-in (disconnecting needs none: it only removes access).
- L-121 — Negative authorization is first-class.
- L-190 to L-193 — Panel CSRF, fetch metadata and referrer rules apply to the consent form.
- L-218 — Long unbreakable text must not overflow a 320 px page.

## Docs to update
- docs/dev/oauth.md, docs/guide/oauth-phone.md (new), docs/guide/admin-panel.md, docs/guide/configuration.md,
  docs/THREAT_MODEL.md, docs/ARCHITECTURE.md, docs/reference/admin-api.md (generated)

## Out of scope
- Remembered consent and write consent (D-66; Phase 7 for `mcp:write`).
- Refresh rotation, the reuse window (P5-05); administrator views of other users' devices and registered clients (P5-08);
  abuse controls (P5-09).
- Anything not listed under Scope.
