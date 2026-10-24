// SPDX-License-Identifier: Apache-2.0
// The consent post and the sign-in redirect of `/oauth/authorize` under the abuse controls (P5-09, T10, T20, L-121):
// the built-in consent screen only exists on a server with sign-in, so this runs on the panel's test server. A refused
// post reaches the screen's code never: no session lookup, no handle taken, no code issued, no Agility request.
import { describe, expect, it, vi } from 'vitest';
import { setup } from '../helpers/panel.ts';

const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

describe('OAuth abuse controls: the consent post and authorize with the built-in screen', () => {
  const server = (oauth: Record<string, unknown> = {}) =>
    setup({ oauth: { registrationIpLimit: 1000, registrationMaxClients: 500, ...oauth } as never });
  const post = (t: Awaited<ReturnType<typeof setup>>) =>
    t.send('POST', '/oauth/consent?client_id=x', { site: null, form: 'decision=approve', headers: {} });

  it('consent: posts over the address limit are refused with 429, audited once, and take nothing', async () => {
    const t = await server({ consentIpLimit: 2 });
    const agility = t.w.agilityTokens.length;
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) seen.push((await post(t)).status);
    expect(seen.slice(0, 2).every((s) => s !== 429)).toBe(true);
    expect(seen.slice(2)).toEqual([429, 429, 429, 429, 429, 429]);
    const refused = await post(t);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ error: 'temporarily_unavailable' });
    expect(await t.w.storage.kv.list('oauth-consent:', { limit: 100 })).toEqual([]);
    expect(await t.w.storage.kv.list('oauth:grant:', { limit: 100 })).toEqual([]);
    expect(t.w.agilityTokens.length).toBe(agility);
    const rows = (await t.rows()).filter((r) => r.action === 'oauth.request.refused');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ details: { surface: 'consent', scope: 'address', limit: 2 } });
    // The sign-in routes and the panel are not part of this limit.
    expect((await t.send('GET', '/admin', { site: 'none', headers: NAV })).status).not.toBe(429);
  });

  it('consent: the deployment limit counts what passed the address limit, and a window later it is served again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t = await server({ consentIpLimit: 5, consentLimit: 3 });
      for (let i = 0; i < 3; i++) expect((await post(t)).status).not.toBe(429);
      const refused = await post(t);
      expect(refused.status).toBe(429);
      const rows = (await t.rows()).filter((r) => r.action === 'oauth.request.refused');
      expect(rows[0]).toMatchObject({ details: { surface: 'consent', scope: 'deployment', limit: 3 } });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await post(t)).status).not.toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it('authorize: the sign-in redirect and the page share the address limit with every other authorization request', async () => {
    const t = await server({ authorizeIpLimit: 2 });
    const open = () => t.send('GET', '/oauth/authorize?client_id=x', { site: 'cross-site', headers: NAV });
    expect((await open()).status).not.toBe(429);
    expect((await open()).status).not.toBe(429);
    const refused = await open();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('location')).toBeNull();
    expect(refused.headers.get('set-cookie')).toBeNull();
    // No sign-in was started for the refused request: no login state row beyond what the first two caused.
    expect(await t.w.storage.kv.list('oauth:grant:', { limit: 10 })).toEqual([]);
  });
});
