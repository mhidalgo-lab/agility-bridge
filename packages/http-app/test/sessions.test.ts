// SPDX-License-Identifier: Apache-2.0
// Admin sessions over HTTP (P4-02, THREAT_MODEL T13, T14): the cookie, rotation, CSRF and fetch-metadata checks, roles
// through real sessions, re-authentication, logout and what a disabled or demoted user loses. Local fake IdP, no network.
import {
  AdminTokenVerifier,
  createIdentityProviders,
  EMPTY_LOGIN_POLICY,
  generateAdminToken,
} from '@agility-bridge/auth';
import { Secret } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { type FakeOidc, fakeOidc, route } from '../../auth/test/helpers/fake-idp.ts';
import {
  ADMIN_BASE,
  adminAuthenticator,
  adminTokenAuthenticator,
  CLEAR_SITE_DATA_VALUE,
  type SessionOptions,
} from '../src/index.ts';
import { type World, world } from './helpers/world.ts';

const MIN = 60_000;
const ISSUER = 'https://login.example.test';

interface Opts {
  publicUrl?: string;
  session?: SessionOptions;
}

async function setup(options: Opts = {}) {
  const publicUrl = options.publicUrl ?? 'http://127.0.0.1:8787';
  const host = new URL(publicUrl).host;
  const secure = publicUrl.startsWith('https:');
  const cookieName = secure ? '__Host-ab_session' : 'ab_session';
  const idp: FakeOidc = await fakeOidc({ issuer: ISSUER });
  const providers = createIdentityProviders(
    {
      providers: [
        {
          kind: 'oidc',
          name: 'corp',
          label: 'Corporate login',
          issuer: idp.issuer,
          clientId: idp.clientId,
          clientSecret: new Secret(idp.clientSecret),
        },
      ],
      policy: EMPTY_LOGIN_POLICY,
    },
    { fetch: route(idp.handle) },
  );
  const w: World = await world(
    {
      identity: {
        publicUrl,
        providers,
        policy: EMPTY_LOGIN_POLICY,
        audit: (e) => w.audit.login(e),
        auditAdmin: (c) => w.audit.admin(c),
      },
      publicUrl,
      ...(options.session === undefined ? {} : { session: options.session }),
    },
    { admin: true },
  );
  const send = (
    method: string,
    path: string,
    init: {
      cookie?: string;
      headers?: Record<string, string>;
      body?: unknown;
      form?: string;
      site?: string | null;
    } = {},
  ): Promise<Response> => {
    const unsafe = method !== 'GET';
    const headers: Record<string, string> = {
      host,
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    };
    // A browser's own request: same-origin, with an Origin on unsafe methods.
    if (init.site !== null) headers['sec-fetch-site'] = init.site ?? 'same-origin';
    if (unsafe && init.site !== null) headers['origin'] = publicUrl;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    Object.assign(headers, init.headers);
    return Promise.resolve(
      w.app.fetch(
        new Request(`${publicUrl}${path}`, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          ...(init.form === undefined ? {} : { body: init.form }),
        }),
      ),
    );
  };
  const cookieOf = (res: Response, name = cookieName) => {
    const all = res.headers.getSetCookie();
    const found = all.find((c) => c.startsWith(`${name}=`));
    return found === undefined ? undefined : (found.split(';')[0] as string);
  };
  /** A full sign-in as `email` (a user of the test world); returns the callback response. */
  const signIn = async (
    email: string,
    over: { cookie?: string; claims?: Record<string, unknown>; path?: string } = {},
  ): Promise<Response> => {
    const start = await send('GET', over.path ?? '/auth/login/oidc-corp', {
      ...(over.cookie === undefined ? {} : { cookie: over.cookie }),
      site: 'none',
    });
    if (start.status !== 302) throw new Error(`login did not redirect (${start.status})`);
    const location = new URL(start.headers.get('location') as string);
    const binding = cookieOf(start, secure ? '__Host-ab_login' : 'ab_login') as string;
    const { code, state } = idp.authorize(location, { email, sub: `sub-${email}`, ...over.claims });
    return send('GET', `/auth/callback/oidc-corp?code=${code}&state=${state}`, {
      cookie: [binding, over.cookie].filter(Boolean).join('; '),
      site: 'cross-site',
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
  };
  /** Signs in and returns the cookie and the CSRF token. */
  const session = async (email: string) => {
    const res = await signIn(email);
    const cookie = cookieOf(res);
    if (res.status !== 303 || cookie === undefined) throw new Error(`sign-in failed (${res.status})`);
    const info = await (await send('GET', `${ADMIN_BASE}/session`, { cookie })).json();
    return { cookie, csrf: info.csrfToken as string, res, info };
  };
  const api = (
    method: string,
    path: string,
    s: { cookie: string; csrf?: string },
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    send(method, `${ADMIN_BASE}${path}`, {
      cookie: s.cookie,
      ...(body === undefined ? {} : { body }),
      headers: { ...(s.csrf === undefined ? {} : { 'x-csrf-token': s.csrf }), ...headers },
    });
  const rows = async () => {
    await w.audit.flush();
    return w.storage.audit.query({ limit: 1_000 });
  };
  return { w, idp, send, signIn, session, api, cookieOf, cookieName, publicUrl, host, secure, rows };
}

const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';

describe('the session cookie', () => {
  it('is __Host-, Secure, HttpOnly, SameSite=Lax, Path=/ and without Domain on https', async () => {
    const s = await setup({ publicUrl: 'https://bridge.example.test' });
    const res = await s.signIn(OWNER);
    expect(res.status).toBe(303);
    const header = res.headers.getSetCookie().find((c) => c.startsWith('__Host-ab_session='));
    expect(header).toBeDefined();
    const attrs = (header as string).split('; ').slice(1);
    expect(attrs).toEqual(expect.arrayContaining(['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure']));
    expect(attrs.some((a) => /^domain=/i.test(a))).toBe(false);
    expect(attrs).toContain(`Max-Age=${12 * 3600}`);
    expect(res.headers.get('location')).toBe('/auth/account');
    // The login binding cookie is cleared in the same response.
    expect(res.headers.getSetCookie().some((c) => /^__Host-ab_login=;.*Max-Age=0/.test(c))).toBe(true);
  });

  it('is a plain name without Secure on http loopback', async () => {
    const s = await setup();
    const res = await s.signIn(OWNER);
    const header = res.headers.getSetCookie().find((c) => c.startsWith('ab_session=')) as string;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Secure');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-'))).toBe(false);
  });

  it('holds no secret in storage, logs or audit rows', async () => {
    const s = await setup();
    const { cookie, csrf } = await s.session(OWNER);
    await s.api('GET', '/users', { cookie });
    await s.api('POST', `/users/${s.w.ids.alice}/sessions/revoke`, { cookie, csrf });
    const secret = cookie.split('.')[1] as string;
    const everything = JSON.stringify(await s.rows()) + s.w.logs.join('\n');
    for (const needle of [secret, csrf, cookie]) expect(everything).not.toContain(needle);
    for (const key of await s.w.storage.kv.list('')) {
      expect(key).not.toContain(secret);
      expect((await s.w.storage.kv.get(key)) ?? '').not.toContain(secret);
    }
  });

  it('a cookie named twice, a malformed one and another user id each mean no session', async () => {
    const s = await setup();
    const { cookie } = await s.session(OWNER);
    const value = cookie.split('=')[1] as string;
    const dup = `${s.cookieName}=${value}; ${s.cookieName}=${value}`;
    expect((await s.api('GET', '/users', { cookie: dup })).status).toBe(401);
    expect((await s.api('GET', '/users', { cookie: `${s.cookieName}=garbage` })).status).toBe(401);
    const secret = value.split('.')[1];
    expect((await s.api('GET', '/users', { cookie: `${s.cookieName}=usr_other.${secret}` })).status).toBe(
      401,
    );
    expect((await s.api('GET', '/users', { cookie })).status).toBe(200);
  });
});

describe('lifecycle', () => {
  it('ends after 30 idle minutes, and 12 hours in all however active', async () => {
    const s = await setup();
    const a = await s.session(OWNER);
    s.w.now.t += 29 * MIN;
    expect((await s.api('GET', '/users', a)).status).toBe(200);
    s.w.now.t += 30 * MIN;
    expect((await s.api('GET', '/users', a)).status).toBe(401);

    const b = await s.session(OWNER);
    // Steady activity every 29 minutes keeps it alive up to its absolute end and not beyond it.
    for (let elapsed = 29; elapsed < 12 * 60; elapsed += 29) {
      s.w.now.t += 29 * MIN;
      expect((await s.api('GET', '/users', b)).status, `${elapsed} min`).toBe(200);
    }
    s.w.now.t += 29 * MIN;
    expect((await s.api('GET', '/users', b)).status).toBe(401);
  });

  it('honours AB_SESSION_* style timeouts and the cap per user', async () => {
    const s = await setup({
      session: { timeouts: { idleMs: 10 * MIN, absoluteMs: 60 * MIN }, maxPerUser: 2 },
    });
    const a = await s.session(OWNER);
    s.w.now.t += 1_000;
    const b = await s.session(OWNER);
    s.w.now.t += 1_000;
    const c = await s.session(OWNER);
    expect((await s.api('GET', '/users', a)).status).toBe(401); // the oldest went
    expect((await s.api('GET', '/users', b)).status).toBe(200);
    expect((await s.api('GET', '/users', c)).status).toBe(200);
    s.w.now.t += 11 * MIN;
    expect((await s.api('GET', '/users', c)).status).toBe(401);
  });

  it('rotates at sign-in: the presented cookie dies, a planted one cannot be fixed on a victim', async () => {
    const s = await setup();
    const attacker = await s.session(ALICE); // the attacker's own session, planted in the victim's browser
    const res = await s.signIn(OWNER, { cookie: attacker.cookie });
    const fresh = s.cookieOf(res) as string;
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(attacker.cookie);
    expect((await s.api('GET', '/users', attacker)).status).toBe(401);
    expect((await s.api('GET', '/users', { cookie: fresh })).status).toBe(200);
    const rows = await s.rows();
    const created = rows.filter((r) => r.action === 'session.create');
    expect(created.map((r) => (r.details as { rotated: boolean }).rotated).sort()).toEqual([false, true]);
  });

  it('audits session start, logout and end-all without secrets', async () => {
    const s = await setup();
    const a = await s.session(OWNER);
    await s.session(OWNER);
    const out = await s.api('POST', `/users/${s.w.ids.owner}/sessions/revoke`, a);
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true, revoked: 2 });
    const rows = await s.rows();
    expect(rows.filter((r) => r.action === 'session.create')).toHaveLength(2);
    const revoke = rows.find((r) => r.action === 'session.revoke_all');
    expect(revoke?.status).toBe('ok');
    expect(revoke?.userId).toBe(s.w.ids.owner);
    expect(rows.find((r) => r.action === 'login.ok')).toBeDefined();
  });
});

describe('CSRF and request origin', () => {
  const target = (s: Awaited<ReturnType<typeof setup>>) => `/users/${s.w.ids.owner}/sessions/revoke`;

  it('accepts a change with the token from GET /session and refuses without it, with no side effect', async () => {
    const s = await setup();
    const a = await s.session(OWNER);
    for (const csrf of [undefined, 'wrong', 'x'.repeat(43), `${a.csrf}x`]) {
      const res = await s.api('POST', target(s), {
        cookie: a.cookie,
        ...(csrf === undefined ? {} : { csrf }),
      });
      expect(res.status, String(csrf)).toBe(403);
      expect((await res.json()).error.code).toBe('forbidden');
    }
    expect((await s.api('GET', '/users', a)).status).toBe(200); // the session is untouched
    expect((await s.api('POST', target(s), a)).status).toBe(200);
    expect((await s.api('GET', '/users', a)).status).toBe(401);
    const denied = (await s.rows()).filter((r) => r.action === 'admin.forbidden');
    expect(denied.length).toBe(4);
    expect(denied.every((r) => (r.details as { reason: string }).reason === 'csrf')).toBe(true);
  });

  it('refuses every unsafe method with a foreign Origin, Origin null or cross-site fetch metadata', async () => {
    const s = await setup();
    const a = await s.session(OWNER);
    const tries: Array<[string, Record<string, string>, string | null]> = [
      ['foreign origin', { origin: 'https://evil.example' }, 'same-origin'],
      ['origin null', { origin: 'null' }, 'same-origin'],
      ['cross-site', {}, 'cross-site'],
      ['same-site', {}, 'same-site'],
      ['none (typed url)', {}, 'none'],
      ['no metadata at all', { origin: '' }, null],
    ];
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      for (const [label, headers, site] of tries) {
        const h = { ...headers };
        if (h['origin'] === '') delete h['origin'];
        const res = await s.send(
          method,
          `${ADMIN_BASE}${method === 'POST' ? target(s) : `/users/${s.w.ids.alice}`}`,
          {
            cookie: a.cookie,
            site,
            body: method === 'POST' ? undefined : { role: 'member' },
            headers: { 'x-csrf-token': a.csrf, ...(site === null ? {} : {}), ...h },
          },
        );
        expect([401, 403], `${method} ${label}`).toContain(res.status);
        expect(res.status, `${method} ${label}`).not.toBe(200);
      }
    }
    // Nothing happened: the session lives, Alice is unchanged.
    expect((await s.api('GET', '/users', a)).status).toBe(200);
    expect((await s.w.storage.users.get(s.w.ids.alice))?.role).toBe('member');
  });

  it('a cross-site navigation may open a page, a cross-site fetch may not read', async () => {
    const s = await setup();
    const a = await s.session(OWNER);
    const nav = await s.send('GET', `${ADMIN_BASE}/session`, {
      cookie: a.cookie,
      site: 'cross-site',
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    expect(nav.status).toBe(200);
    for (const mode of ['cors', 'no-cors', 'same-origin']) {
      const res = await s.send('GET', `${ADMIN_BASE}/session`, {
        cookie: a.cookie,
        site: 'cross-site',
        headers: { 'sec-fetch-mode': mode, 'sec-fetch-dest': 'empty' },
      });
      expect(res.status, mode).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain(a.csrf);
    }
    const sameSite = await s.send('GET', `${ADMIN_BASE}/session`, { cookie: a.cookie, site: 'same-site' });
    expect(sameSite.status).toBe(403);
  });

  it('a cookie request needs no CSRF token on GET, and the token is bound to its own session', async () => {
    const s = await setup();
    const a = await s.session(OWNER);
    const b = await s.session(ADMIN);
    expect((await s.api('GET', '/users', a)).status).toBe(200);
    const res = await s.api('POST', `/users/${s.w.ids.admin}/sessions/revoke`, {
      cookie: b.cookie,
      csrf: a.csrf,
    });
    expect(res.status).toBe(403);
    expect((await s.api('GET', '/users', b)).status).toBe(200);
  });

  it('the break-glass token needs no CSRF, and a wrong token never falls back to a valid cookie', async () => {
    const token = generateAdminToken();
    const s = await setup();
    const verifier = await AdminTokenVerifier.create(token);
    // Build an authenticator the way the server does and probe it directly with real requests.
    const { createSessionManager } = await import('../src/index.ts');
    const sessions = createSessionManager({
      publicUrl: s.publicUrl,
      storage: s.w.storage,
      clock: { now: () => s.w.now.t },
      runInBackground: () => {},
    });
    const authenticate = adminAuthenticator({ token: adminTokenAuthenticator(verifier), sessions });
    const a = await s.session(OWNER);
    const ctx = (headers: Record<string, string>, method = 'POST') => {
      const store = new Map<string, unknown>();
      return {
        req: {
          header: (n: string) => headers[n.toLowerCase()],
          method,
          url: `${s.publicUrl}${ADMIN_BASE}/users`,
        },
        set: (k: string, v: unknown) => store.set(k, v),
      } as never;
    };
    const cookieHeaders = {
      host: s.host,
      cookie: a.cookie,
      'sec-fetch-site': 'same-origin',
      origin: s.publicUrl,
    };
    expect(await authenticate(ctx({ ...cookieHeaders, authorization: `Bearer ${token}` }))).toEqual({
      kind: 'break_glass',
    });
    expect(
      await authenticate(ctx({ ...cookieHeaders, authorization: `Bearer ${generateAdminToken()}` })),
    ).toBeNull();
    expect(await authenticate(ctx({ ...cookieHeaders, authorization: 'Basic abc' }))).toBeNull();
    expect(await authenticate(ctx(cookieHeaders))).toMatchObject({ kind: 'refused', reason: 'csrf' });
    expect(await authenticate(ctx({ ...cookieHeaders, 'x-csrf-token': a.csrf }))).toMatchObject({
      kind: 'user',
    });
  });
});

describe('roles through real sessions', () => {
  it('a member sees only themselves and cannot reach owner or admin routes', async () => {
    const s = await setup();
    const m = await s.session(ALICE);
    const list = await (await s.api('GET', '/users', m)).json();
    expect(list.map((u: { id: string }) => u.id)).toEqual([s.w.ids.alice]);
    expect((await s.api('GET', `/users/${s.w.ids.owner}`, m)).status).toBe(404);
    expect((await s.api('GET', '/audit', m)).status).toBe(403);
    expect((await s.api('GET', '/keys', m)).status).toBe(403);
    const before = (await s.w.storage.users.list()).length;
    const created = await s.api('POST', '/users', m, { email: 'new@example.test', role: 'member' });
    expect(created.status).toBe(403);
    expect((await s.w.storage.users.list()).length).toBe(before);
    expect((await s.api('GET', '/session', m)).status).toBe(200);
    expect(((await (await s.api('GET', '/session', m)).json()) as { user: { role: string } }).user.role).toBe(
      'member',
    );
  });

  it('an admin manages members only, an owner everyone, and nobody manages /keys but owners', async () => {
    const s = await setup();
    const adm = await s.session(ADMIN);
    expect((await s.api('GET', '/keys', adm)).status).toBe(403);
    expect((await s.api('POST', '/users', adm, { email: 'n1@example.test', role: 'member' })).status).toBe(
      201,
    );
    for (const body of [
      { email: 'n2@example.test', role: 'admin' },
      { email: 'n3@example.test', role: 'owner' },
    ]) {
      expect((await s.api('POST', '/users', adm, body)).status).toBe(403);
    }
    expect((await s.api('PATCH', `/users/${s.w.ids.alice}`, adm, { role: 'admin' })).status).toBe(403);
    expect((await s.api('PATCH', `/users/${s.w.ids.owner}`, adm, { role: 'member' })).status).toBe(403);
    expect((await s.api('POST', `/users/${s.w.ids.owner}/disable`, adm)).status).toBe(403);
    expect((await s.api('POST', `/users/${s.w.ids.admin}/disable`, adm)).status).toBe(403);
    expect((await s.w.storage.users.get(s.w.ids.owner))?.role).toBe('owner');
    expect((await s.w.storage.users.get(s.w.ids.owner))?.disabledAt).toBeNull();

    const own = await s.session(OWNER);
    expect((await s.api('GET', '/keys', own)).status).toBe(200);
    expect((await s.api('PATCH', `/users/${s.w.ids.alice}`, own, { role: 'admin' })).status).toBe(200);
  });

  it('never demotes or disables the last owner, and a second owner makes it possible', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    const demote = await s.api('PATCH', `/users/${s.w.ids.owner}`, own, { role: 'admin' });
    expect(demote.status).toBe(403);
    const disable = await s.api('POST', `/users/${s.w.ids.owner}/disable`, own);
    expect(disable.status).toBe(403);
    expect((await s.w.storage.users.get(s.w.ids.owner))?.role).toBe('owner');
    expect((await s.api('GET', '/users', own)).status).toBe(200);
    expect((await s.api('PATCH', `/users/${s.w.ids.alice}`, own, { role: 'owner' })).status).toBe(200);
    expect((await s.api('PATCH', `/users/${s.w.ids.owner}`, own, { role: 'member' })).status).toBe(200);
  });

  it('a disabled user loses the session on the next request, and enabling again does not revive it', async () => {
    const s = await setup();
    const a = await s.session(ALICE);
    const own = await s.session(OWNER);
    expect((await s.api('GET', '/users', a)).status).toBe(200);
    expect((await s.api('POST', `/users/${s.w.ids.alice}/disable`, own)).status).toBe(200);
    expect((await s.api('GET', '/users', a)).status).toBe(401);
    await s.w.storage.users.update(s.w.ids.alice, { disabledAt: null });
    expect((await s.api('GET', '/users', a)).status).toBe(401);
    expect(await s.w.storage.kv.list(`sess:${s.w.ids.alice}:`)).toEqual([]);
  });

  it('a user disabled behind the API (database) is refused and the session deleted', async () => {
    const s = await setup();
    const a = await s.session(ALICE);
    await s.w.storage.users.update(s.w.ids.alice, { disabledAt: s.w.now.t });
    expect((await s.api('GET', '/users', a)).status).toBe(401);
    expect(await s.w.storage.kv.list(`sess:${s.w.ids.alice}:`)).toEqual([]);
    await s.w.storage.users.update(s.w.ids.alice, { disabledAt: null });
    expect((await s.api('GET', '/users', a)).status).toBe(401);
  });

  it('a role change takes effect on the next request, with no stale role in the session', async () => {
    const s = await setup();
    const adm = await s.session(ADMIN);
    expect((await s.api('GET', '/audit', adm)).status).toBe(200);
    await s.w.storage.users.update(s.w.ids.admin, { role: 'member' }); // behind the API: sessions not ended
    expect((await s.api('GET', '/audit', adm)).status).toBe(403);
    expect(
      ((await (await s.api('GET', '/session', adm)).json()) as { user: { role: string } }).user.role,
    ).toBe('member');
  });

  it("changing a role through the API ends the user's sessions", async () => {
    const s = await setup();
    const a = await s.session(ALICE);
    const own = await s.session(OWNER);
    expect((await s.api('PATCH', `/users/${s.w.ids.alice}`, own, { role: 'admin' })).status).toBe(200);
    expect((await s.api('GET', '/users', a)).status).toBe(401);
    const reasons = (await s.rows())
      .filter((r) => r.action === 'session.revoke_all')
      .map((r) => (r.details as { reason: string }).reason);
    expect(reasons).toContain('role_change');
  });
});

describe('ending sessions', () => {
  it('yourself, any role; an owner anyone; an admin members only; a member nobody else', async () => {
    const s = await setup();
    const m = await s.session(ALICE);
    const m2 = await s.session(BOB);
    const adm = await s.session(ADMIN);
    const own = await s.session(OWNER);
    const end = (who: { cookie: string; csrf: string }, id: string) =>
      s.api('POST', `/users/${id}/sessions/revoke`, who);

    expect((await end(m, s.w.ids.owner)).status).toBe(404); // no existence oracle
    expect((await end(adm, s.w.ids.owner)).status).toBe(403);
    expect((await end(adm, s.w.ids.admin)).status).toBe(200); // itself: ends adm's own session
    expect((await s.api('GET', '/users', adm)).status).toBe(401);
    const adm2 = await s.session(ADMIN);
    expect((await end(adm2, s.w.ids.alice)).status).toBe(200);
    expect((await s.api('GET', '/users', m)).status).toBe(401);
    expect((await end(own, s.w.ids.admin)).status).toBe(200);
    expect((await s.api('GET', '/users', adm2)).status).toBe(401);
    expect((await s.api('GET', '/users', m2)).status).toBe(200); // Bob's session was never touched
    expect((await end(own, 'usr_missing')).status).toBe(404);
    // Denied calls ended nothing.
    const again = await s.session(ADMIN);
    expect((await end(again, s.w.ids.owner)).status).toBe(403);
    expect((await s.api('GET', '/users', own)).status).toBe(200);
    expect((await s.api('GET', '/users', again)).status).toBe(200);
    const denied = (await s.rows()).filter((r) => r.action === 'session.revoke_all' && r.status === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });
});

describe('re-authentication', () => {
  const adminUser = { email: 'newadmin@example.test', role: 'admin' };

  it('is recent for ten minutes after the sign-in, not a second more', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    expect(own.info.recentAuth).toBe(true);
    s.w.now.t += 10 * MIN - 1_000;
    expect((await s.api('GET', '/session', own)).status).toBe(200); // keep the idle clock alive
    expect(((await (await s.api('GET', '/session', own)).json()) as { recentAuth: boolean }).recentAuth).toBe(
      true,
    );
    expect((await s.api('POST', '/users', own, adminUser)).status).toBe(201);
    s.w.now.t += 1_000; // exactly ten minutes
    expect(((await (await s.api('GET', '/session', own)).json()) as { recentAuth: boolean }).recentAuth).toBe(
      false,
    );
    const res = await s.api('POST', '/users', own, { ...adminUser, email: 'two@example.test' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('reauth_required');
    expect(await s.w.storage.users.getByEmail('two@example.test')).toBeNull();
  });

  it('guards every high-impact action, and leaves ordinary changes alone', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    s.w.now.t += 11 * MIN;
    const refused: Array<[string, string, unknown]> = [
      ['POST', '/users', adminUser],
      ['PATCH', `/users/${s.w.ids.admin}`, { role: 'member' }],
      ['POST', `/users/${s.w.ids.admin}/disable`, undefined],
      ['PATCH', `/users/${s.w.ids.alice}`, { role: 'admin' }],
      ['POST', `/instances/${s.w.ids.instance}/retarget`, { baseUrl: 'https://other.example.test' }],
      ['POST', '/keys/1/retire', { reason: 'test' }],
      ['POST', '/setup-links', {}],
      ['PATCH', `/workspaces/${s.w.ids.workspaceA}`, { writePolicy: { enabled: true } }],
    ];
    for (const [method, path, body] of refused) {
      const res = await s.api(method, path, own, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code, `${method} ${path}`).toBe(
        'reauth_required',
      );
    }
    // Ordinary changes need no recent sign-in.
    expect((await s.api('POST', '/users', own, { email: 'plain@example.test', role: 'member' })).status).toBe(
      201,
    );
    expect((await s.api('GET', '/users', own)).status).toBe(200);
    expect((await s.w.storage.users.get(s.w.ids.admin))?.role).toBe('admin');
  });

  it('GET /auth/reauth asks the IdP for a fresh login and returns to the action with a new session', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    s.w.now.t += 11 * MIN;
    expect((await s.api('POST', '/users', own, adminUser)).status).toBe(403);
    const start = await s.send('GET', '/auth/reauth?next=%2Fauth%2Faccount%3Fdone%3D1', {
      cookie: own.cookie,
      site: 'none',
    });
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location') as string);
    expect(location.searchParams.get('prompt')).toBe('login');
    expect(location.searchParams.get('max_age')).toBe('0');
    const binding = s.cookieOf(start, 'ab_login') as string;
    const { code, state } = s.idp.authorize(location, {
      email: OWNER,
      sub: `sub-${OWNER}`,
    });
    // The owner's identity is already bound by the first sign-in.
    const done = await s.send('GET', `/auth/callback/oidc-corp?code=${code}&state=${state}`, {
      cookie: `${binding}; ${own.cookie}`,
      site: 'cross-site',
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/auth/account?done=1');
    const fresh = s.cookieOf(done) as string;
    expect(fresh).toBeDefined();
    expect((await s.api('GET', '/users', own)).status).toBe(401); // rotated
    const next = {
      cookie: fresh,
      csrf: (await (await s.send('GET', `${ADMIN_BASE}/session`, { cookie: fresh })).json()).csrfToken,
    };
    expect((await s.api('POST', '/users', next, adminUser)).status).toBe(201);
    const rows = await s.rows();
    expect(
      rows.some((r) => r.action === 'login.ok' && (r.details as { outcome?: string }).outcome === 'reauth'),
    ).toBe(true);
    expect(
      rows.some((r) => r.action === 'session.create' && (r.details as { via?: string }).via === 'reauth'),
    ).toBe(true);
  });

  it('refuses a re-authentication by another person, and keeps the old session as it was', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    await s.session(ALICE); // Alice's identity is bound
    const start = await s.send('GET', '/auth/reauth', { cookie: own.cookie, site: 'none' });
    const location = new URL(start.headers.get('location') as string);
    const binding = s.cookieOf(start, 'ab_login') as string;
    const { code, state } = s.idp.authorize(location, { email: ALICE, sub: `sub-${ALICE}` });
    const done = await s.send('GET', `/auth/callback/oidc-corp?code=${code}&state=${state}`, {
      cookie: `${binding}; ${own.cookie}`,
      site: 'cross-site',
    });
    expect(done.status).toBe(403);
    expect(s.cookieOf(done)).toBeUndefined();
    expect((await s.api('GET', '/users', own)).status).toBe(200);
    const reasons = (await s.rows())
      .filter((r) => r.action === 'login.denied')
      .map((r) => (r.details as { reason: string }).reason);
    expect(reasons).toContain('reauth_mismatch');
  });

  it('a reauthentication creates no user and binds no identity, even for an allowed stranger', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    const before = (await s.w.storage.users.list()).length;
    const start = await s.send('GET', '/auth/reauth', { cookie: own.cookie, site: 'none' });
    const location = new URL(start.headers.get('location') as string);
    const binding = s.cookieOf(start, 'ab_login') as string;
    const { code, state } = s.idp.authorize(location, { email: 'stranger@example.test', sub: 'stranger' });
    const done = await s.send('GET', `/auth/callback/oidc-corp?code=${code}&state=${state}`, {
      cookie: `${binding}; ${own.cookie}`,
      site: 'cross-site',
    });
    expect(done.status).toBe(403);
    expect((await s.w.storage.users.list()).length).toBe(before);
  });

  it('refuses an auth_time the IdP reports as old, and accepts a fresh one', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    const attempt = async (authTime: number) => {
      const start = await s.send('GET', '/auth/reauth', { cookie: own.cookie, site: 'none' });
      const location = new URL(start.headers.get('location') as string);
      const binding = s.cookieOf(start, 'ab_login') as string;
      const { code, state } = s.idp.authorize(location, {
        email: OWNER,
        sub: `sub-${OWNER}`,
        auth_time: authTime,
      });
      return s.send('GET', `/auth/callback/oidc-corp?code=${code}&state=${state}`, {
        cookie: `${binding}; ${own.cookie}`,
        site: 'cross-site',
      });
    };
    const nowSeconds = Math.floor(s.w.now.t / 1000);
    const stale = await attempt(nowSeconds - 11 * 60);
    expect(stale.status).toBe(403);
    expect(s.cookieOf(stale)).toBeUndefined();
    const reasons = (await s.rows())
      .filter((r) => r.action === 'login.denied')
      .map((r) => (r.details as { reason: string }).reason);
    expect(reasons).toContain('reauth_stale');
    expect((await attempt(nowSeconds - 5)).status).toBe(303);
  });

  it('without a session it sends the browser to sign in, and a cross-site fetch is refused', async () => {
    const s = await setup();
    const res = await s.send('GET', '/auth/reauth?next=%2Fx', { site: 'none' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/login?next=%2Fx');
    const own = await s.session(OWNER);
    const cross = await s.send('GET', '/auth/reauth', {
      cookie: own.cookie,
      site: 'cross-site',
      headers: { 'sec-fetch-mode': 'cors' },
    });
    expect(cross.status).toBe(403);
    expect(await s.w.storage.kv.list('login:')).toEqual([]);
  });
});

describe('logout and the account page', () => {
  it('shows the CSRF token on the account page only to its own session, with no referrer loss', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    const res = await s.send('GET', '/auth/account', { cookie: own.cookie, site: 'none' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(own.csrf);
    expect(html).toContain('owner@example.test');
    expect(html).toContain('action="/auth/logout"');
    expect(html).not.toMatch(/<script/i);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const anon = await s.send('GET', '/auth/account', { site: 'none' });
    expect(anon.status).toBe(303);
    expect(await anon.text()).not.toContain(own.csrf);
    const cross = await s.send('GET', '/auth/account', {
      cookie: own.cookie,
      site: 'cross-site',
      headers: { 'sec-fetch-mode': 'no-cors' },
    });
    expect(cross.status).toBe(403);
    expect(await cross.text()).not.toContain(own.csrf);
  });

  it('is POST only: a GET changes nothing', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await s.send(method, '/auth/logout', { cookie: own.cookie, site: 'none' });
      expect([404, 405], method).toContain(res.status);
    }
    expect((await s.api('GET', '/users', own)).status).toBe(200);
  });

  it('needs the CSRF token and a same-origin request, and a cross-site form changes nothing', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    const form = (token: string) => `_csrf=${encodeURIComponent(token)}`;
    for (const init of [
      { form: '' },
      { form: form('wrong') },
      { form: form(own.csrf), site: 'cross-site' },
      { form: form(own.csrf), headers: { origin: 'https://evil.example' } },
      { form: form(own.csrf), headers: { origin: 'null' } },
      { form: form(own.csrf), site: 'none' },
    ]) {
      const res = await s.send('POST', '/auth/logout', { cookie: own.cookie, ...init });
      expect(res.status, JSON.stringify(init)).toBe(403);
      expect(res.headers.get('clear-site-data')).toBeNull();
    }
    // A cross-site form from a browser carries no SameSite=Lax cookie: nothing is cleared or revoked.
    const anon = await s.send('POST', '/auth/logout', { form: form(own.csrf), site: 'cross-site' });
    expect(anon.status).toBe(200);
    expect(anon.headers.get('set-cookie')).toBeNull();
    expect(anon.headers.get('clear-site-data')).toBeNull();
    expect((await s.api('GET', '/users', own)).status).toBe(200);
  });

  it('deletes the session, clears the cookie and sends Clear-Site-Data: "cookies"', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    const res = await s.send('POST', '/auth/logout', { cookie: own.cookie, form: `_csrf=${own.csrf}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('clear-site-data')).toBe('"cookies"');
    expect(CLEAR_SITE_DATA_VALUE).toBe('"cookies"');
    const clear = res.headers.getSetCookie().find((c) => c.startsWith('ab_session='));
    expect(clear).toMatch(/Max-Age=0/);
    expect((await s.api('GET', '/users', own)).status).toBe(401);
    expect(await s.w.storage.kv.list(`sess:${s.w.ids.owner}:`)).toEqual([]);
    const row = (await s.rows()).find((r) => r.action === 'session.revoke');
    expect(row?.userId).toBe(s.w.ids.owner);
    // The same cookie again: not signed in, nothing to protect, the cookie is dropped.
    const again = await s.send('POST', '/auth/logout', { cookie: own.cookie, form: `_csrf=${own.csrf}` });
    expect(again.status).toBe(200);
    expect(again.headers.get('clear-site-data')).toBeNull();
  });

  it('also accepts the token in the header, and everywhere=1 ends every session of the user', async () => {
    const s = await setup();
    const a = await s.session(OWNER);
    const b = await s.session(OWNER);
    const other = await s.session(ALICE);
    const res = await s.send('POST', '/auth/logout', {
      cookie: a.cookie,
      form: 'everywhere=1',
      headers: { 'x-csrf-token': a.csrf },
    });
    expect(res.status).toBe(200);
    expect((await s.api('GET', '/users', a)).status).toBe(401);
    expect((await s.api('GET', '/users', b)).status).toBe(401);
    expect((await s.api('GET', '/users', other)).status).toBe(200);
    expect((await s.rows()).some((r) => r.action === 'session.revoke_all')).toBe(true);
  });

  it('Clear-Site-Data can be switched off (it clears the whole registrable domain)', async () => {
    const s = await setup({ session: { clearSiteData: false } });
    const own = await s.session(OWNER);
    const res = await s.send('POST', '/auth/logout', { cookie: own.cookie, form: `_csrf=${own.csrf}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('clear-site-data')).toBeNull();
    expect(res.headers.getSetCookie().some((c) => /Max-Age=0/.test(c))).toBe(true);
    expect((await s.api('GET', '/users', own)).status).toBe(401);
  });
});
