// SPDX-License-Identifier: Apache-2.0
// The `/admin` sub-app (P4-03). Built lazily by `@agility-bridge/http-app` whenever sign-in is configured, so a request
// that never opens the panel never loads or builds it.
//
//   GET /admin                     overview (any signed-in role)
//   GET /admin/account             the signed-in person's session and two small forms (any role; the name form: owners)
//   GET /admin/assets/:file        static assets (public, hashed names, immutable)
//   ALL /admin/*                   signed-in 404 page (everyone else: sign-in redirect)
//
// Screens (P4-04 and later) add their routes in `registerScreens` with `kit.page` / `kit.form` and an entry in `NAV_ITEMS`.
import { Hono } from 'hono';
import { ASSET_CACHE_CONTROL, findAsset } from './assets.ts';
import { type AdminUiDeps, createUiKit, requestIdOf, type UiKit } from './kit.ts';
import { errorPage } from './pages.tsx';
import { registerAccount } from './screens/account.tsx';
import { registerOverview } from './screens/overview.tsx';

/** Where the panel is mounted. */
export const ADMIN_UI_BASE: '/admin' = '/admin';

/** Every screen's routes. Add new screens here, before the catch-all. */
function registerScreens(ui: Hono, kit: UiKit): void {
  registerOverview(ui, kit);
  registerAccount(ui, kit);
}

/** The panel's routes, relative to {@link ADMIN_UI_BASE} (mount it with `app.route(ADMIN_UI_BASE, createAdminUi(deps))`). */
export function createAdminUi(deps: AdminUiDeps): Hono {
  const kit = createUiKit(deps);
  const ui = new Hono();

  ui.get('/assets/:file', (c) => {
    const asset = findAsset(c.req.param('file'));
    if (asset === undefined) return errorPage(404, requestIdOf(c));
    return new Response(asset.body, {
      headers: { 'Content-Type': asset.type, 'Cache-Control': ASSET_CACHE_CONTROL },
    });
  });

  registerScreens(ui, kit);

  // Anything else under /admin: sign-in first (no page names leak to strangers), then a 404 page.
  ui.all(
    '/*',
    kit.page('member', (c, page) => errorPage(404, requestIdOf(c), page.principal)),
  );

  ui.onError((error, c) => {
    try {
      deps.onError?.(c, error);
    } catch {
      // never let logging change the answer
    }
    return errorPage(500, requestIdOf(c));
  });

  return ui;
}
