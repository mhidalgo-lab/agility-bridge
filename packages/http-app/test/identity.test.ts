// SPDX-License-Identifier: Apache-2.0
// Sign-in over HTTP (P4-01, THREAT_MODEL T14, T11): the routes against local fake identity providers, from the first
// redirect to the user row, with the refusals that keep a forged, replayed or misdirected login out.
import {
  createIdentityProviders,
  EMPTY_LOGIN_POLICY,
  type IdentityProvider,
  type LoginPolicy,
  type ProviderSettings,
} from '@agility-bridge/auth';
import { Secret, silentLogger } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import {
  type FakeAccess,
  type FakeGitHub,
  type FakeOidc,
  fakeAccess,
  fakeOidc,
  FakeGitHub as GitHub,
  route,
} from '../../auth/test/helpers/fake-idp.ts';
import {
  ADMIN_BASE,
  createRequestLimits,
  DEFAULT_RATE_LIMITS,
  type HttpAppOptions,
  MemoryRateLimiter,
  parseServerSettings,
  SettingsError,
  safeNextPath,
} from '../src/index.ts';
import { type World, world } from './helpers/world.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const HOST = '127.0.0.1:8787';

interface Setup {
  w: World;
  idp: FakeOidc;
  gh: FakeGitHub;
  access: FakeAccess;
  /** Requests that reached any fake identity provider. */
  upstream: string[];
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  post(path: string, body: string, headers?: Record<string, string>): Promise<Response>;
  admin(who: string, method: string, path: string, body?: unknown): Promise<Response>;
  /** Starts a redirect login: the IdP URL and the binding cookie. */
  start(provider: string, query?: string): Promise<{ location: URL; cookie: string; res: Response }>;
  /** A complete sign-in; returns the callback response. */
  signIn(provider: string, user?: Record<string, unknown>, cookieOverride?: string | null): Promise<Response>;
  providers: IdentityProvider[];
}

async function setup(
  options: {
    policy?: Partial<LoginPolicy>;
    publicUrl?: string;
    over?: Partial<HttpAppOptions>;
    onLogin?: NonNullable<HttpAppOptions['identity']>['onLogin'];
    limits?: HttpAppOptions['limits'];
    isolation?: 'request';
    only?: Array<'oidc' | 'github' | 'cf-access'>;
  } = {},
): Promise<Setup> {
  const idp = await fakeOidc({ issuer: 'https://login.example.test' });
  const gh = new GitHub();
  const access = await fakeAccess();
  const upstream: string[] = [];
  const inner = route(idp.handle, gh.handle, access.handle);
  const fetch = async (request: Request) => {
    upstream.push(`${request.method} ${request.url}`);
    return inner(request);
  };
  const all: ProviderSettings[] = [
    {
      kind: 'oidc',
      name: 'corp',
      label: 'Corporate login',
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: new Secret(idp.clientSecret),
    },
    { kind: 'github', clientId: gh.clientId, clientSecret: new Secret(gh.clientSecret) },
    { kind: 'cf-access', team: access.team, audience: access.audience },
  ];
  const wanted = options.only ?? ['oidc', 'github', 'cf-access'];
  const settings = all.filter((p) => (wanted as string[]).includes(p.kind));
  const policy: LoginPolicy = { ...EMPTY_LOGIN_POLICY, ...options.policy };
  const providers = createIdentityProviders({ providers: settings, policy }, { fetch });
  const publicUrl = options.publicUrl ?? ORIGIN;
  const w = await world(
    {
      identity: {
        publicUrl,
        providers,
        policy,
        audit: (e) => w.audit.login(e),
        ...(options.onLogin === undefined ? {} : { onLogin: options.onLogin }),
      },
      publicUrl,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
      ...options.over,
    },
    { admin: true },
  );
  const host = new URL(publicUrl).host;
  const get: Setup['get'] = (path, headers = {}) =>
    Promise.resolve(w.app.fetch(new Request(`${publicUrl}${path}`, { headers: { host, ...headers } })));
  const post: Setup['post'] = (path, body, headers = {}) =>
    Promise.resolve(
      w.app.fetch(
        new Request(`${publicUrl}${path}`, {
          method: 'POST',
          headers: { host, 'content-type': 'application/x-www-form-urlencoded', ...headers },
          body,
        }),
      ),
    );
  const admin: Setup['admin'] = (who, method, path, body) =>
    Promise.resolve(
      w.app.fetch(
        new Request(`${publicUrl}${ADMIN_BASE}${path}`, {
          method,
          headers: {
            host,
            'x-test-actor': who,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    );
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  const start: Setup['start'] = async (provider, query = '') => {
    const res = await get(`/auth/login/${provider}${query}`);
    if (res.status !== 302) throw new Error(`expected a redirect, got ${res.status}`);
    return { location: new URL(res.headers.get('location') as string), cookie: cookieOf(res), res };
  };
  const signIn: Setup['signIn'] = async (provider, user, cookieOverride) => {
    const { location, cookie } = await start(provider);
    const { code, state } = provider === 'github' ? gh.authorize(location) : idp.authorize(location, user);
    const sent = cookieOverride === undefined ? cookie : cookieOverride;
    return get(
      `/auth/callback/${provider}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      sent === null ? {} : { cookie: sent },
    );
  };
  return { w, idp, gh, access, upstream, get, post, admin, start, signIn, providers };
}

/** Users beyond the four the test world starts with. */
const newUsers = async (s: Setup) => (await s.w.storage.users.list()).length - 4;
const auditRows = async (s: Setup) => {
  await s.w.audit.flush();
  return s.w.storage.audit.query({ limit: 1_000 });
};
const loginRows = async (s: Setup) =>
  (await auditRows(s)).filter((r) => r.kind === 'auth' && r.action.startsWith('login.'));
const reasons = async (s: Setup) =>
  (await loginRows(s)).map((r) => (r.details as { reason?: string })?.reason);

describe('the chooser and the routes', () => {
  it('lists the providers with links, under a strict policy of its own', async () => {
    const s = await setup();
    const res = await s.get('/auth/login');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/auth/login/oidc-corp');
    expect(html).toContain('Continue with Corporate login');
    expect(html).toContain('/auth/login/github');
    expect(html).toContain('/auth/cf-access');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/ style=|<style/i);
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(s.upstream).toEqual([]);
  });

  it('is absent without a provider, and answers 404 for unknown or header-kind providers', async () => {
    const off = await world({}, {});
    expect(
      (await off.app.fetch(new Request(`${ORIGIN}/auth/login`, { headers: { host: HOST } }))).status,
    ).toBe(404);
    const s = await setup();
    for (const path of [
      '/auth/login/nope',
      '/auth/login/cf-access',
      '/auth/callback/nope',
      '/auth/callback/cf-access',
      '/auth/login/..%2f',
    ]) {
      expect((await s.get(path)).status, path).toBe(404);
    }
    expect(s.upstream).toEqual([]);
  });

  it('does not take the Authorization header for an identity', async () => {
    const s = await setup();
    const res = await s.get('/auth/callback/oidc-corp?code=x&state=y', { authorization: 'Bearer anything' });
    expect(res.status).toBe(400);
    expect(await newUsers(s)).toBe(0);
  });
});

describe('a redirect login', () => {
  it('goes to the IdP with PKCE, state and nonce, and sets a browser-binding cookie', async () => {
    const s = await setup();
    const { location, res } = await s.start('oidc-corp');
    expect(location.origin + location.pathname).toBe('https://login.example.test/authorize');
    const q = location.searchParams;
    expect(q.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback/oidc-corp`);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('nonce')).toBeTruthy();
    const cookie = res.headers.get('set-cookie') as string;
    expect(cookie).toMatch(/^ab_login=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/);
    // The binding value never travels to the IdP.
    expect(location.href).not.toContain(cookie.split(';')[0]?.split('=')[1] as string);
  });

  it('uses a __Host- cookie with Secure on https', async () => {
    const s = await setup({ publicUrl: 'https://bridge.example.test' });
    const { res } = await s.start('oidc-corp');
    expect(res.headers.get('set-cookie')).toMatch(
      /^__Host-ab_login=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/,
    );
  });

  it('signs in a user created by an admin, binds the identity, clears the cookie and audits without identifiers', async () => {
    const s = await setup();
    await s.w.storage.users.create({ id: 'u-ann', email: 'ann@example.test', role: 'admin' });
    const res = await s.signIn('oidc-corp');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Signed in as ann@example.test (admin)');
    expect(res.headers.get('set-cookie')).toMatch(/^ab_login=; Path=\/; Max-Age=0;/);
    expect(await s.w.storage.users.getByIdentity('oidc:corp', 'subject-1')).toMatchObject({
      id: 'u-ann',
      role: 'admin',
    });
    const [row] = await loginRows(s);
    expect(row).toMatchObject({ kind: 'auth', action: 'login.ok', status: 'ok', userId: 'u-ann' });
    expect(row?.details).toMatchObject({ provider: 'oidc-corp', idp: 'oidc:corp', outcome: 'linked' });
    const details = row?.details as { identityHash: string };
    expect(details.identityHash).toMatch(/^v1\.[0-9a-f]{32}$/);
    const text = JSON.stringify(await auditRows(s)) + s.w.logs.join('\n');
    expect(text).not.toContain('subject-1');
    expect(text).not.toContain('ann@example.test');
  });

  it('keeps one hash per identity, so repeated attempts can be correlated', async () => {
    const s = await setup();
    await s.signIn('oidc-corp');
    await s.signIn('oidc-corp');
    await s.signIn('oidc-corp', { sub: 'other' });
    const hashes = (await loginRows(s)).map((r) => (r.details as { identityHash: string }).identityHash);
    // Two attempts by one identity share a hash; the third, by another subject, does not.
    expect(hashes).toHaveLength(3);
    expect(new Set(hashes).size).toBe(2);
  });

  it('hands the verified user and a validated next path to onLogin', async () => {
    const seen: Array<{ next: string; role: string; provider: string }> = [];
    const s = await setup({
      onLogin: (_c, login) => {
        seen.push({ next: login.next, role: login.user.role, provider: login.provider });
        return new Response('welcome');
      },
      policy: { emails: ['ann@example.test'], autoProvision: 'member' },
    });
    const { location, cookie } = await s.start(
      'oidc-corp',
      `?next=${encodeURIComponent('/admin/users?page=2')}`,
    );
    const { code, state } = s.idp.authorize(location);
    const res = await s.get(`/auth/callback/oidc-corp?code=${code}&state=${state}`, { cookie });
    expect(await res.text()).toBe('welcome');
    expect(seen).toEqual([{ next: '/admin/users?page=2', role: 'member', provider: 'oidc-corp' }]);
  });

  it('refuses an IdP error answer, a missing code and a malformed state, spending the transaction first', async () => {
    const s = await setup();
    const a = await s.start('oidc-corp');
    const state = a.location.searchParams.get('state') as string;
    const denied = await s.get(`/auth/callback/oidc-corp?error=access_denied&state=${state}`, {
      cookie: a.cookie,
    });
    expect(denied.status).toBe(403);
    const retry = await s.get(`/auth/callback/oidc-corp?code=c&state=${state}`, { cookie: a.cookie });
    expect(retry.status).toBe(400);
    const b = await s.start('oidc-corp');
    const noCode = await s.get(`/auth/callback/oidc-corp?state=${b.location.searchParams.get('state')}`, {
      cookie: b.cookie,
    });
    expect(noCode.status).toBe(400);
    for (const q of [
      '',
      '?state=short',
      `?code=c&state=${'a'.repeat(44)}`,
      `?code=${'c'.repeat(3000)}&state=${state}`,
    ]) {
      expect((await s.get(`/auth/callback/oidc-corp${q}`, { cookie: a.cookie })).status, q).toBe(400);
    }
    expect(await reasons(s)).toEqual(
      expect.arrayContaining(['idp_error', 'unknown_state', 'invalid_callback']),
    );
    expect(await newUsers(s)).toBe(0);
  });
});

describe('replays and misdirected logins', () => {
  it('refuses a replayed callback: the code and state work once', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'], autoProvision: 'member' } });
    const { location, cookie } = await s.start('oidc-corp');
    const { code, state } = s.idp.authorize(location);
    const url = `/auth/callback/oidc-corp?code=${code}&state=${state}`;
    expect((await s.get(url, { cookie })).status).toBe(200);
    const upstreamBefore = s.upstream.length;
    const again = await s.get(url, { cookie });
    expect(again.status).toBe(400);
    expect(await again.text()).not.toContain('Signed in as');
    // The replay never reached the IdP and made no session or user.
    expect(s.upstream.length).toBe(upstreamBefore);
    expect(await newUsers(s)).toBe(1);
  });

  it('lets exactly one of ten parallel callbacks through', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'], autoProvision: 'member' } });
    const { location, cookie } = await s.start('oidc-corp');
    const { code, state } = s.idp.authorize(location);
    const url = `/auth/callback/oidc-corp?code=${code}&state=${state}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => s.get(url, { cookie })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(9);
    expect(upstreamTokenCalls(s)).toBe(1);
  });

  it('refuses another browser (no cookie, someone else’s cookie, a duplicated cookie) without calling the IdP', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'], autoProvision: 'member' } });
    const other = await s.start('oidc-corp');
    for (const cookie of [null, other.cookie, 'ab_login=short', `${other.cookie}; ${other.cookie}`]) {
      const mine = await s.start('oidc-corp');
      const { code, state } = s.idp.authorize(mine.location);
      const before = s.upstream.length;
      const res = await s.get(
        `/auth/callback/oidc-corp?code=${code}&state=${state}`,
        cookie === null ? {} : { cookie },
      );
      expect(res.status, String(cookie)).toBe(400);
      expect(s.upstream.length).toBe(before);
    }
    // A cookie named twice is no cookie, even when one of them is the right one (L-189).
    const mine = await s.start('oidc-corp');
    const { code, state } = s.idp.authorize(mine.location);
    const dup = await s.get(`/auth/callback/oidc-corp?code=${code}&state=${state}`, {
      cookie: `${mine.cookie}; ${mine.cookie}`,
    });
    expect(dup.status).toBe(400);
    expect(await reasons(s)).toContain('binding_mismatch');
    expect(await newUsers(s)).toBe(0);
  });

  it('refuses a state of one provider at the callback of another (mix-up)', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'], autoProvision: 'member' } });
    const { location, cookie } = await s.start('oidc-corp');
    const { code, state } = s.idp.authorize(location);
    const before = s.upstream.length;
    const res = await s.get(`/auth/callback/github?code=${code}&state=${state}`, { cookie });
    expect(res.status).toBe(400);
    expect(s.upstream.length).toBe(before);
    expect(await reasons(s)).toContain('provider_mismatch');
  });

  it('refuses a callback that names another issuer (RFC 9207)', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'], autoProvision: 'member' } });
    const { location, cookie } = await s.start('oidc-corp');
    const { code, state } = s.idp.authorize(location);
    const res = await s.get(
      `/auth/callback/oidc-corp?code=${code}&state=${state}&iss=${encodeURIComponent('https://evil.example.test')}`,
      { cookie },
    );
    expect(res.status).toBe(403);
    expect(await reasons(s)).toContain('issuer_mismatch');
  });

  it('a started login expires after ten minutes', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'], autoProvision: 'member' } });
    const { location, cookie } = await s.start('oidc-corp');
    const { code, state } = s.idp.authorize(location);
    s.w.now.t += 601_000;
    const res = await s.get(`/auth/callback/oidc-corp?code=${code}&state=${state}`, { cookie });
    expect(res.status).toBe(400);
    expect(await s.w.storage.users.getByEmail('ann@example.test')).toBeNull();
  });
});

function upstreamTokenCalls(s: Setup): number {
  return s.upstream.filter((u) => u.startsWith('POST') && u.endsWith('/token')).length;
}

describe('who gets in', () => {
  it('nobody by default: an unknown identity is refused and nothing is created', async () => {
    const s = await setup();
    const res = await s.signIn('oidc-corp');
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Sign-in was refused');
    expect(html).not.toContain('ann@example.test');
    expect(await reasons(s)).toEqual(['not_allowed']);
    expect(await s.w.storage.users.getByEmail('ann@example.test')).toBeNull();
  });

  it('an allowlist without auto-provisioning still admits nobody new', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'] } });
    expect((await s.signIn('oidc-corp')).status).toBe(403);
    expect(await reasons(s)).toEqual(['not_provisioned']);
    expect(await s.w.storage.users.getByEmail('ann@example.test')).toBeNull();
  });

  it('an allowlisted identity is provisioned as configured', async () => {
    const s = await setup({ policy: { domains: ['example.test'], autoProvision: 'member' } });
    const res = await s.signIn('oidc-corp');
    expect(res.status).toBe(200);
    expect(await s.w.storage.users.getByEmail('ann@example.test')).toMatchObject({
      role: 'member',
      idp: 'oidc:corp',
    });
    expect((await loginRows(s))[0]?.details).toMatchObject({ outcome: 'provisioned' });
  });

  it('refuses an identity conflict, whatever the allowlist says', async () => {
    const s = await setup({ policy: { domains: ['example.test'], autoProvision: 'admin' } });
    await s.w.storage.users.create({
      id: 'u-ann',
      email: 'ann@example.test',
      role: 'owner',
      idp: 'github',
      idpSubject: '99',
    });
    const res = await s.signIn('oidc-corp');
    expect(res.status).toBe(403);
    expect(await reasons(s)).toEqual(['identity_conflict']);
    expect(await s.w.storage.users.getByIdentity('oidc:corp', 'subject-1')).toBeNull();
    expect((await s.w.storage.users.get('u-ann'))?.idp).toBe('github');
  });

  it('refuses a disabled user and an unverified email', async () => {
    const s = await setup({ policy: { domains: ['example.test'], autoProvision: 'member' } });
    await s.w.storage.users.create({ id: 'u-off', email: 'off@example.test', role: 'member', disabledAt: 5 });
    expect((await s.signIn('oidc-corp', { email: 'off@example.test', sub: 'sub-off' })).status).toBe(403);
    expect((await s.signIn('oidc-corp', { email_verified: false })).status).toBe(403);
    expect((await reasons(s)).sort()).toEqual(['email_unverified', 'user_disabled']);
    expect(await s.w.storage.users.getByEmail('ann@example.test')).toBeNull();
  });

  it('refuses a forged ID token and creates nothing', async () => {
    const s = await setup({ policy: { domains: ['example.test'], autoProvision: 'member' } });
    s.idp.nextClaims = { aud: 'someone-else' };
    expect((await s.signIn('oidc-corp')).status).toBe(403);
    expect(await reasons(s)).toEqual(['wrong_audience']);
    expect(await s.w.storage.users.getByEmail('ann@example.test')).toBeNull();
  });

  it('GitHub: signs in with a verified primary email and revokes the token in the background', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'], autoProvision: 'member' } });
    const res = await s.signIn('github');
    expect(res.status).toBe(200);
    expect(await s.w.storage.users.getByIdentity('github', '4242')).toMatchObject({
      email: 'ann@example.test',
    });
    expect(s.gh.revocations).toHaveLength(1);
    expect(s.gh.liveTokens).toBe(0);
  });

  it('GitHub: refuses an unverified primary email and still revokes the token', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'], autoProvision: 'member' } });
    s.gh.user.emails = [{ email: 'ann@example.test', primary: true, verified: false }];
    expect((await s.signIn('github')).status).toBe(403);
    expect(await reasons(s)).toEqual(['email_unverified']);
    expect(s.gh.liveTokens).toBe(0);
    expect(await newUsers(s)).toBe(0);
  });

  it('GitHub: an organization allowlist needs active membership', async () => {
    const s = await setup({ policy: { githubOrgs: ['acme'], autoProvision: 'member' } });
    s.gh.user.orgs = { acme: 'pending' };
    expect((await s.signIn('github')).status).toBe(403);
    s.gh.user.orgs = { acme: 'active' };
    expect((await s.signIn('github')).status).toBe(200);
  });

  it('an identity provider that is down is a 502 page, not a stack trace', async () => {
    const s = await setup();
    s.idp.tokenFailure = new Response('boom', { status: 500 });
    const res = await s.signIn('oidc-corp');
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('could not be reached');
    s.idp.tokenFailure = undefined;
  });
});

describe('Cloudflare Access', () => {
  const policy = { emails: ['ann@example.test'], autoProvision: 'member' as const };

  it('signs in from a verified assertion header', async () => {
    const s = await setup({ policy });
    const res = await s.get('/auth/cf-access', { 'cf-access-jwt-assertion': await s.access.assertion() });
    expect(res.status).toBe(200);
    expect(await s.w.storage.users.getByIdentity('cf-access', 'access-subject-1')).toMatchObject({
      role: 'member',
    });
  });

  it('refuses a missing, forged or misdirected assertion and an allowlist miss', async () => {
    const s = await setup({ policy });
    expect((await s.get('/auth/cf-access')).status).toBe(403);
    expect((await s.get('/auth/cf-access', { 'cf-access-jwt-assertion': 'garbage' })).status).toBe(403);
    expect(
      (
        await s.get('/auth/cf-access', {
          'cf-access-jwt-assertion': await s.access.assertion({ aud: ['other-application-tag-0123456789'] }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await s.get('/auth/cf-access', {
          'cf-access-jwt-assertion': await s.access.assertion({ email: 'eve@example.test', sub: 'e' }),
        })
      ).status,
    ).toBe(403);
    expect((await reasons(s)).sort()).toEqual([
      'invalid_token',
      'missing_assertion',
      'not_allowed',
      'wrong_audience',
    ]);
    expect(await s.w.storage.users.getByEmail('eve@example.test')).toBeNull();
    expect(await s.w.storage.users.getByEmail('ann@example.test')).toBeNull();
  });

  it('is 404 when Access is not configured', async () => {
    const s = await setup({ only: ['oidc'] });
    expect((await s.get('/auth/cf-access')).status).toBe(404);
  });
});

describe('redirect targets (L-091)', () => {
  const ok: Array<[string, string]> = [
    ['/admin', '/admin'],
    ['/admin/users?page=2#top', '/admin/users?page=2#top'],
    ['/oauth/authorize?client_id=a&state=b', '/oauth/authorize?client_id=a&state=b'],
    ['/a/./b', '/a/b'],
    ['/a/b/../c', '/a/c'],
    ['/admin//users', '/admin//users'],
    // A percent-encoded backslash is not a separator for a browser: still a path on this origin.
    ['/%5cevil.example', '/%5cevil.example'],
  ];
  const evil = [
    '//evil.example',
    '//evil.example/x',
    '/\\evil.example',
    '/\\/evil.example',
    '\\\\evil.example',
    '/.//evil.example/x',
    '/..//evil.example',
    '/a/..//evil.example',
    '/%2e//evil.example',
    '/%2E/%2e//evil.example',
    '/./\\evil.example',
    'https://evil.example',
    'http://evil.example/admin',
    'javascript:alert(1)',
    'data:text/html,x',
    'admin',
    '',
    '/ admin',
    '/admin\r\nSet-Cookie: x=1',
    '/admin\nx',
    '/admin\tx',
    '/\u0000',
    '/é',
    `/${'a'.repeat(2100)}`,
    ' /admin',
  ];

  it('keeps local paths, normalised', () => {
    for (const [input, expected] of ok) expect(safeNextPath(input, ORIGIN), input).toBe(expected);
  });

  it('never returns anything that could leave the origin', () => {
    for (const input of evil) {
      const result = safeNextPath(input, ORIGIN);
      // Either refused, or a path that stays on this origin once parsed again.
      if (result !== null) {
        expect(result.startsWith('/') && !result.startsWith('//') && !result.startsWith('/\\'), input).toBe(
          true,
        );
        expect(new URL(result, ORIGIN).origin, input).toBe(ORIGIN);
      }
    }
    for (const input of evil.filter(
      (e) => /evil|javascript|data:|\r|\n|\t|\\/.test(e) || e === '' || e === 'admin',
    )) {
      expect(safeNextPath(input, ORIGIN), input).toBeNull();
    }
    expect(safeNextPath(undefined, ORIGIN)).toBeNull();
  });

  it('falls back to /admin end to end: every hostile next ends up local', async () => {
    const seen: string[] = [];
    const s = await setup({
      policy: { emails: ['ann@example.test'], autoProvision: 'member' },
      onLogin: (_c, login) => {
        seen.push(login.next);
        return new Response('ok');
      },
    });
    for (const next of evil) {
      const { location, cookie } = await s.start('oidc-corp', `?next=${encodeURIComponent(next)}`);
      const { code, state } = s.idp.authorize(location);
      await s.get(`/auth/callback/oidc-corp?code=${code}&state=${state}`, { cookie });
    }
    expect(seen).toHaveLength(evil.length);
    for (const next of seen) expect(next === '/admin' || /^\/(?![/\\])/.test(next)).toBe(true);
    for (const next of seen) expect(next).not.toMatch(/evil/);
  });
});

describe('owner setup links (L-085)', () => {
  const idpOwner = { email: 'first@example.test', sub: 'sub-first' };

  async function link(
    s: Setup,
    body: unknown = {},
  ): Promise<{ url: string; code: string; expiresAt: number; id: string }> {
    const res = await s.admin('break_glass', 'POST', '/setup-links', body);
    expect(res.status).toBe(201);
    const { url, expiresAt, id } = (await res.json()) as { url: string; expiresAt: number; id: string };
    return { url, expiresAt, id, code: new URL(url).hash.slice(1) };
  }
  const form = (code: string, provider = 'oidc-corp') =>
    `code=${encodeURIComponent(code)}&provider=${provider}`;

  it('puts the code in the URL fragment, never in the path or query', async () => {
    const s = await setup();
    const { url, code } = await link(s);
    expect(url).toBe(`${ORIGIN}/auth/setup#${code}`);
    expect(code).toMatch(/^ab_setup_[0-9a-f]{64}$/);
    const u = new URL(url);
    expect(u.search).toBe('');
    expect(u.pathname).toBe('/auth/setup');
  });

  it('serves a setup page whose only script is a same-origin file, and that file moves the fragment into the form', async () => {
    const s = await setup();
    const page = await s.get('/auth/setup');
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toMatch(/<form method="post" action="\/auth\/setup"/);
    expect(html).toContain('type="password"');
    expect(html.match(/<script[^>]*>/g)).toEqual(['<script src="/auth/setup.js">']);
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
    expect(html).toContain('name="provider" value="oidc-corp"');
    const script = await s.get('/auth/setup.js');
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
    const js = await script.text();
    expect(js).toContain('location.hash');
    expect(js).toContain('history.replaceState');
    // The script never sends the code anywhere itself: no network API.
    expect(js).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|WebSocket|\.src\s*=/);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('makes the first sign-in an owner, once; the link is then used up', async () => {
    const s = await setup();
    const { code } = await link(s);
    const start = await s.post('/auth/setup', form(code));
    expect(start.status).toBe(303);
    const location = new URL(start.headers.get('location') as string);
    expect(location.origin).toBe('https://login.example.test');
    // The code is in no URL the server produced or saw.
    expect(location.href).not.toContain(code);
    expect(start.headers.get('location')).not.toContain('ab_setup');
    const cookie = (start.headers.get('set-cookie') as string).split(';')[0] as string;
    const { code: authCode, state } = s.idp.authorize(location, idpOwner);
    const done = await s.get(`/auth/callback/oidc-corp?code=${authCode}&state=${state}`, { cookie });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('first@example.test (owner)');
    expect(await s.w.storage.users.getByEmail('first@example.test')).toMatchObject({
      role: 'owner',
      idp: 'oidc:corp',
    });
    expect((await loginRows(s))[0]?.details).toMatchObject({ outcome: 'owner_bootstrap' });

    const again = await s.post('/auth/setup', form(code));
    expect(again.status).toBe(400);
    expect(again.headers.get('location')).toBeNull();
    expect(await reasons(s)).toContain('setup_invalid');
  });

  it('is consumed once even when ten sign-ins started from it finish at the same time', async () => {
    const s = await setup();
    const { code } = await link(s);
    const started = await Promise.all(
      Array.from({ length: 10 }, async (_v, i) => {
        const res = await s.post('/auth/setup', form(code));
        const location = new URL(res.headers.get('location') as string);
        const cookie = (res.headers.get('set-cookie') as string).split(';')[0] as string;
        return { cookie, ...s.idp.authorize(location, { email: `owner${i}@example.test`, sub: `sub-${i}` }) };
      }),
    );
    const results = await Promise.all(
      started.map((a) =>
        s.get(`/auth/callback/oidc-corp?code=${a.code}&state=${a.state}`, { cookie: a.cookie }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      (await s.w.storage.users.list()).filter((u) => u.role === 'owner' && /^owner\d@/.test(u.email)),
    ).toHaveLength(1);
  });

  it('expires', async () => {
    const s = await setup();
    const { code } = await link(s, { ttlMinutes: 5 });
    s.w.now.t += 5 * 60_000 + 1_000;
    const res = await s.post('/auth/setup', form(code));
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await s.w.storage.kv.list('login:')).toEqual([]);
  });

  it('a link that expired while the browser was at the IdP is refused at the callback', async () => {
    const s = await setup();
    const { code } = await link(s, { ttlMinutes: 5 });
    const start = await s.post('/auth/setup', form(code));
    const location = new URL(start.headers.get('location') as string);
    const cookie = (start.headers.get('set-cookie') as string).split(';')[0] as string;
    const { code: authCode, state } = s.idp.authorize(location, idpOwner);
    s.w.now.t += 5 * 60_000 + 1_000;
    const done = await s.get(`/auth/callback/oidc-corp?code=${authCode}&state=${state}`, { cookie });
    expect(done.status).toBe(400);
    expect(await s.w.storage.users.getByEmail('first@example.test')).toBeNull();
  });

  it('refuses malformed, unknown and foreign codes before any storage lookup', async () => {
    const s = await setup();
    for (const code of [
      '',
      'x',
      `ab_setup_${'a'.repeat(64)}`,
      `ab_setup_${'a'.repeat(63)}`,
      `AB_SETUP_${'a'.repeat(64)}`,
    ]) {
      const res = await s.post('/auth/setup', form(code));
      expect(res.status, code).toBe(400);
    }
    expect(await s.w.storage.kv.list('login:')).toEqual([]);
    expect(s.upstream).toEqual([]);
    // Unknown provider.
    const { code } = await link(s);
    expect((await s.post('/auth/setup', form(code, 'nope'))).status).toBe(400);
    expect((await s.post('/auth/setup', `code=${code}`)).status).toBe(400);
  });

  it('does not accept the code in the query string or on the login routes', async () => {
    const s = await setup();
    const { code } = await link(s);
    const q = await s.get(`/auth/login/oidc-corp?setup=${code}`);
    expect(q.status).toBe(302);
    const { code: authCode, state } = s.idp.authorize(new URL(q.headers.get('location') as string), idpOwner);
    const cookie = (q.headers.get('set-cookie') as string).split(';')[0] as string;
    await s.get(`/auth/callback/oidc-corp?code=${authCode}&state=${state}`, { cookie });
    // An ordinary login: not allowed, so no owner was made.
    expect(await s.w.storage.users.getByEmail('first@example.test')).toBeNull();
    const res = await s.post('/auth/setup', form(code));
    expect(res.status).toBe(303);
  });

  it('refuses a cross-site, wrongly typed or oversized form', async () => {
    const s = await setup();
    const { code } = await link(s);
    const before = s.upstream.length;
    expect((await s.post('/auth/setup', form(code), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await s.post('/auth/setup', form(code), { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await s.post('/auth/setup', form(code), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await s.post('/auth/setup', form(code), { 'content-type': 'application/json' })).status).toBe(
      415,
    );
    expect((await s.post('/auth/setup', `${form(code)}&pad=${'x'.repeat(5_000)}`)).status).toBe(413);
    expect(s.upstream.length).toBe(before);
    expect(await s.w.storage.kv.list('login:')).toEqual([]);
    // The link is untouched by all of that.
    expect((await s.post('/auth/setup', form(code), { 'sec-fetch-site': 'same-origin' })).status).toBe(303);
  });

  it('does not touch a disabled user or an identity conflict, and uses the link up', async () => {
    const s = await setup();
    await s.w.storage.users.create({
      id: 'u-off',
      email: 'first@example.test',
      role: 'member',
      disabledAt: 5,
    });
    const { code } = await link(s);
    const start = await s.post('/auth/setup', form(code));
    const cookie = (start.headers.get('set-cookie') as string).split(';')[0] as string;
    const { code: authCode, state } = s.idp.authorize(
      new URL(start.headers.get('location') as string),
      idpOwner,
    );
    const done = await s.get(`/auth/callback/oidc-corp?code=${authCode}&state=${state}`, { cookie });
    expect(done.status).toBe(403);
    expect((await s.w.storage.users.get('u-off'))?.role).toBe('member');
    expect((await s.post('/auth/setup', form(code))).status).toBe(400);
  });

  it('works through Cloudflare Access too', async () => {
    const s = await setup({ only: ['cf-access'] });
    const { code } = await link(s);
    const res = await s.post('/auth/setup', form(code, 'cf-access'), {
      'cf-access-jwt-assertion': await s.access.assertion(),
    });
    expect(res.status).toBe(200);
    expect(await s.w.storage.users.getByIdentity('cf-access', 'access-subject-1')).toMatchObject({
      role: 'owner',
    });
    expect(
      (
        await s.post('/auth/setup', form(code, 'cf-access'), {
          'cf-access-jwt-assertion': await s.access.assertion(),
        })
      ).status,
    ).toBe(400);
  });

  it('never appears in storage, audit rows, logs or responses other than the one that issued it', async () => {
    const s = await setup();
    const { code, id } = await link(s);
    const start = await s.post('/auth/setup', form(code));
    const cookie = (start.headers.get('set-cookie') as string).split(';')[0] as string;
    const { code: authCode, state } = s.idp.authorize(
      new URL(start.headers.get('location') as string),
      idpOwner,
    );
    const done = await s.get(`/auth/callback/oidc-corp?code=${authCode}&state=${state}`, { cookie });
    await s.post('/auth/setup', form(code));
    const bodies = [await start.text(), await done.text()].join('\n');
    const kv = JSON.stringify(
      await Promise.all((await s.w.storage.kv.list('')).map(async (k) => [k, await s.w.storage.kv.get(k)])),
    );
    const everything = [bodies, kv, JSON.stringify(await auditRows(s)), s.w.logs.join('\n')].join('\n');
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(code.slice('ab_setup_'.length));
    // The audit row of the issue names the link by a short hash prefix.
    expect(JSON.stringify(await auditRows(s))).toContain(id);
  });

  describe('creating one', () => {
    it('is for owners (with a recent sign-in) and the break-glass token only', async () => {
      const s = await setup();
      for (const who of ['member', 'admin', 'owner_stale']) {
        const res = await s.admin(who, 'POST', '/setup-links', {});
        expect(res.status, who).toBe(403);
      }
      expect((await s.admin('none', 'POST', '/setup-links', {})).status).toBe(401);
      expect(await s.w.storage.kv.list('setup:')).toEqual([]);
      expect((await s.admin('owner', 'POST', '/setup-links', {})).status).toBe(201);
      expect((await s.admin('break_glass', 'POST', '/setup-links', {})).status).toBe(201);
      expect(await s.w.storage.kv.list('setup:')).toHaveLength(2);
    });

    it('audits who created it, without the code', async () => {
      const s = await setup();
      const { code } = await link(s);
      const rows = (await auditRows(s)).filter((r) => r.action === 'setup_link.create');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'admin', status: 'ok', targetType: 'setup_link' });
      expect(JSON.stringify(rows)).not.toContain(code);
    });

    it('limits the lifetime and refuses unknown fields', async () => {
      const s = await setup();
      for (const body of [
        { ttlMinutes: 0 },
        { ttlMinutes: 10_081 },
        { ttlMinutes: 1.5 },
        { ttlMinutes: '5' },
        { other: 1 },
      ]) {
        expect(
          (await s.admin('break_glass', 'POST', '/setup-links', body)).status,
          JSON.stringify(body),
        ).toBe(422);
      }
      const res = await s.admin('break_glass', 'POST', '/setup-links', { ttlMinutes: 30 });
      const { expiresAt } = (await res.json()) as { expiresAt: number };
      expect(expiresAt).toBe(s.w.now.t + 30 * 60_000);
    });

    it('answers 409 when sign-in is not configured, after the owner check', async () => {
      const off = await world({}, { admin: true });
      const call = (who: string) =>
        off.app.fetch(
          new Request(`${ORIGIN}${ADMIN_BASE}/setup-links`, {
            method: 'POST',
            headers: { host: HOST, 'x-test-actor': who },
          }),
        );
      expect((await call('break_glass')).status).toBe(409);
      expect((await call('member')).status).toBe(403);
      expect(await off.storage.kv.list('setup:')).toEqual([]);
    });
  });
});

describe('abuse limits', () => {
  it('limits sign-in starts per address before touching storage or the IdP', async () => {
    let allowed = 3;
    const s = await setup({
      limits: {
        beforeSignIn: () => (allowed-- > 0 ? { ok: true } : { ok: false, retryAfterSeconds: 42 }),
      },
    });
    for (let i = 0; i < 3; i++) expect((await s.get('/auth/login/oidc-corp')).status).toBe(302);
    const before = (await s.w.storage.kv.list('login:')).length;
    const upstream = s.upstream.length;
    const res = await s.get('/auth/login/oidc-corp');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect((await s.get('/auth/callback/oidc-corp?code=a&state=b')).status).toBe(429);
    expect((await s.post('/auth/setup', 'code=x&provider=oidc-corp')).status).toBe(429);
    expect((await s.w.storage.kv.list('login:')).length).toBe(before);
    expect(s.upstream.length).toBe(upstream);
    // The setup script is a static file and stays reachable.
    expect((await s.get('/auth/setup.js')).status).toBe(200);
  });

  it('counts starts per address with the real sign-in rule (default 60 per 5 minutes), by IPv6 /64', async () => {
    const limits = createRequestLimits(
      new MemoryRateLimiter(),
      { ...DEFAULT_RATE_LIMITS, signInPer5Minutes: 3 },
      silentLogger,
    );
    const s = await setup({ limits, over: { clientIp: (c) => c.req.header('x-test-ip') ?? 'unknown' } });
    const from = (ip: string) => ({ 'x-test-ip': ip });
    for (let i = 0; i < 3; i++) expect((await s.get('/auth/login', from('203.0.113.7'))).status).toBe(200);
    const refused = await s.get('/auth/login/oidc-corp', from('203.0.113.7'));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await s.get('/auth/login', from('203.0.113.8'))).status).toBe(200);
    // Rotating through one IPv6 /64 does not reset the budget.
    for (let i = 0; i < 3; i++)
      expect((await s.get('/auth/login', from(`2001:db8:1:2::${i + 1}`))).status).toBe(200);
    expect((await s.get('/auth/login', from('2001:db8:1:2::99'))).status).toBe(429);
    expect(DEFAULT_RATE_LIMITS.signInPer5Minutes).toBe(60);
  });

  it('is off with AB_RATE_LIMIT=off', async () => {
    const limits = createRequestLimits(
      new MemoryRateLimiter(),
      { ...DEFAULT_RATE_LIMITS, enabled: false, signInPer5Minutes: 1 },
      silentLogger,
    );
    const s = await setup({ limits });
    for (let i = 0; i < 5; i++) expect((await s.get('/auth/login')).status).toBe(200);
  });

  it('also honours the general per-address limit', async () => {
    const s = await setup({ limits: { beforeAuth: () => ({ ok: false, retryAfterSeconds: 7 }) } });
    expect((await s.get('/auth/login')).status).toBe(429);
  });
});

describe('what never leaks', () => {
  it('keeps codes, tokens, cookies and client secrets out of logs, audit rows and pages', async () => {
    const s = await setup({ policy: { emails: ['ann@example.test'], autoProvision: 'member' } });
    const { location, cookie } = await s.start('oidc-corp');
    const { code, state } = s.idp.authorize(location);
    const ok = await s.get(`/auth/callback/oidc-corp?code=${code}&state=${state}`, { cookie });
    const bad = await s.get(`/auth/callback/oidc-corp?code=${code}&state=${state}`, { cookie });
    const gh = await s.signIn('github');
    s.idp.tokenFailure = new Response(JSON.stringify({ error: 'x', error_description: s.idp.clientSecret }), {
      status: 400,
    });
    const failed = await s.signIn('oidc-corp');
    const everything = [
      await ok.text(),
      await bad.text(),
      await gh.text(),
      await failed.text(),
      JSON.stringify(await auditRows(s)),
      s.w.logs.join('\n'),
    ].join('\n');
    const bindingValue = cookie.split('=')[1] as string;
    for (const secret of [
      code,
      state,
      bindingValue,
      s.idp.clientSecret,
      s.gh.clientSecret,
      s.gh.revocations[0]?.token ?? 'none',
    ]) {
      expect(everything, secret.slice(0, 8)).not.toContain(secret);
    }
  });

  it('answers failures with the same generic page and only the request id as detail', async () => {
    const s = await setup();
    const a = await s.get('/auth/callback/oidc-corp?code=a&state=b');
    const html = await a.text();
    expect(html).toContain('Sign-in failed');
    expect(html).toMatch(/Request id: [0-9a-f-]{36}/);
    expect(a.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(html).not.toMatch(/stack|Error:|at \w+ \(/);
  });
});

describe('on Workers (request isolation)', () => {
  it('serves the same routes with the lightweight router', async () => {
    const s = await setup({ isolation: 'request', over: { background: () => {} } });
    expect((await s.get('/auth/login')).status).toBe(200);
    expect((await s.start('oidc-corp')).location.hostname).toBe('login.example.test');
    expect((await s.get('/auth/setup')).status).toBe(200);
  });
});

describe('settings (parseServerSettings)', () => {
  const env = {
    AB_PUBLIC_URL: 'https://bridge.example.test',
    AB_GOOGLE_CLIENT_ID: 'gid',
    AB_GOOGLE_CLIENT_SECRET: 'gsecret-value-123',
  };
  const defaults = { callBudget: 45, maxResponseBytes: 524_288 };

  it('exposes the identity settings, or none', () => {
    expect(parseServerSettings(env, defaults).identity?.providers).toHaveLength(1);
    expect(parseServerSettings({}, defaults).identity).toBeUndefined();
    expect(parseServerSettings({}, defaults).rateLimits.signInPer5Minutes).toBe(60);
    expect(parseServerSettings({ AB_RATE_LIMIT_SIGN_IN: '5' }, defaults).rateLimits.signInPer5Minutes).toBe(
      5,
    );
  });

  it('turns a bad identity setting into a SettingsError that names the variable and not the value', () => {
    for (const bad of [
      { AB_LOGIN_AUTO_PROVISION: 'owner' },
      { AB_GOOGLE_HOSTED_DOMAIN: 'bad value!' },
      { AB_PUBLIC_URL: 'http://bridge.example.test' },
    ]) {
      try {
        parseServerSettings({ ...env, ...bad }, defaults);
        throw new Error(`accepted ${JSON.stringify(bad)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(SettingsError);
        expect((error as Error).message).not.toContain('gsecret-value-123');
        expect((error as Error).message).not.toContain(Object.values(bad)[0] as string);
      }
    }
  });
});
