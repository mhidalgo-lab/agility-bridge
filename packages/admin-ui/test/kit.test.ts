// SPDX-License-Identifier: Apache-2.0
// The page and form kit (P4-03, THREAT_MODEL T13/T14) against a fake server: session, role, fetch-metadata and CSRF
// refusals change nothing and call nothing; flash messages, re-authentication and error mapping.
import { describe, expect, it } from 'vitest';
import { flashCookie } from '../src/flash.ts';
import { adminPath, createUiKit, pageFetchProblem } from '../src/kit.ts';
import { CSRF, fakeDeps, get, post } from './helpers/fake-deps.ts';

const asOwner = { 'x-test-session': 'owner' };
const asAdmin = { 'x-test-session': 'admin' };
const asMember = { 'x-test-session': 'member' };
const NAME = '/admin/account/name';
const SESSIONS = '/admin/account/sessions';

describe('pages: who gets in', () => {
  it('sends a stranger to sign-in with the page as `next`, and shows nothing', async () => {
    const f = fakeDeps();
    for (const path of ['/admin', '/admin/account', '/admin/nothing-here', '/admin/assets-not']) {
      const res = await get(f, path);
      expect(res.status, path).toBe(303);
      expect(res.headers.get('location'), path).toBe(`/auth/login?next=${encodeURIComponent(path)}`);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await res.text()).toBe('');
    }
    expect(f.calls).toEqual([]);
  });

  it('keeps the query in `next`, encoded', async () => {
    const f = fakeDeps();
    const res = await get(f, '/admin/account?a=1&b=%2F%2Fevil');
    expect(res.headers.get('location')).toBe(
      `/auth/login?next=${encodeURIComponent('/admin/account?a=1&b=%2F%2Fevil')}`,
    );
  });

  it('clears a dead cookie on the way to sign-in', async () => {
    const f = fakeDeps();
    const res = await get(f, '/admin', { 'x-test-session': 'dead' });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toEqual([f.deps.clearSessionCookie]);
  });

  it('never lets a bearer token or a query credential stand in for a session', async () => {
    const f = fakeDeps();
    for (const headers of [{ authorization: 'Bearer ab_admin_x' }, { authorization: 'Basic eDp5' }]) {
      expect((await get(f, '/admin', headers)).status).toBe(303);
    }
    expect((await get(f, '/admin?token=abc&access_token=abc')).status).toBe(303);
  });

  it('serves a signed-in person any page and a 404 page for an unknown path', async () => {
    const f = fakeDeps();
    expect((await get(f, '/admin', asMember)).status).toBe(200);
    expect((await get(f, '/admin/account', asMember)).status).toBe(200);
    const missing = await get(f, '/admin/nothing-here', asMember);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Page not found');
  });

  it('refuses cross-site requests that are not top-level navigations, before the session is read', async () => {
    let looked = 0;
    const f = fakeDeps({
      authenticate: async () => {
        looked++;
        return { ok: false, presented: false };
      },
    });
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    ]) {
      const res = await f.app.request('/admin/account', { headers: { ...asOwner, ...headers } });
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(looked).toBe(0);
    // A link from mail or chat is a top-level navigation: served (L-192).
    const nav = await f.app.request('/admin', {
      headers: {
        ...asOwner,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(nav.status).toBe(303);
    expect(looked).toBe(1);
    expect(pageFetchProblem).toBeTypeOf('function');
  });

  it('stops at the pre-authentication hook (a rate limit) before the session', async () => {
    let looked = 0;
    const f = fakeDeps({
      beforeAuth: () => new Response('slow down', { status: 429 }),
      authenticate: async () => {
        looked++;
        return { ok: false, presented: false };
      },
    });
    const res = await get(f, '/admin', asOwner);
    expect(res.status).toBe(429);
    expect(looked).toBe(0);
  });

  it('shows errors as fixed text with the request id and no detail', async () => {
    const f = fakeDeps({
      authenticate: async () => {
        throw new Error('database password is hunter2');
      },
      onError: () => {
        throw new Error('the logger failed too');
      },
    });
    const res = await get(f, '/admin', asOwner);
    const html = await res.text();
    expect(res.status).toBe(500);
    expect(html).toContain('req-test');
    expect(html).not.toContain('hunter2');
    expect(html).not.toContain('logger failed');
  });

  it('gates a page by role, and says so in an audit-able way', async () => {
    const f = fakeDeps();
    const kit = createUiKit(f.deps);
    const gated = kit.page('admin', () => new Response('ok'));
    const { Hono } = await import('hono');
    const app = new Hono();
    app.get('/only-admins', gated);
    expect((await app.request('/only-admins', { headers: asMember })).status).toBe(403);
    expect(f.forbidden).toEqual(['role']);
    expect((await app.request('/only-admins', { headers: asAdmin })).status).toBe(200);
    expect((await app.request('/only-admins', { headers: asOwner })).status).toBe(200);
  });
});

describe('forms: what is refused, and that nothing happens', () => {
  const ok = { _csrf: CSRF, displayName: 'New Name' };

  it('accepts a good form from the owner and calls the admin API once', async () => {
    const f = fakeDeps();
    const res = await post(f, NAME, ok, asOwner);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/account');
    expect(f.calls).toEqual([
      { method: 'PATCH', path: '/users/usr_owner', body: { displayName: 'New Name' } },
    ]);
  });

  interface Refusal {
    readonly name: string;
    readonly fake: ReturnType<typeof fakeDeps>;
    readonly send: () => Promise<Response> | Response;
    readonly status: number;
    /** The reason the panel reports for its audit row; null when the refusal is not a security refusal. */
    readonly reason: string | null;
  }
  const refusals: Refusal[] = [];
  const refuse = (
    name: string,
    status: number,
    reason: string | null,
    send: (fake: ReturnType<typeof fakeDeps>) => Promise<Response> | Response,
  ) => {
    const fake = fakeDeps();
    refusals.push({ name, fake, send: () => send(fake), status, reason });
  };
  for (const [name, fields] of [
    ['a missing token', { displayName: 'New Name' }],
    ['a wrong token', { _csrf: 'nope', displayName: 'New Name' }],
    ['an empty token', { _csrf: '', displayName: 'New Name' }],
    ['a token in another case', { _csrf: CSRF.toUpperCase(), displayName: 'New Name' }],
    ['the token twice', { _csrf: [CSRF, CSRF], displayName: 'New Name' }],
    ['a right and a wrong token', { _csrf: [CSRF, 'nope'], displayName: 'New Name' }],
  ] as Array<[string, Record<string, string | string[]>]>) {
    refuse(name, 403, 'csrf', (f) => post(f, NAME, fields, asOwner));
    refuse(`${name} (sessions form)`, 403, 'csrf', (f) =>
      post(f, SESSIONS, { ...fields, confirm: 'yes' }, asOwner),
    );
  }
  for (const problem of ['cross_site', 'origin_mismatch', 'origin_missing']) {
    refuse(`fetch metadata says ${problem}`, 403, problem, (f) =>
      post(f, NAME, ok, { ...asOwner, 'x-test-problem': problem }),
    );
  }
  refuse('a form from a member', 403, 'role', (f) => post(f, NAME, ok, asMember));
  refuse('a form from an admin', 403, 'role', (f) => post(f, NAME, ok, asAdmin));
  refuse('JSON instead of a form', 415, null, (f) =>
    post(f, NAME, JSON.stringify(ok), { ...asOwner, 'content-type': 'application/json' }),
  );
  refuse('multipart instead of a form', 415, null, (f) =>
    post(f, NAME, 'x', { ...asOwner, 'content-type': 'multipart/form-data; boundary=x' }),
  );
  refuse('a body over 16 KiB', 413, null, (f) =>
    post(f, NAME, `_csrf=${CSRF}&displayName=${'a'.repeat(17 * 1024)}`, asOwner),
  );
  refuse('a declared length over 16 KiB', 413, null, (f) =>
    post(f, NAME, 'x', { ...asOwner, 'content-length': String(1024 * 1024) }),
  );

  it.each(refusals.map((r, i) => [r.name, i] as const))(
    'refuses %s and changes nothing',
    async (_name, i) => {
      const { fake, send, status, reason } = refusals[i] as Refusal;
      const res = await send();
      expect(res.status).toBe(status);
      // A refused request's page never echoes what was submitted.
      expect(await res.text()).not.toContain('New Name');
      expect(fake.calls).toEqual([]);
      expect(fake.forbidden).toEqual(reason === null ? [] : [reason]);
    },
  );

  it('a stranger posting a form is sent to sign-in and nothing is called', async () => {
    const fake = fakeDeps();
    const res = await post(fake, NAME, ok);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/auth/login?next=${encodeURIComponent('/admin')}`);
    expect(fake.calls).toEqual([]);
    expect(fake.forbidden).toEqual([]);
  });

  it('refuses a GET to a form target', async () => {
    const fake = fakeDeps();
    expect([404, 405]).toContain((await get(fake, NAME, asOwner)).status);
    expect(fake.calls).toEqual([]);
  });

  it('removes the CSRF field before the handler sees the form', async () => {
    const fake = fakeDeps();
    const kit = createUiKit(fake.deps);
    let seen: string[] = [];
    const { Hono } = await import('hono');
    const app = new Hono();
    app.post(
      '/x',
      kit.form('member', (_c, _p, form) => {
        seen = [...form.fields.keys()];
        return new Response('ok');
      }),
    );
    await app.request('/x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...asMember },
      body: `_csrf=${CSRF}&a=1`,
    });
    expect(seen).toEqual(['a']);
  });
});

describe('callAdmin: a change needs the verified form of its own request', () => {
  it('throws for an unsafe call without a form, and for a form of another request', async () => {
    const fake = fakeDeps();
    const kit = createUiKit(fake.deps);
    const { Hono } = await import('hono');
    const app = new Hono();
    let stolen: Parameters<Parameters<typeof kit.form>[1]>[2] | undefined;
    app.post(
      '/first',
      kit.form('member', (_c, _p, form) => {
        stolen = form;
        return new Response('ok');
      }),
    );
    const outcomes: string[] = [];
    app.post(
      '/second',
      kit.form('member', async (c, p, form) => {
        for (const [label, attempt] of [
          ['no form', () => kit.callAdmin(c, p, { method: 'POST', path: '/x' })],
          ['stolen form', () => kit.callAdmin(c, p, { method: 'POST', path: '/x' }, stolen)],
          [
            'forged form',
            () =>
              kit.callAdmin(c, p, { method: 'DELETE', path: '/x' }, { fields: form.fields, principal: p }),
          ],
          ['bad path', () => kit.callAdmin(c, p, { method: 'GET', path: '//evil.example/x' })],
          ['relative path', () => kit.callAdmin(c, p, { method: 'GET', path: 'users' })],
        ] as const) {
          try {
            await attempt();
            outcomes.push(`${label}: allowed`);
          } catch {
            outcomes.push(`${label}: refused`);
          }
        }
        await kit.callAdmin(c, p, { method: 'GET', path: '/users' });
        await kit.callAdmin(c, p, { method: 'POST', path: '/ok' }, form);
        return new Response('ok');
      }),
    );
    const init = (extra: Record<string, string> = {}) => ({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...asMember, ...extra },
      body: `_csrf=${CSRF}`,
    });
    await app.request('/first', init());
    await app.request('/second', init());
    expect(outcomes).toEqual([
      'no form: refused',
      'stolen form: refused',
      'forged form: refused',
      'bad path: refused',
      'relative path: refused',
    ]);
    // Only the two legitimate calls reached the admin API.
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /users', 'POST /ok']);
  });

  it('adminPath makes every value one path segment', () => {
    expect(adminPath`/users/${'a/b?c#d'}/sessions/revoke`).toBe('/users/a%2Fb%3Fc%23d/sessions/revoke');
    expect(adminPath`/x/${7}`).toBe('/x/7');
    for (const bad of ['', '.', '..']) expect(() => adminPath`/x/${bad}`).toThrow(TypeError);
  });
});

describe('answers to the admin API', () => {
  const ok = { _csrf: CSRF, displayName: 'N' };

  it('turns reauth_required into the re-authentication prompt, changing nothing more', async () => {
    const fake = fakeDeps();
    fake.answer = {
      status: 403,
      body: { error: { code: 'reauth_required', message: 'Sign in again before x.' } },
    };
    const res = await post(fake, NAME, ok, asOwner);
    const html = await res.text();
    expect(res.status).toBe(403);
    expect(html).toContain('href="/auth/reauth?next=%2Fadmin%2Faccount"');
    expect(html).toContain('Nothing was changed');
    expect(html).not.toContain('Sign in again before x');
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    ['forbidden', 403, 'not_allowed'],
    ['not_found', 404, 'not_found'],
    ['conflict', 409, 'conflict'],
    ['invalid_input', 422, 'invalid'],
    ['bad_request', 400, 'invalid'],
    ['rate_limited', 429, 'rate_limited'],
    ['unavailable', 503, 'unavailable'],
    ['upstream', 502, 'unavailable'],
    ['internal', 500, 'failed'],
    ['something_new', 418, 'failed'],
  ])('maps %s to a fixed flash message and shows nothing from the response', async (code, status, flash) => {
    const fake = fakeDeps();
    fake.answer = { status, body: { error: { code, message: '<script>alert(1)</script> secret detail' } } };
    const res = await post(fake, NAME, ok, asOwner);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/account');
    expect(res.headers.getSetCookie()).toEqual([flashCookie(flash as 'failed', false)]);
    expect(await res.text()).toBe('');
  });

  it('answers a lost session with the sign-in redirect and clears the cookie', async () => {
    const fake = fakeDeps();
    fake.answer = { status: 401, body: { error: { code: 'unauthorized', message: 'x' } } };
    const res = await post(fake, NAME, ok, asOwner);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/auth/login');
    expect(res.headers.getSetCookie()).toEqual([fake.deps.clearSessionCookie]);
  });

  it('survives a body that is not JSON-shaped as expected', async () => {
    const fake = fakeDeps();
    for (const body of [null, 'text', 5, [], { error: 'x' }, { error: { code: 5 } }]) {
      fake.answer = { status: 500, body };
      const res = await post(fake, NAME, ok, asOwner);
      expect(res.status).toBe(303);
      expect(res.headers.getSetCookie()).toEqual([flashCookie('failed', false)]);
    }
  });
});

describe('flash messages', () => {
  it('shows a known code once, as fixed text, and clears the cookie; an unknown code shows nothing', async () => {
    const fake = fakeDeps();
    const shown = await get(fake, '/admin/account', { ...asOwner, cookie: 'ab_flash=saved' });
    const html = await shown.text();
    expect(html).toContain('class="flash flash-success"');
    expect(html).toContain('Saved.');
    expect(
      shown.headers.getSetCookie().some((c) => c.startsWith('ab_flash=;') && c.includes('Max-Age=0')),
    ).toBe(true);
    const unknown = await get(fake, '/admin/account', { ...asOwner, cookie: 'ab_flash=%3Cscript%3E' });
    expect(await unknown.text()).not.toContain('class="flash');
    const none = await get(fake, '/admin/account', asOwner);
    expect(none.headers.getSetCookie()).toEqual([]);
  });

  it('a flash cookie named twice shows nothing (cookie tossing, L-189)', async () => {
    const fake = fakeDeps();
    const res = await get(fake, '/admin/account', { ...asOwner, cookie: 'ab_flash=saved; ab_flash=failed' });
    expect(await res.text()).not.toContain('class="flash');
  });

  it('a flash cookie is an HttpOnly, SameSite=Lax code that lives a minute (and __Host- over https)', () => {
    expect(flashCookie('saved', false)).toBe('ab_flash=saved; Path=/; Max-Age=60; HttpOnly; SameSite=Lax');
    expect(flashCookie('saved', true)).toBe(
      '__Host-ab_flash=saved; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure',
    );
  });
});
