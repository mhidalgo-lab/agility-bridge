// SPDX-License-Identifier: Apache-2.0
// Client registration through the whole server (P5-03, L-121, THREAT_MODEL T9, T10, T11): Client ID Metadata Documents
// and Dynamic Client Registration, written once against `OAuthHost` and run on Node with memory storage (http-app), on
// Node with SQLite (cli) and in workerd with D1 (worker). Documents come from a fake origin, never from the network.
// The negative cases check the whole denial: a `400 invalid_client` and no redirect, no code, no Agility request, nothing
// stored for the client.

import type { OAuthClientInformationFull } from '@modelcontextprotocol/client';
import { exchangeAuthorization } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { APPROVE_HEADER } from './consent.ts';
import { clientDocument } from './documents.ts';
import {
  auditRows,
  authorize,
  fetchFn,
  issOf,
  kvText,
  mcp,
  metadata,
  type OAuthHost,
  resourceOf,
  WHOAMI,
} from './suite.ts';

const DOC_URL = 'https://client.example.org/oauth/client-metadata.json';
const LOOPBACK = 'http://127.0.0.1:53682/callback';

/** Requests the fixture Agility had seen when each host was created. */
const started = new WeakMap<OAuthHost, number>();

/** An authorization request for a client id exactly as given (no SDK in between), approved as Alice. */
async function rawAuthorize(h: OAuthHost, clientId: string, redirect = LOOPBACK): Promise<Response> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'state-1',
    scope: 'mcp:read',
    resource: resourceOf(h, 'team-a'),
  });
  return h.call(`${h.origin}/oauth/authorize?${params.toString()}`, {
    redirect: 'manual',
    headers: { [APPROVE_HEADER]: `${h.ids.alice}|${h.ids.aliceGrantA}` },
  });
}

/** The whole denial of a refused client: 400 `invalid_client`, no redirect, no Agility request, nothing stored. */
async function expectClientRefused(h: OAuthHost, clientId: string, response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(response.headers.get('location')).toBeNull();
  const body = (await response.json()) as { error: string; error_description: string };
  expect(body.error).toBe('invalid_client');
  // One generic sentence: what was wrong with the document is for the log, not for whoever sent the URL.
  expect(body.error_description).toBe('The client metadata document could not be used.');
  // The fixture Agility is shared by the tests of a file: nothing new reached it since this host started.
  expect(h.agilityRequests()).toBe(started.get(h));
  if (clientId.length < 400) expect(await h.storage.kv.get(`oauth:client:${clientId}`)).toBeNull();
  expect(await h.storage.kv.list('oauth:grant:')).toEqual([]);
  expect(await h.storage.kv.list('oauth-code:')).toEqual([]);
}

const documentClient = (url = DOC_URL, redirect = LOOPBACK): OAuthClientInformationFull =>
  ({ client_id: url, redirect_uris: [redirect] }) as OAuthClientInformationFull;

/**
 * `matrix: false` runs every sixth row of the refusal matrices (workerd: each case starts a Worker and a database, so the
 * full matrices run on Node, where the logic under test is the same code).
 */
export function defineOAuthClientSuite(
  name: string,
  makeHost: () => Promise<OAuthHost>,
  options: { readonly matrix?: boolean } = {},
): void {
  const each: typeof it.each = ((rows: readonly unknown[]) =>
    it.each(options.matrix === false ? rows.filter((_, i) => i % 6 === 0) : rows)) as never;
  describe(`OAuth client registration: ${name}`, () => {
    const open: OAuthHost[] = [];
    afterEach(async () => {
      await Promise.all(open.splice(0).map((h) => h.close()));
    });
    const host = async (): Promise<OAuthHost> => {
      const h = await makeHost();
      started.set(h, h.agilityRequests());
      open.push(h);
      return h;
    };

    // ------------------------------------------------------------------------------------------------ CIMD

    it('CIMD: a client named by its metadata document authorizes, exchanges, and calls the workspace', async () => {
      const h = await host();
      h.documents.serveClient(
        DOC_URL,
        { client_name: 'Claude-like client' },
        { 'cache-control': 'max-age=600' },
      );
      const client = documentClient(DOC_URL, 'http://127.0.0.1:60123/callback');
      const a = await authorize(h, client, { redirect: 'http://127.0.0.1:60123/callback' });
      expect(a.code, `authorize answered ${a.response.status}`).not.toBeNull();
      const tokens = await exchangeAuthorization(h.origin, {
        metadata: await metadata(h),
        clientInformation: { client_id: DOC_URL },
        authorizationCode: a.code as string,
        ...issOf(a),
        codeVerifier: a.verifier,
        redirectUri: a.redirect,
        resource: resourceOf(h, 'team-a'),
        fetchFn: fetchFn(h),
      });
      expect(tokens.access_token).toBeTruthy();
      // One fetch for both requests: the validated document is cached in shared storage, as a stored client record.
      expect(h.documents.fetched()).toEqual([DOC_URL]);
      expect(h.documents.requests[0]).toMatchObject({
        method: 'GET',
        accept: 'application/json',
        ...(h.documents.observesRedirectMode ? { redirect: 'manual' } : {}),
      });
      const stored = JSON.parse((await h.storage.kv.get(`oauth:client:${DOC_URL}`)) as string) as Record<
        string,
        unknown
      >;
      expect(stored).toMatchObject({
        clientId: DOC_URL,
        clientName: 'Claude-like client',
        tokenEndpointAuthMethod: 'none',
        redirectUris: [LOOPBACK, 'https://client.example.org/callback'],
      });
      // The call with the token works for the workspace it was approved for, through the usual access decision.
      const ok = await mcp(h, 'team-a', tokens.access_token, WHOAMI);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('Team A');
      expect((await mcp(h, 'team-b', tokens.access_token, WHOAMI)).status).toBe(401);
      // The fetch is on the record, by host and lifetime: never the document.
      const rows = await auditRows(h, (r) => r.action === 'oauth.client.fetched');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        clientId: DOC_URL,
        status: 'ok',
        details: { kind: 'metadata_document', host: 'client.example.org', ttlSeconds: 600 },
      });
      expect(JSON.stringify(rows)).not.toContain('Claude-like client');
    });

    it('CIMD: the https callback on the client id host works; one that is not in the document is refused before any redirect', async () => {
      const h = await host();
      h.documents.serveClient(DOC_URL);
      const own = await rawAuthorize(h, DOC_URL, 'https://client.example.org/callback');
      expect(own.status).toBe(302);
      expect(new URL(own.headers.get('location') as string).searchParams.get('code')).not.toBeNull();
      for (const other of [
        'https://client.example.org/other',
        'https://evil.example.net/callback',
        'http://localhost:53682/callback',
      ]) {
        const res = await rawAuthorize(h, DOC_URL, other);
        expect(res.status, other).toBe(400);
        expect(res.headers.get('location'), other).toBeNull();
      }
    });

    each([
      ['an IPv4 literal', 'https://127.0.0.1/meta.json'],
      ['a private IPv4 literal', 'https://10.0.0.5/meta.json'],
      ['the metadata address', 'https://169.254.169.254/latest/meta-data.json'],
      ['an IPv6 loopback', 'https://[::1]/meta.json'],
      ['an IPv4-mapped IPv6 loopback', 'https://[::ffff:7f00:1]/meta.json'],
      ['a unique-local IPv6', 'https://[fd00::1]/meta.json'],
      ['a decimal IPv4 spelling', 'https://2130706433/meta.json'],
      ['a hex IPv4 spelling', 'https://0x7f.1/meta.json'],
      ['localhost', 'https://localhost/meta.json'],
      ['an internal suffix', 'https://metadata.internal/meta.json'],
      ['a name without a dot', 'https://client/meta.json'],
      ['a port', 'https://client.example.org:8443/meta.json'],
      ['userinfo', 'https://user:pw@client.example.org/meta.json'],
      ['a fragment', 'https://client.example.org/meta.json#frag'],
      ['no path', 'https://client.example.org'],
      ['an uppercase host', 'https://Client.Example.org/meta.json'],
      ['dot segments', 'https://client.example.org/a/../meta.json'],
      ['a backslash', 'https://client.example.org\\@evil.example.net/meta.json'],
      ['a client id over 400 characters', `https://client.example.org/${'a'.repeat(420)}`],
    ])('CIMD: %s as client_id is refused before anything is fetched', async (_label, clientId) => {
      const h = await host();
      const response = await rawAuthorize(h, clientId);
      await expectClientRefused(h, clientId, response);
      expect(h.documents.fetched()).toEqual([]);
      // Nor does the token endpoint resolve it.
      const token = await h.call(`${h.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'x',
          code_verifier: 'a'.repeat(43),
          client_id: clientId,
        }).toString(),
      });
      expect(token.status).toBe(400);
      expect(((await token.json()) as { error: string }).error).toBe('invalid_client');
      expect(h.documents.fetched()).toEqual([]);
    });

    it('an unknown or oversized client id that is not a URL is a 400, never a server error', async () => {
      const h = await host();
      for (const clientId of [
        'unknown-client',
        'a'.repeat(600),
        'http://client.example.org/meta.json',
        'ftp://x.example.org/m',
      ]) {
        const res = await rawAuthorize(h, clientId);
        expect(res.status, clientId.slice(0, 30)).toBe(400);
        expect(res.headers.get('location')).toBeNull();
        // Ours for URLs we refuse, the provider's `invalid_request` for a client it does not know.
        expect(['invalid_client', 'invalid_request']).toContain(
          ((await res.json()) as { error: string }).error,
        );
      }
      expect(h.documents.fetched()).toEqual([]);
    });

    const bad: readonly (readonly [
      string,
      (url: string) => Parameters<OAuthHost['documents']['serve']>[1],
    ])[] = [
      [
        'redirects to a private address',
        () => ({ status: 302, headers: { location: 'http://10.0.0.1/meta.json' } }),
      ],
      [
        'redirects to a public one',
        () => ({ status: 301, headers: { location: 'https://other.example.org/meta.json' } }),
      ],
      ['answers 404', () => ({ status: 404 })],
      ['answers 500', () => ({ status: 500, headers: { 'content-type': 'application/json' }, body: '{}' })],
      [
        'is served as HTML',
        (u) => ({ headers: { 'content-type': 'text/html' }, body: JSON.stringify(clientDocument(u)) }),
      ],
      [
        'is larger than 5 KiB',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { pad: 'x'.repeat(6000) })),
        }),
      ],
      [
        'names another client_id',
        () => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument('https://other.example.org/m.json')),
        }),
      ],
      ['is not JSON', () => ({ headers: { 'content-type': 'application/json' }, body: 'not json' })],
      ['is a JSON array', () => ({ headers: { 'content-type': 'application/json' }, body: '[]' })],
      [
        'carries a client_secret',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { client_secret: 'shh' })),
        }),
      ],
      [
        'asks for private_key_jwt',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { token_endpoint_auth_method: 'private_key_jwt' })),
        }),
      ],
      [
        'has no client_name',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { client_name: undefined })),
        }),
      ],
      [
        'has a name with a bidi override',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { client_name: 'Safe‮evil' })),
        }),
      ],
      [
        'has no redirect_uris',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { redirect_uris: [] })),
        }),
      ],
      [
        'lists only a foreign-host callback',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { redirect_uris: ['https://evil.example.net/cb'] })),
        }),
      ],
      [
        'lists a callback with a wildcard',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { redirect_uris: ['https://client.example.org/*'] })),
        }),
      ],
      [
        'lists a callback with a fragment',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { redirect_uris: ['https://client.example.org/cb#x'] })),
        }),
      ],
      [
        'lists a plain-http remote callback',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { redirect_uris: ['http://client.example.org/cb'] })),
        }),
      ],
      [
        'lists a private-address callback',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { redirect_uris: ['https://10.0.0.1/cb'] })),
        }),
      ],
      [
        'lists a javascript: callback',
        (u) => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clientDocument(u, { redirect_uris: ['javascript:alert(1)'] })),
        }),
      ],
    ];
    each(bad)('CIMD: a document that %s is a 400 and is not stored or trusted', async (_label, spec) => {
      const h = await host();
      h.documents.serve(DOC_URL, spec(DOC_URL));
      const response = await rawAuthorize(h, DOC_URL);
      await expectClientRefused(h, DOC_URL, response);
      // Fetched once, and a refusal leaves a row with the stable reason and the host.
      expect(h.documents.fetched()).toEqual([DOC_URL]);
      const rows = await auditRows(h, (r) => r.action === 'oauth.client.refused');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'denied',
        details: { kind: 'metadata_document', host: 'client.example.org' },
      });
      // Errors are never cached: serving a good document afterwards works at once.
      h.documents.serveClient(DOC_URL);
      expect((await rawAuthorize(h, DOC_URL)).status).toBe(302);
    });

    it('CIMD: a document that cannot be fetched now does not burn an authorization code at the token endpoint', async () => {
      const h = await host();
      h.documents.serveClient(DOC_URL);
      const client = documentClient();
      const a = await authorize(h, client);
      expect(a.code).not.toBeNull();
      // The cached record is gone and the document is down: refused, and the code is still good afterwards.
      await h.storage.kv.delete(`oauth:client:${DOC_URL}`);
      h.documents.serve(DOC_URL, { status: 503 });
      const params = {
        grant_type: 'authorization_code',
        code: a.code as string,
        code_verifier: a.verifier,
        redirect_uri: a.redirect,
        client_id: DOC_URL,
        resource: resourceOf(h, 'team-a'),
      };
      const down = await h.call(`${h.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
      // A server that is down says nothing about the client: `invalid_client` would make an SDK client throw away its
      // registration and tokens and ask the person to approve again (P5-10). It is a passing condition, so a 503.
      expect(down.status).toBe(503);
      expect(down.headers.get('retry-after')).not.toBeNull();
      expect(((await down.json()) as { error: string }).error).toBe('temporarily_unavailable');
      h.documents.serveClient(DOC_URL);
      const again = await h.call(`${h.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
      expect(again.status).toBe(200);
    });

    it('CIMD: at the token endpoint a document that is gone or no longer valid is invalid_client, one that is only unreachable is not (P5-10)', async () => {
      const h = await host();
      h.documents.serveClient(DOC_URL);
      const refresh = (clientId: string) =>
        h.call(`${h.origin}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: 'usr_x:AbCdEfGhIjKlMnOp:SecretSecretSecretSecretSecret12',
            client_id: clientId,
          }).toString(),
        });
      const expectVerdict = async (status: number, error: string) => {
        await h.storage.kv.delete(`oauth:client:${DOC_URL}`);
        const res = await refresh(DOC_URL);
        expect(res.status).toBe(status);
        expect(((await res.json()) as { error: string }).error).toBe(error);
      };
      // Verdicts on the client: the document says another client, is not JSON, or is not there.
      h.documents.serveClient(DOC_URL, { client_id: 'https://other.example.org/x' });
      await expectVerdict(400, 'invalid_client');
      h.documents.serve(DOC_URL, { headers: { 'content-type': 'application/json' }, body: 'nope' });
      await expectVerdict(400, 'invalid_client');
      h.documents.serve(DOC_URL, { status: 404 });
      await expectVerdict(400, 'invalid_client');
      // Passing conditions: the server errs or asks to slow down, or the fetch itself fails.
      for (const status of [500, 502, 503, 429]) {
        h.documents.serve(DOC_URL, { status });
        await expectVerdict(503, 'temporarily_unavailable');
      }
    });

    it('CIMD: one address can make the server fetch only so many documents per hour', async () => {
      const h = await host();
      // 20 per hour by default: every attempt counts, including the ones whose document is missing.
      for (let i = 0; i < 20; i++) {
        const res = await rawAuthorize(h, `https://client${i}.example.org/meta.json`);
        expect(res.status).toBe(400);
      }
      expect(h.documents.fetched()).toHaveLength(20);
      const over = await rawAuthorize(h, 'https://client99.example.org/meta.json');
      expect(over.status).toBe(400);
      expect(h.documents.fetched()).toHaveLength(20);
      // A document already stored needs no fetch, so a known client is not locked out by the budget.
      const rows = await auditRows(
        h,
        (r) =>
          r.action === 'oauth.client.refused' && (r as { errorCode?: string }).errorCode === 'fetch_limit',
      );
      expect(rows).toHaveLength(1);
      // The refusal is audited once per window, not once per request.
      await rawAuthorize(h, 'https://client98.example.org/meta.json');
      expect(
        await auditRows(h, (r) => (r as { errorCode?: string }).errorCode === 'fetch_limit'),
      ).toHaveLength(1);
    });

    // ------------------------------------------------------------------------------------------------ DCR

    const register = (h: OAuthHost, body: unknown, init: RequestInit = {}) =>
      h.call(`${h.origin}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        ...init,
      });
    const good = {
      client_name: 'Dynamic client',
      redirect_uris: [LOOPBACK],
      token_endpoint_auth_method: 'none',
    };
    const clientRecords = async (h: OAuthHost) => (await h.storage.kv.list('oauth:client:')).length;

    each([
      ['not JSON', 'nope', 'invalid_client_metadata'],
      ['a JSON array', '[]', 'invalid_client_metadata'],
      ['no redirect_uris', { client_name: 'x' }, 'invalid_redirect_uri'],
      ['an empty redirect_uris', { redirect_uris: [] }, 'invalid_redirect_uri'],
      [
        'eleven redirect_uris',
        { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example.org/${i}`) },
        'invalid_redirect_uri',
      ],
      ['a non-string redirect URI', { redirect_uris: [1] }, 'invalid_redirect_uri'],
      ['a remote http redirect', { redirect_uris: ['http://app.example.org/cb'] }, 'invalid_redirect_uri'],
      ['an https IP-literal redirect', { redirect_uris: ['https://203.0.113.7/cb'] }, 'invalid_redirect_uri'],
      ['a wildcard redirect', { redirect_uris: ['https://*.example.org/cb'] }, 'invalid_redirect_uri'],
      [
        'a redirect with a fragment',
        { redirect_uris: ['https://app.example.org/cb#x'] },
        'invalid_redirect_uri',
      ],
      [
        'a redirect with userinfo',
        { redirect_uris: ['https://u:p@app.example.org/cb'] },
        'invalid_redirect_uri',
      ],
      ['a javascript: redirect', { redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri'],
      ['a data: redirect', { redirect_uris: ['data:text/html,x'] }, 'invalid_redirect_uri'],
      [
        'a private-use scheme only (D-69)',
        { redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] },
        'invalid_redirect_uri',
      ],
      [
        'a redirect with whitespace',
        { redirect_uris: ['https://app.example.org/a b'] },
        'invalid_redirect_uri',
      ],
      [
        'a redirect over 2,000 characters',
        { redirect_uris: [`https://app.example.org/${'a'.repeat(2000)}`] },
        'invalid_redirect_uri',
      ],
      ['a name with a bidi override', { ...good, client_name: 'Safe‮evil' }, 'invalid_client_metadata'],
      ['a name with a zero-width character', { ...good, client_name: 'Co​de' }, 'invalid_client_metadata'],
      [
        'a look-alike (Latin and Cyrillic) name',
        { ...good, client_name: 'Clаude' },
        'invalid_client_metadata',
      ],
      ['a name over 100 characters', { ...good, client_name: 'n'.repeat(101) }, 'invalid_client_metadata'],
      [
        'private_key_jwt',
        { ...good, token_endpoint_auth_method: 'private_key_jwt' },
        'invalid_client_metadata',
      ],
      [
        'tls_client_auth',
        { ...good, token_endpoint_auth_method: 'tls_client_auth' },
        'invalid_client_metadata',
      ],
      ['the implicit grant', { ...good, grant_types: ['implicit'] }, 'invalid_client_metadata'],
      [
        'client_credentials next to the code grant',
        { ...good, grant_types: ['authorization_code', 'client_credentials'] },
        'invalid_client_metadata',
      ],
      ['response type token', { ...good, response_types: ['token'] }, 'invalid_client_metadata'],
    ])('DCR: %s is a 400 and nothing is stored', async (_label, body, error) => {
      const h = await host();
      const res = await register(h, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
      expect(await clientRecords(h)).toBe(0);
    });

    it('DCR: wrong content type and oversized bodies are refused', async () => {
      const h = await host();
      expect(
        (await register(h, JSON.stringify(good), { headers: { 'content-type': 'text/plain' } })).status,
      ).toBe(400);
      expect((await register(h, JSON.stringify({ ...good, pad: 'x'.repeat(20_000) }))).status).toBe(413);
      expect(await clientRecords(h)).toBe(0);
    });

    it('DCR: only the fields we use are stored; nothing else the client names is kept, fetched or echoed', async () => {
      const h = await host();
      const res = await register(h, {
        ...good,
        logo_uri: 'https://tracker.example.net/logo.png',
        client_uri: 'https://tracker.example.net/',
        policy_uri: 'https://tracker.example.net/policy',
        tos_uri: 'https://tracker.example.net/tos',
        jwks_uri: 'https://tracker.example.net/jwks.json',
        contacts: ['boss@example.net'],
        software_statement: 'eyJhbGciOiJub25lIn0.e30.',
        software_id: 'abc',
        redirect_uris: [
          LOOPBACK,
          'cursor://anysphere.cursor-mcp/oauth/callback',
          'https://app.example.org/cb',
        ],
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as Record<string, unknown>;
      expect(JSON.stringify(created)).not.toContain('tracker.example.net');
      expect(created['redirect_uris']).toEqual([LOOPBACK, 'https://app.example.org/cb']);
      const record = (await h.storage.kv.get(`oauth:client:${created['client_id'] as string}`)) as string;
      expect(record).not.toContain('tracker.example.net');
      expect(record).not.toContain('boss@example.net');
      expect(record).not.toContain('cursor://');
      expect(h.documents.fetched()).toEqual([]);
    });

    it('DCR: public and confidential methods are accepted; a registered client completes the code flow', async () => {
      const h = await host();
      for (const method of ['none', 'client_secret_basic', 'client_secret_post']) {
        const res = await register(h, { ...good, token_endpoint_auth_method: method });
        expect(res.status, method).toBe(201);
        expect(
          ((await res.json()) as { token_endpoint_auth_method: string }).token_endpoint_auth_method,
        ).toBe(method);
      }
      const created = (await (await register(h, good)).json()) as { client_id: string };
      const a = await authorize(h, {
        client_id: created.client_id,
        redirect_uris: [LOOPBACK],
      } as OAuthClientInformationFull);
      expect(a.code, `authorize answered ${a.response.status}`).not.toBeNull();
    });

    it('DCR: a registration lives a day until its first token exchange, which renews it', async () => {
      const h = await host();
      const created = (await (await register(h, good)).json()) as { client_id: string };
      const key = `oauth:client:${created.client_id}`;
      const unused = JSON.parse((await h.storage.kv.get(key)) as string) as { registrationExpiresAt: number };
      const nowS = Math.floor(Date.now() / 1000);
      expect(unused.registrationExpiresAt).toBeGreaterThan(nowS + 86_400 - 120);
      expect(unused.registrationExpiresAt).toBeLessThanOrEqual(nowS + 86_400 + 120);
      const client = {
        client_id: created.client_id,
        redirect_uris: [LOOPBACK],
      } as OAuthClientInformationFull;
      const a = await authorize(h, client);
      await exchangeAuthorization(h.origin, {
        metadata: await metadata(h),
        clientInformation: client,
        authorizationCode: a.code as string,
        ...issOf(a),
        codeVerifier: a.verifier,
        redirectUri: a.redirect,
        resource: resourceOf(h, 'team-a'),
        fetchFn: fetchFn(h),
      });
      const used = JSON.parse((await h.storage.kv.get(key)) as string) as { registrationExpiresAt: number };
      expect(used.registrationExpiresAt).toBeGreaterThan(nowS + 80 * 86_400);
    });

    it('DCR: a revocation request is not a use: it cannot renew an unused registration, public or confidential (P5-10)', async () => {
      const h = await host();
      const stamps = async (id: string) => {
        const record = JSON.parse((await h.storage.kv.get(`oauth:client:${id}`)) as string) as {
          registrationDate: number;
          registrationExpiresAt: number;
        };
        return { span: record.registrationExpiresAt - record.registrationDate, record };
      };
      const revoke = (headers: Record<string, string>, params: Record<string, string>) =>
        h.call(`${h.origin}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
          body: new URLSearchParams({ token: 'garbage:token:value', ...params }).toString(),
        });
      // Public: the id alone authenticates it.
      const pub = (await (await register(h, good)).json()) as { client_id: string };
      const before = await stamps(pub.client_id);
      expect(before.span).toBeLessThanOrEqual(86_400 + 120);
      expect((await revoke({}, { client_id: pub.client_id })).status).toBe(200);
      expect((await stamps(pub.client_id)).record).toEqual(before.record);
      // Confidential: an authenticated revocation of a token that is not its own changes nothing either.
      const conf = (await (
        await register(h, { ...good, token_endpoint_auth_method: 'client_secret_basic' })
      ).json()) as { client_id: string; client_secret: string };
      const confBefore = await stamps(conf.client_id);
      const basic = `Basic ${btoa(`${conf.client_id}:${conf.client_secret}`)}`;
      expect((await revoke({ authorization: basic }, {})).status).toBe(200);
      expect((await stamps(conf.client_id)).record).toEqual(confBefore.record);
      // A client that did exchange a code keeps the long lifetime a later revocation request must not shorten.
      const client = { client_id: pub.client_id, redirect_uris: [LOOPBACK] } as OAuthClientInformationFull;
      const a = await authorize(h, client);
      await exchangeAuthorization(h.origin, {
        metadata: await metadata(h),
        clientInformation: client,
        authorizationCode: a.code as string,
        ...issOf(a),
        codeVerifier: a.verifier,
        redirectUri: a.redirect,
        resource: resourceOf(h, 'team-a'),
        fetchFn: fetchFn(h),
      });
      const used = await stamps(pub.client_id);
      expect(used.span).toBeGreaterThan(80 * 86_400);
      expect((await revoke({}, { client_id: pub.client_id })).status).toBe(200);
      expect((await stamps(pub.client_id)).record).toEqual(used.record);
    });

    it('DCR: one address may register 10 clients an hour; the next gets a 429, audited once; others are unaffected', async () => {
      const h = await host();
      for (let i = 0; i < 10; i++) expect((await register(h, good)).status).toBe(201);
      for (let i = 0; i < 3; i++) {
        const res = await register(h, good);
        expect(res.status).toBe(429);
        expect(((await res.json()) as { error: string }).error).toBe('temporarily_unavailable');
        expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      }
      expect(await clientRecords(h)).toBe(10);
      const registered = await auditRows(h, (r) => r.action === 'oauth.client.registered', 10);
      expect(registered).toHaveLength(10);
      expect(registered[0]).toMatchObject({
        status: 'ok',
        details: { kind: 'dynamic', redirectHosts: ['127.0.0.1:53682'] },
      });
      const refused = await auditRows(h, (r) => r.action === 'oauth.client.refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        status: 'denied',
        details: { kind: 'dynamic', reason: 'ip_limit' },
      });
      // The counter is keyed by a hash: no address in storage.
      expect(await kvText(h)).not.toMatch(/203\.0\.113\.9/);
    });

    it('metadata: registration and document support are advertised', async () => {
      const h = await host();
      const m = await metadata(h);
      expect(m.registration_endpoint).toBe(`${h.origin}/oauth/register`);
      expect(
        (m as unknown as { client_id_metadata_document_supported: boolean })
          .client_id_metadata_document_supported,
      ).toBe(true);
    });
  });
}
