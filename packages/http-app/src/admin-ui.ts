// SPDX-License-Identifier: Apache-2.0
// The admin panel's view of the server (P4-03, THREAT_MODEL T13/T14): the P4-02 session manager and the admin API, handed
// to `@agility-bridge/admin-ui` through its structural `AdminUiDeps`. The panel package never sees storage, the session
// record or a secret: pages get a `UiPrincipal` (what they show, plus the CSRF token their forms embed) and change things
// only through `callAdmin`, which runs the admin API's own app in-process with the caller's session. Web-standard only
// (ADR-0004).
import type { AdminCall, AdminCallResult, AdminUiDeps, UiPrincipal } from '@agility-bridge/admin-ui';
import type { KvStore } from '@agility-bridge/storage';
import type { Context } from 'hono';
import { ADMIN_BASE } from './admin/api.ts';
import type { AdminChange } from './audit.ts';
import type { SessionManager, SessionPrincipal } from './session.ts';

/** Where the panel is mounted. */
export const ADMIN_UI_BASE = '/admin';

/** The panel module, loaded on first use (never by an MCP request: P3-14, L-182). */
export type AdminUiModule = typeof import('@agility-bridge/admin-ui');
export const loadAdminUiModule = (): Promise<AdminUiModule> => import('@agility-bridge/admin-ui');

/** Headers that carry the client address to the per-IP limits; copied onto in-process admin API calls. */
const CLIENT_ADDRESS_HEADERS = ['cf-connecting-ip', 'x-forwarded-for'] as const;

export interface AdminUiWiring {
  readonly sessions: SessionManager;
  /** Single-use form handles (the one-time device token page) live here (P4-04); `take` is atomic (L-073). */
  readonly kv: KvStore;
  /** `AB_PUBLIC_URL`'s origin. */
  readonly publicOrigin: string;
  readonly now: () => number;
  /** Records a refused panel request (`admin.forbidden`); its work is kept alive with `runInBackground`. */
  readonly audit?: (change: AdminChange) => Promise<void> | undefined;
  readonly runInBackground: (c: Context, work: Promise<unknown>) => void;
  /** The per-IP limit before a session is looked up; a Response stops the request. */
  readonly beforeAuth?: (c: Context) => Promise<Response | undefined> | Response | undefined;
  /** An unexpected panel error, logged by name only. */
  readonly onError: (c: Context, error: unknown) => void;
  /** The admin API app, in-process (absent: the admin API is not mounted and every call is a 404). */
  readonly callApi?: (request: Request, c: Context) => Response | Promise<Response>;
}

export function adminUiDeps(w: AdminUiWiring): AdminUiDeps {
  const { sessions } = w;
  // The session each principal came from, keyed weakly by the (frozen) object the pages get.
  const origins = new WeakMap<UiPrincipal, SessionPrincipal>();
  const toUi = (p: SessionPrincipal): UiPrincipal => {
    const ui: UiPrincipal = Object.freeze({
      userId: p.user.id,
      email: p.user.email,
      displayName: p.user.displayName,
      role: p.role,
      csrf: p.session.record.csrf,
      recentAuth: p.recentAuth,
      expiresAt: p.session.record.expiresAt,
      idleExpiresAt: p.session.idleExpiresAt,
    });
    origins.set(ui, p);
    return ui;
  };
  const sessionOf = (ui: UiPrincipal): SessionPrincipal => {
    const p = origins.get(ui);
    if (p === undefined) throw new TypeError('unknown admin UI principal');
    return p;
  };
  const requestId = (c: Context): string | null =>
    (c.get('requestId' as never) as string | undefined) ?? null;

  return {
    now: w.now,
    secureCookies: w.publicOrigin.startsWith('https:'),
    clearSessionCookie: sessions.clearCookie,
    ...(w.beforeAuth === undefined ? {} : { beforeAuth: w.beforeAuth }),
    onceStore: {
      put: (key, ttlSeconds) => w.kv.set(key, '1', { expiresAt: w.now() + ttlSeconds * 1000 }),
      take: async (key) => (await w.kv.take(key)) !== null,
      list: (prefix, limit) => w.kv.list(prefix, { limit }),
    },

    async authenticate(c) {
      const auth = await sessions.authenticate(c);
      if (auth.ok) return { ok: true, principal: toUi(auth.principal) };
      // `none`: no cookie at all. Anything else is a dead, broken or duplicated cookie, which the page clears.
      return { ok: false, presented: auth.reason !== 'none' };
    },

    checkFetchOrigin: (c, unsafe) => sessions.checkFetchOrigin(c, unsafe),
    csrfMatches: (ui, presented) => sessions.csrfMatches(sessionOf(ui), presented),

    onForbidden(c, ui, reason) {
      const work = w.audit?.({
        requestId: requestId(c),
        action: 'admin.forbidden',
        status: 'denied',
        userId: ui.userId,
        targetType: 'admin_ui',
        targetId: '-',
        errorCode: 'forbidden',
        details: { reason, route: `${c.req.method} ${c.req.path}`.slice(0, 200), role: ui.role },
      });
      if (work !== undefined) w.runInBackground(c, work);
    },

    onError: w.onError,

    async callAdmin(c, ui, call: AdminCall): Promise<AdminCallResult> {
      if (w.callApi === undefined) return { status: 404, body: null };
      const session = sessionOf(ui);
      const url = new URL(`${w.publicOrigin}${ADMIN_BASE}${call.path}`);
      // The path is ours to build, but never let it escape the admin API (`/../`, encoded or not).
      if (
        url.origin !== w.publicOrigin ||
        !url.pathname.startsWith(`${ADMIN_BASE}/`) ||
        url.search !== '' ||
        url.hash !== ''
      ) {
        throw new TypeError('admin UI calls must stay inside the admin API');
      }
      for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v);
      const cookie = sessions.readCookie(c);
      const headers = new Headers({
        accept: 'application/json',
        // Our own page, by construction: the panel checked the form's CSRF token before an unsafe call got here, and
        // the admin API checks the session's token again.
        origin: w.publicOrigin,
        'sec-fetch-site': 'same-origin',
        'x-csrf-token': session.session.record.csrf,
      });
      if (typeof cookie === 'string') headers.set('cookie', `${sessions.cookieName}=${cookie}`);
      for (const name of CLIENT_ADDRESS_HEADERS) {
        const value = c.req.header(name);
        if (value !== undefined) headers.set(name, value);
      }
      let body: string | undefined;
      if (call.body !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(call.body);
      }
      const res = await w.callApi(
        new Request(url, { method: call.method, headers, ...(body === undefined ? {} : { body }) }),
        c,
      );
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      return { status: res.status, body: parsed };
    },
  };
}
