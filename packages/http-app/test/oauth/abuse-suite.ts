// SPDX-License-Identifier: Apache-2.0
// Flood tests of the OAuth abuse controls (P5-09, THREAT_MODEL T10, T11, T20, L-079, L-081, L-121), written once against
// `OAuthHost` and run on memory, SQLite and workerd with D1, with the default limits: one address floods an endpoint, and
// what must hold is that the endpoint's work, the stored rows and the outbound fetches stay within budget, that the
// refusals are `429` with `Retry-After`, that they are audited once, and that other addresses are not locked out.
import { exchangeAuthorization } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditRows,
  authorize,
  fetchFn,
  issOf,
  kvText,
  metadata,
  type OAuthHost,
  REDIRECT,
  register,
  resourceOf,
} from './suite.ts';

const ATTACKER = '198.51.100.7';
const OTHER = '198.51.100.8';
/** The defaults under test (`OAUTH_DEFAULT_*` in `oauth/server.ts`). */
const AUTHORIZE_IP = 30;
const TOKEN_FAILURE_IP = 20;
const DCR_IP = 10;
const CIMD_IP = 20;
/** The fixed windows of the counters (`ABUSE_WINDOW_S` and `CAP_WINDOW_S` in `oauth/server.ts`). */
const ABUSE_WINDOW_S = 600;
const HOUR_S = 3600;
/** A flood takes a few seconds even on a loaded runner; it starts only when this much of its window is left. */
const NEAR_END_MS = 20_000;
const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const docUrl = (n: number): string => `https://client${n}.example.org/meta.json`;

export function defineOAuthAbuseSuite(name: string, makeHost: () => Promise<OAuthHost>): void {
  describe(`OAuth abuse controls: ${name}`, () => {
    const open: OAuthHost[] = [];
    afterEach(async () => {
      await Promise.all(open.splice(0).map((h) => h.close()));
    });
    /**
     * A host whose clock is at least `NEAR_END_MS` from the end of the abuse window, so a flood cannot straddle two
     * fixed windows (the counters reset at the boundary: a flood split in two is cut by neither, L-382).
     */
    const host = async (windowSeconds = ABUSE_WINDOW_S): Promise<OAuthHost> => {
      const h = await makeHost();
      open.push(h);
      const left = windowSeconds * 1000 - (Date.now() % (windowSeconds * 1000));
      if (left < NEAR_END_MS) await new Promise((r) => setTimeout(r, left + 50));
      return h;
    };
    const rows = (h: OAuthHost, prefix: string) => h.storage.kv.list(prefix, { limit: 1000 });
    const authorizeUrl = (h: OAuthHost, over: Record<string, string> = {}): string =>
      `${h.origin}/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: 'no-such-client',
        redirect_uri: REDIRECT,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        state: 's',
        resource: resourceOf(h, 'team-a'),
        ...over,
      })}`;
    const badToken = (h: OAuthHost, ip: string | null) =>
      h.call(`${h.origin}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(ip === null ? {} : h.address(ip)),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'not-a-code',
          code_verifier: 'a'.repeat(43),
          client_id: 'no-such-client',
          redirect_uri: REDIRECT,
        }).toString(),
      });
    const dcr = (h: OAuthHost, ip: string) =>
      h.call(`${h.origin}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...h.address(ip) },
        body: JSON.stringify({ client_name: 'Flood app', redirect_uris: [REDIRECT] }),
      });
    const statuses = async (calls: Promise<Response>[]): Promise<number[]> =>
      (await Promise.all(calls)).map((r) => r.status);

    it('authorize: a flood from one address is cut at the limit, writes two counters, is audited once, locks nobody else out', async () => {
      const h = await host();
      const agility = h.agilityRequests();
      const seen: Response[] = [];
      for (let i = 0; i < AUTHORIZE_IP + 5; i++) {
        seen.push(await h.call(authorizeUrl(h), { redirect: 'manual', headers: h.address(ATTACKER) }));
      }
      const refused = seen.filter((r) => r.status === 429);
      expect(seen.slice(0, AUTHORIZE_IP).every((r) => r.status !== 429)).toBe(true);
      expect(refused).toHaveLength(5);
      for (const r of refused) {
        const wait = Number(r.headers.get('retry-after'));
        expect(wait).toBeGreaterThan(0);
        expect(wait).toBeLessThanOrEqual(600);
        expect(await r.json()).toMatchObject({ error: 'temporarily_unavailable' });
      }
      // Storage: the address's counter and the deployment's, one audit marker; nothing for the refused requests.
      expect(await rows(h, 'oauth-abuse:authorize:')).toHaveLength(2);
      expect(await rows(h, 'oauth:grant:')).toEqual([]);
      expect(h.agilityRequests()).toBe(agility);
      // One audit row for the whole flood, without the address.
      const audited = await auditRows(h, (r) => r.action === 'oauth.request.refused');
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({
        status: 'denied',
        details: { surface: 'authorize', scope: 'address', limit: AUTHORIZE_IP },
      });
      expect(JSON.stringify(audited)).not.toContain(ATTACKER);
      expect(await kvText(h)).not.toContain(ATTACKER);
      // Someone else is not locked out: the deployment counter holds only what passed the attacker's own limit.
      expect((await h.call(authorizeUrl(h), { headers: h.address(OTHER) })).status).not.toBe(429);
      // The default address (the legitimate user in the other suites) still works too.
      const c = await register(h);
      expect((await authorize(h, c)).code).not.toBeNull();
    });

    it('the operator view shows the caps, the limits and the refusals, and nothing that identifies a caller (P5-20)', async () => {
      const h = await host();
      if (h.adminApi === undefined) return;
      for (let i = 0; i < AUTHORIZE_IP + 3; i++) {
        const res = await h.call(authorizeUrl(h), { redirect: 'manual', headers: h.address(ATTACKER) });
        await res.text();
      }
      await auditRows(h, (r) => r.action === 'oauth.request.refused');
      const res = await h.adminApi('GET', '/oauth/abuse');
      const text = await res.text();
      expect(res.status).toBe(200);
      const view = JSON.parse(text) as {
        registrations: { dynamic: { live: number; cap: number; enabled: boolean } };
        limits: Record<string, number>;
        refusals: { reason: string; surface: string | null; scope: string | null; count: number }[];
      };
      expect(view.registrations.dynamic).toMatchObject({ enabled: true, cap: 200 });
      expect(view.limits).toMatchObject({ authorizeIp: AUTHORIZE_IP, tokenFailureIp: TOKEN_FAILURE_IP });
      expect(view.refusals).toContainEqual(
        expect.objectContaining({
          reason: 'authorize_limit_address',
          surface: 'authorize',
          scope: 'address',
          count: 1,
        }),
      );
      // No address, no hash of it, no request id, no client: only reasons and numbers.
      const hash = (await sha256Hex(ATTACKER)).slice(0, 12);
      expect(text).not.toContain(ATTACKER);
      expect(text).not.toContain(hash);
      expect(text).not.toContain('no-such-client');
      expect(text).not.toMatch(/req_|requestId|clientId|"host"/);
    });

    it('token: failed exchanges are cut at the limit per address; a clean client of another address still gets its tokens', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client);
      expect(a.code).not.toBeNull();
      const failures: number[] = [];
      for (let i = 0; i < TOKEN_FAILURE_IP + 5; i++) failures.push((await badToken(h, ATTACKER)).status);
      expect(failures.slice(0, TOKEN_FAILURE_IP).every((s) => s >= 400 && s < 500 && s !== 429)).toBe(true);
      expect(failures.slice(TOKEN_FAILURE_IP)).toEqual([429, 429, 429, 429, 429]);
      // Counters: the attacker's and the deployment's, nothing per request.
      expect(await rows(h, 'oauth-abuse:token_failure:')).toHaveLength(2);
      const refused = await (await badToken(h, ATTACKER)).json();
      expect(refused).toMatchObject({ error: 'temporarily_unavailable' });
      // Another address is served normally, and the code of the clean client is exchanged.
      expect((await badToken(h, OTHER)).status).not.toBe(429);
      const tokens = await exchangeAuthorization(h.origin, {
        metadata: await metadata(h),
        clientInformation: client,
        authorizationCode: a.code as string,
        ...issOf(a),
        codeVerifier: a.verifier,
        redirectUri: a.redirect,
        resource: resourceOf(h, 'team-a'),
        fetchFn: fetchFn(h),
      });
      expect(tokens.access_token).toBeTruthy();
      const audited = await auditRows(h, (r) => r.action === 'oauth.request.refused');
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({ details: { surface: 'token_failure', scope: 'address' } });
    });

    it('token: a refused address gets no token even with a valid code, and the code is not spent', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client);
      for (let i = 0; i < TOKEN_FAILURE_IP; i++) await badToken(h, ATTACKER);
      const res = await h.call(`${h.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...h.address(ATTACKER) },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: a.code as string,
          code_verifier: a.verifier,
          client_id: client.client_id,
          redirect_uri: a.redirect,
          resource: resourceOf(h, 'team-a'),
        }).toString(),
      });
      expect(res.status).toBe(429);
      expect(await res.text()).not.toContain('access_token');
      // The legitimate holder of the code (another address) redeems it afterwards.
      const tokens = await exchangeAuthorization(h.origin, {
        metadata: await metadata(h),
        clientInformation: client,
        authorizationCode: a.code as string,
        ...issOf(a),
        codeVerifier: a.verifier,
        redirectUri: a.redirect,
        resource: resourceOf(h, 'team-a'),
        fetchFn: fetchFn(h),
      });
      expect(tokens.access_token).toBeTruthy();
    });

    it('register: a flood from one address stores only its own limit of clients, and another address can still register', async () => {
      const h = await host(HOUR_S);
      const out = await statuses(Array.from({ length: DCR_IP + 4 }, () => dcr(h, ATTACKER)));
      expect(out.filter((s) => s === 201)).toHaveLength(DCR_IP);
      expect(out.filter((s) => s === 429)).toHaveLength(4);
      expect(await rows(h, 'oauth:client:')).toHaveLength(DCR_IP);
      const refused = await dcr(h, ATTACKER);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await dcr(h, OTHER)).status).toBe(201);
      expect(await rows(h, 'oauth:client:')).toHaveLength(DCR_IP + 1);
      // The per-address counters are the only other rows, and the audit has one row for the flood (P5-03's own).
      expect(await rows(h, 'oauth-dcr-ip:')).toHaveLength(2);
      const audited = await auditRows(h, (r) => r.action === 'oauth.client.refused');
      expect(audited).toHaveLength(1);
      expect(await kvText(h)).not.toContain(ATTACKER);
    });

    it('metadata documents: a flood of client ids from one address causes at most its budget of fetches and stored clients', async () => {
      const h = await host(HOUR_S);
      const agility = h.agilityRequests();
      const ask = (n: number, ip: string) => {
        h.documents.serveClient(docUrl(n));
        return h.call(authorizeUrl(h, { client_id: docUrl(n) }), {
          redirect: 'manual',
          headers: h.address(ip),
        });
      };
      const out: number[] = [];
      for (let i = 0; i < CIMD_IP + 5; i++) out.push((await ask(i, ATTACKER)).status);
      expect(h.documents.fetched()).toHaveLength(CIMD_IP);
      // Over the budget: the usual refusal of a client that cannot be resolved, and no fetch at all.
      expect(out.slice(CIMD_IP).every((s) => s === 400)).toBe(true);
      expect(await rows(h, 'oauth:client:https://')).toHaveLength(CIMD_IP);
      // Another address may still resolve a document: the budget is per address first.
      expect((await ask(100, OTHER)).status).not.toBe(429);
      expect(h.documents.fetched()).toHaveLength(CIMD_IP + 1);
      expect(h.agilityRequests()).toBe(agility);
      expect(await rows(h, 'oauth-cimd-ip:')).toHaveLength(2);
    });

    it('a document client that is already stored costs no fetch and no counter, however often it is asked for', async () => {
      const h = await host(HOUR_S);
      h.documents.serveClient(docUrl(1));
      for (let i = 0; i < 10; i++) {
        await h.call(authorizeUrl(h, { client_id: docUrl(1) }), {
          redirect: 'manual',
          headers: h.address(OTHER),
        });
      }
      expect(h.documents.fetched()).toEqual([docUrl(1)]);
      expect(await rows(h, 'oauth-cimd-ip:')).toHaveLength(1);
    });
  });
}
