// SPDX-License-Identifier: Apache-2.0
// Client registration settings and caps through the server (P5-03, T10, T11, L-089): switches, the allowlist, the
// deployment caps, the lifetimes and the cleanup hook. Memory storage with a moving clock, because most of these need
// time to pass; the shared suite (`clients-suite.ts`) covers the defaults on every host.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthOptions } from '../../src/index.ts';
import { APPROVE_HEADER } from './consent.ts';
import { clientDocument } from './documents.ts';
import { memoryHost } from './memory-host.ts';
import { auditRows, metadata, type OAuthHost, resourceOf } from './suite.ts';

const LOOPBACK = 'http://127.0.0.1:53682/callback';
const HOUR = 3_600_000;
const doc = (n: number) => `https://client${n}.example.org/meta.json`;

describe('OAuth client registration settings (memory storage)', () => {
  const open: OAuthHost[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(open.splice(0).map((h) => h.close()));
  });
  const host = async (oauth: Partial<OAuthOptions> = {}): Promise<OAuthHost> => {
    const h = await memoryHost({ oauth });
    open.push(h);
    return h;
  };
  const register = (h: OAuthHost, over: Record<string, unknown> = {}) =>
    h.call(`${h.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'App', redirect_uris: [LOOPBACK], ...over }),
    });
  const authorizeDoc = (h: OAuthHost, clientId: string, redirect = LOOPBACK) =>
    h.call(
      `${h.origin}/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        state: 's',
        resource: resourceOf(h, 'team-a'),
      }).toString()}`,
      { redirect: 'manual', headers: { [APPROVE_HEADER]: `${h.ids.alice}|${h.ids.aliceGrantA}` } },
    );
  const serve = (h: OAuthHost, url: string, headers: Record<string, string> = {}, over = {}) =>
    h.documents.serve(url, {
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(clientDocument(url, over)),
    });

  // ------------------------------------------------------------------------------------------------ switches

  it('registration off: no endpoint (404), none advertised, and documents still work (AB_OAUTH_DCR=off)', async () => {
    const h = await host({ registration: false });
    const res = await register(h);
    expect(res.status).toBe(404);
    expect(await h.storage.kv.list('oauth:client:')).toEqual([]);
    expect((await metadata(h)).registration_endpoint).toBeUndefined();
    serve(h, doc(1));
    expect((await authorizeDoc(h, doc(1))).status).toBe(302);
  });

  it('documents off: URL client ids are refused without a fetch and the metadata says so (AB_OAUTH_CIMD=off)', async () => {
    // The switch, and a host without a guarded fetcher (the option explicitly absent).
    const cases = [
      { clientMetadataDocuments: false },
      { clientMetadataFetch: undefined },
    ] as unknown as Partial<OAuthOptions>[];
    for (const oauth of cases) {
      const h = await host(oauth);
      serve(h, doc(1));
      const res = await authorizeDoc(h, doc(1));
      expect(res.status).toBe(400);
      expect(h.documents.fetched()).toEqual([]);
      const m = (await (await h.call(`${h.origin}/.well-known/oauth-authorization-server`)).json()) as Record<
        string,
        unknown
      >;
      expect(m['client_id_metadata_document_supported']).toBe(false);
      // Dynamic registration is a separate switch and stays on.
      expect((await register(h)).status).toBe(201);
    }
  });

  // ------------------------------------------------------------------------------------------------ DCR caps

  it('the deployment cap on live registrations holds across addresses, is audited once, and frees up with expiry', async () => {
    const h = await host({ registrationMaxClients: 2, registrationIpLimit: 100 });
    expect((await register(h)).status).toBe(201);
    expect((await register(h)).status).toBe(201);
    for (let i = 0; i < 3; i++) {
      const res = await register(h);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(await h.registrations?.count()).toEqual({ dynamic: 2, documents: 0 });
    const refused = await auditRows(h, (r) => r.action === 'oauth.client.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ details: { kind: 'dynamic', reason: 'client_cap', limit: 2 } });
    // Unused registrations expire after a day: the cap is not a permanent lockout.
    h.advance?.(25 * HOUR);
    expect((await register(h)).status).toBe(201);
    expect(await h.registrations?.count()).toEqual({ dynamic: 1, documents: 0 });
  });

  it('at the cap, registrations nobody used within the hour make room; fresh and used ones do not (P5-10, D-77)', async () => {
    const h = await host({ registrationMaxClients: 3, registrationIpLimit: 100 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(((await (await register(h)).json()) as { client_id: string }).client_id);
    }
    // Fresh: nothing is abandoned yet, so the cap still refuses.
    expect((await register(h)).status).toBe(429);
    // One of them is used (a token exchange renews its stamp to the long lifetime).
    const key = `oauth:client:${ids[0]}`;
    const record = JSON.parse((await h.storage.kv.get(key)) as string) as Record<string, number>;
    await h.storage.kv.set(
      key,
      JSON.stringify({ ...record, registrationExpiresAt: Math.floor(Date.now() / 1000) + 90 * 86_400 }),
      { expiresAt: Date.now() + 90 * 86_400_000 },
    );
    h.advance?.(HOUR + 60_000);
    // The two abandoned ones go, the used one stays, and the new registration is accepted.
    expect((await register(h)).status).toBe(201);
    expect(await h.storage.kv.get(key)).not.toBeNull();
    const left = await h.registrations?.count();
    expect(left?.dynamic).toBeLessThanOrEqual(3);
    expect(await h.storage.kv.get(`oauth:client:${ids[1]}`)).toBeNull();
    expect(await h.storage.kv.get(`oauth:client:${ids[2]}`)).toBeNull();
  });

  it('one address registering at its limit all day cannot keep the registration cap full for everyone else (P5-10)', async () => {
    const h = await host({ registrationMaxClients: 30, registrationIpLimit: 3 });
    const other = { 'x-test-ip': '203.0.113.9' };
    // 3 an hour for 40 hours is 120 registrations against a cap of 30 and a day's unused lifetime.
    for (let hour = 0; hour < 40; hour++) {
      for (let i = 0; i < 3; i++) await register(h);
      const res = await h.call(`${h.origin}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...other },
        body: JSON.stringify({ client_name: 'Someone else', redirect_uris: [LOOPBACK] }),
      });
      expect(res.status, `hour ${hour}`).toBe(201);
      h.advance?.(HOUR);
    }
  });

  it('a flood from one address cannot use up the deployment cap for everyone (the address limit comes first)', async () => {
    // relic-bridge review M1: with a global window one source locked everyone out. Here the cap is on live clients and
    // the address limit is checked first, so the flood stops at its own limit.
    const h = await host({ registrationMaxClients: 50, registrationIpLimit: 3 });
    for (let i = 0; i < 3; i++) expect((await register(h)).status).toBe(201);
    for (let i = 0; i < 20; i++) expect((await register(h)).status).toBe(429);
    expect(await h.registrations?.count()).toEqual({ dynamic: 3, documents: 0 });
    // The window is an hour: the next one starts afresh.
    h.advance?.(HOUR + 1000);
    expect((await register(h)).status).toBe(201);
  });

  it('the redirect host allowlist limits https redirects of dynamic clients; loopback stays open', async () => {
    const h = await host({ registrationRedirectHosts: ['claude.ai'] });
    expect((await register(h, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })).status).toBe(
      201,
    );
    expect((await register(h, { redirect_uris: [LOOPBACK] })).status).toBe(201);
    const res = await register(h, { redirect_uris: ['https://evil.example.net/cb'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    // A document client is not a dynamic client: its callbacks follow its own host (not the allowlist).
    serve(h, doc(1));
    expect((await authorizeDoc(h, doc(1), 'https://client1.example.org/callback')).status).toBe(302);
  });

  it('the unused lifetime is a setting, and expiry makes the client unknown', async () => {
    const h = await host({ registrationUnusedTtlSeconds: 7200 });
    const created = (await (await register(h)).json()) as { client_id: string };
    const record = JSON.parse((await h.storage.kv.get(`oauth:client:${created.client_id}`)) as string) as {
      registrationExpiresAt: number;
    };
    expect(record.registrationExpiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(7200);
    expect(record.registrationExpiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(7000);
    expect((await authorizeDoc(h, created.client_id)).status).toBe(302);
    h.advance?.(2 * HOUR + 60_000);
    expect(await h.storage.kv.get(`oauth:client:${created.client_id}`)).toBeNull();
    expect((await authorizeDoc(h, created.client_id)).status).toBe(400);
  });

  it('sweep() removes unused registrations older than the unused lifetime now configured, and nothing else', async () => {
    const h = await host({ registrationUnusedTtlSeconds: 3600, registrationIpLimit: 100 });
    const created = (await (await register(h)).json()) as { client_id: string };
    serve(h, doc(1));
    expect((await authorizeDoc(h, doc(1))).status).toBe(302);
    // Nothing is stale yet.
    expect(await h.registrations?.sweep()).toEqual({ removed: 0 });
    // A registration made under a longer lifetime (a stamp a day out) that has outlived the shorter one now configured.
    const key = `oauth:client:${created.client_id}`;
    const record = JSON.parse((await h.storage.kv.get(key)) as string) as Record<string, number>;
    const old = Math.floor(Date.now() / 1000) - 2 * 3600;
    await h.storage.kv.set(
      key,
      JSON.stringify({ ...record, registrationDate: old, registrationExpiresAt: old + 86_400 }),
      { expiresAt: Date.now() + 86_400_000 },
    );
    expect(await h.registrations?.sweep()).toEqual({ removed: 1 });
    expect(await h.storage.kv.get(key)).toBeNull();
    // The document client was not touched, and a used (renewed) registration is not "unused".
    expect(await h.registrations?.count()).toEqual({ dynamic: 0, documents: 1 });
    const used = (await (await register(h)).json()) as { client_id: string };
    const usedKey = `oauth:client:${used.client_id}`;
    const r2 = JSON.parse((await h.storage.kv.get(usedKey)) as string) as Record<string, number>;
    await h.storage.kv.set(
      usedKey,
      JSON.stringify({
        ...r2,
        registrationDate: old,
        registrationExpiresAt: Math.floor(Date.now() / 1000) + 90 * 86_400,
      }),
      { expiresAt: Date.now() + 90 * 86_400_000 },
    );
    expect(await h.registrations?.sweep()).toEqual({ removed: 0 });
    expect(await h.storage.kv.get(usedKey)).not.toBeNull();
  });

  // ------------------------------------------------------------------------------------------------ CIMD caps and cache

  it('stored document clients are capped per deployment; at the cap one cached document is evicted, never a client refused (P5-10, D-76)', async () => {
    const h = await host({ clientMetadataMaxClients: 2 });
    for (const n of [1, 2]) {
      serve(h, doc(n));
      expect((await authorizeDoc(h, doc(n))).status).toBe(302);
    }
    // A third client gets in: the room is made by dropping a cached document, which costs its next request a fetch.
    serve(h, doc(3));
    expect((await authorizeDoc(h, doc(3))).status).toBe(302);
    expect(h.documents.fetched()).toContain(doc(3));
    expect(await h.registrations?.count()).toEqual({ dynamic: 0, documents: 2 });
    const evicted = await auditRows(h, (r) => r.action === 'oauth.client.evicted');
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toMatchObject({
      status: 'ok',
      details: { kind: 'metadata_document', reason: 'client_cap', limit: 2 },
    });
    // Another one: still no refusal, and no second audit row in the window.
    serve(h, doc(4));
    expect((await authorizeDoc(h, doc(4))).status).toBe(302);
    expect(await auditRows(h, (r) => r.action === 'oauth.client.evicted')).toHaveLength(1);
    expect(await auditRows(h, (r) => r.action === 'oauth.client.refused')).toEqual([]);
    expect(await h.registrations?.count()).toEqual({ dynamic: 0, documents: 2 });
  });

  it('one address cannot keep every other client out by filling the document cap with long-cached documents (P5-10)', async () => {
    const h = await host({ clientMetadataMaxClients: 5, clientMetadataFetchLimit: 100 });
    for (let n = 100; n < 110; n++) {
      serve(h, doc(n), { 'cache-control': 'max-age=86400' });
      expect((await authorizeDoc(h, doc(n))).status).toBe(302);
    }
    // The cap holds (storage stays bounded) and a client that was never seen still connects.
    expect(await h.registrations?.count()).toEqual({ dynamic: 0, documents: 5 });
    serve(h, doc(1));
    expect((await authorizeDoc(h, doc(1))).status).toBe(302);
    expect(await h.registrations?.count()).toEqual({ dynamic: 0, documents: 5 });
  });

  it('the fetch limit per address is a setting, and refusing costs no fetch', async () => {
    const h = await host({ clientMetadataFetchLimit: 2 });
    for (const n of [1, 2, 3, 4]) await authorizeDoc(h, doc(n));
    expect(h.documents.fetched()).toEqual([doc(1), doc(2)]);
  });

  it('a spent fetch budget at the token endpoint is a 429 with Retry-After, not invalid_client (P5-10)', async () => {
    const h = await host({ clientMetadataFetchLimit: 1 });
    serve(h, doc(1));
    serve(h, doc(2));
    expect((await authorizeDoc(h, doc(1))).status).toBe(302);
    const token = (clientId: string) =>
      h.call(`${h.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'usr_x:AbCdEfGhIjKlMnOp:SecretSecretSecretSecretSecret12',
          client_id: clientId,
        }).toString(),
      });
    const res = await token(doc(2));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await res.json()) as { error: string }).error).toBe('temporarily_unavailable');
    // The browser-facing endpoint keeps its page: there is no client to tell to retry.
    expect((await authorizeDoc(h, doc(2))).status).toBe(400);
    expect(h.documents.fetched()).toEqual([doc(1)]);
  });

  it('a document is cached for its Cache-Control lifetime (within 5 minutes - 24 hours) and then fetched again', async () => {
    const h = await host();
    serve(h, doc(1), { 'cache-control': 'max-age=600' });
    expect((await authorizeDoc(h, doc(1))).status).toBe(302);
    expect((await authorizeDoc(h, doc(1))).status).toBe(302);
    expect(h.documents.fetched()).toHaveLength(1);
    h.advance?.(11 * 60_000);
    // The document changed in the meantime (a callback removed): the next fetch picks that up.
    serve(h, doc(1), { 'cache-control': 'max-age=600' }, { redirect_uris: ['http://127.0.0.1:1/other'] });
    expect((await authorizeDoc(h, doc(1))).status).toBe(400);
    expect(h.documents.fetched()).toHaveLength(2);
    // A year-long max-age is cut to 24 hours.
    serve(h, doc(2), { 'cache-control': 'max-age=31536000' });
    expect((await authorizeDoc(h, doc(2))).status).toBe(302);
    h.advance?.(23 * HOUR);
    expect((await authorizeDoc(h, doc(2))).status).toBe(302);
    expect(h.documents.fetched().filter((u) => u === doc(2))).toHaveLength(1);
    h.advance?.(2 * HOUR);
    expect((await authorizeDoc(h, doc(2))).status).toBe(302);
    expect(h.documents.fetched().filter((u) => u === doc(2))).toHaveLength(2);
  });

  it('the consent seam learns where the client came from: the vouching host for a document, nothing for a dynamic client', async () => {
    const seen: { kind: string; host: string | null; name: string | null; redirectHost: string }[] = [];
    const h = await host({
      consent: async (_c, api) => {
        const r = api.request;
        seen.push({
          kind: r.clientKind,
          host: r.clientHost,
          name: r.clientName,
          redirectHost: r.redirectHost,
        });
        return new Response(null, { status: 302, headers: { location: api.deny() } });
      },
    });
    serve(h, doc(1), {}, { client_name: 'Document client' });
    await authorizeDoc(h, doc(1), 'https://client1.example.org/callback');
    const created = (await (await register(h, { client_name: 'Dynamic client' })).json()) as {
      client_id: string;
    };
    await authorizeDoc(h, created.client_id);
    expect(seen).toEqual([
      {
        kind: 'metadata_document',
        host: 'client1.example.org',
        name: 'Document client',
        redirectHost: 'client1.example.org',
      },
      { kind: 'dynamic', host: null, name: 'Dynamic client', redirectHost: '127.0.0.1:53682' },
    ]);
  });
});
