# Admin panel (`packages/admin-ui`)

The server-rendered panel at `/admin` ([ADR-0004](../adr/0004-typescript-runtime-agnostic-core.md), L-095, THREAT_MODEL
T13). P4-03 ships the frame and two small pages; the screens (P4-04 to P4-07) are built in it by the conventions below.

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
  request id. Text from the admin API's error body is never displayed (it can carry names).
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

## Not in the panel (yet)

Single-use form handles for one-time pages (a new device token must not be minted twice by a reload) belong to P4-04, which
needs them; relic-bridge keeps them in `kv` with a bounded number of open handles per user (its review finding L6: a handle
written on every GET of a token form let any member spend D1 writes). A browser run (axe-core, keyboard, 320 px, CSP
violations in a real browser) is P4-08.
