// SPDX-License-Identifier: Apache-2.0
// The built-in sign-in and consent screen and the connected-apps list (P5-04, THREAT_MODEL T9, T10, T13, T15): a full
// server with sign-in, driven the way a browser drives it. Every refusal is a negative authorization test (L-121): no
// code is issued, no device appears, no upstream call is made.
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_BASE } from '../../src/index.ts';
import { setup } from '../helpers/panel.ts';

type T = Awaited<ReturnType<typeof setup>>;

const REDIRECT = 'http://127.0.0.1:53682/callback';
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const MCP = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};
const WHOAMI = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } };

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = (n = 32): string => b64u(crypto.getRandomValues(new Uint8Array(n)));

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = random(48);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64u(digest) };
}

async function server(over: { writeSwitch?: boolean } = {}) {
  // Many registrations from one address: the per-address registration limit (P5-03) is not under test here.
  const t = await setup({
    oauth: { registrationIpLimit: 1000, registrationMaxClients: 500 },
    ...(over.writeSwitch === true ? { writeSwitch: true } : {}),
  });
  return t;
}

async function register(t: T, over: { name?: string | null; redirect?: string } = {}): Promise<string> {
  const res = await t.send('POST', '/oauth/register', {
    site: null,
    body: {
      ...(over.name === null ? {} : { client_name: over.name ?? 'Test app' }),
      redirect_uris: [over.redirect ?? REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

interface Request {
  readonly clientId: string;
  readonly verifier: string;
  readonly state: string;
  readonly redirect: string;
  /** `/oauth/authorize?…` */
  readonly path: string;
}

async function authRequest(
  t: T,
  clientId: string,
  over: { slug?: string; redirect?: string; state?: string; extra?: Record<string, string> } = {},
): Promise<Request> {
  const { verifier, challenge } = await pkce();
  const state = over.state ?? `state-${random(8)}`;
  const redirect = over.redirect ?? REDIRECT;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: 'mcp:read offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${t.publicUrl}/w/${over.slug ?? 'team-a'}/mcp`,
    ...over.extra,
  });
  return { clientId, verifier, state, redirect, path: `/oauth/authorize?${params}` };
}

/** The navigation a client's browser makes to the authorization endpoint (from another site). */
const open = (t: T, r: Request, cookie?: string): Promise<Response> =>
  t.send('GET', r.path, {
    site: 'cross-site',
    headers: NAV,
    ...(cookie === undefined ? {} : { cookie }),
  });

/** A sign-in that returns to `next`; the session cookie. */
async function login(t: T, email: string, next = '/admin'): Promise<string> {
  const res = await t.signIn(email, { path: `/auth/login/oidc-corp?next=${encodeURIComponent(next)}` });
  expect(res.status).toBe(303);
  return t.cookieOf(res) as string;
}

interface Form {
  readonly action: string;
  readonly csrf: string;
  readonly handle: string;
  readonly grants: readonly string[];
  readonly html: string;
}

const attr = (html: string, name: string): string | undefined =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];

function formOf(html: string): Form {
  return {
    action: (/<form method="post" action="([^"]*)"/.exec(html)?.[1] ?? '').replaceAll('&amp;', '&'),
    csrf: attr(html, '_csrf') ?? '',
    handle: attr(html, 'handle') ?? '',
    grants: [...html.matchAll(/name="grant" value="([^"]*)"/g)].map((m) => m[1] as string),
    html,
  };
}

/** Opens the consent page as a signed-in person and reads its form. */
async function consentPage(t: T, r: Request, cookie: string): Promise<{ res: Response; form: Form }> {
  const res = await open(t, r, cookie);
  return { res, form: formOf(await res.text()) };
}

const body = (f: Form, over: Record<string, string> = {}): string =>
  new URLSearchParams({
    _csrf: f.csrf,
    handle: f.handle,
    grant: f.grants[0] ?? '',
    decision: 'approve',
    ...over,
  }).toString();

/** A browser's own form post to the consent endpoint. */
const post = (t: T, f: Form, cookie: string, form: string, over: { site?: string | null } = {}) =>
  t.send('POST', f.action, { cookie, form, ...(over.site === undefined ? {} : { site: over.site }) });

const codeOf = (res: Response): string | null => {
  const location = res.headers.get('location');
  return location === null ? null : new URL(location).searchParams.get('code');
};

async function exchange(t: T, r: Request, code: string): Promise<Response> {
  return t.send('POST', '/oauth/token', {
    site: null,
    form: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: r.redirect,
      client_id: r.clientId,
      code_verifier: r.verifier,
      resource: `${t.publicUrl}/w/team-a/mcp`,
    }).toString(),
  });
}

/** The whole flow for one app: page, Allow, code exchange. Returns the tokens. */
async function connect(
  t: T,
  cookie: string,
  over: { name?: string; redirect?: string; label?: string } = {},
): Promise<{ access: string; refresh: string; request: Request }> {
  const clientId = await register(t, {
    ...(over.name === undefined ? {} : { name: over.name }),
    ...(over.redirect === undefined ? {} : { redirect: over.redirect }),
  });
  const r = await authRequest(t, clientId, over.redirect === undefined ? {} : { redirect: over.redirect });
  const { form } = await consentPage(t, r, cookie);
  const res = await post(t, form, cookie, body(form, over.label === undefined ? {} : { label: over.label }));
  const code = codeOf(res);
  expect(code).not.toBeNull();
  const tokens = await exchange(t, r, code as string);
  expect(tokens.status).toBe(200);
  const json = (await tokens.json()) as { access_token: string; refresh_token: string };
  return { access: json.access_token, refresh: json.refresh_token, request: r };
}

const mcp = (t: T, token: string): Promise<Response> =>
  t.send('POST', '/w/team-a/mcp', {
    site: null,
    headers: { ...MCP, host: t.host, authorization: `Bearer ${token}` },
    body: WHOAMI,
  });

/** Disconnect through the admin API as the signed-in person. */
const api = (t: T, cookie: string, csrf: string, method: string, path: string) =>
  t.send(method, `${ADMIN_BASE}${path}`, { cookie, headers: { 'x-csrf-token': csrf } });

async function csrfOf(t: T, cookie: string): Promise<string> {
  const info = (await (await t.send('GET', `${ADMIN_BASE}/session`, { cookie })).json()) as {
    csrfToken: string;
  };
  return info.csrfToken;
}

const issued = async (t: T) => {
  const rows = await t.rows();
  return rows.filter((r) => r.action === 'oauth.authorize' && r.status === 'ok');
};

describe('sign-in and consent (P5-04)', () => {
  it('signs in and returns to the same authorization request, then approves and issues tokens', async () => {
    const t = await server();
    const clientId = await register(t, { name: 'Phone app' });
    const r = await authRequest(t, clientId);
    // Signed out: to sign-in, with the validated way back to exactly this request.
    const first = await open(t, r);
    expect(first.status).toBe(303);
    const login1 = new URL(first.headers.get('location') as string, t.publicUrl);
    expect(login1.pathname).toBe('/auth/login');
    expect(login1.searchParams.get('next')).toBe(r.path);
    // The sign-in returns to the authorize request; the page then opens.
    const cookie = await login(t, 'alice@example.test', r.path);
    const { res, form } = await consentPage(t, r, cookie);
    expect(res.status).toBe(200);
    expect(form.html).toContain('Phone app');
    expect(form.html).toContain('127.0.0.1:53682');
    expect(form.html).toContain('Team A');
    expect(form.html).toContain('not verified');
    expect(form.grants).toHaveLength(1);
    expect(await issued(t)).toHaveLength(0);

    const res2 = await post(t, form, cookie, body(form, { label: 'Pixel phone' }));
    expect(res2.status).toBe(303);
    const location = new URL(res2.headers.get('location') as string);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe(r.state);
    expect(location.searchParams.get('iss')).toBe(t.publicUrl);
    const tokens = await exchange(t, r, location.searchParams.get('code') as string);
    expect(tokens.status).toBe(200);
    const access = ((await tokens.json()) as { access_token: string }).access_token;
    expect((await mcp(t, access)).status).toBe(200);
    // The device is listed with its client, workspace and name.
    const csrf = await csrfOf(t, cookie);
    const list = (await (await api(t, cookie, csrf, 'GET', '/me/oauth-devices')).json()) as Array<
      Record<string, unknown>
    >;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      clientName: 'Phone app',
      redirectHost: '127.0.0.1:53682',
      workspaceSlug: 'team-a',
      workspaceName: 'Team A',
      label: 'Pixel phone',
    });
    // The last use is the time of the request above (P5-14): a number, to within the five minute throttle.
    expect(typeof list[0]?.['lastUsedAt']).toBe('number');
    expect(Math.abs(Date.now() - (list[0]?.['lastUsedAt'] as number))).toBeLessThan(5 * 60_000);
    expect(await issued(t)).toHaveLength(1);
  });

  it('offers mcp:write as its own unticked box, only when asked for, never carried over, and grants it only when ticked (P7-24)', async () => {
    const t = await server({ writeSwitch: true });
    const w = t.w;
    await w.storage.workspaces.update(w.ids.workspaceA, {
      enabledTools: ['whoami', 'add_comment'],
      writePolicy: { enabled: true },
    });
    await w.storage.grants.update(w.ids.aliceGrant, { tools: ['whoami', 'add_comment'] });
    const clientId = await register(t);
    const asked = await authRequest(t, clientId, { extra: { scope: 'mcp:read mcp:write' } });
    const cookie = await login(t, 'alice@example.test', asked.path);
    const page = await consentPage(t, asked, cookie);
    // A separate box, never pre-ticked, naming the write tools.
    expect(page.form.html).toMatch(/<input[^>]*type="checkbox"[^>]*name="write"[^>]*>/);
    expect(page.form.html).not.toMatch(/name="write"[^>]*checked/);
    expect(page.form.html).toContain('add_comment');
    // Not ticked: the token is read-only.
    const plain = await post(t, page.form, cookie, body(page.form));
    const plainToken = await exchange(t, asked, codeOf(plain) as string);
    expect(((await plainToken.json()) as { scope: string }).scope.split(' ')).not.toContain('mcp:write');
    // A new request is a new page: nothing is remembered from the first, and ticking grants the scope.
    const again = await authRequest(t, clientId, { extra: { scope: 'mcp:read mcp:write' } });
    const second = await consentPage(t, again, cookie);
    expect(second.form.html).not.toMatch(/name="write"[^>]*checked/);
    const ticked = await post(t, second.form, cookie, body(second.form, { write: '1' }));
    const token = await exchange(t, again, codeOf(ticked) as string);
    expect(((await token.json()) as { scope: string }).scope.split(' ')).toContain('mcp:write');
    // An app that did not ask gets no box, and a forged tick is ignored (never granted).
    const quiet = await authRequest(t, clientId);
    const third = await consentPage(t, quiet, cookie);
    expect(third.form.html).not.toContain('name="write"');
    const forged = await post(t, third.form, cookie, body(third.form, { write: '1' }));
    const forgedToken = await exchange(t, quiet, codeOf(forged) as string);
    expect(((await forgedToken.json()) as { scope: string }).scope.split(' ')).not.toContain('mcp:write');
  });

  it('shows no write box when the server switch is off, even if the app asks', async () => {
    const t = await server();
    const clientId = await register(t);
    const asked = await authRequest(t, clientId, { extra: { scope: 'mcp:read mcp:write' } });
    const cookie = await login(t, 'alice@example.test', asked.path);
    const page = await consentPage(t, asked, cookie);
    expect(page.form.html).not.toContain('name="write"');
  });

  it('shows the page with the strict policy: no framing, no inline script, the redirect origin in form-action', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const r = await authRequest(t, await register(t));
    const res = await open(t, r, cookie);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' http://127.0.0.1:53682");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("script-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    // Every script is an external file; nothing runs inline.
    for (const m of html.matchAll(/<script\b[^>]*>/gi)) expect(m[0]).toContain('src=');
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/style=/i);
  });

  it('renders hostile client names inert and keeps long unbreakable text from becoming markup', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'&';
    const r = await authRequest(t, await register(t, { name: hostile }));
    const html = await (await open(t, r, cookie)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // A name that is only markup characters, and an app without a name.
    const unnamed = await authRequest(t, await register(t, { name: null }));
    expect(await (await open(t, unnamed, cookie)).text()).toContain('An unnamed app');
  });

  it('names a loopback redirect as a program on this computer; an IPv6 loopback gets no http: form-action source', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const r = await authRequest(t, await register(t));
    expect(await (await open(t, r, cookie)).text()).toContain('a program on the computer');
    const v6 = 'http://[::1]:53682/callback';
    const id = await register(t, { redirect: v6 });
    const r6 = await authRequest(t, id, { redirect: v6 });
    const page = await consentPage(t, r6, cookie);
    const csp = page.res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("form-action 'self';");
    expect(csp).not.toMatch(/form-action[^;]*http:/);
    // The answer is a same-origin page that navigates, not a redirect that form-action would block.
    const res = await post(t, page.form, cookie, body(page.form));
    expect(res.status).toBe(200);
    expect(res.headers.get('refresh')).toMatch(/^0; url=http:\/\/\[::1\]:53682\/callback\?code=/);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('Continue to the app');
  });

  it('denies with access_denied, state and iss, only to the registered redirect URI, and issues nothing', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const r = await authRequest(t, await register(t));
    const { form } = await consentPage(t, r, cookie);
    const res = await post(t, form, cookie, body(form, { decision: 'deny' }));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location') as string);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe(r.state);
    expect(location.searchParams.get('iss')).toBe(t.publicUrl);
    expect(location.searchParams.get('code')).toBeNull();
    expect(await issued(t)).toHaveLength(0);
    const denied = (await t.rows()).filter((x) => x.action === 'oauth.authorize' && x.status === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.userId).toBe(t.w.ids.alice);
  });

  it('answers prompt=none without a page: login_required signed out, consent_required signed in, never a code', async () => {
    const t = await server();
    const r = await authRequest(t, await register(t), { extra: { prompt: 'none' } });
    const out = await open(t, r);
    const outLocation = new URL(out.headers.get('location') as string);
    expect(`${outLocation.origin}${outLocation.pathname}`).toBe(REDIRECT);
    expect(outLocation.searchParams.get('error')).toBe('login_required');
    expect(outLocation.searchParams.get('state')).toBe(r.state);
    expect(outLocation.searchParams.get('iss')).toBe(t.publicUrl);
    const cookie = await login(t, 'alice@example.test');
    const inn = await open(t, r, cookie);
    expect(new URL(inn.headers.get('location') as string).searchParams.get('error')).toBe('consent_required');
    const mixed = await authRequest(t, await register(t), { extra: { prompt: 'none login' } });
    expect(
      new URL((await open(t, mixed, cookie)).headers.get('location') as string).searchParams.get('error'),
    ).toBe('invalid_request');
    expect(await issued(t)).toHaveLength(0);
  });

  it('refuses an authorization URL too long to return to after sign-in', async () => {
    const t = await server();
    const r = await authRequest(t, await register(t), { state: 'x'.repeat(2100) });
    const res = await open(t, r);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('refuses cross-site requests that are not top-level navigations', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const r = await authRequest(t, await register(t));
    for (const headers of [
      { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    ]) {
      const res = await t.send('GET', r.path, { cookie, site: 'cross-site', headers });
      expect(res.status).toBe(403);
    }
  });
});

describe('the consent post is a negative authorization boundary (P5-04, L-121)', () => {
  async function ready(email = 'alice@example.test') {
    const t = await server();
    const cookie = await login(t, email);
    const r = await authRequest(t, await register(t));
    const { form } = await consentPage(t, r, cookie);
    return { t, cookie, r, form };
  }
  const nothingIssued = async (t: T) => {
    expect(await issued(t)).toHaveLength(0);
    expect(t.w.agilityTokens).toHaveLength(0);
  };

  it('needs a session: signed out it goes to sign-in and approves nothing', async () => {
    const { t, form } = await ready();
    const res = await t.send('POST', form.action, { form: body(form) });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/auth/login');
    await nothingIssued(t);
  });

  it('refuses cross-site posts, posts without an Origin and posts from a typed URL', async () => {
    const { t, cookie, form } = await ready();
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await post(t, form, cookie, body(form), { site });
      expect(res.status, site).toBe(403);
    }
    // No fetch metadata and no Origin at all (not a browser form post).
    expect((await post(t, form, cookie, body(form), { site: null })).status).toBe(403);
    // A foreign Origin.
    const foreign = await t.send('POST', form.action, {
      cookie,
      form: body(form),
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    await nothingIssued(t);
  });

  it('needs exactly one correct CSRF token and a form body', async () => {
    const { t, cookie, form } = await ready();
    const wrong = body(form).replace(`_csrf=${encodeURIComponent(form.csrf)}`, '_csrf=wrong');
    expect((await post(t, form, cookie, wrong)).status).toBe(403);
    expect((await post(t, form, cookie, `${body(form)}&_csrf=${encodeURIComponent(form.csrf)}`)).status).toBe(
      403,
    );
    const none = new URLSearchParams(body(form));
    none.delete('_csrf');
    expect((await post(t, form, cookie, none.toString())).status).toBe(403);
    const json = await t.send('POST', form.action, { cookie, body: { decision: 'approve' } });
    expect(json.status).toBe(415);
    await nothingIssued(t);
  });

  it('is single use: a replayed form approves nothing, and a second tab cannot approve after the first', async () => {
    const { t, cookie, r, form } = await ready();
    const first = await post(t, form, cookie, body(form));
    expect(codeOf(first)).not.toBeNull();
    const again = await post(t, form, cookie, body(form));
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBeNull();
    expect(await again.text()).toContain('already used');
    expect(await issued(t)).toHaveLength(1);
    // A fresh page for the same request gets its own handle.
    const second = await consentPage(t, r, cookie);
    expect(second.form.handle).not.toBe(form.handle);
    const refused = (await t.rows()).filter((x) => x.action === 'oauth.consent.refused');
    expect(refused.map((x) => x.errorCode)).toEqual(['handle_used_or_expired']);
  });

  it('is bound to the exact request: a form carried to another request approves nothing', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const clientId = await register(t);
    const a = await authRequest(t, clientId);
    const { form } = await consentPage(t, a, cookie);
    // Another state, another PKCE challenge, another resource, another client, another redirect URI.
    const other = await register(t, { redirect: 'http://127.0.0.1:53683/callback' });
    const swapped = [
      await authRequest(t, clientId),
      await authRequest(t, clientId, { slug: 'team-b' }),
      await authRequest(t, other, { redirect: 'http://127.0.0.1:53683/callback' }),
    ];
    for (const b of swapped) {
      // A new handle for each attempt: the point is that the handle of `a` cannot serve `b`.
      const fresh = await consentPage(t, a, cookie);
      const res = await t.send('POST', `/oauth/consent?${new URL(b.path, t.publicUrl).searchParams}`, {
        cookie,
        form: body({ ...fresh.form }),
      });
      expect(res.status).toBe(409);
      expect(codeOf(res)).toBeNull();
      expect(await res.text()).toContain('another request');
    }
    expect(await issued(t)).toHaveLength(0);
    // The untouched form still works for its own request.
    expect(codeOf(await post(t, form, cookie, body(form)))).not.toBeNull();
  });

  it("is bound to the person: another user's handle (or session) approves nothing", async () => {
    const { t, r, form } = await ready();
    const bob = await login(t, 'bob@example.test');
    const bobPage = await consentPage(t, r, bob);
    // Bob posts Alice's handle with his own CSRF token.
    const res = await t.send('POST', form.action, {
      cookie: bob,
      form: body(form, { _csrf: bobPage.form.csrf }),
    });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBeNull();
    await nothingIssued(t);
  });

  it('refuses an expired or invented handle', async () => {
    const { t, cookie, form } = await ready();
    for (const handle of ['', 'nope', `${'0'.repeat(14)}-${'A'.repeat(22)}`, `${form.handle}x`]) {
      const res = await post(t, form, cookie, body(form, { handle }));
      expect(res.status, handle).toBe(409);
    }
    await nothingIssued(t);
  });

  it('offers only the person’s own live grants, and refuses a forged grant id before approve()', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const r = await authRequest(t, await register(t));
    const { form } = await consentPage(t, r, cookie);
    // Alice's grant on the other workspace, Bob's grant and a made-up id are not on this page's list.
    for (const grant of [t.w.ids.aliceGrantB, t.w.ids.bobGrant, 'grt_forged']) {
      const fresh = await consentPage(t, r, cookie);
      const res = await post(t, fresh.form, cookie, body(fresh.form, { grant }));
      expect(res.status, grant).toBe(422);
      expect(codeOf(res)).toBeNull();
    }
    expect(form.grants).toEqual([t.w.ids.aliceGrant]);
    await nothingIssued(t);
  });

  it('gives a clear refusal and no token when the person has no live grant on the workspace', async () => {
    const t = await server();
    // Bob has no grant on team-a.
    const bob = await login(t, 'bob@example.test');
    const r = await authRequest(t, await register(t));
    const page = await consentPage(t, r, bob);
    expect(page.res.status).toBe(200);
    expect(page.form.grants).toEqual([]);
    expect(page.form.html).toContain('no access to this workspace');
    expect(page.form.html).not.toContain('>Allow<');
    // Even a posted approval (the button is not there, but a hand-made form is) issues nothing.
    const res = await post(t, page.form, bob, body(page.form, { grant: t.w.ids.aliceGrant }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBeNull();
    // An unknown workspace looks the same.
    const unknown = await authRequest(t, await register(t), { slug: 'no-such-team' });
    const u = await consentPage(t, unknown, bob);
    expect(u.form.html).toContain('no access to this workspace');
    // Deny is still there.
    expect(codeOf(await post(t, u.form, bob, body(u.form, { decision: 'deny' })))).toBeNull();
    await nothingIssued(t);
  });

  it('refuses a grant revoked or expired between the page and the post, and a disabled person’s session', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const r = await authRequest(t, await register(t));
    const { form } = await consentPage(t, r, cookie);
    await t.w.storage.grants.update(t.w.ids.aliceGrant, { revokedAt: Date.now() });
    const res = await post(t, form, cookie, body(form));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBeNull();
    // Expired grant: the page does not offer it.
    const r2 = await authRequest(t, await register(t), { slug: 'team-b' });
    await t.w.storage.grants.update(t.w.ids.aliceGrantB, { expiresAt: Date.now() - 1000 });
    const expired = await consentPage(t, r2, cookie);
    expect(expired.form.grants).toEqual([]);
    // A disabled person has no session any more: sign-in again, not a page.
    await t.w.storage.users.update(t.w.ids.alice, { disabledAt: Date.now() });
    await t.w.services.users.disable(t.w.ids.alice).catch(() => undefined);
    const gone = await open(t, await authRequest(t, await register(t)), cookie);
    expect(gone.status).toBe(303);
    expect(gone.headers.get('location')).toContain('/auth/login');
    await nothingIssued(t);
  });
});

describe('devices (P5-04, L-090, T15)', () => {
  it('a silent authorization revokes nothing; a device is replaced only after a successful code exchange', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const first = await connect(t, cookie, { name: 'Same app' });
    expect((await mcp(t, first.access)).status).toBe(200);
    // The same app asks again (a navigation, with or without prompt=none): the first device keeps working.
    const again = await authRequest(t, first.request.clientId);
    await open(t, again, cookie);
    await open(t, { ...again, path: `${again.path}&prompt=none` }, cookie);
    expect((await mcp(t, first.access)).status).toBe(200);
    // Approved but not redeemed: still nothing ends.
    const page = await consentPage(t, again, cookie);
    const approved = await post(t, page.form, cookie, body(page.form));
    const code = codeOf(approved) as string;
    expect((await mcp(t, first.access)).status).toBe(200);
    // Redeemed by the holder of the verifier: now the earlier device is replaced, and audited.
    const tokens = await exchange(t, again, code);
    expect(tokens.status).toBe(200);
    const second = ((await tokens.json()) as { access_token: string }).access_token;
    expect((await mcp(t, second)).status).toBe(200);
    expect((await mcp(t, first.access)).status).toBe(401);
    const refresh = await t.send('POST', '/oauth/token', {
      site: null,
      form: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: first.refresh,
        client_id: first.request.clientId,
      }).toString(),
    });
    expect(refresh.status).toBe(400);
    const replaced = (await t.rows()).filter((x) => x.action === 'oauth.device.replaced');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.userId).toBe(t.w.ids.alice);
  });

  it('keeps devices of different apps and different workspaces apart', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const a = await connect(t, cookie, { name: 'App one' });
    const b = await connect(t, cookie, { name: 'App two' });
    expect((await mcp(t, a.access)).status).toBe(200);
    expect((await mcp(t, b.access)).status).toBe(200);
    const csrf = await csrfOf(t, cookie);
    const list = (await (await api(t, cookie, csrf, 'GET', '/me/oauth-devices')).json()) as unknown[];
    expect(list).toHaveLength(2);
  });

  it('disconnecting ends the access token and the refresh token at once; only the owner can do it', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const mine = await connect(t, cookie, { name: 'Mine' });
    const csrf = await csrfOf(t, cookie);
    const list = (await (await api(t, cookie, csrf, 'GET', '/me/oauth-devices')).json()) as Array<{
      id: string;
    }>;
    const id = list[0]?.id as string;
    // Bob cannot see or disconnect it; it answers 404 and the device stays.
    const bob = await login(t, 'bob@example.test');
    const bobCsrf = await csrfOf(t, bob);
    expect(await (await api(t, bob, bobCsrf, 'GET', '/me/oauth-devices')).json()).toEqual([]);
    const refused = await api(t, bob, bobCsrf, 'POST', `/me/oauth-devices/${id}/revoke`);
    expect(refused.status).toBe(404);
    expect((await mcp(t, mine.access)).status).toBe(200);
    // Without the CSRF token, nothing happens either.
    const noCsrf = await t.send('POST', `${ADMIN_BASE}/me/oauth-devices/${id}/revoke`, { cookie });
    expect(noCsrf.status).toBe(403);
    expect((await mcp(t, mine.access)).status).toBe(200);
    // The owner disconnects it.
    const ok = await api(t, cookie, csrf, 'POST', `/me/oauth-devices/${id}/revoke`);
    expect(ok.status).toBe(200);
    expect((await mcp(t, mine.access)).status).toBe(401);
    const refresh = await t.send('POST', '/oauth/token', {
      site: null,
      form: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: mine.refresh,
        client_id: mine.request.clientId,
      }).toString(),
    });
    expect(refresh.status).toBe(400);
    expect(await (await api(t, cookie, csrf, 'GET', '/me/oauth-devices')).json()).toEqual([]);
    const rows = (await t.rows()).filter((x) => x.action === 'oauth.device.revoke');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(t.w.ids.alice);
    // The break-glass token has no person: refused.
    const bg = await t.send('GET', `${ADMIN_BASE}/me/oauth-devices`, {
      headers: { 'x-test-actor': 'break_glass' },
    });
    expect(bg.status).toBe(403);
  });

  it('a device disconnected on My access cannot refresh, not even with a token spent a moment ago (P5-05)', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const mine = await connect(t, cookie, { name: 'Mine' });
    const refresh = (token: string) =>
      t.send('POST', '/oauth/token', {
        site: null,
        form: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token,
          client_id: mine.request.clientId,
        }).toString(),
      });
    const rotated = await refresh(mine.refresh);
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { access_token: string; refresh_token: string };
    const csrf = await csrfOf(t, cookie);
    const list = (await (await api(t, cookie, csrf, 'GET', '/me/oauth-devices')).json()) as Array<{
      id: string;
    }>;
    expect((await api(t, cookie, csrf, 'POST', `/me/oauth-devices/${list[0]?.id}/revoke`)).status).toBe(200);
    // Inside the reuse window the spent token would be answered with the stored successor: not for a gone device.
    for (const token of [mine.refresh, next.refresh_token]) {
      const res = await refresh(token);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    }
    expect((await mcp(t, next.access_token)).status).toBe(401);
    expect((await mcp(t, mine.access)).status).toBe(401);
  });

  it('shows connected apps on My access, escaped, with a Disconnect form that works and "disconnect all"', async () => {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const a = await connect(t, cookie, { name: '<b>bold</b> app', label: 'Pixel <3' });
    const b = await connect(t, cookie, { name: 'Second app' });
    const page = await (await t.send('GET', '/admin/me', { cookie })).text();
    expect(page).toContain('Connected apps');
    expect(page).toContain('&lt;b&gt;bold&lt;/b&gt; app');
    expect(page).not.toContain('<b>bold</b>');
    expect(page).toContain('Pixel &lt;3');
    const csrf = attr(page, '_csrf') as string;
    const action = /action="(\/admin\/me\/oauth-devices\/[A-Za-z0-9_-]{16}\/revoke)"/.exec(
      page,
    )?.[1] as string;
    const res = await t.send('POST', action, {
      cookie,
      form: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    expect(res.status).toBe(303);
    expect([200, 401].filter((s) => s === 200).length).toBe(1);
    const statuses = [(await mcp(t, a.access)).status, (await mcp(t, b.access)).status].sort();
    expect(statuses).toEqual([200, 401]);
    const all = await t.send('POST', '/admin/me/oauth-devices/revoke-all', {
      cookie,
      form: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    expect(all.status).toBe(303);
    expect((await mcp(t, a.access)).status).toBe(401);
    expect((await mcp(t, b.access)).status).toBe(401);
  });

  /** A person with `n` connected apps already (approved, not necessarily redeemed), and a way to prepare more. */
  async function holder(n: number) {
    const t = await server();
    const cookie = await login(t, 'alice@example.test');
    const prepare = async (name: string) => {
      const r = await authRequest(t, await register(t, { name }));
      const { form } = await consentPage(t, r, cookie);
      return { r, form };
    };
    for (let i = 0; i < n; i++) {
      const { form } = await prepare(`app ${i}`);
      expect(codeOf(await post(t, form, cookie, body(form)))).not.toBeNull();
    }
    const listed = async () => {
      const csrf = await csrfOf(t, cookie);
      return (await (await api(t, cookie, csrf, 'GET', '/me/oauth-devices')).json()) as unknown[];
    };
    return { t, cookie, prepare, listed };
  }

  it('caps the devices one person can hold: the next approval is refused with a clear page and no code', async () => {
    const { t, cookie, prepare, listed } = await holder(25);
    expect(await listed()).toHaveLength(25);
    const last = await prepare('one too many');
    const full = await post(t, last.form, cookie, body(last.form));
    expect(codeOf(full)).toBeNull();
    expect(full.status).toBe(409);
    expect(await full.text()).toContain('Too many connected apps');
    expect(await listed()).toHaveLength(25);
    // Reconnecting an app that already holds a place needs no new one (it replaces its own after the exchange).
    const first = await authRequest(t, (await listed()).length > 0 ? await register(t) : '');
    expect(first.clientId).not.toBe('');
  }, 60_000);

  it('serializes approvals per person, and counts again after the insert so a lapsed lock cannot exceed the cap', async () => {
    const { t, cookie, prepare, listed } = await holder(23);
    // Three approvals race for two places: the lock lets one at a time through, the rest are told to try again.
    const forms = await Promise.all([prepare('x'), prepare('y'), prepare('z')]);
    const results = await Promise.all(forms.map((p) => post(t, p.form, cookie, body(p.form))));
    expect((await listed()).length).toBeLessThanOrEqual(25);
    expect(results.filter((res) => codeOf(res) !== null).length).toBe((await listed()).length - 23);
    // The same race with the lock neutralised (as after it lapsed): the oldest places keep theirs, the rest are undone.
    const loose = await holder(23);
    const kv = loose.t.w.storage.kv;
    const real = kv.setIfAbsent.bind(kv);
    const spy = vi
      .spyOn(kv, 'setIfAbsent')
      .mockImplementation((key, ...rest) =>
        key.startsWith('oauth-approving:') ? Promise.resolve(true) : real(key, ...rest),
      );
    try {
      const more = await Promise.all([loose.prepare('x'), loose.prepare('y'), loose.prepare('z')]);
      await Promise.all(more.map((p) => post(loose.t, p.form, loose.cookie, body(p.form))));
      // The stored grants themselves (the list is capped, so it could hide a 26th).
      const stored = await loose.t.w.storage.kv.list(`oauth:grant:${loose.t.w.ids.alice}:`);
      expect(stored.length).toBeLessThanOrEqual(25);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('refuses an approval while another one of the same person is in progress, and nothing is issued', async () => {
    const { t, cookie, prepare, listed } = await holder(0);
    const p = await prepare('busy');
    await t.w.storage.kv.set(`oauth-approving:${t.w.ids.alice}`, '1', { expiresAt: Date.now() + 60_000 });
    const res = await post(t, p.form, cookie, body(p.form));
    expect(codeOf(res)).toBeNull();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Another approval');
    expect(await listed()).toHaveLength(0);
    // The lock lapses (or is released) and the same person can approve.
    await t.w.storage.kv.delete(`oauth-approving:${t.w.ids.alice}`);
    const again = await prepare('free');
    expect(codeOf(await post(t, again.form, cookie, body(again.form)))).not.toBeNull();
  });
});

describe('without OAuth', () => {
  it('has no consent route and no connected-apps API', async () => {
    const t = await setup();
    expect((await t.send('POST', '/oauth/consent', { site: null })).status).toBe(404);
    const { cookie } = await t.session('alice@example.test');
    expect((await t.send('GET', `${ADMIN_BASE}/me/oauth-devices`, { cookie })).status).toBe(404);
    // And My access shows no such section.
    expect(await (await t.send('GET', '/admin/me', { cookie })).text()).not.toContain('Connected apps');
  });
});
