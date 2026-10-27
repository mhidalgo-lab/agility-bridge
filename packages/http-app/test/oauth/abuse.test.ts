// SPDX-License-Identifier: Apache-2.0
// The OAuth abuse controls on memory storage (P5-09): the shared flood suite, then what needs a moving clock and small
// limits (windows, the deployment caps, the audit once per window, fail-open, the sweeps) and the settings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { oauthSettingsFromEnv, scheduleStorageHousekeeping, sweepRegistrations } from '../../src/index.ts';
import { SWEEP_CURSOR_KEY } from '../../src/oauth/housekeeping.ts';
import { defineOAuthAbuseSuite } from './abuse-suite.ts';
import { memoryHost } from './memory-host.ts';
import type { OAuthHost } from './suite.ts';

defineOAuthAbuseSuite('memory storage', () => memoryHost());
defineOAuthAbuseSuite('memory storage, Workers shape (a new app per request)', () =>
  memoryHost({ request: true }),
);

const MINUTE = 60_000;
const WINDOW = 10 * MINUTE;
const HOUR = 60 * MINUTE;
const ATTACKER = '198.51.100.7';
const LOOPBACK = 'http://127.0.0.1:53682/callback';

describe('OAuth abuse controls: limits, windows and cleanup (memory storage)', () => {
  const open: OAuthHost[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(open.splice(0).map((h) => h.close()));
  });
  const host = async (oauth: Record<string, unknown> = {}): Promise<OAuthHost> => {
    const h = await memoryHost({ oauth: oauth as never });
    open.push(h);
    return h;
  };
  const authorizeAs = (h: OAuthHost, ip: string) =>
    h.call(
      `${h.origin}/oauth/authorize?${new URLSearchParams({ client_id: 'x', resource: `${h.origin}/w/team-a/mcp` })}`,
      { redirect: 'manual', headers: h.address(ip) },
    );
  const failToken = (h: OAuthHost, ip: string) =>
    h.call(`${h.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...h.address(ip) },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'nope',
        code_verifier: 'a'.repeat(43),
        client_id: 'x',
        redirect_uri: LOOPBACK,
      }).toString(),
    });
  const dcr = (h: OAuthHost, ip: string) =>
    h.call(`${h.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...h.address(ip) },
      body: JSON.stringify({ client_name: 'App', redirect_uris: [LOOPBACK] }),
    });
  const documentRequest = (h: OAuthHost, url: string, ip?: string) =>
    h.call(
      `${h.origin}/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: url,
        redirect_uri: LOOPBACK,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        resource: `${h.origin}/w/team-a/mcp`,
      })}`,
      { redirect: 'manual', ...(ip === undefined ? {} : { headers: h.address(ip) }) },
    );
  const refusals = async (h: OAuthHost) => {
    // The audit rows are written in the background.
    await vi.waitFor(async () => {
      expect(
        (await h.storage.audit.query({ limit: 1000 })).some((r) => r.action === 'oauth.request.refused'),
      ).toBe(true);
    });
    return (await h.storage.audit.query({ limit: 1000 })).filter((r) => r.action === 'oauth.request.refused');
  };
  const counter = async (h: OAuthHost, prefix: string): Promise<number[]> =>
    Promise.all(
      (await h.storage.kv.list(prefix, { limit: 1000 })).map(async (k) => Number(await h.storage.kv.get(k))),
    );
  const scopeOf = (r: { details?: unknown }): string | undefined => (r.details as { scope?: string }).scope;

  it('the window ends: an address that was refused is served again, and Retry-After says when', async () => {
    const h = await host({ authorizeIpLimit: 3 });
    for (let i = 0; i < 3; i++) expect((await authorizeAs(h, ATTACKER)).status).not.toBe(429);
    const refused = await authorizeAs(h, ATTACKER);
    expect(refused.status).toBe(429);
    const toEnd = Math.ceil((Math.floor(Date.now() / WINDOW) * WINDOW + WINDOW - Date.now()) / 1000);
    expect(Math.abs(Number(refused.headers.get('retry-after')) - toEnd)).toBeLessThanOrEqual(1);
    h.advance?.(WINDOW + 1000);
    expect((await authorizeAs(h, ATTACKER)).status).not.toBe(429);
  });

  it('the address limits hold per IPv6 /64, as the general limiter does: rotating addresses inside one network gains nothing (P5-10)', async () => {
    const h = await host({ authorizeIpLimit: 3, registrationIpLimit: 2 });
    const v6 = (n: number) => `2001:db8:1:2::${n.toString(16)}`;
    // Authorization: the fourth request of the network is refused, whichever of its addresses it comes from.
    for (let i = 0; i < 3; i++) expect((await authorizeAs(h, v6(i))).status).not.toBe(429);
    expect((await authorizeAs(h, v6(100))).status).toBe(429);
    expect((await authorizeAs(h, '2001:db8:1:2:ffff:ffff:ffff:ffff')).status).toBe(429);
    // Another network, an IPv4 address and the IPv4-mapped spelling of one are separate callers.
    expect((await authorizeAs(h, '2001:db8:1:3::1')).status).not.toBe(429);
    expect((await authorizeAs(h, '203.0.113.9')).status).not.toBe(429);
    // Registration has its own per-address counter, keyed the same way.
    expect((await dcr(h, v6(1))).status).toBe(201);
    expect((await dcr(h, v6(2))).status).toBe(201);
    expect((await dcr(h, v6(3))).status).toBe(429);
    expect((await dcr(h, '::ffff:203.0.113.9')).status).toBe(201);
    expect((await dcr(h, '203.0.113.9')).status).toBe(201);
    expect((await dcr(h, '203.0.113.9')).status).toBe(429);
  });

  it('the address limit is taken first: a flood from one address does not use up the deployment limit', async () => {
    const h = await host({ authorizeIpLimit: 3, authorizeLimit: 5 });
    for (let i = 0; i < 20; i++) await authorizeAs(h, ATTACKER);
    // The deployment counter holds only what passed the attacker's own limit.
    expect(await counter(h, 'oauth-abuse:authorize:all:')).toEqual([3]);
    expect((await authorizeAs(h, '198.51.100.20')).status).not.toBe(429);
    expect((await authorizeAs(h, '198.51.100.21')).status).not.toBe(429);
    // Now the deployment's five are gone: a new address is refused, and that is the documented cost of the cap.
    expect((await authorizeAs(h, '198.51.100.22')).status).toBe(429);
    const deployment = (await refusals(h)).filter((r) => scopeOf(r) === 'deployment');
    expect(deployment).toHaveLength(1);
    expect(deployment[0]).toMatchObject({ status: 'denied', details: { surface: 'authorize', limit: 5 } });
    // Audited once per window, surface and scope: more refusals add no row.
    for (let i = 0; i < 5; i++) await authorizeAs(h, `198.51.100.${30 + i}`);
    expect((await refusals(h)).filter((r) => scopeOf(r) === 'deployment')).toHaveLength(1);
  });

  it('token failures: the deployment limit turns away only addresses that already failed', async () => {
    const h = await host({ tokenFailureIpLimit: 10, tokenFailureLimit: 3 });
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      expect((await failToken(h, ip)).status).not.toBe(429);
    }
    // The deployment has seen its three failures. An address with no failure of its own is still served (and fails),
    // an address that failed before is refused.
    expect((await failToken(h, '198.51.100.4')).status).not.toBe(429);
    expect((await failToken(h, '198.51.100.5')).status).not.toBe(429);
    const again = await failToken(h, '198.51.100.1');
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
    // 198.51.100.4 failed once in this window too, so it is now one of the refused.
    expect((await failToken(h, '198.51.100.4')).status).toBe(429);
    expect(await counter(h, 'oauth-abuse:token_failure:all:')).toEqual([3]);
    const rows = await refusals(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ details: { surface: 'token_failure', scope: 'deployment', limit: 3 } });
  });

  it('a request that does not fail costs no token counter', async () => {
    const h = await host();
    expect(await h.storage.kv.list('oauth-abuse:', { limit: 1000 })).toEqual([]);
    // The metadata and a registration are not token requests; a failed exchange is counted (address and deployment).
    expect((await dcr(h, ATTACKER)).status).toBe(201);
    expect(await h.storage.kv.list('oauth-abuse:token_failure:', { limit: 1000 })).toEqual([]);
    expect((await failToken(h, ATTACKER)).status).not.toBe(429);
    expect(await h.storage.kv.list('oauth-abuse:token_failure:', { limit: 1000 })).toHaveLength(2);
  });

  it('registrations: the deployment-wide hourly limit stops many addresses together, with one audit row and no stored client', async () => {
    const h = await host({ registrationHourlyLimit: 3 });
    for (let i = 0; i < 3; i++) expect((await dcr(h, `198.51.100.${i + 1}`)).status).toBe(201);
    const refused = await dcr(h, '198.51.100.9');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await h.registrations?.count()).toEqual({ dynamic: 3, documents: 0 });
    const rows = await refusals(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      details: {
        surface: 'registration',
        scope: 'deployment',
        limit: 3,
        reason: 'dcr_hourly_limit_deployment',
      },
    });
    h.advance?.(HOUR + 1000);
    expect((await dcr(h, '198.51.100.9')).status).toBe(201);
  });

  it('metadata documents: the deployment-wide hourly fetch limit holds across addresses', async () => {
    const h = await host({ clientMetadataHourlyLimit: 2 });
    const ask = (n: number, ip: string) => {
      const url = `https://client${n}.example.org/meta.json`;
      h.documents.serveClient(url);
      return documentRequest(h, url, ip);
    };
    await ask(1, '198.51.100.1');
    await ask(2, '198.51.100.2');
    expect((await ask(3, '198.51.100.3')).status).toBe(400);
    expect(h.documents.fetched()).toHaveLength(2);
    expect(await h.storage.kv.list('oauth:client:https://', { limit: 100 })).toHaveLength(2);
    expect((await refusals(h)).map((r) => (r.details as { reason?: string }).reason)).toEqual([
      'fetch_hourly_limit_deployment',
    ]);
  });

  it('a refused counter is remembered in the isolate: refused requests cost no storage write', async () => {
    const h = await host({ authorizeIpLimit: 2 });
    const increment = vi.spyOn(h.storage.kv, 'increment');
    for (let i = 0; i < 3; i++) await authorizeAs(h, ATTACKER);
    const used = increment.mock.calls.length;
    expect(used).toBeGreaterThan(0);
    for (let i = 0; i < 25; i++) expect((await authorizeAs(h, ATTACKER)).status).toBe(429);
    expect(increment.mock.calls.length).toBe(used);
    // And the memory is only an optimisation: the next window starts afresh.
    h.advance?.(WINDOW + 1000);
    expect((await authorizeAs(h, ATTACKER)).status).not.toBe(429);
  });

  it('a counter store that fails lets the request through, with a log line and no address in it', async () => {
    const h = await host();
    vi.spyOn(h.storage.kv, 'increment').mockRejectedValue(new Error('D1 is down'));
    const res = await authorizeAs(h, ATTACKER);
    // The request is handled as usual (an unknown client: a 4xx answer), neither refused nor failed.
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(429);
    expect(h.logs().some((l) => l.includes('oauth abuse limiter failed'))).toBe(true);
    expect(h.logs().join('\n')).not.toContain(ATTACKER);
    expect(h.logs().join('\n')).not.toContain('D1 is down');
  });

  it('refusals leave no address, token or secret in the audit row, the log or the stored rows', async () => {
    const h = await host({ authorizeIpLimit: 1, tokenFailureIpLimit: 1 });
    await authorizeAs(h, ATTACKER);
    await authorizeAs(h, ATTACKER);
    await failToken(h, ATTACKER);
    await failToken(h, ATTACKER);
    const rows = await refusals(h);
    expect(rows.length).toBeGreaterThan(0);
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ATTACKER))),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const everything = JSON.stringify(rows) + h.logs().join('\n');
    for (const needle of [ATTACKER, hash.slice(0, 32), 'nope', 'a'.repeat(43)]) {
      expect(everything).not.toContain(needle);
    }
  });

  it('counters and markers expire with their window, and the purge reclaims them', async () => {
    const h = await host();
    for (let i = 0; i < 40; i++) await authorizeAs(h, ATTACKER);
    expect((await h.storage.kv.list('oauth-abuse', { limit: 1000 })).length).toBeGreaterThan(0);
    h.advance?.(2 * HOUR);
    // Expired rows read as absent at once; the purge reclaims the space.
    expect(await h.storage.kv.list('oauth-abuse', { limit: 1000 })).toEqual([]);
    expect(await h.storage.kv.purgeExpired(1000)).toBeGreaterThanOrEqual(3);
  });

  it('the registration sweep is bounded, resumes where it stopped and applies a shorter unused lifetime', async () => {
    const h = await host({ registrationIpLimit: 100 });
    for (let i = 0; i < 5; i++) expect((await dcr(h, `198.51.100.${i + 1}`)).status).toBe(201);
    h.advance?.(2 * HOUR);
    const options = { now: () => Date.now(), unusedTtlSeconds: 3600 };
    expect(await sweepRegistrations(h.storage, { ...options, limit: 2 })).toEqual({
      removed: 2,
      examined: 2,
    });
    expect(await h.storage.kv.get(SWEEP_CURSOR_KEY)).not.toBeNull();
    expect(await sweepRegistrations(h.storage, { ...options, limit: 2 })).toEqual({
      removed: 2,
      examined: 2,
    });
    expect(await sweepRegistrations(h.storage, { ...options, limit: 2 })).toEqual({
      removed: 1,
      examined: 1,
    });
    // The cursor is dropped once the list ends, and nothing is left.
    expect(await h.storage.kv.get(SWEEP_CURSOR_KEY)).toBeNull();
    expect(await h.registrations?.count()).toEqual({ dynamic: 0, documents: 0 });
  });

  it('the sweep leaves stored documents and young registrations alone', async () => {
    const h = await host();
    expect((await dcr(h, ATTACKER)).status).toBe(201);
    h.documents.serveClient(
      'https://client1.example.org/meta.json',
      {},
      { 'cache-control': 'max-age=86400' },
    );
    await documentRequest(h, 'https://client1.example.org/meta.json');
    expect(await h.registrations?.count()).toEqual({ dynamic: 1, documents: 1 });
    const options = { now: () => Date.now() };
    // Young: the lifetime has not run out.
    expect(await sweepRegistrations(h.storage, { ...options, unusedTtlSeconds: 86_400 })).toMatchObject({
      removed: 0,
    });
    h.advance?.(2 * HOUR);
    expect(await sweepRegistrations(h.storage, { ...options, unusedTtlSeconds: 3600 })).toMatchObject({
      removed: 1,
    });
    expect(await h.registrations?.count()).toEqual({ dynamic: 0, documents: 1 });
  });

  it('the sweep keeps a registration that exchanged a code, however old', async () => {
    const h = await host();
    const now = Math.floor(Date.now() / 1000);
    const day = 86_400;
    const put = (id: string, expires: number, ttlMs: number) =>
      h.storage.kv.set(
        `oauth:client:${id}`,
        JSON.stringify({ clientId: id, registrationDate: now - 3 * day, registrationExpiresAt: expires }),
        { expiresAt: Date.now() + ttlMs },
      );
    // As the provider renews it on the first token exchange: the expiry is the long registration lifetime.
    await put('used-client', now + 60 * day, 60 * day * 1000);
    await put('unused-client', now - 2 * day + 3600, day * 1000);
    expect(await sweepRegistrations(h.storage, { now: () => Date.now(), unusedTtlSeconds: day })).toEqual({
      removed: 1,
      examined: 2,
    });
    expect(await h.storage.kv.list('oauth:client:', { limit: 10 })).toEqual(['oauth:client:used-client']);
  });

  it('Node housekeeping purges expired rows at start and sweeps registrations when OAuth is on', async () => {
    const h = await host();
    expect((await dcr(h, ATTACKER)).status).toBe(201);
    h.advance?.(25 * HOUR);
    const purge = vi.spyOn(h.storage.kv, 'purgeExpired');
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } as never;
    const stop = scheduleStorageHousekeeping(h.storage, {
      clock: { now: () => Date.now() },
      logger,
      oauth: {},
      everyMs: 3_600_000,
    });
    await vi.waitFor(() => expect(purge).toHaveBeenCalled());
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
    stop();
    expect(lines.filter((l) => l.includes('failed'))).toEqual([]);
  });
});

describe('OAuth abuse settings', () => {
  const env = (extra: Record<string, string>) => ({ AB_OAUTH: 'on', ...extra });
  it('reads the limits with safe defaults and bounds', () => {
    expect(oauthSettingsFromEnv(env({}), true)).toEqual({});
    expect(
      oauthSettingsFromEnv(
        env({
          AB_OAUTH_AUTHORIZE_IP_LIMIT: '5',
          AB_OAUTH_AUTHORIZE_LIMIT: '50',
          AB_OAUTH_CONSENT_IP_LIMIT: '6',
          AB_OAUTH_CONSENT_LIMIT: '60',
          AB_OAUTH_TOKEN_FAILURE_IP_LIMIT: '7',
          AB_OAUTH_TOKEN_FAILURE_LIMIT: '70',
          AB_OAUTH_DCR_LIMIT: '8',
          AB_OAUTH_CIMD_LIMIT: '9',
        }),
        true,
      ),
    ).toEqual({
      authorizeIpLimit: 5,
      authorizeLimit: 50,
      consentIpLimit: 6,
      consentLimit: 60,
      tokenFailureIpLimit: 7,
      tokenFailureLimit: 70,
      registrationHourlyLimit: 8,
      clientMetadataHourlyLimit: 9,
    });
  });

  it.each([
    ['AB_OAUTH_AUTHORIZE_IP_LIMIT', '0'],
    ['AB_OAUTH_AUTHORIZE_LIMIT', '100001'],
    ['AB_OAUTH_CONSENT_IP_LIMIT', '-1'],
    ['AB_OAUTH_CONSENT_LIMIT', '1.5'],
    ['AB_OAUTH_TOKEN_FAILURE_IP_LIMIT', 'many'],
    ['AB_OAUTH_TOKEN_FAILURE_LIMIT', '99999999'],
    ['AB_OAUTH_DCR_LIMIT', '0'],
    ['AB_OAUTH_CIMD_LIMIT', '0'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => oauthSettingsFromEnv(env({ [name]: value }), true)).toThrow(name);
  });
});
