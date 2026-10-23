---
id: P4-03
title: Admin UI scaffold
phase: 4
status: review
priority: high
depends_on: [P4-02]
adr: ["0004"]
lessons: [L-095, L-182, L-191, L-192, L-193]
owner: "claude-agent"
---

# P4-03 — Admin UI scaffold

## Goal
A server-rendered, phone-friendly panel that is safe by construction: the frame every admin screen (P4-04 to P4-07) is
built in. This task ships the frame, one overview page and one small account page that performs a real change through
the admin API; the screens themselves are not part of it.

## Scope
- **Package split.** `packages/admin-ui` (web-standard, ADR-0004, depends on `hono` only) owns the views and the
  `/admin` routes: `createAdminUi(deps)` returns a Hono sub-app. What it needs from the server (the session, in-process
  calls to the admin API, audit of refusals) arrives through the structural `AdminUiDeps` interface, so there is no
  package cycle. `packages/http-app` wires it from the P4-02 session manager and mounts it at `/admin` whenever sign-in
  is configured (the panel needs a session), on `serve` and on the Worker.
- **Rendering.** Hono JSX (`.tsx`, `@jsxImportSource hono/jsx`) rendered to a string with a doctype. Auto-escaping
  only: no `raw()`, `html` helper, `dangerouslySetInnerHTML` or string-built HTML anywhere in the UI or the HTTP app.
  `scripts/check-ui-escaping.ts` fails `pnpm lint` on any of them (and on HTML sinks and dynamic code in the script
  asset); a test plants a violation of each kind.
- **Static assets.** One stylesheet and one optional script, authored in `packages/admin-ui/assets/` and embedded into
  `src/assets.generated.ts` by `scripts/gen-admin-assets.ts` (content hash in the name, SHA-384 SRI value;
  `--check` in `pnpm lint`). Served from the bundle on both hosts (no file system, no static-assets binding) at
  `/admin/assets/<name>.<hash>.<ext>`: public, `Cache-Control: public, max-age=31536000, immutable`, correct type,
  unknown names are 404. Every page works without the script.
- **Headers on every panel page** (errors, 404 and sign-in pages included): `Content-Security-Policy: default-src
  'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors
  'none'; base-uri 'none'; require-trusted-types-for 'script'` (no `unsafe-inline`, no `unsafe-eval`, no nonces: the
  pages carry no inline script or style), `Referrer-Policy: same-origin` (L-191), `Cache-Control: no-store`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, a `Permissions-Policy` that
  turns every powerful feature off, plus the edge's `nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy`
  and HSTS. The edge keeps exactly the panel's policy (compared as a whole) and replaces any other CSP a handler set.
- **Layout.** Skip link, header with navigation (current page `aria-current`, entries filtered by role), `main`
  landmark with the flash, footer with the signed-in user and sign-out. Phone first (works at 320 px: nothing overflows
  the page, tables scroll inside their wrapper), design tokens as custom properties for light and dark, visible focus,
  44 px targets, reduced motion; colour pairs meet 4.5:1 (computed in a test).
- **Page and form kit** (`kit.page(minRole, handler)`, `kit.form(minRole, handler)`):
  - Pages: fetch metadata first (same-origin, `none` and top-level cross-site navigations are served; any other
    cross-site request is refused 403 before the session is read), a per-IP limit hook, then the session. No session:
    `303 /auth/login?next=<path>` with the path re-validated by the sign-in route (a dead cookie is cleared); bearer
    tokens never authenticate a page. Role gate per page; the admin API checks again.
  - Forms: POST only, urlencoded only, 16 KiB cap, fetch-metadata and `Origin` checks, then exactly one `_csrf` field
    compared in constant time, then the role. A refusal is a 403 page, an `admin.forbidden` audit row (reason, route,
    never the token) and no side effect. `<Form>` is the only way a screen builds a form and always carries the token.
  - Post/Redirect/Get with flash messages: a short-lived `HttpOnly` cookie holding a message *code* from a fixed
    catalogue, never text.
  - Re-authentication: when the admin API answers `403 reauth_required` the kit answers with a page that explains it and
    links to `/auth/reauth?next=<the form's page>`; nothing is retried automatically.
  - Error mapping: the admin API's error codes map to fixed flash messages (nothing from the response body is shown).
- **Data and changes through the admin API.** `kit.callAdmin` runs the admin API's own Hono app in-process with the
  caller's session (cookie, CSRF header, own `Origin`, same client address and request id), so validation, role
  guards, re-authentication rules and audit rows are those of the HTTP API, and the UI package never touches storage.
  An unsafe call needs the `VerifiedForm` of the same request (type- and runtime-checked), so a handler cannot skip the
  CSRF check. Paths are built with `adminPath` (every value is one percent-encoded segment).
- **Mounting.** `GET /admin`, `/admin/*`. On the Worker the panel is built on its first request, not at boot, and loaded
  with a dynamic import, so MCP requests never pay for it (P3-14, L-182); the admin API app is shared by the HTTP route
  and the panel. On Node the same lazy load keeps scripts that import the HTTP app from source (docs generators)
  independent of the panel's `.tsx` files.
- **Pages in this task:** `GET /admin` (who you are, role, session expiry, the sign-out forms, and for admins the first
  users through `callAdmin`), `GET /admin/account` with `POST /admin/account/sessions` (end every session of mine through
  `POST /users/{id}/sessions/revoke`, any role) and `POST /admin/account/name` (owners: change the display name through
  `PATCH /users/{id}`, which needs a recent sign-in: the re-authentication round trip), the asset route and a signed-in
  404 page. Everyone else gets the sign-in redirect for any `/admin/*` path (no page names leak).
- **Sign-in pages.** The `/auth/*` pages (chooser, setup form, failures, sign-out result) move onto the same layout and
  headers; `/auth/account` redirects to `/admin/account`; the default post-login landing (`DEFAULT_LOGIN_NEXT`) is
  `/admin`.
- **Role parity.** The panel's role ranks are tested against the guards' (relic-bridge Q4): every nav entry is reachable
  by exactly the roles whose menu shows it.

## Acceptance criteria
- [x] The CSP (asserted as a literal string, once, and compared by exact match at the edge) has no `unsafe-inline` or
      `unsafe-eval`; the full header set is asserted on every panel route (overview, account, asset, 404, 403, error,
      sign-in redirect target, `/auth/*` pages) on Node (in-process) and in workerd.
- [x] Hostile strings (script tags, attribute breakouts, `javascript:` URLs, a user's email and display name coming from
      storage) render inert through every component and both pages.
- [x] `scripts/check-ui-escaping.ts` is in `pnpm lint` and fails on a planted `raw(`, `dangerouslySetInnerHTML`,
      `hono/html`, `html` template with interpolation, `innerHTML =` and `eval(`; the scan covers `admin-ui` and
      `http-app` sources.
- [x] SRI hashes in the pages match the bytes served; names carry the content hash; assets are `immutable`; the
      generator's `--check` detects a changed asset or a hand-edited generated file (in `pnpm lint`).
- [x] Unauthenticated, bearer-only, dead-cookie and disabled-user requests to `/admin` and `/admin/*` redirect to sign-in
      with a same-origin `next`, with no page content; cross-site subresource and `fetch` requests are refused.
- [x] Form refusals (missing, duplicate and wrong CSRF token, foreign and `null` `Origin`, cross-site fetch metadata,
      wrong content type, oversized body, role too low) answer 403/413/415 and change nothing (no storage write, no
      audit row except `admin.forbidden`).
- [x] A change made in the panel goes through the admin API: its audit row equals the row of the same call made on the
      API (same action, actor role, fields, `via`), a role the API refuses is refused in the panel, and the UI package
      has no storage import.
- [x] Re-authentication round trip: an owner without a recent sign-in gets the prompt page (nothing changed), follows
      `/auth/reauth`, returns to the page and the same form succeeds.
- [x] `/admin` renders on the Worker in workerd, and MCP requests do not load the panel (test on the lazy build).
- [x] The Worker cold start is not worse: bundle size delta recorded, the panel is not evaluated by an MCP request.
- [x] Key security tests are mutation-checked (L-121), recorded under Outcome.
- [x] `docs/dev/admin-ui.md`, THREAT_MODEL T13, `docs/guide/admin-access.md`, ARCHITECTURE, a changeset and new lessons
      are done; documented commands run (L-133).

## Outcome
- Built as scoped. `packages/admin-ui` (components, kit, pages, headers, flash, assets, `overview` and `account` screens),
  `packages/http-app/src/admin-ui.ts` (the session and admin API as `AdminUiDeps`) and the mounting in `app.ts`; the
  `/auth/*` pages now render through the panel's layout and `packages/http-app/src/identity-pages.ts` (string-built HTML) is
  gone. `DEFAULT_LOGIN_NEXT` is `/admin`; `GET /auth/account` redirects to `/admin/account`; the one-off `/auth/setup.js` is
  folded into the panel's script (`input[data-setup-code]`).
- Tests added: admin-ui 137 (components and hostile strings, headers, assets, contrast, kit against a fake server), http-app
  53 (`admin-panel.test.ts`, `admin-panel-lazy.test.ts`: headers on every route on Node and in the Workers configuration,
  who gets in, 28 form-refusal cases that must change nothing, panel change equals API change, re-authentication round
  trip, lazy loading), scripts 25 (escaping guard with a planted violation of each kind, generator `--check` drift), plus
  workerd (`/admin`, asset, form with the in-process admin API on the Worker) and a real-socket `serve` run (the form body
  reaches the panel through the forwarded request). Existing P4-01/P4-02 tests were updated where the page markup or the
  landing page changed.
- Worker bundle: the panel and `hono/jsx` are about 83 KB of 2.29 MB, inside a lazy initialiser that runs only on the first
  panel or sign-in request (checked in `apps/worker/dist/index.js`); `pnpm bench:worker` cold boot is unchanged within its
  noise. No Cloudflare measurement was made (no deploy in this task).
- Mutation checks (L-121), 29 deliberate reversions that each fail a test: CSRF comparison removed, token accepted twice,
  form `Origin`/fetch-metadata check removed, form role check removed, page role check removed, page fetch-metadata check
  removed, content-type check removed, size cap removed, an unsafe admin call without the verified form, the
  re-authentication prompt removed, dead cookie not cleared, `localHref` accepting anything, `adminPath` not encoding,
  a flash cookie named twice accepted, a flash rendered with `dangerouslySetInnerHTML`, `unsafe-inline` in the CSP, assets
  not immutable, the edge keeping any CSP, the CSRF header dropped from the in-process call, no audit row for a refused panel
  request, the panel loaded eagerly, the request id not carried to the panel, the setup page keeping `form-action`, a dead
  session not clearing the cookie, the forwarded request losing its body, the escaping guard without its `raw(` or
  `html` template rule, SRI over the wrong digest, and `--check` always passing. Three survived their first test set and led
  to a test or a better mutation: a flash cookie named twice (test added), a flash mutation that did not change what is
  rendered (replaced by `dangerouslySetInnerHTML`), and an audit mutation that kept the write alive anyway (replaced by
  dropping the call). Writing the edge mutation showed that no test served a loose policy through the edge, so a test now
  adds routes with loose and near-miss policies to the app and checks that only the panel's two survive.
- relic-bridge findings folded in: the CSP test compares against a literal (Q1, L-194); role ranks are tested against the
  admin API's behaviour and every menu entry against the roles that may open it (Q4); the panel's `Referrer-Policy:
  same-origin` (task text there said `no-referrer`); a flash cookie named twice is none; the single-use handle written on
  every GET of a token form (L6) is not ported and is noted for P4-04. Not ported: jsdom/axe-core runs (jsdom has no layout:
  the token contrast is computed instead; browser runs are P4-08), the once-store, the consent and member screens.
- New: lessons L-194 to L-196, task P4-14 (benchmark scenarios for the panel), decision D-35.
- Not exercised: a real browser (P4-08: the CSP, Trusted Types and `form-action` behaviour are per the specification only),
  a real identity provider, and the Worker cold start on Cloudflare itself.

## Security notes
THREAT_MODEL T13 (XSS, CSRF, clickjacking), T14 (session use on pages), T21 (no request data in module state: the kit
keeps nothing between requests).

## Lessons applied
- L-095 — Server-rendered, script-light, and calling its own API.
- L-182 — Move what needs no environment to module scope, keep the rest out of MCP requests.
- L-191 — Forms need `Referrer-Policy: same-origin`.
- L-192 — A link from elsewhere is a cross-site navigation.
- L-193 — Re-authentication never resolves users.

## Docs to update
- docs/dev/admin-ui.md (new), docs/guide/admin-access.md, docs/THREAT_MODEL.md, docs/ARCHITECTURE.md

## Out of scope
- The screens (P4-04 instances, credentials, workspaces, grants, tokens, users; P4-05 audit viewer; P4-06 connect page;
  P4-07 member self-service), single-use form handles for one-time token pages (P4-04 builds them where it needs them),
  axe-core/browser accessibility runs (P4-08: jsdom has no layout), a session list screen, unbind (P4-12).
