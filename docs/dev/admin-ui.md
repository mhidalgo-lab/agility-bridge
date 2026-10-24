# Admin panel (`packages/admin-ui`)

The server-rendered panel at `/admin` ([ADR-0004](../adr/0004-typescript-runtime-agnostic-core.md), L-095, THREAT_MODEL
T13). The frame (P4-03), the management screens (P4-04), the audit viewer (P4-05), the connect page (P4-06) and member self-service (P4-07) are built by the conventions below; what the screens do for an operator is in the [admin guide](../guide/admin-guide.md).

| Piece | Where | Notes |
|---|---|---|
| Components (layout, nav, flash, forms, tables) | `packages/admin-ui/src/components.tsx` | Hono JSX, auto-escaping only |
| Whole pages (sign-in chooser, owner setup, message, error, re-authentication prompt) | `src/pages.tsx` | the `/auth/*` pages use them too |
| Page and form kit | `src/kit.ts` | `kit.page`, `kit.form`, `kit.callAdmin`, `kit.redirect`, `kit.fail` |
| Headers and the CSP | `src/headers.ts` | one literal policy, asserted in tests |
| Flash messages | `src/flash.ts` | a code from a fixed catalogue in a cookie, never text |
| Assets | `packages/admin-ui/assets/admin.css`, `admin.js` -> `src/assets.generated.ts` | hashed names, SRI, generated |
| Screens | `src/screens/*.tsx`, registered in `src/app.ts` | `overview.tsx` and `account.tsx` are the references |
| Server side of the panel | `packages/http-app/src/admin-ui.ts`, `app.ts` | session, in-process admin API calls, mounting |
| OAuth consent page (P5-04) | `src/consent.tsx` (view), `packages/http-app/src/oauth/consent.ts` (handler), `src/headers.ts` (`consentCsp`) | a pure view; the handler is not a `kit.form` route: it needs the single-use handle bound to the request, and a CSP that also names the client's redirect origin |

The package is web-standard only (no `node:*`, `process`, `Buffer`; `scripts/check-runtime-imports.ts` scans it) and
imports nothing but `hono` and its own files: it never sees storage, the session record or a secret. What it needs from the
server arrives through `AdminUiDeps` (`kit.ts`); `packages/http-app` implements that interface from the P4-02 session
manager.

## Rules

- **Auto-escaping only.** No `raw()`, `html` helper, `dangerouslySetInnerHTML` or string-built HTML in `admin-ui` or
  `http-app`. `node scripts/check-ui-escaping.ts` (part of `pnpm lint`) fails on them, and on HTML sinks and dynamic code
  in `assets/admin.js`. A comment may name the forbidden things.
- **Nothing inline.** No `<script>` body, `<style>`, `style=` or `on*=` attribute. The CSP has no `unsafe-inline`, no
  nonces. Behaviour that needs a script goes into `assets/admin.js` (optional enhancement: every page works without it).
- **Links and form actions are same-origin paths**: `localHref()` throws for anything else, so a component cannot emit
  `javascript:` or another origin whatever it is given.
- **Every form is `<Form action csrf={principal.csrf}>`** and posts to a `kit.form(minRole, handler)` route. The token is
  never put in a URL.
- **Changes only through the admin API**: `kit.callAdmin(c, principal, { method, path: adminPath\`/users/${id}\`, body },
  form)`. Unsafe methods need the `VerifiedForm` the kit handed to the handler. Never import storage or auth here.
- **Show fixed text.** Flash messages are codes (`kit.redirect(path, 'saved')`); error pages show fixed sentences and the
  request id. Text from the admin API's error body is never displayed (it can carry names), with one exception made in P4-04
  (decision D-36): the one-line message of a `422 invalid_input`, shown as escaped text beside the form it came from.
- Every new screen is added to the "every screen with data" list of the browser test (`e2e/admin.spec.ts`: 320 px, desktop,
  light and dark, axe-core, CSP and console watch) and, when it carries a flow, gets a step in that spec
  ([testing](testing.md#browser-e2e-and-zap-e2e-phase-4)). A scrollable region is a focusable, named `<section>`.
- Every new route is added to the tests that list the panel's routes (`packages/http-app/test/admin-panel.test.ts`:
  headers, sign-in redirect, role matrix, refusals) and to `NAV_ITEMS` when it has a menu entry.

## A page

```tsx
/** @jsxImportSource hono/jsx */
export function registerThing(ui: Hono, kit: UiKit): void {
  ui.get('/thing', kit.page('admin', async (c, page) => {
    const res = await kit.callAdmin(c, page.principal, { method: 'GET', path: '/things' });
    return page.html(
      <Layout title="Things" viewer={page.principal} current="/admin/thing" flash={page.flash}>
        …
      </Layout>,
    );
  }));
}
```

`kit.page` runs, in this order: the fetch-metadata check (same-origin, `none` and top-level cross-site navigations pass; any
other cross-site request is a 403 before the session is read), the per-IP limit (`beforeAuth`), the session (none: `303
/auth/login?next=<path>`, a dead cookie is cleared), the role (`403` page plus an `admin.forbidden` audit row). Unknown
paths under `/admin` get the same sign-in redirect for strangers and a 404 page for everyone signed in.

## A form

```tsx
<Form action="/admin/thing" csrf={principal.csrf}>…</Form>

ui.post('/thing', kit.form('admin', async (c, principal, form) => {
  const result = await kit.callAdmin(c, principal, { method: 'POST', path: '/things', body: {…} }, form);
  if (result.status !== 201) return kit.fail(c, principal, result, '/admin/thing');
  return kit.redirect('/admin/thing', 'saved');
}));
```

`kit.form` refuses, without calling the handler and without any side effect: a cross-site or foreign-origin post
(`Sec-Fetch-Site`, `Origin`), a body that is not `application/x-www-form-urlencoded`, a body over 16 KiB, a missing,
repeated or wrong `_csrf` field (constant-time comparison, bound to the session), and a role below `minRole`. The CSRF
field is removed from `form.fields` before the handler sees them.

`kit.fail` turns an admin API answer that is not a success into the next page: `403 reauth_required` becomes a page that
says nothing was changed and links to `/auth/reauth?next=<the page>` (the same person signs in again, L-093, L-193; the
change is made again from there, nothing is retried); `401` the sign-in redirect; everything else a redirect with a flash
message chosen from the error code.

Destructive actions use `<ConfirmAction>` (a `<details>` disclosure, no script) and the handler checks `confirm=yes`.

## In-process admin API calls

`callAdmin` builds a request for `/api/admin/v1<path>` with the caller's session cookie, the session's CSRF token, the
public `Origin` and `Sec-Fetch-Site: same-origin`, the client address headers and the panel request's id, and runs it
through the admin API's own Hono app (`packages/http-app/src/app.ts`, `getInner`). The API therefore does what it does for a
browser or a script: the same validation, the same guards (roles, last owner, re-authentication), the same audit rows
(`via: api`, with the panel request's id). `agility-bridge audit tail` shows no difference between a panel change and an
API call, and the test `a panel change is an admin API change` compares them.

## Headers

Every panel page, including errors, 404s and the `/auth/*` pages, is built by `htmlResponse` and carries:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'
Referrer-Policy: same-origin
Cache-Control: no-store
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
```

and the edge adds `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy:
same-origin` and, over https, HSTS. The edge keeps a page's own CSP only when it is exactly the panel's policy
(`isUiCsp`); any other policy a handler sets is replaced by the JSON-only default, so one mistake cannot loosen a response.

`Referrer-Policy: same-origin`, not `no-referrer`: with the app-wide `no-referrer` a browser posts a same-origin form with
`Origin: null`, which the CSRF check rightly refuses (L-191). One page has a looser policy: the owner setup page drops
`form-action` (`UI_CSP_SETUP`), because its form is answered with a redirect to the identity provider and Chromium applies
`form-action` to the redirects that follow a form post.

## Assets

`assets/admin.css` and `assets/admin.js` are embedded into `src/assets.generated.ts` by `scripts/gen-admin-assets.ts`: the
file name carries a content hash (`admin.<16 hex>.css`) and the tag a SHA-384 `integrity` value, so Workers need no file
system and no static-assets binding, and both hosts serve the same bytes at `/admin/assets/<name>` with `Cache-Control:
public, max-age=31536000, immutable`. Change an asset, then:

```
pnpm ui:assets          # regenerate src/assets.generated.ts
node scripts/gen-admin-assets.ts --check   # what pnpm lint runs: fails when the generated file is stale
```

The stylesheet is phone first (works at 320 px: tables scroll inside `.table-wrap`, long values wrap), keeps 44 px targets
and visible focus, honours `prefers-reduced-motion`, and defines light and dark tokens; `test/contrast.test.ts` computes the
WCAG ratios of every token pair (4.5:1 for text, 3:1 for borders and the focus ring), because jsdom cannot.

## Loading on Cloudflare Workers and Node

The panel is never loaded by an MCP request (P3-14, L-182). `http-app` imports it with `import()` the first time a panel or
sign-in page is needed and builds the panel's Hono app on that request (the same pattern as the admin API, which is also
shared with the panel's in-process calls). In the bundle the panel and `hono/jsx` are about 83 KB of 2.3 MB, wrapped in a
lazy initialiser that runs on the first panel request; `packages/http-app/test/admin-panel-lazy.test.ts` fails when an MCP
request, an admin API call or a health check loads it. A failed import answers `500` with no detail and is retried by the
next request.

Because the panel is `.tsx`, scripts that run with `node --conditions=source` (the documentation generators, `cf:setup`)
never need it, but a dev server run that way cannot open `/admin`: run the built CLI (`pnpm build`, then
`node apps/cli/dist/index.mjs serve`) or `wrangler dev` to see the panel. Tests and the Worker bundle alias the package to
its sources.

## Screens (P4-04)

`src/screens/` holds one file per screen (`instances`, `credentials`, `workspaces`, `grants`, `tokens`, `users`) plus
`data.ts` (parsers: only the fields a page shows, with safe defaults) and `shared.tsx` (paging, form readers, confirmation
page, tool/limit/asset-type pickers, error text). Conventions:

- **Load, then render**: `load(kit, c, principal, path, parse)` calls the admin API as the viewer; a failed load is
  `loadFailed` (the status as a fixed error page). Lists are whole arrays; `paged()` shows 25 rows (`?page=`).
- **Controls mirror the API** (L-197): `canManage`, `canIssueOn`, `canReplace` and the role checks decide what a page
  offers; the http-app role matrix test compares them with the API's answers. Add a rule to the API and the test together.
- **Send only what changed** (L-198) and leave out fields the viewer may not edit.
- **Forms re-render on a 422** with the typed values (never a password field's) and the API's validation sentence beside
  the field (`formErrors`); every other refusal is a fixed sentence (`formMessage`) or, for a 403/404/409 on an action, a
  flash code through `kit.fail`. `reauth_required` is the sign-in-again page and `detail: last_owner` the last-owner flash.
- **Destructive actions** post first without `confirm`, get `confirmPage`, then post with `confirm=yes`.
- **Secrets**: `TextField type="password"` never renders a value and sets `autocomplete=off`; handlers pass the typed secret
  only to `kit.callAdmin` and never to a redirect, flash, header or log.
- **One-time pages** use `kit.issueOnce(principal)` when the GET renders the form and `kit.claimOnce(form)` before the API
  call (L-199); the server provides the `OnceStore` (`kv`, `take` atomic).
- The admin API gained `GET /tools` (name, kind, group; owner and admin) for the tool checklists, and every last-owner
  refusal carries `error.detail = "last_owner"`.

## My access (P4-07)

`screens/me.tsx` is the member area (`/admin/me/...`, `kit.page('member')`), and `tokens.tsx` registers its token routes twice
through an `Area` (`ADMIN_AREA` for owners and admins on any grant, `MEMBER_AREA` for the signed-in person's own). Rules:

- **Mine only, for every role** (L-205): the admin API lets an owner read any credential or grant, so the member area checks
  the row's `ownerUserId` / `userId` against the principal itself and answers the 404 page (`loadCredential`, `loadGrant`,
  `/me/grants`), also for owners and admins.
- Members cannot read workspaces: the pages take the few workspace fields from `GET /me/grants`.
- The choice of a credential is `POST /me/grants/{id}/credential`; the page offers only valid tokens of the grant's instance and
  the default only while the grant uses the person's own token (the guard decides; the page mirrors it, L-197).
- The add form lists only instances of the person's live grants in workspaces that use stored tokens (the guard enforces it too).

## Connect page (P4-06)

`snippets.ts` (pure text, no JSX) and `screens/connect.tsx` (`SnippetList`, `ConnectPage`); the routes
`GET /admin/grants/:id/connect` and `GET /admin/me/grants/:id/connect` are registered next to the token routes in
`tokens.tsx`, so both areas share `loadGrant` (mine only, L-205), `loadWorkspace` and `canIssueOn`. Rules:

- **Endpoint from configuration only**: `AdminUiDeps.publicOrigin` (`AB_PUBLIC_URL`'s origin) plus `/w/<slug>/mcp`; never `Host`,
  `X-Forwarded-*` or the request URL. `endpointFor` and `clientSnippets` throw for a slug the storage would not hold (so no
  `${…}` or quote reaches a client configuration), and the page shows an error instead of snippets.
- **One builder per client** in `CLIENT_BUILDERS`; the input carries `auth: SnippetAuth` (today `{ kind: 'device-token', token? }`).
  Phase 5 adds `{ kind: 'oauth' }` and the OAuth branch of each builder (no `Authorization` header, and `claude.ai`/Desktop
  entries moving from `OAUTH_ONLY_CLIENTS` to snippets) without touching the page.
- **Quote per format**: `JSON.stringify` for JSON, `shellWord` (POSIX single quotes) and `powershellWord` for commands; shell lines
  that carry the token read `$AGILITY_BRIDGE_TOKEN` and never the literal value. `Snippet.literalToken` says whether a body holds
  the real token; the only such client is JetBrains, and only when `SnippetAuth.token` is set, which only the one-time page does.
- **Docs agree with the code**: `packages/admin-ui/test/snippets.test.ts` compares every `<!-- snippet: id -->` block of
  `docs/guide/clients.md` with the generated placeholder snippets (slug `my-team`, `https://agility-bridge.example.com`); change a
  builder and regenerate the guide block (copy the output) in the same commit.
- **Copy buttons** are `button[data-copy]` revealed by `admin.js` when the clipboard API exists; without it the `<pre>` is selectable.

## Audit viewer and usage (P4-05)

`screens/audit.tsx` and `screens/usage.tsx`. Notes for the next screen that lists server records:

- **Keyset paging through the API**: ask for page size + 1 rows (`limit=51`); a surplus row means a next page, whose cursor
  (`after=<ts>.<id>`) is the last row *shown*. The cursor and every filter value are validated by regex or allowlist in the
  panel before they reach the API or a link (the API validates again).
- **Who may see what is the API's decision**: `GET /audit` scopes a member to their own user id from the session. The panel
  does not send a `userId` for a member (the API would answer 403) and hides the owner filters; it never filters rows itself.
- **Export is one API call** (`limit=1000`, the API ceiling), not a loop of pages: each in-process call costs several D1
  queries and a Worker request has a small subrequest budget (L-097). `csvCell` is the only place that quotes and neutralises.
- **Names are display-only lookups** (`/workspaces`, `/users`, admins only); a failed lookup shows ids.
- Statistics come from `GET /audit/stats`, bounded in storage (`audit.stats`: newest 10,000 rows, 100 groups) and honest
  about truncation.

## Also in the panel

The audit viewer and the connect page are above; the owner-only unbind (P4-12) is the `/admin/users/{id}/unbind` pair in `screens/users.tsx`: a thin client of `POST /users/{id}/unbind` (owner-only `kit.page`/`kit.form`, the control offered by `canUnbind`, the typed email re-rendered never echoed). A browser run (axe-core, keyboard, 320 px, CSP violations in a real browser) is P4-08.

### Panel follow-ups (P4-15)

- **Enable** is the `/admin/users/{id}/enable` pair in `screens/users.tsx` (`canEnable` = `canManage` and disabled; confirmation page
  first; the unconfirmed step does not call the API, the confirmed one always does, so a forged POST is answered by the guards).
- **Device token list**: `screens/all-tokens.tsx`, registered after `registerTokens`; one `GET /tokens` per page, `parseTokenPage`
  forwards `next` only when it matches `TOKEN_CURSOR_RE`, and the screen forwards `after`, `grant` and `user` only when they have
  the shape the API accepts (anything else is the first page). Revoke posts to the grant's own revoke route (one confirmation
  page, one implementation). There is no `previous`: keyset lists offer *Newest entries* (`Pager first`).
- **Number prefixes**: `GET/POST /admin/instances/{id}/prefixes` in `screens/instances.tsx`; `parsePrefixText` checks only the
  shape (one `=`, no repeated type, at most 64 lines), the rules (`ASSET_TYPE_NAME_RE`, `NUMBER_PREFIX_RE`) are the admin API's
  and shown as its 422 sentence. Only a changed value is sent, empty clears (`null`). `TextAreaField` is the multi-line field.

## CPU benchmark (P4-14)

`pnpm bench:worker` measures the first signed-in `/admin` page of a fresh process (nine of them, the fastest, after a forced
garbage collection) and warm pages (overview, users list with 100 users, audit page with 200 rows, the stylesheet, a form
POST that creates a user through the in-process admin API), in the Workers configuration, and counts Agility requests (0).
The panel is JSX, so the script builds `packages/admin-ui` first and resolves the package to its bundle with a resolution
hook (`scripts/bench/admin-ui-dist-hook.mjs`); everything else runs from source. Numbers: [Cloudflare limits](../guide/cloudflare-limits.md#measured-cost).
