// SPDX-License-Identifier: Apache-2.0
// Client registration policy (P5-03, THREAT_MODEL T9, T10, T11): the pure checks, the bounded document fetch against
// fake responses (redirects, oversize, slow, wrong shape), and the `AB_OAUTH_CIMD*` / `AB_OAUTH_DCR*` settings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthConfigError, oauthSettingsFromEnv } from '../../src/index.ts';
import {
  CIMD_MAX_BYTES,
  CIMD_TIMEOUT_MS,
  ClientMetadataError,
  type ClientMetadataFetch,
  checkRegistration,
  clientIdUrlProblem,
  fetchMetadataDocument,
  isIpLiteral,
  isLoopbackHost,
  metadataCacheTtl,
  redirectUriVerdict,
  safeClientName,
  validateMetadataDocument,
} from '../../src/oauth/clients.ts';
import { clientDocument } from './documents.ts';

const URL_OK = 'https://client.example.org/meta.json';

describe('hosts', () => {
  it('knows IP literals in every spelling the URL parser leaves', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '[::1]', '[fd00::1]', '[::ffff:7f00:1]', '[2001:db8::1]']) {
      expect(isIpLiteral(host), host).toBe(true);
    }
    for (const host of ['client.example.org', 'a.b', '1.example.org', 'localhost']) {
      expect(isIpLiteral(host), host).toBe(false);
    }
    // The parser rewrites the other IPv4 spellings to a dotted quad, so they are caught as literals.
    for (const href of ['https://2130706433/', 'https://0x7f.1/', 'https://0177.0.0.1/', 'https://127.1/']) {
      expect(isIpLiteral(new URL(href).hostname), href).toBe(true);
    }
  });

  it('loopback is localhost, 127/8 and [::1] only (RFC 8252)', () => {
    for (const host of ['localhost', '127.0.0.1', '127.9.9.9', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      '128.0.0.1',
      '10.0.0.1',
      '[::ffff:7f00:1]',
      '[::2]',
      'localhost.example.org',
      'evil-localhost',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('display names', () => {
  it('accepts ordinary names and refuses the ones that can mislead a consent screen', () => {
    expect(safeClientName('  Claude Code  ')).toBe('Claude Code');
    expect(safeClientName('日本語クライアント')).toBe('日本語クライアント');
    for (const bad of [
      '',
      '   ',
      'a\u0000b',
      'a\nb',
      'Safe‮evil',
      'Co​de',
      'a b',
      'Clаude',
      'x'.repeat(101),
      5,
      null,
      {},
    ]) {
      expect(safeClientName(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('client id policy', () => {
  it('accepts a canonical https URL on a public-looking DNS name', () => {
    expect(clientIdUrlProblem(URL_OK, 'bridge.example.com')).toBeNull();
    expect(clientIdUrlProblem(URL_OK, 'bridge.example.com', ['client.example.org'])).toBeNull();
    expect(clientIdUrlProblem(URL_OK, 'bridge.example.com', ['other.example.org'])).toBe(
      'client_host_not_allowed',
    );
    expect(
      clientIdUrlProblem('https://claude.ai/oauth/claude-code-client-metadata', 'bridge.example.com'),
    ).toBeNull();
  });

  it.each([
    ['https://client.example.org/meta.json#x', 'client_id_fragment'],
    ['http://client.example.org/meta.json', 'client_id_not_https'],
    ['https://u:p@client.example.org/m', 'client_id_userinfo'],
    ['https://client.example.org:443/m', 'client_id_not_canonical'],
    ['https://client.example.org:8443/m', 'client_id_port'],
    ['https://client.example.org', 'client_id_not_canonical'],
    ['https://client.example.org/', 'client_id_no_path'],
    ['https://127.0.0.1/m', 'client_id_ip_literal'],
    ['https://[::1]/m', 'client_id_ip_literal'],
    ['https://2130706433/m', 'client_id_not_canonical'],
    ['https://client/m', 'client_id_internal_name'],
    ['https://client.example.org./m', 'client_id_internal_name'],
    ['https://host.localhost/m', 'client_id_internal_name'],
    ['https://svc.internal/m', 'client_id_internal_name'],
    ['https://printer.local/m', 'client_id_internal_name'],
    ['https://x.example/m', 'client_id_internal_name'],
    ['https://bridge.example.com/m', 'client_id_self'],
    ['not a url', 'client_id_not_url'],
    [`https://client.example.org/${'a'.repeat(512)}`, 'client_id_too_long'],
    ['HTTPS://client.example.org/m', 'client_id_not_canonical'],
  ])('refuses %s (%s)', (clientId, reason) => {
    expect(clientIdUrlProblem(clientId, 'bridge.example.com')).toBe(reason);
  });
});

describe('redirect URIs', () => {
  it.each([
    ['https://app.example.org/cb', {}, 'usable'],
    ['http://127.0.0.1:1234/cb', {}, 'usable'],
    ['http://localhost/cb', {}, 'usable'],
    ['http://[::1]:9/cb', {}, 'usable'],
    ['https://127.0.0.1/cb', {}, 'usable'],
    ['https://app.example.org/cb', { clientHost: 'app.example.org' }, 'usable'],
    ['https://other.example.org/cb', { clientHost: 'app.example.org' }, 'unusable'],
    ['https://app.example.org/cb', { allowedHosts: ['app.example.org'] }, 'usable'],
    ['https://other.example.org/cb', { allowedHosts: ['app.example.org'] }, 'bad:redirect_uri_host'],
    ['http://127.0.0.1:1234/cb', { allowedHosts: ['app.example.org'] }, 'usable'],
    ['cursor://anysphere.cursor-mcp/oauth/callback', {}, 'unusable'],
    ['com.example.app:/cb', {}, 'unusable'],
    ['http://app.example.org/cb', {}, 'bad:redirect_uri_http'],
    ['http://10.0.0.1/cb', {}, 'bad:redirect_uri_http'],
    ['https://10.0.0.1/cb', {}, 'bad:redirect_uri_ip_literal'],
    ['https://[fd00::1]/cb', {}, 'bad:redirect_uri_ip_literal'],
    ['https://app.example.org/cb#x', {}, 'bad:redirect_uri_fragment'],
    ['https://app.example.org/*', {}, 'bad:redirect_uri_wildcard'],
    ['https://app.example.org/a b', {}, 'bad:redirect_uri_whitespace'],
    ['https://u:p@app.example.org/cb', {}, 'bad:redirect_uri_userinfo'],
    ['javascript:alert(1)', {}, 'bad:redirect_uri_scheme'],
    ['data:text/html,x', {}, 'bad:redirect_uri_scheme'],
    ['file:///etc/passwd', {}, 'bad:redirect_uri_scheme'],
    ['blob:https://app.example.org/x', {}, 'bad:redirect_uri_scheme'],
    ['/relative', {}, 'bad:redirect_uri_not_url'],
    ['', {}, 'bad:redirect_uri_type'],
    [`https://app.example.org/${'a'.repeat(2000)}`, {}, 'bad:redirect_uri_too_long'],
  ])('%s under %j is %s', (uri, policy, verdict) => {
    expect(redirectUriVerdict(uri, policy)).toBe(verdict);
  });

  it('a non-string is refused', () => {
    expect(redirectUriVerdict(5, {})).toBe('bad:redirect_uri_type');
    expect(redirectUriVerdict(null, {})).toBe('bad:redirect_uri_type');
  });
});

describe('registration requests', () => {
  const ok = { redirect_uris: ['https://app.example.org/cb'], client_name: 'App' };

  it('forwards only the fields we use and the usable redirect URIs', () => {
    const verdict = checkRegistration(
      JSON.stringify({
        ...ok,
        redirect_uris: ['https://app.example.org/cb', 'cursor://x/y', 'https://app.example.org/cb'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        logo_uri: 'https://t.example.net/l.png',
        jwks_uri: 'https://t.example.net/j',
        software_statement: 'x.y.z',
      }),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(JSON.parse(verdict.body)).toEqual({
      redirect_uris: ['https://app.example.org/cb'],
      client_name: 'App',
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  it('applies the host allowlist to https redirects only', () => {
    expect(checkRegistration(JSON.stringify(ok), ['other.example.org'])).toMatchObject({
      ok: false,
      reason: 'redirect_uri_host',
    });
    expect(checkRegistration(JSON.stringify(ok), ['app.example.org']).ok).toBe(true);
    expect(
      checkRegistration(JSON.stringify({ redirect_uris: ['http://127.0.0.1:5/cb'] }), ['app.example.org']).ok,
    ).toBe(true);
  });

  it.each([
    [{ ...ok, grant_types: 'authorization_code' }, 'grant_types'],
    [{ ...ok, grant_types: ['refresh_token'] }, 'grant_types'],
    [
      { ...ok, grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer'] },
      'grant_types',
    ],
    [{ ...ok, response_types: ['code', 'token'] }, 'response_types'],
    [{ ...ok, token_endpoint_auth_method: ['none'] }, 'token_endpoint_auth_method'],
    [{ ...ok, client_name: 5 }, 'client_name'],
  ])('refuses %j (%s)', (body, reason) => {
    expect(checkRegistration(JSON.stringify(body))).toMatchObject({
      ok: false,
      error: 'invalid_client_metadata',
      reason,
    });
  });
});

describe('metadata documents', () => {
  const doc = (over: Record<string, unknown> = {}) => clientDocument(URL_OK, over);

  it('validates into the provider record, public client only, usable redirects only', () => {
    const client = validateMetadataDocument(
      URL_OK,
      doc({
        redirect_uris: [
          'http://127.0.0.1:1/cb',
          'https://client.example.org/cb',
          'https://elsewhere.example.net/cb',
          'cursor://x/y',
        ],
        grant_types: ['authorization_code', 'implicit'],
      }),
      1000,
    );
    expect(client).toEqual({
      clientId: URL_OK,
      clientName: 'Document client',
      redirectUris: ['http://127.0.0.1:1/cb', 'https://client.example.org/cb'],
      tokenEndpointAuthMethod: 'none',
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
      registrationDate: 1000,
    });
  });

  it.each([
    [{ client_id: 'https://client.example.org/other.json' }, 'client_id_mismatch'],
    [{ client_id: `${URL_OK}?x=1` }, 'client_id_mismatch'],
    [{ client_name: undefined }, 'client_name'],
    [{ client_secret: 'x' }, 'client_secret'],
    [{ client_secret_expires_at: 0 }, 'client_secret'],
    [{ token_endpoint_auth_method: 'client_secret_basic' }, 'token_endpoint_auth_method'],
    [{ grant_types: ['refresh_token'] }, 'grant_types'],
    [{ grant_types: 'authorization_code' }, 'grant_types'],
    [{ response_types: ['token'] }, 'response_types'],
    [{ redirect_uris: [] }, 'redirect_uris_count'],
    [
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${i + 1}/cb`) },
      'redirect_uris_count',
    ],
    [{ redirect_uris: ['https://elsewhere.example.net/cb'] }, 'no_usable_redirect_uri'],
    [{ redirect_uris: ['https://client.example.org/cb#x'] }, 'redirect_uri_fragment'],
    [{ redirect_uris: ['https://client.example.org/*'] }, 'redirect_uri_wildcard'],
    [{ redirect_uris: ['http://client.example.org/cb'] }, 'redirect_uri_http'],
  ])('refuses %j (%s)', (over, reason) => {
    expect(() => validateMetadataDocument(URL_OK, doc(over), 0)).toThrow(
      expect.objectContaining({ name: 'ClientMetadataError', reason }),
    );
  });

  it('refuses a document that is not an object', () => {
    for (const value of [null, [], 'x', 5]) {
      expect(() => validateMetadataDocument(URL_OK, value, 0)).toThrow(ClientMetadataError);
    }
  });

  it('bounds the cache lifetime to 5 minutes - 24 hours (1 hour by default)', () => {
    expect(metadataCacheTtl(null)).toBe(3600);
    expect(metadataCacheTtl('public')).toBe(3600);
    expect(metadataCacheTtl('max-age=10')).toBe(300);
    expect(metadataCacheTtl('max-age=600')).toBe(600);
    expect(metadataCacheTtl('max-age=999999999')).toBe(86_400);
    expect(metadataCacheTtl('public, s-maxage=900, max-age=60')).toBe(900);
    expect(metadataCacheTtl('no-store')).toBe(300);
    expect(metadataCacheTtl('private, max-age=7200')).toBe(300);
  });
});

describe('fetching a document', () => {
  afterEach(() => vi.useRealTimers());
  const json = { 'content-type': 'application/json' };
  const body = (over: Record<string, unknown> = {}) => JSON.stringify(clientDocument(URL_OK, over));
  const serving =
    (make: () => Response): ClientMetadataFetch =>
    async () =>
      make();
  const refusedWith = (fetcher: ClientMetadataFetch, reason: string) =>
    expect(fetchMetadataDocument(URL_OK, fetcher, 0)).rejects.toMatchObject({ reason });

  it('returns the client and a bounded cache lifetime for a good document', async () => {
    const result = await fetchMetadataDocument(
      URL_OK,
      serving(() => new Response(body(), { headers: { ...json, 'cache-control': 'max-age=1200' } })),
      5,
    );
    expect(result.client.clientId).toBe(URL_OK);
    expect(result.ttlSeconds).toBe(1200);
    // Structured-syntax JSON types are accepted, parameters ignored.
    await fetchMetadataDocument(
      URL_OK,
      serving(
        () =>
          new Response(body(), {
            headers: { 'content-type': 'application/client-metadata+json; charset=utf-8' },
          }),
      ),
      5,
    );
  });

  it('treats every redirect as a failure, and an opaque redirect too', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      await refusedWith(
        serving(() => new Response(null, { status, headers: { location: 'http://10.0.0.1/' } })),
        'redirect',
      );
    }
    const opaque = Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' });
    await refusedWith(
      serving(() => opaque),
      'redirect',
    );
  });

  it('accepts only 200 and a JSON media type', async () => {
    await refusedWith(
      serving(() => new Response(body(), { status: 201, headers: json })),
      'http_status',
    );
    await refusedWith(
      serving(() => new Response('', { status: 404 })),
      'http_status',
    );
    await refusedWith(
      serving(() => new Response(body(), { headers: { 'content-type': 'text/html' } })),
      'content_type',
    );
    await refusedWith(
      serving(() => new Response(body())),
      'content_type',
    );
    await refusedWith(
      serving(() => new Response(body(), { headers: { 'content-type': 'application/jsonx' } })),
      'content_type',
    );
  });

  it('refuses a document over 5 KiB, declared or streamed, and stops reading', async () => {
    await refusedWith(
      serving(
        () => new Response(body(), { headers: { ...json, 'content-length': String(CIMD_MAX_BYTES + 1) } }),
      ),
      'too_large',
    );
    await refusedWith(
      serving(() => new Response(body(), { headers: { ...json, 'content-length': 'lots' } })),
      'too_large',
    );
    await refusedWith(
      serving(() => new Response(body({ pad: 'x'.repeat(CIMD_MAX_BYTES) }), { headers: json })),
      'too_large',
    );
    // A body that never ends is cut at the cap, not read to the end.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new Uint8Array(1024).fill(120));
      },
    });
    await refusedWith(
      serving(() => new Response(endless, { headers: json })),
      'too_large',
    );
    expect(pulled).toBeLessThanOrEqual(CIMD_MAX_BYTES + 4096);
  });

  it('refuses bodies that are not UTF-8 JSON objects', async () => {
    await refusedWith(
      serving(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: json })),
      'not_utf8',
    );
    await refusedWith(
      serving(() => new Response('{"client_id":', { headers: json })),
      'not_json',
    );
    await refusedWith(
      serving(() => new Response('[]', { headers: json })),
      'not_object',
    );
  });

  it('gives up after 5 seconds on a server that never answers, even if the fetcher ignores its signal', async () => {
    vi.useFakeTimers();
    const hung: ClientMetadataFetch = () => new Promise<Response>(() => undefined);
    const pending = expect(fetchMetadataDocument(URL_OK, hung, 0)).rejects.toMatchObject({
      reason: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS + 1);
    await pending;
  });

  it('gives up on a body that stops sending (headers sent, then nothing)', async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"client_id":'));
      },
    });
    const pending = expect(
      fetchMetadataDocument(
        URL_OK,
        serving(() => new Response(stalled, { headers: json })),
        0,
      ),
    ).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS + 1);
    await pending;
  });

  it('reports a failing fetcher as a failure without its message', async () => {
    const failing: ClientMetadataFetch = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443 secret-detail');
    };
    const error = await fetchMetadataDocument(URL_OK, failing, 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientMetadataError);
    expect((error as ClientMetadataError).reason).toBe('fetch_failed');
    expect(String(error)).not.toContain('10.0.0.1');
  });

  it('passes the abort signal on', async () => {
    let seen: AbortSignal | undefined;
    await fetchMetadataDocument(
      URL_OK,
      async (_url, init) => {
        seen = init.signal;
        return new Response(body(), { headers: json });
      },
      0,
    );
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

describe('AB_OAUTH client registration settings', () => {
  const on = { AB_OAUTH: 'on' };
  const read = (env: Record<string, string>) => oauthSettingsFromEnv({ ...on, ...env }, true);

  it('leaves the defaults to the server when nothing is set', () => {
    expect(read({})).toEqual({});
  });

  it('reads the switches, the caps, the allowlist and the unused lifetime', () => {
    expect(
      read({
        AB_OAUTH_CIMD: 'off',
        AB_OAUTH_CIMD_MAX_CLIENTS: '50',
        AB_OAUTH_CIMD_FETCH_LIMIT: '5',
        AB_OAUTH_DCR: 'OFF',
        AB_OAUTH_DCR_MAX_CLIENTS: '10',
        AB_OAUTH_DCR_IP_LIMIT: '3',
        AB_OAUTH_DCR_REDIRECT_HOSTS: 'Claude.ai, chat.example.org,claude.ai',
        AB_OAUTH_DCR_UNUSED_TTL: '2h',
      }),
    ).toEqual({
      clientMetadataDocuments: false,
      clientMetadataMaxClients: 50,
      clientMetadataFetchLimit: 5,
      registration: false,
      registrationMaxClients: 10,
      registrationIpLimit: 3,
      registrationRedirectHosts: ['claude.ai', 'chat.example.org'],
      registrationUnusedTtlSeconds: 7200,
    });
  });

  it.each([
    ['AB_OAUTH_CIMD', 'maybe'],
    ['AB_OAUTH_DCR', '1'],
    ['AB_OAUTH_CIMD_MAX_CLIENTS', '0'],
    ['AB_OAUTH_CIMD_MAX_CLIENTS', '501'],
    ['AB_OAUTH_CIMD_FETCH_LIMIT', '0'],
    ['AB_OAUTH_CIMD_FETCH_LIMIT', '10001'],
    ['AB_OAUTH_DCR_MAX_CLIENTS', '0'],
    ['AB_OAUTH_DCR_MAX_CLIENTS', '1000'],
    ['AB_OAUTH_DCR_MAX_CLIENTS', 'many'],
    ['AB_OAUTH_DCR_IP_LIMIT', '-1'],
    ['AB_OAUTH_DCR_IP_LIMIT', '1.5'],
    ['AB_OAUTH_DCR_UNUSED_TTL', '30m'],
    ['AB_OAUTH_DCR_UNUSED_TTL', '8d'],
    ['AB_OAUTH_DCR_REDIRECT_HOSTS', 'https://claude.ai'],
    ['AB_OAUTH_DCR_REDIRECT_HOSTS', 'claude.ai:443'],
    ['AB_OAUTH_DCR_REDIRECT_HOSTS', '*.claude.ai'],
    ['AB_OAUTH_DCR_REDIRECT_HOSTS', ','],
  ])('refuses %s=%s, naming the variable', (name, value) => {
    let thrown: unknown;
    try {
      read({ [name]: value });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OAuthConfigError);
    expect((thrown as OAuthConfigError).variable).toBe(name);
  });
});
