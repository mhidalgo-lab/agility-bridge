// SPDX-License-Identifier: Apache-2.0
// The admin panel over HTTP (P4-03, THREAT_MODEL T13, T14): headers on every page, who gets in, form refusals that change
// nothing, changes that go through the admin API (same audit rows), and the re-authentication round trip. Real sessions
// and a local fake identity provider; no network.
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, UI_ROLE_RANK } from '../../admin-ui/src/index.ts';
import { MIN, setup } from './helpers/panel.ts';

const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const ALICE = 'alice@example.test';

/** The panel's policy, spelled out here as a literal (a test that imports the constant it checks cannot fail). */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'";
const PERMISSIONS =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';
const FORM = 'application/x-www-form-urlencoded';

type S = Awaited<ReturnType<typeof setup>>;
type Session = { cookie: string; csrf: string };

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const page = (s: S, path: string, session: Session | undefined, headers: Record<string, string> = {}) =>
  s.send('GET', path, {
    ...(session === undefined ? {} : { cookie: session.cookie }),
    site: 'none',
    headers,
  });
const submit = (
  s: S,
  path: string,
  session: Session,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  s.send('POST', path, { cookie: session.cookie, form: form({ _csrf: session.csrf, ...fields }), headers });

/** The CSRF token a page embeds for this session. */
const csrfOf = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] as string;

/** Everything a refused request must leave alone: the user row, the live sessions, the audit log. */
async function snapshot(s: S) {
  const users = await s.w.storage.users.list();
  const sessions = (await s.w.storage.kv.list('')).filter((k) => k.startsWith('session'));
  const audit = await s.rows();
  return { users: JSON.stringify(users), sessions: sessions.sort(), auditCount: audit.length };
}
const forbiddenReasons = async (s: S) =>
  (await s.rows())
    .filter((r) => r.action === 'admin.forbidden')
    .map((r) => (r.details as { reason?: string }).reason);

describe('headers on every panel response', () => {
  const expectPage = (res: Response, csp = CSP) => {
    expect(res.headers.get('content-security-policy')).toBe(csp);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('permissions-policy')).toBe(PERMISSIONS);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  };

  it('are the same on pages, errors, 404s and the sign-in pages (Node)', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    const member = await s.session(ALICE);
    const longBody = form({ _csrf: own.csrf, displayName: 'a'.repeat(20_000) });
    const responses: Array<[string, Response, number]> = [
      ['overview', await page(s, '/admin', own), 200],
      ['account', await page(s, '/admin/account', own), 200],
      ['member account', await page(s, '/admin/account', member), 200],
      ['signed-in 404', await page(s, '/admin/no/such/page', own), 404],
      [
        'forbidden',
        await s.send('POST', '/admin/account/name', {
          cookie: member.cookie,
          form: form({ _csrf: member.csrf }),
        }),
        403,
      ],
      [
        'bad token',
        await s.send('POST', '/admin/account/name', { cookie: own.cookie, form: form({ _csrf: 'x' }) }),
        403,
      ],
      [
        'wrong content type',
        await s.send('POST', '/admin/account/name', {
          cookie: own.cookie,
          body: { a: 1 },
        }),
        415,
      ],
      ['too large', await s.send('POST', '/admin/account/name', { cookie: own.cookie, form: longBody }), 413],
      ['cross-site fetch', await page(s, '/admin', own, { 'sec-fetch-site': 'cross-site' }), 403],
      ['sign-in chooser', await page(s, '/auth/login', undefined), 200],
      ['sign-in failure', await page(s, '/auth/callback/oidc-corp?code=x&state=y', undefined), 400],
      [
        'signed out',
        await s.send('POST', '/auth/logout', { cookie: (await s.session(ALICE)).cookie, form: form({}) }),
        403,
      ],
    ];
    for (const [name, res, status] of responses) {
      expect(res.status, name).toBe(status);
      expectPage(res);
    }
    // The owner setup page alone drops `form-action`, which would stop the redirect to the identity provider.
    const setupPage = await page(s, '/auth/setup', undefined);
    expect(setupPage.status).toBe(200);
    expectPage(setupPage, CSP.replace("form-action 'self'; ", ''));
  });

  it('are the same in the Workers configuration, with HSTS on https', async () => {
    const s = await setup({ isolation: 'request', publicUrl: 'https://bridge.example.test' });
    const own = await s.session(OWNER);
    for (const path of ['/admin', '/admin/account', '/admin/nothing', '/auth/login']) {
      const res = await page(s, path, own);
      expect(res.status, path).toBe(path === '/admin/nothing' ? 404 : 200);
      expectPage(res);
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    }
  });

  it('keep the panel policy only when it is exactly the panel policy; assets are immutable, everything else no-store', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    const html = await (await page(s, '/admin', own)).text();
    const css = /href="(\/admin\/assets\/[^"]+\.css)"/.exec(html)?.[1] as string;
    const js = /src="(\/admin\/assets\/[^"]+\.js)"/.exec(html)?.[1] as string;
    for (const [path, type] of [
      [css, 'text/css; charset=utf-8'],
      [js, 'text/javascript; charset=utf-8'],
    ] as const) {
      // Public: no session needed.
      const res = await page(s, path, undefined);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    }
    expect((await page(s, '/admin/assets/admin.css', undefined)).status).toBe(404);
    // Anything but the panel's own policy is replaced (a handler's mistake cannot loosen a response).
    expect((await page(s, '/health', undefined)).headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it("keeps a response's own CSP only when it is exactly one of the panel's two, and replaces any other", async () => {
    const s = await setup();
    const DEFAULT = "default-src 'none'; frame-ancestors 'none'";
    const policies: Record<string, string> = {
      exact: CSP,
      setup: CSP.replace("form-action 'self'; ", ''),
      loose: "default-src * 'unsafe-inline'",
      looser: `${CSP}; script-src 'unsafe-inline'`,
      lenient: CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      other: "default-src 'none'",
      empty: '',
    };
    for (const [name, value] of Object.entries(policies)) {
      s.w.app.app.get(`/csp-${name}`, (c) =>
        c.body('x', 200, { 'content-security-policy': value, 'referrer-policy': 'unsafe-url' }),
      );
    }
    const own = await s.session(OWNER); // loads the panel, as any page does
    for (const [name, value] of Object.entries(policies)) {
      const res = await page(s, `/csp-${name}`, own);
      const kept = name === 'exact' || name === 'setup';
      expect(res.headers.get('content-security-policy'), name).toBe(kept ? value : DEFAULT);
      // The referrer policy is the app's own unless the response is a panel page.
      expect(res.headers.get('referrer-policy'), name).toBe(kept ? 'same-origin' : 'no-referrer');
    }
  });

  it('pages embed the integrity of the very bytes the assets are served with', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    const html = await (await page(s, '/admin', own)).text();
    for (const m of html.matchAll(/(?:href|src)="(\/admin\/assets\/[^"]+)" integrity="([^"]+)"/g)) {
      const body = await (await page(s, m[1] as string, undefined)).text();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', new TextEncoder().encode(body)));
      expect(`sha384-${btoa(String.fromCharCode(...digest))}`).toBe(m[2]);
    }
    expect([...html.matchAll(/integrity=/g)]).toHaveLength(2);
  });
});

describe('who gets in', () => {
  it('sends strangers to sign-in, showing nothing, for every kind of path', async () => {
    const s = await setup();
    const paths = [
      '/admin',
      '/admin/',
      '/admin/account',
      '/admin/nothing',
      '/admin//evil.example',
      '/admin/%5Cevil.example',
      '/admin?token=x',
    ];
    for (const path of paths) {
      const res = await page(s, path, undefined);
      expect(res.status, path).toBe(303);
      const location = res.headers.get('location') as string;
      const next = new URL(location, 'http://127.0.0.1:8787').searchParams.get('next') as string;
      expect(location.startsWith('/auth/login?next='), path).toBe(true);
      // Stays on this origin: one leading slash, never `//` or `\`.
      expect(next, path).toMatch(/^\/(?![/\\])/);
      expect(await res.text()).toBe('');
    }
  });

  it('never accepts a bearer token, the break-glass token or a query credential as a session', async () => {
    const s = await setup();
    for (const headers of [
      { authorization: `Bearer ${['ab', 'admin', '0123456789abcdef'].join('_')}` },
      { authorization: `Bearer ${s.w.tokens.alice}` },
      { authorization: 'Basic eDp5' },
      { 'x-test-actor': 'owner' },
      { 'x-agility-token': 'whatever' },
    ]) {
      const res = await page(s, '/admin', undefined, headers);
      expect(res.status, JSON.stringify(headers)).toBe(303);
      expect(await res.text()).not.toContain('Overview');
    }
    // Not even with a (valid) session cookie of someone else sitting next to a token.
    const own = await s.session(OWNER);
    const res = await page(s, '/admin/account', own, { authorization: 'Bearer nonsense' });
    expect(res.status).toBe(200);
  });

  it('a broken, forged, duplicated or expired cookie is no session and is cleared', async () => {
    const s = await setup({ session: { timeouts: { idleMs: 10 * MIN, absoluteMs: 60 * MIN } } });
    const own = await s.session(OWNER);
    const value = own.cookie.split('=')[1] as string;
    const bad = [
      `${s.cookieName}=garbage`,
      `${s.cookieName}=usr_nobody.${value.split('.')[1]}`,
      `${s.cookieName}=${value}; ${s.cookieName}=${value}`,
      `${s.cookieName}=`,
    ];
    for (const cookie of bad) {
      const res = await page(s, '/admin', { cookie, csrf: '' });
      expect(res.status, cookie).toBe(303);
      expect(res.headers.get('location'), cookie).toContain('/auth/login');
    }
    expect((await page(s, '/admin', own)).status).toBe(200);
    s.w.now.t += 11 * MIN;
    const expired = await page(s, '/admin', own);
    expect(expired.status).toBe(303);
    expect(
      expired.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${s.cookieName}=;`) && c.includes('Max-Age=0')),
    ).toBe(true);
  });

  it('a disabled user loses the panel at once', async () => {
    const s = await setup();
    const owner = await s.session(OWNER);
    const alice = await s.session(ALICE);
    expect((await page(s, '/admin', alice)).status).toBe(200);
    expect((await s.api('POST', `/users/${s.w.ids.alice}/disable`, owner)).status).toBe(200);
    const res = await page(s, '/admin', alice);
    expect(res.status).toBe(303);
    expect(await res.text()).toBe('');
  });

  it('refuses cross-site subresource loads and fetches before the session, and serves a top-level link', async () => {
    const s = await setup();
    const own = await s.session(OWNER);
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    ]) {
      const withSession = await page(s, '/admin/account', own, headers);
      expect(withSession.status, JSON.stringify(headers)).toBe(403);
      expect(await withSession.text()).not.toContain(own.csrf);
      expect((await page(s, '/admin/account', undefined, headers)).status).toBe(403);
    }
    const link = await page(s, '/admin/account', own, {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    });
    expect(link.status).toBe(200);
  });

  it('the panel needs each role as its pages say, and the roles are ranked as the admin API treats them', async () => {
    const s = await setup();
    const owner = await s.session(OWNER);
    const admin = await s.session(ADMIN);
    const member = await s.session(ALICE);
    expect(UI_ROLE_RANK).toEqual({ member: 1, admin: 2, owner: 3 });
    const sessions = { owner, admin, member } as const;
    // Every menu entry opens for exactly the roles the menu shows it to.
    for (const item of NAV_ITEMS) {
      for (const [role, session] of Object.entries(sessions)) {
        const res = await page(s, item.href, session);
        const allowed = UI_ROLE_RANK[role as keyof typeof UI_ROLE_RANK] >= UI_ROLE_RANK[item.minRole];
        expect(res.status, `${role} ${item.href}`).toBe(allowed ? 200 : 403);
        const menu = await (await page(s, '/admin', session)).text();
        expect(menu.includes(`href="${item.href}"`), `${role} menu ${item.href}`).toBe(allowed);
      }
    }
    // The admin API ranks them the same way: members manage nobody, admins members, owners everybody.
    const create = (who: Session, email: string, role: string) =>
      s.api('POST', '/users', who, { email, role });
    expect((await create(member, 'm1@example.test', 'member')).status).toBe(403);
    expect((await create(admin, 'm2@example.test', 'member')).status).toBe(201);
    expect((await create(admin, 'a2@example.test', 'admin')).status).toBe(403);
    expect((await create(owner, 'a3@example.test', 'admin')).status).toBe(201);
  });
});

describe('what the pages show', () => {
  it('renders hostile names and emails from storage inert', async () => {
    const s = await setup();
    const owner = await s.session(OWNER);
    const evil = '<img src=x onerror=alert(1)>"\'</title><script>alert(2)</script>';
    const set = await s.api('PATCH', `/users/${s.w.ids.owner}`, owner, { displayName: evil });
    expect(set.status).toBe(200);
    // A user whose email carries markup, if the API accepts one at all.
    await s.api('POST', '/users', owner, { email: '"><svg onload=alert(3)>@example.test', role: 'member' });
    for (const path of ['/admin', '/admin/account', '/admin/nothing']) {
      const html = await (await page(s, path, owner)).text();
      expect(html, path).not.toContain('<img src=x');
      expect(html, path).not.toContain('<script>alert');
      expect(html, path).not.toContain('<svg onload');
      expect(html, path).not.toMatch(/<script[^>]*>[^<]/i);
      expect(html, path).toContain('&lt;img src=x onerror=alert(1)&gt;');
    }
  });

  it('shows admins the user list through the admin API, and members only themselves', async () => {
    const s = await setup();
    const admin = await s.session(ADMIN);
    const member = await s.session(ALICE);
    const adminHtml = await (await page(s, '/admin', admin)).text();
    expect(adminHtml).toContain('Users (');
    expect(adminHtml).toContain('alice@example.test');
    const memberHtml = await (await page(s, '/admin', member)).text();
    expect(memberHtml).not.toContain('Users (');
    expect(memberHtml).not.toContain('bob@example.test');
    expect(memberHtml).toContain('alice@example.test');
  });

  it('the account page shows the name form to owners only', async () => {
    const s = await setup();
    const owner = await s.session(OWNER);
    const admin = await s.session(ADMIN);
    expect(await (await page(s, '/admin/account', owner)).text()).toContain('action="/admin/account/name"');
    expect(await (await page(s, '/admin/account', admin)).text()).not.toContain('/admin/account/name');
  });
});

describe('forms: refusals change nothing', () => {
  const NAME = '/admin/account/name';
  const SESSIONS = '/admin/account/sessions';
  const origin = 'http://127.0.0.1:8787';

  type Case = [
    name: string,
    send: (s: S, who: { owner: Session; admin: Session; member: Session }) => Promise<Response>,
    status: number,
    reason: string | null,
    /** Another origin the edge allows (CORS), so the panel's own check is the one that refuses. */
    options?: { allowedOrigins: string[] },
  ];
  const OTHER = 'https://other.example.test';
  const named = (owner: Session) => ({ displayName: 'Hijacked', confirm: 'yes', _csrf: owner.csrf });
  const raw = (s: S, path: string, session: Session, body: string, headers: Record<string, string> = {}) =>
    s.send('POST', path, { cookie: session.cookie, form: body, headers });
  const cases: Case[] = [];
  for (const path of [NAME, SESSIONS]) {
    const tag = path === NAME ? 'name' : 'sessions';
    cases.push(
      [
        `${tag}: no token`,
        (s, w) => raw(s, path, w.owner, form({ displayName: 'Hijacked', confirm: 'yes' })),
        403,
        'csrf',
      ],
      [
        `${tag}: wrong token`,
        (s, w) => raw(s, path, w.owner, form({ ...named(w.owner), _csrf: 'x'.repeat(43) })),
        403,
        'csrf',
      ],
      [
        `${tag}: token of another user's session`,
        async (s, w) => raw(s, path, w.owner, form({ ...named(w.owner), _csrf: w.admin.csrf })),
        403,
        'csrf',
      ],
      [
        `${tag}: token twice`,
        (s, w) => raw(s, path, w.owner, `${form(named(w.owner))}&_csrf=${w.owner.csrf}`),
        403,
        'csrf',
      ],
      // The edge's allowlist refuses these first (a JSON 403, no panel page).
      [
        `${tag}: foreign Origin, refused at the edge`,
        (s, w) => raw(s, path, w.owner, form(named(w.owner)), { origin: 'https://evil.example.test' }),
        403,
        null,
      ],
      [
        `${tag}: Origin null, refused at the edge`,
        (s, w) => raw(s, path, w.owner, form(named(w.owner)), { origin: 'null' }),
        403,
        null,
      ],
      // An origin the edge allows (CORS) but that is not ours: the panel's own check refuses.
      [
        `${tag}: allowed foreign Origin`,
        (s, w) => raw(s, path, w.owner, form(named(w.owner)), { origin: OTHER }),
        403,
        'origin_mismatch',
        { allowedOrigins: [OTHER] },
      ],
      [
        `${tag}: cross-site fetch metadata`,
        (s, w) => raw(s, path, w.owner, form(named(w.owner)), { 'sec-fetch-site': 'cross-site', origin }),
        403,
        'cross_site',
      ],
      [
        `${tag}: same-site fetch metadata`,
        (s, w) => raw(s, path, w.owner, form(named(w.owner)), { 'sec-fetch-site': 'same-site', origin }),
        403,
        'cross_site',
      ],
      [
        `${tag}: no Origin and no fetch metadata`,
        (s, w) => s.send('POST', path, { cookie: w.owner.cookie, form: form(named(w.owner)), site: null }),
        403,
        'origin_missing',
      ],
      [
        `${tag}: JSON instead of a form`,
        (s, w) =>
          s.send('POST', path, {
            cookie: w.owner.cookie,
            body: { displayName: 'Hijacked', _csrf: w.owner.csrf },
          }),
        415,
        null,
      ],
      [
        `${tag}: multipart instead of a form`,
        (s, w) =>
          raw(s, path, w.owner, '--x\r\n\r\n--x--', { 'content-type': 'multipart/form-data; boundary=x' }),
        415,
        null,
      ],
      [
        `${tag}: oversize body`,
        (s, w) => raw(s, path, w.owner, form({ ...named(w.owner), displayName: 'a'.repeat(20_000) })),
        413,
        null,
      ],
    );
  }
  cases.push(
    [
      'name: member',
      (s, w) => raw(s, NAME, w.member, form({ displayName: 'Hijacked', _csrf: w.member.csrf })),
      403,
      'role',
    ],
    [
      'name: admin',
      (s, w) => raw(s, NAME, w.admin, form({ displayName: 'Hijacked', _csrf: w.admin.csrf })),
      403,
      'role',
    ],
  );

  it.each(cases.map((c) => [c[0]] as const))('%s', async (name) => {
    const [, send, status, reason, options] = cases.find((c) => c[0] === name) as Case;
    const s = await setup(options);
    const who = {
      owner: await s.session(OWNER),
      admin: await s.session(ADMIN),
      member: await s.session(ALICE),
    };
    await s.w.audit.flush();
    const before = await snapshot(s);
    const res = await send(s, who);
    expect(res.status).toBe(status);
    // A panel page, or the edge's own JSON refusal for an origin it does not allow at all.
    expect(res.headers.get('content-security-policy')).toBe(
      res.headers.get('content-type')?.startsWith('text/html')
        ? CSP
        : "default-src 'none'; frame-ancestors 'none'",
    );
    expect(await res.text()).not.toContain('Hijacked');
    const after = await snapshot(s);
    // No user changed, no session ended, and the only audit row a security refusal writes is its own.
    expect(after.users).toBe(before.users);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.auditCount).toBe(before.auditCount + (reason === null ? 0 : 1));
    if (reason !== null) expect((await forbiddenReasons(s)).slice(-1)).toEqual([reason]);
    // Everybody is still signed in.
    for (const session of Object.values(who)) expect((await page(s, '/admin', session)).status).toBe(200);
  });

  it('a stranger posting a form is sent to sign-in; a cross-site form carries no cookie and so changes nothing', async () => {
    const s = await setup();
    const owner = await s.session(OWNER);
    const before = await snapshot(s);
    const stranger = await s.send('POST', NAME, {
      form: form({ _csrf: owner.csrf, displayName: 'Hijacked' }),
    });
    expect(stranger.status).toBe(303);
    expect(stranger.headers.get('location')).toContain('/auth/login');
    expect(await snapshot(s)).toEqual(before);
  });

  it('GET on a form target changes nothing', async () => {
    const s = await setup();
    const owner = await s.session(OWNER);
    const before = await snapshot(s);
    for (const path of [NAME, SESSIONS]) expect([404, 405]).toContain((await page(s, path, owner)).status);
    expect(await snapshot(s)).toEqual(before);
  });
});

describe('a panel change is an admin API change', () => {
  const NAME = '/admin/account/name';

  it('writes the audit row the API call writes, with the panel request id, and shows the change after a redirect', async () => {
    const s = await setup();
    const owner = await s.session(OWNER);
    const res = await submit(s, NAME, owner, { displayName: 'Panel Name' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/account');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('ab_flash=saved;'))).toBe(true);
    const panelRequest = res.headers.get('x-request-id');
    expect((await s.w.storage.users.get(s.w.ids.owner))?.displayName).toBe('Panel Name');
    // Post/Redirect/Get: the next page shows the message once and clears it.
    const next = await page(s, '/admin/account', owner, { cookie: `${owner.cookie}; ab_flash=saved` });
    const html = await next.text();
    expect(html).toContain('Saved.');
    expect(html).toContain('Panel Name');
    expect(next.headers.getSetCookie().some((c) => c.startsWith('ab_flash=;'))).toBe(true);

    // The same change made on the API itself.
    expect((await s.api('PATCH', `/users/${s.w.ids.owner}`, owner, { displayName: 'Api Name' })).status).toBe(
      200,
    );
    const rows = (await s.rows()).filter((r) => r.action === 'user.update');
    expect(rows).toHaveLength(2);
    // The row of the panel request is the one that carries its request id.
    const panel = rows.find((r) => r.requestId === panelRequest) as (typeof rows)[number];
    const api = rows.find((r) => r.requestId !== panelRequest) as (typeof rows)[number];
    expect(panel).toBeDefined();
    expect(api).toBeDefined();
    const shape = (r: typeof panel) => ({
      kind: r.kind,
      action: r.action,
      status: r.status,
      userId: r.userId,
      targetType: r.targetType,
      targetId: r.targetId,
      errorCode: r.errorCode,
      details: r.details,
    });
    expect(shape(panel)).toEqual(shape(api));
    expect(panel.details).toEqual({ actor: 'owner', fields: ['displayName'], via: 'api' });
  });

  it('ends all sessions through POST /users/{id}/sessions/revoke, as that call does, for any role', async () => {
    const s = await setup();
    const alice = await s.session(ALICE);
    const other = await s.session(ALICE);
    const bob = await s.session('bob@example.test');
    // Without the confirmation field nothing happens.
    const unconfirmed = await submit(s, '/admin/account/sessions', alice, {});
    expect(unconfirmed.status).toBe(303);
    expect(unconfirmed.headers.get('location')).toBe('/admin/account');
    expect((await page(s, '/admin', alice)).status).toBe(200);
    const res = await submit(s, '/admin/account/sessions', alice, { confirm: 'yes' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/login');
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith('ab_session=;') && c.includes('Max-Age=0')),
    ).toBe(true);
    expect((await page(s, '/admin', alice)).status).toBe(303);
    expect((await page(s, '/admin', other)).status).toBe(303);
    // Somebody else's sessions are untouched.
    expect((await page(s, '/admin', bob)).status).toBe(200);
    const rows = (await s.rows()).filter((r) => r.action === 'session.revoke_all');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: s.w.ids.alice,
      targetType: 'user',
      targetId: s.w.ids.alice,
      status: 'ok',
      details: { actor: 'member', via: 'api' },
    });
  });

  it('shows an error from the admin API as a fixed message', async () => {
    const s = await setup();
    const owner = await s.session(OWNER);
    const original = (await s.w.storage.users.get(s.w.ids.owner))?.displayName;
    // The API refuses a name past its limit even though the panel's own check lets 200 characters through.
    const res = await submit(s, NAME, owner, { displayName: 'a'.repeat(201) });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('ab_flash=invalid;'))).toBe(true);
    expect((await s.w.storage.users.get(s.w.ids.owner))?.displayName).toBe(original);
  });
});

describe('re-authentication in the panel', () => {
  const NAME = '/admin/account/name';

  it('asks for a recent sign-in without changing anything, and the same form works after /auth/reauth', async () => {
    const s = await setup();
    const owner = await s.session(OWNER);
    s.w.now.t += 11 * MIN;
    const original = (await s.w.storage.users.get(s.w.ids.owner))?.displayName;
    const before = await snapshot(s);
    const res = await submit(s, NAME, owner, { displayName: 'After Reauth' });
    const html = await res.text();
    expect(res.status).toBe(403);
    expect(html).toContain('href="/auth/reauth?next=%2Fadmin%2Faccount"');
    expect(html).toContain('Nothing was changed');
    expect((await s.w.storage.users.get(s.w.ids.owner))?.displayName).toBe(original);
    // The admin API recorded its refusal, like any API call (no `forbidden` row of the panel itself).
    const after = await snapshot(s);
    expect(after.users).toBe(before.users);
    const denied = (await s.rows()).filter((r) => r.action === 'user.update');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      status: 'denied',
      details: { error: 'reauth_required', actor: 'owner' },
    });

    // The link goes through the identity provider and returns to the account page.
    const start = await page(s, '/auth/reauth?next=%2Fadmin%2Faccount', owner);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location') as string);
    expect(location.searchParams.get('prompt')).toBe('login');
    const binding = s.cookieOf(start, 'ab_login') as string;
    const { code, state } = s.idp.authorize(location, { email: OWNER, sub: `sub-${OWNER}` });
    const done = await s.send('GET', `/auth/callback/oidc-corp?code=${code}&state=${state}`, {
      cookie: `${binding}; ${owner.cookie}`,
      site: 'cross-site',
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/admin/account');
    const cookie = s.cookieOf(done) as string;
    expect(cookie).not.toBe(owner.cookie);
    const landing = await page(s, '/admin/account', { cookie, csrf: '' });
    expect(landing.status).toBe(200);
    const landed = await landing.text();
    expect(landed).toContain('<dd>yes</dd>');
    const fresh = { cookie, csrf: csrfOf(landed) };
    expect(fresh.csrf).not.toBe(owner.csrf);
    const again = await submit(s, NAME, fresh, { displayName: 'After Reauth' });
    expect(again.status).toBe(303);
    expect((await s.w.storage.users.get(s.w.ids.owner))?.displayName).toBe('After Reauth');
    // The old session died at rotation.
    expect((await page(s, '/admin', owner)).status).toBe(303);
  });

  it('does not ask for it when the change needs none', async () => {
    const s = await setup();
    const alice = await s.session(ALICE);
    s.w.now.t += 11 * MIN;
    const res = await submit(s, '/admin/account/sessions', alice, { confirm: 'yes' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/login');
  });
});
