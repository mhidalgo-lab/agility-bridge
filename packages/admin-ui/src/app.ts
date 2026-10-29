// SPDX-License-Identifier: Apache-2.0
// The `/admin` sub-app (P4-03). Built lazily by `@agility-bridge/http-app` whenever sign-in is configured, so a request
// that never opens the panel never loads or builds it.
//
//   GET /admin                     overview (any signed-in role)
//   GET /admin/account             the signed-in person's session and two small forms (any role; the name form: owners)
//   /admin/me/*                    "My access": my personal Agility token, grants and devices (any role, P4-07)
//   /admin/oauth/*                 connected apps of everyone (owner, admin) and registered OAuth apps (owner), P5-08
//   /admin/instances, /credentials, /workspaces, /grants (with their device tokens) and /users: P4-04, owners and admins
//   GET /admin/assets/:file        static assets (public, hashed names, immutable)
//   GET       /admin/approve       the signed-in person's own open requests (P7-14)
//   GET, POST /admin/approve/:id   a write waiting for the person's approval (P7-02; only with write tools on)
//   ALL /admin/*                   signed-in 404 page (everyone else: sign-in redirect)
//
// Screens (P4-04 and later) add their routes in `registerScreens` with `kit.page` / `kit.form` and an entry in `NAV_ITEMS`.
import { Hono } from 'hono';
import { ASSET_CACHE_CONTROL, findAsset } from './assets.ts';
import { type AdminUiDeps, createUiKit, requestIdOf, type UiKit } from './kit.ts';
import { errorPage } from './pages.tsx';
import { registerAccount } from './screens/account.tsx';
import { registerAllTokens } from './screens/all-tokens.tsx';
import { registerApprove } from './screens/approve.tsx';
import { registerAudit } from './screens/audit.tsx';
import { registerCredentials } from './screens/credentials.tsx';
import { registerGrants } from './screens/grants.tsx';
import { registerInstances } from './screens/instances.tsx';
import { registerMe } from './screens/me.tsx';
import { registerOAuthAdmin } from './screens/oauth-admin.tsx';
import { registerOverview } from './screens/overview.tsx';
import { registerTokens } from './screens/tokens.tsx';
import { registerUsage } from './screens/usage.tsx';
import { registerUsers } from './screens/users.tsx';
import { registerWorkspaces } from './screens/workspaces.tsx';

/** Where the panel is mounted. */
export const ADMIN_UI_BASE: '/admin' = '/admin';

/** Every screen's routes. Add new screens here, before the catch-all. */
function registerScreens(ui: Hono, kit: UiKit): void {
  registerOverview(ui, kit);
  registerAccount(ui, kit);
  registerMe(ui, kit);
  registerInstances(ui, kit);
  registerCredentials(ui, kit);
  registerWorkspaces(ui, kit);
  registerGrants(ui, kit);
  registerTokens(ui, kit);
  registerAllTokens(ui, kit);
  registerOAuthAdmin(ui, kit);
  registerUsers(ui, kit);
  registerAudit(ui, kit);
  registerUsage(ui, kit);
  registerApprove(ui, kit);
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
