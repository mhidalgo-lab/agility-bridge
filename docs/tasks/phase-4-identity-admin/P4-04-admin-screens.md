---
id: P4-04
title: "Admin screens: instances, credentials, workspaces, grants, tokens, users"
phase: 4
status: done
priority: high
depends_on: [P4-03]
adr: ["0008"]
lessons: [L-065, L-073, L-093, L-095, L-121, L-191, L-192, L-193]
owner: "claude-agent"
---

# P4-04 — Admin screens: instances, credentials, workspaces, grants, tokens, users

## Goal
Everything an owner or admin manages from the browser, including a phone, through the same admin API, guards and audit
rows as a script would use. Members' own access ("My access") is P4-07; the audit viewer is P4-05; the connect page is
P4-06; the owner-only unbind is P4-12.

## Scope

Screens, all under `/admin`, built in `packages/admin-ui/src/screens/` with `kit.page` / `kit.form` / `kit.callAdmin`
(never storage, never auth). Lists page in the panel (25 rows, `?page=`), because the admin API returns whole arrays.

| Screen | Routes | Who |
|---|---|---|
| Instances | `/instances`, `/instances/new`, `/instances/:id` (+ `edit`, `disable`, `enable`, `delete`, `retarget`) | owner, admin; origin/TLS change: owner, recent sign-in, shows what will be revoked |
| Credentials | `/credentials`, `/credentials/new`, `/credentials/:id` (+ `rename`, `token`, `validate`, `revoke`, `delete`) | owner, admin. Shared credentials, or *my* personal one; a token is typed once (password field, never echoed, never in a flash, a URL or a log) and replacing it needs a recent sign-in |
| Workspaces | `/workspaces`, `/workspaces/new`, `/workspaces/:id` (+ `edit`, `disable`, `delete`) | owner, admin; write settings, write tools and pass-through: owner with a recent sign-in (hidden from admins) |
| Grants | `/grants`, `/grants/new`, `/grants/:id` (+ `edit`, `revoke`, `delete`) | owner, admin; write tools: owner, recent sign-in |
| Device tokens | `/grants/:id/tokens/new`, `/grants/:id/tokens` (issue), `/tokens/:id/revoke` | owner, admin (a grant on someone else's personal credential offers no token button: the API refuses it) |
| Users | `/users`, `/users/new`, `/users/:id` (+ `edit`, `role`, `disable`, `sessions`) | owner, admin (members only); owners and admins: owner; last active owner protected and said so |

- **Device token shown once.** The form of the issue page carries a single-use handle (`_once`) kept in `kv` through an
  `OnceStore` the server provides (the panel never sees storage). The handle is taken before the admin API call, so a
  reload or the back button of the one-time page issues nothing. Handles are written only for the page that shows the
  form (never for HEAD, never for the list), at most 10 open per user (relic-bridge review L6, P4-19), and the answer is
  `no-store` like every panel page.
- **Role-aware controls match the API**: a control is shown only when the API would allow it (owner-only changes are
  hidden from admins, an admin sees no button for an owner or admin user, personal credentials of other people offer no
  token replacement); a test compares what the page offers with what the API answers for every role (relic-bridge
  review L9).
- **High-impact changes** (origin/TLS, token replacement, write settings, owner/admin changes) answer `403
  reauth_required` from the API; the panel shows the sign-in-again page and changes nothing.
- **Forms**: secrets are `type=password autocomplete=off` and never put back into a page; a validation error (`422`)
  re-renders the form with the API's message next to it (escaped) and the values the person typed, except secrets;
  every other failure is a fixed message. Destructive actions (revoke, delete, disable, retarget) are POST forms with
  CSRF, behind a confirmation page that says what will happen.
- **Admin API addition**: `GET /tools` (the tool catalogue: name, kind, group; owner and admin), for the tool
  checklists, and `detail: "last_owner"` on the error of any last-owner refusal so the panel can say so.
- **Hygiene**: all strings through auto-escaping, no inline script or style, CSP unchanged, generated assets refreshed,
  phone friendly at 320 px.

Left to the API and CLI on purpose: instance `numberPrefixes` (shown, not edited) and a panel-wide list of every device
token (tokens are listed on their grant).

## Acceptance criteria
- [x] Reloads never mint a second token (test): re-sending the issue form, the back button, a forged or foreign handle.
- [x] Server-side guards tested for every owner-only action, including instance origin changes (API and panel, no
  upstream call and no data on denial).
- [x] Every screen renders for each role (owner, admin, member, disabled) as its role allows; the role matrix of the
  buttons equals the API's answers.
- [x] Secrets are never shown after entry: not in the page, the validation re-render, a flash, a redirect or a log
  (tests scan every response for the typed token).
- [x] Destructive actions need CSRF and a confirmation; CSRF, fetch-metadata and origin refusals change nothing.
- [x] Re-authentication flows tested for origin change, token replacement, write settings and owner changes.
- [x] A panel change equals an API change (same audit row, same actor).
- [x] Hostile strings (names, labels, emails, slugs, scope ids, asset types) are inert on every screen.
- [x] Last-owner refusals are explained; handles are capped and HEAD writes nothing.
- [x] A workerd smoke renders at least one screen with its form.
- [x] Key security tests are mutation-checked (L-121), recorded under Outcome.
- [x] `docs/guide/admin-panel.md` written, `docs/guide/admin-access.md`, `docs/dev/admin-ui.md`, the admin API reference and
  THREAT_MODEL updated; changeset added.

## Security notes
THREAT_MODEL T3, T8, T13, T14, A5, A14.

## Lessons applied
- L-065 — Every alternate writer is an authorization boundary.
- L-073 — One-time state is consumed atomically.
- L-093 — Re-authenticate before high-impact actions.
- L-095 — Server-rendered, script-light, and calling its own API.
- L-121 — Negative authorization is first-class.
- L-191, L-192, L-193 — Referrer policy for forms, cross-site navigations, re-authentication proves the same person.

## Docs to update
- docs/guide/admin-panel.md (new), docs/guide/admin-access.md, docs/dev/admin-ui.md, docs/reference/admin-api.md (generated)

## Notes from P4-03 (the scaffold) and relic-bridge's reviews
- Build screens in `packages/admin-ui/src/screens/` with `kit.page` / `kit.form` / `kit.callAdmin` / `kit.fail` ([admin panel
  guide](../../dev/admin-ui.md)); a screen never imports storage or auth.
- The "shown once" token page needs a single-use form handle, which P4-03 does not provide. relic-bridge keeps handles in
  `kv`, bounded per user; writing one on every GET let any member spend D1 writes (its review L6), so issue it only for the
  page that shows a form, cap the open ones, and write nothing for HEAD.
- Admins get `403 owner` from the API for an owner's keys, grants and tokens: hide those controls from admins instead of
  offering a button that leads to the 403 page (relic-bridge review L9). In agility-bridge the matching refusals are the
  owner-only user, origin and write-setting changes and the personal-credential rules.

## Out of scope
- Member self-service (P4-07), audit viewer (P4-05), connect page (P4-06), unbind (P4-12), benchmark scenarios (P4-14),
  browser end-to-end (P4-08).

## Outcome

- **Built**: six screens (`packages/admin-ui/src/screens/`: instances, credentials, workspaces, grants, tokens, users) with
  shared helpers and parsers; `OnceStore` and `issueOnce` / `claimOnce` in the kit, wired to `kv` in `http-app`; `Pager` and
  `SecretOnce` components; a password field that cannot carry a value; flash codes for the new outcomes; menu entries
  (Instances, Credentials, Workspaces, Grants, Users; the device-token screens live on the grant page); stylesheet additions
  and regenerated hashed assets. `docs/guide/admin-panel.md` is new.
- **Admin API**: `GET /tools` (owner and admin, 403 for members, 401 without credentials) and `error.detail: "last_owner"` on
  every last-owner refusal (guard 403 and storage-trigger 409).
- **Tests**: `packages/http-app/test/admin-screens.test.ts` (35 tests: every screen per role, hostile strings, instances
  incl. origin change and re-authentication, credentials and secret echo scans, workspaces and grants incl. owner-only
  settings and write tools, device token shown once with reload, race, forged, foreign and capped handles, users role matrix
  against the API and the last-owner rule, every POST route refused without effect on CSRF, origin, content type, size, role and
  missing session, panel change == API change, paging, `/tools`), `packages/admin-ui/test/screens.test.tsx` (16 tests), and a
  workerd smoke in `apps/worker/test/worker.test.ts` (screens render, one-time token page and re-sent form against D1).
- **Mutation checks (L-121)**: 21 deliberate reversions each fail at least one test: single-use handle always accepted, handle
  not bound to the user, HEAD writes a handle, no cap on open handles, token button for every grant, admins manage every user,
  password field echoes its value, origin form open to admins, admin overwrites an owner's tool list, `reauth_required` not
  recognised, no last-owner marker, no CSRF check, token replacement for any credential, token issued before the handle is
  taken, token POST open to members, `/tools` open to members, admins offered disable on themselves (found surviving, a
  self-disable assertion was added), error text shown for every status, write tools offered to admins, paging ignoring the
  page, origin change without the confirmation box.
- **relic-bridge findings folded in**: review L6 (handle written on every GET: now only for the form page, never HEAD, capped,
  P4-19 behaviour), L9 (controls hidden instead of leading to a 403: L-197 and the role matrix test), H1's owner boundary mapped to
  agility-bridge's owner-only rules, P4-23's grant-form limits (limits can only narrow; notes recomputed on the grant page),
  P4-20 hygiene (role ranks tested against the API, CSP asserted against literals).
- **New**: lessons L-197 to L-199, decision D-36, task P4-15 (enable a disabled user, a panel-wide device token list, editing number
  prefixes: the API lacks them).
