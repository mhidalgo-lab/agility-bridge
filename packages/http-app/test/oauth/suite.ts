// SPDX-License-Identifier: Apache-2.0
// The OAuth 2.1 conformance and negative-authorization suite (P5-01, L-121, THREAT_MODEL T2, T8, T9, T15, T19, T25),
// written once against `OAuthHost` and run on Node with memory storage (http-app), on Node with SQLite (cli) and in
// workerd with D1 (worker). The clients are the MCP TypeScript SDK's own OAuth functions, so what is tested is what a
// real SDK client sends: discovery metadata, dynamic registration, an authorization URL with PKCE S256 and the RFC 8707
// `resource`, the RFC 9207 `iss` check, a form-encoded code exchange and refresh.
import type { Storage } from '@agility-bridge/storage';
import {
  type AuthorizationServerMetadata,
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  type OAuthClientInformationFull,
  type OAuthClientProvider,
  type OAuthTokens,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthRegistrations } from '../../src/index.ts';
import { APPROVE_HEADER } from './consent.ts';
import type { FakeDocuments } from './documents.ts';

/** What the suite needs from a running server with OAuth on, two workspaces and the users of `world()`. */
export interface OAuthHost {
  /** The issuer: the public URL every OAuth address is built from. */
  readonly origin: string;
  /** A request to the app, by absolute URL. */
  call(url: string, init?: RequestInit): Promise<Response>;
  readonly storage: Storage;
  readonly ids: {
    readonly alice: string;
    readonly bob: string;
    readonly workspaceA: string;
    readonly workspaceB: string;
    /** Alice's grants on team-a and team-b, Bob's on team-b, and a service grant (no user) on team-a. */
    readonly aliceGrantA: string;
    readonly aliceGrantB: string;
    readonly bobGrantB: string;
    readonly serviceGrantA: string;
    readonly aliceDeviceTokenA: string;
  };
  /** Requests that reached the (fake) Agility so far. */
  agilityRequests(): number;
  /** Log lines written so far (empty where they cannot be read, as in workerd). */
  logs(): readonly string[];
  /** The database file's bytes, where there is one (SQLite): for the "no plaintext in a copy" scan. */
  rawDatabase?(): string;
  /** The fake origin of client metadata documents (P5-03): what the host's guarded fetcher talks to. */
  readonly documents: FakeDocuments;
  /** The app's registration hooks (in-process hosts only). */
  readonly registrations?: OAuthRegistrations;
  /** Moves time (Node hosts, in process); absent in workerd. */
  advance?(ms: number): void;
  close(): Promise<void>;
}

export const REDIRECT = 'http://127.0.0.1:53682/callback';
export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
export const WHOAMI = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'whoami', arguments: {} },
};
const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
export const issOf = (a: { location: URL | null }) => {
  const iss = a.location?.searchParams.get('iss');
  return iss === null || iss === undefined ? {} : { iss };
};

export const fetchFn = (h: OAuthHost) => (url: string | URL, init?: RequestInit) => h.call(String(url), init);
export const resourceOf = (h: OAuthHost, slug: string) => `${h.origin}/w/${slug}/mcp`;

export async function metadata(h: OAuthHost): Promise<AuthorizationServerMetadata> {
  const m = await discoverAuthorizationServerMetadata(h.origin, { fetchFn: fetchFn(h) });
  if (m === undefined) throw new Error('no authorization server metadata');
  return m;
}

export async function register(
  h: OAuthHost,
  over: { redirect?: string; name?: string; confidential?: boolean } = {},
): Promise<OAuthClientInformationFull> {
  return registerClient(h.origin, {
    metadata: await metadata(h),
    clientMetadata: {
      client_name: over.name ?? 'SDK conformance client',
      redirect_uris: [over.redirect ?? REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: over.confidential === true ? 'client_secret_post' : 'none',
    },
    fetchFn: fetchFn(h),
  });
}

export interface Authorized {
  readonly response: Response;
  readonly location: URL | null;
  readonly code: string | null;
  readonly state: string;
  readonly verifier: string;
  readonly client: OAuthClientInformationFull;
  readonly redirect: string;
}

/** The SDK's authorization URL for a workspace, requested as a browser would, approved as `who` says. */
export async function authorize(
  h: OAuthHost,
  client: OAuthClientInformationFull,
  options: {
    slug?: string;
    who?: string;
    scope?: string;
    redirect?: string;
    resource?: string | null;
    edit?: (url: URL) => void;
  } = {},
): Promise<Authorized> {
  const redirect = options.redirect ?? REDIRECT;
  const state = `state-${Math.random().toString(36).slice(2)}`;
  const { authorizationUrl, codeVerifier } = await startAuthorization(h.origin, {
    metadata: await metadata(h),
    clientInformation: client,
    redirectUrl: redirect,
    scope: options.scope ?? 'mcp:read offline_access',
    state,
    ...(options.resource === null
      ? {}
      : { resource: options.resource ?? resourceOf(h, options.slug ?? 'team-a') }),
  });
  options.edit?.(authorizationUrl);
  const response = await h.call(authorizationUrl.href, {
    redirect: 'manual',
    headers: { [APPROVE_HEADER]: options.who ?? `${h.ids.alice}|${h.ids.aliceGrantA}` },
  });
  const location =
    response.headers.get('location') === null ? null : new URL(response.headers.get('location') as string);
  return {
    response,
    location,
    code: location?.searchParams.get('code') ?? null,
    state,
    verifier: codeVerifier,
    client,
    redirect,
  };
}

export const form = (params: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});
export const tokenEndpoint = (
  h: OAuthHost,
  params: Record<string, string>,
  init: RequestInit = form(params),
) => h.call(`${h.origin}/oauth/token`, init);

const exchangeParams = (a: Authorized, slug = 'team-a', h?: OAuthHost): Record<string, string> => ({
  grant_type: 'authorization_code',
  code: a.code as string,
  code_verifier: a.verifier,
  redirect_uri: a.redirect,
  client_id: a.client.client_id,
  ...(h === undefined ? {} : { resource: resourceOf(h, slug) }),
});

/** Authorize and exchange through the SDK; returns the tokens. */
export async function connectWorkspace(
  h: OAuthHost,
  slug = 'team-a',
  who?: string,
  client?: OAuthClientInformationFull,
): Promise<{ tokens: OAuthTokens; client: OAuthClientInformationFull; a: Authorized }> {
  const c = client ?? (await register(h));
  const a = await authorize(h, c, { slug, ...(who === undefined ? {} : { who }) });
  expect(a.code, `authorize answered ${a.response.status}`).not.toBeNull();
  const tokens = await exchangeAuthorization(h.origin, {
    metadata: await metadata(h),
    clientInformation: c,
    authorizationCode: a.code as string,
    ...issOf(a),
    codeVerifier: a.verifier,
    redirectUri: a.redirect,
    resource: resourceOf(h, slug),
    fetchFn: fetchFn(h),
  });
  return { tokens, client: c, a };
}

export const mcp = (h: OAuthHost, slug: string, token: string | null, body: unknown = LIST) =>
  h.call(`${h.origin}/w/${slug}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

export async function auditRows(h: OAuthHost, wanted: (row: { action: string }) => boolean, minimum = 1) {
  // Rows are written in the background (and through waitUntil in workerd): wait for them.
  for (let i = 0; i < 100; i++) {
    const rows = (await h.storage.audit.query({ limit: 1000 })).filter(wanted);
    if (rows.length >= minimum) return rows;
    await new Promise((r) => setTimeout(r, 30));
  }
  return (await h.storage.audit.query({ limit: 1000 })).filter(wanted);
}

/** Every `kv` row, as text. */
export async function kvText(h: OAuthHost): Promise<string> {
  const out: string[] = [];
  let after: string | undefined;
  for (;;) {
    const keys = await h.storage.kv.list('', { limit: 1000, ...(after === undefined ? {} : { after }) });
    for (const k of keys) out.push(`${k}=${(await h.storage.kv.get(k)) ?? ''}`);
    if (keys.length < 1000) break;
    after = keys[keys.length - 1];
  }
  return out.join('\n');
}

/** Everything a denied OAuth request must not do, against the same request without any token. */
async function expectDenied(h: OAuthHost, slug: string, token: string, reason: string) {
  const requests = h.agilityRequests();
  const toolCalls = (await h.storage.audit.query({ kind: 'tool_call', limit: 1000 })).length;
  const reference = await mcp(h, slug, null, WHOAMI);
  const denied = await mcp(h, slug, token, WHOAMI);
  expect(denied.status).toBe(401);
  // One body and one challenge for every denial (T19): not a hint of why.
  expect(await denied.text()).toBe(await reference.text());
  expect(denied.headers.get('www-authenticate')).toBe(reference.headers.get('www-authenticate'));
  expect(h.agilityRequests()).toBe(requests);
  expect((await h.storage.audit.query({ kind: 'tool_call', limit: 1000 })).length).toBe(toolCalls);
  const rows = await auditRows(
    h,
    (r) =>
      r.action === 'mcp.unauthenticated' &&
      (r as { details?: { reason?: string } }).details?.reason === reason,
  );
  expect(rows.length, `audit reason ${reason}`).toBeGreaterThanOrEqual(1);
}

export function defineOAuthSuite(name: string, makeHost: () => Promise<OAuthHost>): void {
  describe(`OAuth 2.1 server: ${name}`, () => {
    const open: OAuthHost[] = [];
    afterEach(async () => {
      vi.useRealTimers();
      await Promise.all(open.splice(0).map((h) => h.close()));
    });
    const host = async (): Promise<OAuthHost> => {
      const h = await makeHost();
      open.push(h);
      return h;
    };

    // ------------------------------------------------------------------------------------------------ metadata

    it('publishes RFC 8414 metadata: S256 only, RFC 9207 iss, our endpoints, no workspace list', async () => {
      const h = await host();
      const res = await h.call(`${h.origin}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);
      const m = (await res.json()) as Record<string, unknown>;
      expect(m).toMatchObject({
        issuer: h.origin,
        authorization_endpoint: `${h.origin}/oauth/authorize`,
        token_endpoint: `${h.origin}/oauth/token`,
        registration_endpoint: `${h.origin}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        // Client ID Metadata Documents (P5-03): advertised because every host here has a guarded fetcher.
        client_id_metadata_document_supported: true,
      });
      expect(m['response_types_supported']).toEqual(['code']);
      expect(m['grant_types_supported']).toEqual(
        expect.arrayContaining(['authorization_code', 'refresh_token']),
      );
      expect(m['scopes_supported']).toEqual(['mcp:read', 'offline_access']);
      expect(m['token_endpoint_auth_methods_supported']).toEqual(expect.arrayContaining(['none']));
      // Workspace slugs are not public (T19): no list of protected resources.
      expect(JSON.stringify(m)).not.toContain('team-a');
      expect(m['protected_resources']).toBeUndefined();
      // The issuer is the configured public URL, never the Host header.
      const spoof = await h.call(`${h.origin}/.well-known/oauth-authorization-server`, {
        headers: { host: 'evil.example' },
      });
      if (spoof.status === 200) expect(((await spoof.json()) as { issuer: string }).issuer).toBe(h.origin);
    });

    // ------------------------------------------------------------------------- protected resource metadata (P5-02)

    const PRM = (h: OAuthHost, slug: string) =>
      `${h.origin}/.well-known/oauth-protected-resource/w/${slug}/mcp`;

    it('publishes RFC 9728 metadata per workspace: its own resource, our issuer, one scope, header bearer', async () => {
      const h = await host();
      for (const slug of ['team-a', 'team-b']) {
        const res = await h.call(PRM(h, slug));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        // The app-wide policy (D-65): nothing is cached, so a change of issuer or scope shows at once.
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({
          resource: resourceOf(h, slug),
          authorization_servers: [h.origin],
          scopes_supported: ['mcp:read'],
          bearer_methods_supported: ['header'],
        });
      }
      // The SDK parses it, at the path-insertion URL it derives from the MCP URL.
      const parsed = await discoverOAuthProtectedResourceMetadata(resourceOf(h, 'team-a'), {}, fetchFn(h));
      expect(parsed.resource).toBe(resourceOf(h, 'team-a'));
      // The issuer is the configured public URL, never the Host header.
      const spoof = await h.call(PRM(h, 'team-a'), { headers: { host: 'evil.example' } });
      if (spoof.status === 200) expect(JSON.stringify(await spoof.json())).not.toContain('evil.example');
    });

    it('answers a known, an unknown and a disabled workspace alike; an invalid slug or the root is a 404', async () => {
      const h = await host();
      const shape = async (slug: string) => {
        const res = await h.call(PRM(h, slug));
        return {
          status: res.status,
          type: res.headers.get('content-type'),
          cache: res.headers.get('cache-control'),
          body: (await res.text()).replaceAll(slug, '<slug>'),
        };
      };
      const known = await shape('team-a');
      expect(known.status).toBe(200);
      // Nothing the MCP route does not already reveal (T19): its 401 is one answer for all of these.
      expect(await shape('no-such-workspace')).toEqual(known);
      await h.storage.workspaces.update(h.ids.workspaceA, { disabledAt: Date.now() });
      expect(await shape('team-a')).toEqual(known);
      await h.storage.workspaces.update(h.ids.workspaceA, { disabledAt: null });
      for (const path of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/',
        '/.well-known/oauth-protected-resource/w/Team-A/mcp',
        '/.well-known/oauth-protected-resource/w/-bad/mcp',
        '/.well-known/oauth-protected-resource/w/team-a/mcp/extra',
        '/.well-known/oauth-protected-resource/w/team-a',
        `/.well-known/oauth-protected-resource/w/${'a'.repeat(64)}/mcp`,
      ]) {
        const res = await h.call(`${h.origin}${path}`);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).not.toContain('authorization_servers');
      }
      // Reading only.
      expect((await h.call(PRM(h, 'team-a'), { method: 'POST', body: '{}' })).status).toBe(404);
    });

    it('challenges every 401 with the workspace metadata URL, the same for unknown workspaces and every denial', async () => {
      const h = await host();
      const expected = (slug: string) =>
        `Bearer realm="agility-bridge", resource_metadata="${PRM(h, slug)}", scope="mcp:read"`;
      const neverIssued = `usr_${'a'.repeat(32)}:${'B'.repeat(16)}:${'c'.repeat(32)}`;
      const a = await connectWorkspace(h, 'team-a');
      const cases: readonly (readonly [string, string, string | null])[] = [
        ['no token', 'team-a', null],
        ['malformed token', 'team-a', 'not-a-token'],
        ['OAuth-shaped token that was never issued', 'team-a', neverIssued],
        ['device token of another workspace', 'team-b', h.ids.aliceDeviceTokenA],
        ['OAuth token of another workspace', 'team-b', a.tokens.access_token],
        ['an unknown workspace', 'no-such-workspace', a.tokens.access_token],
      ];
      for (const [label, slug, token] of cases) {
        const res = await mcp(h, slug, token, WHOAMI);
        expect(res.status, label).toBe(401);
        expect(res.headers.get('www-authenticate'), label).toBe(expected(slug));
        expect(await res.json(), label).toEqual({ error: 'unauthorized' });
      }
      // The SDK reads the URL and the scope out of it; no error code splits a missing token from a wrong one.
      const params = extractWWWAuthenticateParams(await mcp(h, 'team-a', null, WHOAMI));
      expect(params.resourceMetadataUrl?.href).toBe(PRM(h, 'team-a'));
      expect(params.scope).toBe('mcp:read');
      expect(params.error).toBeUndefined();
      // A slug that is not valid syntax has nothing to point at: the plain challenge.
      const bad = await h.call(`${h.origin}/w/Bad_Slug/mcp`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: '{}',
      });
      expect(bad.status).toBe(401);
      expect(bad.headers.get('www-authenticate')).toBe('Bearer');
    });

    it('a client that starts from the MCP URL follows the challenge to the resource, authorizes and connects', async () => {
      const h = await host();
      const url = resourceOf(h, 'team-a');
      // The spec's first step: an unauthenticated request, a 401, and a challenge naming the document.
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(await mcp(h, 'team-a', null, LIST));
      expect(resourceMetadataUrl).toBeDefined();
      const doc = await discoverOAuthProtectedResourceMetadata(
        url,
        { resourceMetadataUrl: resourceMetadataUrl as URL },
        fetchFn(h),
      );
      expect(doc.resource).toBe(url);
      expect(doc.authorization_servers).toEqual([h.origin]);
      // Authorization server metadata from the issuer the document names, then the flow with the document's resource.
      const as = await discoverAuthorizationServerMetadata(doc.authorization_servers?.[0] as string, {
        fetchFn: fetchFn(h),
      });
      expect(as?.issuer).toBe(h.origin);
      const client = await register(h);
      const a = await authorize(h, client, { resource: doc.resource, scope: scope ?? '' });
      expect(a.code, `authorize answered ${a.response.status}`).not.toBeNull();
      const tokens = await exchangeAuthorization(h.origin, {
        metadata: await metadata(h),
        clientInformation: client,
        authorizationCode: a.code as string,
        ...issOf(a),
        codeVerifier: a.verifier,
        redirectUri: a.redirect,
        resource: new URL(doc.resource),
        fetchFn: fetchFn(h),
      });
      expect((await mcp(h, 'team-a', tokens.access_token)).status).toBe(200);
      // The audience is the one workspace the document named (T2).
      expect((await mcp(h, 'team-b', tokens.access_token)).status).toBe(401);
      // And refresh cannot retarget it.
      const retarget = await tokenEndpoint(h, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token as string,
        client_id: client.client_id,
        resource: resourceOf(h, 'team-b'),
      });
      expect(retarget.status).toBeGreaterThanOrEqual(400);
    });

    it("the SDK's auth() driven by the challenge's resource_metadata URL connects to another workspace", async () => {
      const h = await host();
      const slug = 'team-b';
      const serverUrl = resourceOf(h, slug);
      let saved: OAuthTokens | undefined;
      let info: OAuthClientInformationFull | undefined;
      let verifier = '';
      let redirected: URL | undefined;
      const provider: OAuthClientProvider = {
        get redirectUrl() {
          return REDIRECT;
        },
        get clientMetadata() {
          return {
            client_name: 'SDK challenge client',
            redirect_uris: [REDIRECT],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          };
        },
        clientInformation: () => info,
        saveClientInformation: (i) => {
          info = i as OAuthClientInformationFull;
        },
        tokens: () => saved,
        saveTokens: (t) => {
          saved = t;
        },
        redirectToAuthorization: (u) => {
          redirected = u;
        },
        saveCodeVerifier: (v) => {
          verifier = v;
        },
        codeVerifier: () => verifier,
      };
      const challenge = extractWWWAuthenticateParams(await mcp(h, slug, null, LIST));
      const resourceMetadataUrl = challenge.resourceMetadataUrl as URL;
      expect(resourceMetadataUrl.href).toBe(PRM(h, slug));
      expect(
        await auth(provider, {
          serverUrl,
          resourceMetadataUrl,
          ...(challenge.scope === undefined ? {} : { scope: challenge.scope }),
          fetchFn: fetchFn(h),
        }),
      ).toBe('REDIRECT');
      const url = redirected as URL;
      expect(url.searchParams.get('resource')).toBe(serverUrl);
      // The scope of the challenge (the SDK adds `offline_access` itself when the server supports it).
      expect(url.searchParams.get('scope')?.split(' ')).toContain('mcp:read');
      const res = await h.call(url.href, {
        redirect: 'manual',
        headers: { [APPROVE_HEADER]: `${h.ids.alice}|${h.ids.aliceGrantB}` },
      });
      const back = new URL(res.headers.get('location') as string);
      expect(
        await auth(provider, {
          serverUrl,
          resourceMetadataUrl,
          authorizationCode: back.searchParams.get('code') as string,
          ...issOf({ location: back }),
          fetchFn: fetchFn(h),
        }),
      ).toBe('AUTHORIZED');
      const token = (saved as OAuthTokens).access_token;
      expect((await mcp(h, slug, token, WHOAMI)).status).toBe(200);
      expect((await mcp(h, 'team-a', token, WHOAMI)).status).toBe(401);
    });

    // ------------------------------------------------------------------------------------------------ the flow

    it('an SDK client registers, authorizes one workspace, exchanges the code, calls MCP and refreshes', async () => {
      const h = await host();
      const meta = await metadata(h);
      const client = await register(h);
      expect(client.client_id).toBeTruthy();
      const a = await authorize(h, client);
      expect(a.response.status).toBe(302);
      expect(`${a.location?.origin}${a.location?.pathname}`).toBe(REDIRECT);
      expect(a.location?.searchParams.get('state')).toBe(a.state);
      // RFC 9207: the issuer is in the authorization response.
      expect(a.location?.searchParams.get('iss')).toBe(h.origin);
      expect(a.code).toMatch(/^usr_[0-9a-f]{32}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{32}$/);

      const tokens = await exchangeAuthorization(h.origin, {
        metadata: meta,
        clientInformation: client,
        authorizationCode: a.code as string,
        ...issOf(a),
        codeVerifier: a.verifier,
        redirectUri: REDIRECT,
        resource: resourceOf(h, 'team-a'),
        fetchFn: fetchFn(h),
      });
      expect(tokens.token_type.toLowerCase()).toBe('bearer');
      expect(tokens.expires_in).toBeGreaterThan(3000);
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.scope?.split(' ').sort()).toEqual(['mcp:read', 'offline_access']);

      // The access token works at the workspace it was issued for, with the same tools the grant has.
      const before = h.agilityRequests();
      const list = await mcp(h, 'team-a', tokens.access_token);
      expect(list.status).toBe(200);
      expect(await list.text()).toContain('whoami');
      // Listing tools costs no Agility request.
      expect(h.agilityRequests()).toBe(before);
      const who = await mcp(h, 'team-a', tokens.access_token, WHOAMI);
      expect(who.status).toBe(200);
      expect(await who.text()).toContain('Team A');

      // Refresh: a new pair, and the new access token works.
      const refreshed = await refreshAuthorization(h.origin, {
        metadata: meta,
        clientInformation: client,
        refreshToken: tokens.refresh_token as string,
        resource: resourceOf(h, 'team-a'),
        fetchFn: fetchFn(h),
      });
      expect(refreshed.access_token).not.toBe(tokens.access_token);
      expect((await mcp(h, 'team-a', refreshed.access_token)).status).toBe(200);
      // The new refresh token rotates again. (Whether the previous one may be used again, and for how long, is the
      // provider's one-generation rule today and P5-05's reuse window tomorrow: not asserted here.)
      const second = await refreshAuthorization(h.origin, {
        metadata: meta,
        clientInformation: client,
        refreshToken: refreshed.refresh_token as string,
        resource: resourceOf(h, 'team-a'),
        fetchFn: fetchFn(h),
      });
      expect((await mcp(h, 'team-a', second.access_token)).status).toBe(200);
    });

    it("the SDK's whole auth() flow connects to a workspace's MCP URL", async () => {
      const h = await host();
      const slug = 'team-a';
      let saved: OAuthTokens | undefined;
      let info: OAuthClientInformationFull | undefined;
      let verifier = '';
      let redirected: URL | undefined;
      const provider: OAuthClientProvider = {
        get redirectUrl() {
          return REDIRECT;
        },
        get clientMetadata() {
          return {
            client_name: 'SDK auth() client',
            redirect_uris: [REDIRECT],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          };
        },
        clientInformation: () => info,
        saveClientInformation: (i) => {
          info = i as OAuthClientInformationFull;
        },
        tokens: () => saved,
        saveTokens: (t) => {
          saved = t;
        },
        redirectToAuthorization: (url) => {
          redirected = url;
        },
        saveCodeVerifier: (v) => {
          verifier = v;
        },
        codeVerifier: () => verifier,
      };
      const serverUrl = resourceOf(h, slug);
      expect(await auth(provider, { serverUrl, fetchFn: fetchFn(h) })).toBe('REDIRECT');
      const url = redirected as URL;
      // The resource comes from the protected resource metadata the SDK discovered (P5-02): no workaround names it.
      expect(url.searchParams.get('resource')).toBe(serverUrl);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      const res = await h.call(url.href, {
        redirect: 'manual',
        headers: { [APPROVE_HEADER]: `${h.ids.alice}|${h.ids.aliceGrantA}` },
      });
      const back = new URL(res.headers.get('location') as string);
      const result = await auth(provider, {
        serverUrl,
        authorizationCode: back.searchParams.get('code') as string,
        ...issOf({ location: back }),
        fetchFn: fetchFn(h),
      });
      expect(result).toBe('AUTHORIZED');
      expect((await mcp(h, slug, (saved as OAuthTokens).access_token, WHOAMI)).status).toBe(200);
    });

    it('a second authorization for another workspace is a separate device; neither ends the other', async () => {
      const h = await host();
      const client = await register(h);
      const a = await connectWorkspace(h, 'team-a', undefined, client);
      const b = await connectWorkspace(h, 'team-b', `${h.ids.alice}|${h.ids.aliceGrantB}`, client);
      expect((await mcp(h, 'team-a', a.tokens.access_token)).status).toBe(200);
      expect((await mcp(h, 'team-b', b.tokens.access_token)).status).toBe(200);
      // A token for workspace A fails at B, and the other way round (RFC 8707, T2).
      expect((await mcp(h, 'team-b', a.tokens.access_token)).status).toBe(401);
      expect((await mcp(h, 'team-a', b.tokens.access_token)).status).toBe(401);
    });

    it('device tokens keep working with OAuth on, and stay bound to their workspace', async () => {
      const h = await host();
      expect((await mcp(h, 'team-a', h.ids.aliceDeviceTokenA)).status).toBe(200);
      expect((await mcp(h, 'team-b', h.ids.aliceDeviceTokenA)).status).toBe(401);
    });

    // ------------------------------------------------------------------------------------------ authorize refusals

    it('refuses an authorization request without PKCE S256, for any client', async () => {
      const h = await host();
      const client = await register(h);
      for (const edit of [
        (u: URL) => u.searchParams.set('code_challenge_method', 'plain'),
        (u: URL) => u.searchParams.delete('code_challenge'),
        (u: URL) => {
          u.searchParams.delete('code_challenge');
          u.searchParams.delete('code_challenge_method');
        },
      ]) {
        const a = await authorize(h, client, { edit });
        // After the client and redirect URI were validated the error goes to the client, with `state`, `iss` and no code.
        expect(a.response.status).toBe(302);
        expect(a.code).toBeNull();
        expect(a.location?.searchParams.get('error')).toBe('invalid_request');
        expect(a.location?.searchParams.get('state')).toBe(a.state);
        expect(a.location?.searchParams.get('iss')).toBe(h.origin);
      }
    });

    it('requires PKCE S256 of a confidential client too (the provider insists only on public ones)', async () => {
      const h = await host();
      const client = await register(h, { confidential: true });
      expect(client.client_secret).toBeTruthy();
      for (const edit of [
        (u: URL) => u.searchParams.delete('code_challenge'),
        (u: URL) => u.searchParams.set('code_challenge_method', 'plain'),
      ]) {
        const a = await authorize(h, client, { edit });
        expect(a.code).toBeNull();
        expect(a.location?.searchParams.get('error')).toBe('invalid_request');
      }
      // With PKCE it works, and the secret is needed at the token endpoint.
      const a = await authorize(h, client);
      expect(a.code).not.toBeNull();
      const withoutSecret = await tokenEndpoint(h, { ...exchangeParams(a, 'team-a', h) });
      expect(withoutSecret.status).toBe(401);
      const b = await authorize(h, client);
      const ok = await tokenEndpoint(h, {
        ...exchangeParams(b, 'team-a', h),
        client_secret: client.client_secret as string,
      });
      expect(ok.status).toBe(200);
    });

    it('refuses a missing, foreign, malformed or repeated resource before anything is redirected', async () => {
      const h = await host();
      const client = await register(h);
      const bad: (string | null)[] = [
        null,
        'https://evil.example/w/team-a/mcp',
        `${h.origin}/w/team-a/mcp/`,
        `${h.origin}/w/team-a/mcp?x=1`,
        `${h.origin}/w/Team_A/mcp`,
        `${h.origin}/p/team-a/mcp`,
        `${h.origin}/w/team-a/other`,
        `${h.origin}/w/%74eam-a/mcp`,
      ];
      for (const resource of bad) {
        const a = await authorize(h, client, { resource });
        expect(a.response.status, String(resource)).toBe(400);
        expect(a.location, String(resource)).toBeNull();
        expect(((await a.response.json()) as { error: string }).error).toBe('invalid_target');
      }
      const twice = await authorize(h, client, {
        edit: (u) => u.searchParams.append('resource', resourceOf(h, 'team-b')),
      });
      expect(twice.response.status).toBe(400);
      expect(twice.location).toBeNull();
    });

    it('refuses a repeated parameter, an unknown client and an unregistered redirect URI without redirecting', async () => {
      const h = await host();
      const client = await register(h);
      const repeated = await authorize(h, client, { edit: (u) => u.searchParams.append('state', 'again') });
      expect(repeated.response.status).toBe(400);
      expect(repeated.location).toBeNull();

      const unknown = await authorize(h, { ...client, client_id: 'no-such-client' });
      expect(unknown.response.status).toBe(400);
      expect(unknown.location).toBeNull();

      for (const redirect of [
        'http://127.0.0.1:53682/other',
        'https://evil.example/callback',
        'http://127.0.0.1.evil.example:53682/callback',
        'http://user@127.0.0.1:53682/callback',
      ]) {
        const wrong = await authorize(h, client, {
          edit: (u) => u.searchParams.set('redirect_uri', redirect),
        });
        expect(wrong.response.status, redirect).toBe(400);
        expect(wrong.location, redirect).toBeNull();
      }
      // None of them reached the consent step: nothing was approved or audited as approved.
      const rows = await auditRows(h, (r) => r.action === 'oauth.authorize', 0);
      expect(rows).toEqual([]);
    });

    it('refuses response types other than code', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client, { edit: (u) => u.searchParams.set('response_type', 'token') });
      expect(a.code).toBeNull();
      expect(a.response.status).toBeGreaterThanOrEqual(300);
      expect(a.location?.hash ?? '').not.toContain('access_token');
    });

    it('a user who denies gets access_denied, with state and iss', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client, { who: 'deny' });
      expect(a.code).toBeNull();
      expect(a.location?.searchParams.get('error')).toBe('access_denied');
      expect(a.location?.searchParams.get('state')).toBe(a.state);
      expect(a.location?.searchParams.get('iss')).toBe(h.origin);
      const rows = await auditRows(h, (r) => r.action === 'oauth.authorize');
      expect(rows.map((r) => r.status)).toEqual(['denied']);
    });

    // -------------------------------------------------------------------------------- approval is an access decision

    it('binds a token only to a grant of the signed-in user on the requested workspace', async () => {
      const h = await host();
      const client = await register(h);
      const refusals: [string, string, string][] = [
        // [who approves, workspace asked for, reason]
        [`${h.ids.alice}|${h.ids.bobGrantB}`, 'team-b', 'principal_mismatch'],
        [`${h.ids.bob}|${h.ids.aliceGrantB}`, 'team-b', 'principal_mismatch'],
        [`${h.ids.alice}|${h.ids.serviceGrantA}`, 'team-a', 'principal_mismatch'],
        // A grant of another workspace than the one asked for.
        [`${h.ids.alice}|${h.ids.aliceGrantA}`, 'team-b', 'wrong_workspace'],
        [`${h.ids.alice}|${h.ids.aliceGrantB}`, 'team-a', 'wrong_workspace'],
        [`${h.ids.alice}|grt_does_not_exist`, 'team-a', 'workspace_missing'],
        // A workspace that does not exist answers like any refusal.
        [`${h.ids.alice}|${h.ids.aliceGrantA}`, 'no-such-workspace', 'workspace_missing'],
      ];
      for (const [who, slug, reason] of refusals) {
        const a = await authorize(h, client, { who, slug });
        expect(a.response.status, `${who} ${slug}`).toBe(403);
        expect(a.code).toBeNull();
        expect(await a.response.json()).toEqual({ refused: reason });
      }
      const rows = await auditRows(h, (r) => r.action === 'oauth.authorize', refusals.length);
      expect(rows.filter((r) => r.status === 'denied')).toHaveLength(refusals.length);
      // No code was minted for any of them: nothing in storage but the client record.
      expect(await h.storage.kv.list('oauth:grant:')).toEqual([]);
      expect(await h.storage.kv.list('oauth-code:')).toEqual([]);
    });

    it('does not approve a revoked or expired grant, a disabled user or a disabled workspace', async () => {
      const h = await host();
      const client = await register(h);
      const now = Date.now();
      expect((await authorize(h, client)).response.status).toBe(302);
      await h.storage.users.update(h.ids.alice, { disabledAt: now });
      expect((await authorize(h, client)).response.status).toBe(403);
      await h.storage.users.update(h.ids.alice, { disabledAt: null });
      await h.storage.workspaces.update(h.ids.workspaceA, { disabledAt: now });
      expect((await authorize(h, client)).response.status).toBe(403);
      await h.storage.workspaces.update(h.ids.workspaceA, { disabledAt: null });
      await h.storage.grants.update(h.ids.aliceGrantA, { expiresAt: now - 1000 });
      expect((await authorize(h, client)).response.status).toBe(403);
      await h.storage.grants.update(h.ids.aliceGrantA, { expiresAt: null });
      expect((await authorize(h, client)).response.status).toBe(302);
      // A revoked grant stays revoked (the storage refuses to undo it).
      await h.storage.grants.update(h.ids.aliceGrantA, { revokedAt: now });
      expect((await authorize(h, client)).response.status).toBe(403);
    });

    // -------------------------------------------------------------------------------------------- token endpoint

    it('refuses a token request that is not form-encoded, repeats a parameter or has a bad verifier', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client);
      const params = exchangeParams(a, 'team-a', h);
      const json = await tokenEndpoint(h, params, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      expect(json.status).toBe(400);
      expect(((await json.json()) as { error: string }).error).toBe('invalid_request');

      const twice = await tokenEndpoint(h, params, {
        ...form(params),
        body: `${new URLSearchParams(params).toString()}&client_id=another`,
      });
      expect(twice.status).toBe(400);

      for (const verifier of ['short', `${a.verifier}!`, 'a'.repeat(129), '']) {
        const res = await tokenEndpoint(h, { ...params, code_verifier: verifier });
        expect(res.status, verifier).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
      }
      // None of the refused requests consumed the code: the real one still redeems.
      const ok = await tokenEndpoint(h, params);
      expect(ok.status).toBe(200);
    });

    it('refuses the wrong verifier, the wrong redirect URI and the wrong client at the token endpoint', async () => {
      const h = await host();
      const client = await register(h);
      const other = await register(h, { name: 'Another client' });
      const cases: [string, (p: Record<string, string>, a: Authorized) => Record<string, string>][] = [
        ['wrong verifier', (p) => ({ ...p, code_verifier: 'x'.repeat(64) })],
        ['wrong redirect', (p) => ({ ...p, redirect_uri: 'http://127.0.0.1:53682/elsewhere' })],
        ['wrong client', (p) => ({ ...p, client_id: other.client_id })],
      ];
      for (const [label, edit] of cases) {
        const a = await authorize(h, client);
        const res = await tokenEndpoint(h, edit(exchangeParams(a, 'team-a', h), a));
        expect(res.status, label).toBe(400);
        const body = (await res.json()) as { error: string; access_token?: string };
        expect(['invalid_grant', 'invalid_client', 'invalid_request'], label).toContain(body.error);
        expect(body.access_token, label).toBeUndefined();
        // The code was spent by the attempt (single use, whatever the outcome), so it cannot be retried correctly.
        const retry = await tokenEndpoint(h, exchangeParams(a, 'team-a', h));
        expect(retry.status, label).toBe(400);
      }
    });

    it('refuses a resource that is not the grant’s: the code and the refresh token cannot retarget', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client);
      // A resource that is not one of ours is refused before the code is touched: the client can retry.
      const foreignResource = await tokenEndpoint(h, {
        ...exchangeParams(a),
        resource: 'https://evil.example/w/team-a/mcp',
      });
      expect(foreignResource.status).toBe(400);
      expect(((await foreignResource.json()) as { error: string }).error).toBe('invalid_target');
      // Another workspace's resource is ours, but not the grant's.
      const wrong = await tokenEndpoint(h, exchangeParams(a, 'team-b', h));
      expect(wrong.status).toBe(400);
      expect(((await wrong.json()) as { error: string }).error).toMatch(/invalid_target|invalid_grant/);
      const again = await authorize(h, client);
      expect(
        (await tokenEndpoint(h, { ...exchangeParams(again), resource: 'https://evil.example/x' })).status,
      ).toBe(400);
      expect((await tokenEndpoint(h, exchangeParams(again, 'team-a', h))).status).toBe(200);

      const { tokens, client: c } = await connectWorkspace(h, 'team-a');
      const retarget = await tokenEndpoint(h, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token as string,
        client_id: c.client_id,
        resource: resourceOf(h, 'team-b'),
      });
      expect(retarget.status).toBe(400);
      expect(((await retarget.json()) as { error: string }).error).toBe('invalid_target');
      const foreign = await tokenEndpoint(h, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token as string,
        client_id: c.client_id,
        resource: 'https://evil.example/w/team-a/mcp',
      });
      expect(foreign.status).toBe(400);
      // A refusal that left the grant alone does not cost the device its refresh token: refresh without `resource`
      // uses the grant's own and keeps the workspace.
      const fine = await tokenEndpoint(h, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token as string,
        client_id: c.client_id,
      });
      expect(fine.status).toBe(200);
      const refreshed = (await fine.json()) as { access_token: string };
      expect((await mcp(h, 'team-a', refreshed.access_token)).status).toBe(200);
      expect((await mcp(h, 'team-b', refreshed.access_token)).status).toBe(401);
    });

    it('caps the token lifetimes at the grant’s expiry, and refuses an issuance when it ends within a minute', async () => {
      const h = await host();
      const client = await register(h);
      await h.storage.grants.update(h.ids.aliceGrantA, { expiresAt: Date.now() + 600_000 });
      const { tokens } = await connectWorkspace(h, 'team-a', undefined, client);
      expect(tokens.expires_in).toBeLessThanOrEqual(600);
      expect(tokens.expires_in).toBeGreaterThan(500);
      // A grant about to end gets no new tokens (the device is revoked).
      await h.storage.grants.update(h.ids.aliceGrantA, { expiresAt: Date.now() + 20_000 });
      const a = await authorize(h, client);
      expect(a.code).not.toBeNull();
      const res = await tokenEndpoint(h, exchangeParams(a, 'team-a', h));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
      const rows = await auditRows(h, (r) => r.action === 'oauth.token.refused');
      expect(rows[0]).toMatchObject({ status: 'denied', errorCode: 'grant_expired' });
    });

    it('an exchange whose device was revoked while the provider answered is refused', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client);
      const [userId, grantId] = (a.code as string).split(':') as [string, string];
      // What a concurrent replay or an administrator leaves first: the tombstone (then the revocation).
      await h.storage.kv.set(`oauth-revoked:${userId}:${grantId}`, '1', { expiresAt: Date.now() + 60_000 });
      const res = await tokenEndpoint(h, exchangeParams(a, 'team-a', h));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
      expect(await h.storage.kv.get(`oauth:grant:${userId}:${grantId}`)).toBeNull();
    });

    it('an expired code is refused', async () => {
      const h = await host();
      if (h.advance === undefined) return;
      const client = await register(h);
      const a = await authorize(h, client);
      h.advance(11 * 60_000);
      const res = await tokenEndpoint(h, exchangeParams(a, 'team-a', h));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('access tokens expire; a refresh after the access lifetime still works', async () => {
      const h = await host();
      if (h.advance === undefined) return;
      const { tokens, client } = await connectWorkspace(h);
      h.advance(61 * 60_000);
      expect((await mcp(h, 'team-a', tokens.access_token)).status).toBe(401);
      const res = await tokenEndpoint(h, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token as string,
        client_id: client.client_id,
      });
      expect(res.status).toBe(200);
      const next = (await res.json()) as { access_token: string };
      expect((await mcp(h, 'team-a', next.access_token)).status).toBe(200);
    });

    // ---------------------------------------------------------------------------------------- single-use codes

    it('a replayed code is refused, and revokes the tokens it already produced', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client);
      const first = await tokenEndpoint(h, exchangeParams(a, 'team-a', h));
      expect(first.status).toBe(200);
      const issued = (await first.json()) as { access_token: string; refresh_token: string };
      expect((await mcp(h, 'team-a', issued.access_token)).status).toBe(200);

      const second = await tokenEndpoint(h, exchangeParams(a, 'team-a', h));
      expect(second.status).toBe(400);
      expect(((await second.json()) as { error: string }).error).toBe('invalid_grant');
      // RFC 6749 §4.1.2: what the code produced is revoked.
      expect((await mcp(h, 'team-a', issued.access_token)).status).toBe(401);
      const refresh = await tokenEndpoint(h, {
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token,
        client_id: client.client_id,
      });
      expect(refresh.status).toBe(400);
      const rows = await auditRows(h, (r) => r.action === 'oauth.code.replayed');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('denied');
    });

    it('concurrent redemptions of one code yield at most one token set', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client);
      const attempts = await Promise.all(
        Array.from({ length: 6 }, () => tokenEndpoint(h, exchangeParams(a, 'team-a', h))),
      );
      const issued = await Promise.all(
        attempts.filter((r) => r.status === 200).map((r) => r.json() as Promise<{ access_token: string }>),
      );
      expect(issued.length).toBeLessThanOrEqual(1);
      expect(attempts.filter((r) => r.status !== 200).every((r) => r.status === 400)).toBe(true);
      // Whatever won, once the dust settles no access token of this code works more than once over.
      let working = 0;
      for (const t of issued) if ((await mcp(h, 'team-a', t.access_token)).status === 200) working++;
      expect(working).toBeLessThanOrEqual(1);
    });

    // ------------------------------------------------------------------------------- negative authorization (L-121)

    it('answers every OAuth denial with the one 401: no Agility request, no tool call, an audit row with the reason', async () => {
      const denials: [string, string, (h: OAuthHost) => Promise<void>][] = [
        [
          'grant_revoked',
          'revoked grant',
          (h) => h.storage.grants.update(h.ids.aliceGrantA, { revokedAt: Date.now() }).then(() => undefined),
        ],
        [
          'grant_expired',
          'expired grant',
          (h) =>
            h.storage.grants.update(h.ids.aliceGrantA, { expiresAt: Date.now() - 1 }).then(() => undefined),
        ],
        [
          'user_disabled',
          'disabled user',
          (h) => h.storage.users.update(h.ids.alice, { disabledAt: Date.now() }).then(() => undefined),
        ],
        [
          'workspace_disabled',
          'disabled workspace',
          (h) =>
            h.storage.workspaces.update(h.ids.workspaceA, { disabledAt: Date.now() }).then(() => undefined),
        ],
        [
          'workspace_missing',
          'deleted grant',
          (h) => h.storage.grants.delete(h.ids.aliceGrantA).then(() => undefined),
        ],
      ];
      for (const [reason, label, apply] of denials) {
        const h = await host();
        const { tokens, client } = await connectWorkspace(h);
        expect((await mcp(h, 'team-a', tokens.access_token)).status, label).toBe(200);
        await apply(h);
        await expectDenied(h, 'team-a', tokens.access_token, reason);
        // The refresh token is useless too: the issuance check refuses it (and revokes the device).
        const refresh = await tokenEndpoint(h, {
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token as string,
          client_id: client.client_id,
        });
        expect(refresh.status, label).toBe(400);
        expect(((await refresh.json()) as { error: string }).error, label).toBe('invalid_grant');
        const refused = await auditRows(h, (r) => r.action === 'oauth.token.refused');
        expect(refused[0], label).toMatchObject({ status: 'denied', errorCode: reason });
      }
    });

    it('a token for workspace A is the one 401 at B, at an unknown workspace and as a garbled bearer', async () => {
      const h = await host();
      const { tokens } = await connectWorkspace(h);
      const [a, secret] = [tokens.access_token, tokens.access_token.split(':')[2] as string];
      // The provider answers "not valid for this resource" for both; nothing says which workspaces exist.
      await expectDenied(h, 'team-b', a, 'oauth_invalid');
      await expectDenied(h, 'team-zzz', a, 'oauth_invalid');
      const garbled = [
        a.slice(0, -1),
        `${a}x`,
        a.replace(secret, 'x'.repeat(32)),
        a.replace(/^usr_[0-9a-f]{32}/, 'usr_00000000000000000000000000000000'),
        `${a}:extra`,
        `Bearer ${a}`,
      ];
      for (const bad of garbled) {
        const requests = h.agilityRequests();
        const res = await mcp(h, 'team-a', bad);
        expect(res.status).toBe(401);
        expect(h.agilityRequests()).toBe(requests);
      }
    });

    it('a refresh token, a code and a device token are not access tokens', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client);
      expect((await mcp(h, 'team-a', a.code)).status).toBe(401);
      const { tokens } = await connectWorkspace(h);
      expect((await mcp(h, 'team-a', tokens.refresh_token as string)).status).toBe(401);
    });

    it('revoking a token (RFC 7009) ends it at once, even through the access cache', async () => {
      const h = await host();
      const { tokens, client } = await connectWorkspace(h);
      expect((await mcp(h, 'team-a', tokens.access_token)).status).toBe(200);
      const res = await tokenEndpoint(h, {
        token: tokens.refresh_token as string,
        token_type_hint: 'refresh_token',
        client_id: client.client_id,
      });
      expect(res.status).toBe(200);
      expect((await mcp(h, 'team-a', tokens.access_token)).status).toBe(401);
      const rows = await auditRows(h, (r) => r.action === 'oauth.token.revoked');
      expect(rows).toHaveLength(1);
    });

    // ------------------------------------------------------------------------------- storage, logs and audit scan

    it('stores codes and tokens hash-only and grant properties encrypted; no log or audit row holds a bearer value', async () => {
      const h = await host();
      const client = await register(h);
      const a = await authorize(h, client);
      const code = a.code as string;
      const exchanged = await tokenEndpoint(h, exchangeParams(a, 'team-a', h));
      const first = (await exchanged.json()) as { access_token: string; refresh_token: string };
      const rotated = (await (
        await tokenEndpoint(h, {
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
          client_id: client.client_id,
        })
      ).json()) as { access_token: string; refresh_token: string };
      await mcp(h, 'team-a', first.access_token);
      await mcp(h, 'team-a', rotated.access_token, WHOAMI);
      // The records of a live device (checked below, before the replay revokes them).
      const live = await kvText(h);
      // A refused replay and a refused foreign token leave their rows and log lines too.
      await tokenEndpoint(h, exchangeParams(a, 'team-a', h));
      await mcp(h, 'team-b', rotated.access_token);
      await auditRows(h, (r) => r.action === 'oauth.code.replayed');

      const secrets = [
        code,
        first.access_token,
        first.refresh_token,
        rotated.access_token,
        rotated.refresh_token,
        a.verifier,
      ];
      const parts = secrets.filter((s) => s.includes(':')).map((s) => s.split(':')[2] as string);
      const kv = `${live}\n${await kvText(h)}`;
      const audit = JSON.stringify(await h.storage.audit.query({ limit: 1000 }));
      const logs = h.logs().join('\n');
      const raw = h.rawDatabase?.() ?? '';
      for (const [where, text] of Object.entries({ kv, audit, logs, raw })) {
        for (const secret of [...secrets, ...parts]) {
          expect(text.includes(secret), `${where} holds a bearer value or verifier`).toBe(false);
        }
      }
      // The scan is not vacuous: the records are there, under the hashes.
      expect(live).toContain(await sha256(rotated.access_token));
      expect(live).toContain(await sha256(rotated.refresh_token));
      expect(live).toContain(`oauth:grant:${first.access_token.split(':')[0]}:`);
      // Grant properties (workspace, access grant, user, client) are encrypted: none of their ids is stored in clear
      // text in a token or grant record, except what the grant metadata says on purpose (the opaque access grant and
      // workspace ids and the device name, P5-04: the list of connected apps needs them without the token).
      const grantRows = live
        .split('\n')
        .filter((line) => line.startsWith('oauth:grant:') || line.startsWith('oauth:token:'));
      expect(grantRows.length).toBeGreaterThanOrEqual(2);
      for (const line of grantRows) {
        expect(line.replaceAll(/"metadata":\{[^}]*\}/g, '')).not.toContain(h.ids.workspaceA);
        expect(line).not.toContain('"workspaceSlug"');
        expect(line).not.toContain('"props"');
      }
      // No email or other personal data anywhere in OAuth state (T25).
      expect(kv).not.toMatch(/@example\.test/);
    });

    it('the audit log records the steps with ids and reasons only', async () => {
      const h = await host();
      const { tokens, client } = await connectWorkspace(h);
      await tokenEndpoint(h, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token as string,
        client_id: client.client_id,
      });
      const rows = await auditRows(h, (r) => r.action === 'oauth.token.issued', 1);
      const actions = new Set((await h.storage.audit.query({ limit: 1000 })).map((r) => r.action));
      expect(actions.has('oauth.authorize')).toBe(true);
      expect(actions.has('oauth.token.issued')).toBe(true);
      const authorize = (
        await h.storage.audit.query({ kind: 'auth', action: 'oauth.authorize', limit: 10 })
      )[0];
      expect(authorize).toMatchObject({
        status: 'ok',
        userId: h.ids.alice,
        grantId: h.ids.aliceGrantA,
        workspaceId: h.ids.workspaceA,
      });
      expect(authorize?.clientId).toBeTruthy();
      // A tool call over OAuth is attributed to the device and the client.
      await mcp(h, 'team-a', tokens.access_token, WHOAMI);
      const calls = await (async () => {
        for (let i = 0; i < 100; i++) {
          const found = await h.storage.audit.query({ kind: 'tool_call', limit: 10 });
          if (found.length > 0) return found;
          await new Promise((r) => setTimeout(r, 30));
        }
        return [];
      })();
      expect(calls[0]).toMatchObject({ userId: h.ids.alice, grantId: h.ids.aliceGrantA, action: 'whoami' });
      expect(calls[0]?.tokenId).toMatch(/^oauth_[A-Za-z0-9_-]{16}$/);
      expect(calls[0]?.clientId).toBe(authorize?.clientId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    // ------------------------------------------------------------------------------------------------ limits

    it('answers unknown methods and paths with the app’s own 404, and keeps the 401 challenge of the MCP route', async () => {
      const h = await host();
      expect((await h.call(`${h.origin}/oauth/token`)).status).toBe(404);
      expect((await h.call(`${h.origin}/oauth/authorize`, { method: 'POST' })).status).toBe(404);
      const challenge = await mcp(h, 'team-a', null);
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get('www-authenticate')).toMatch(/^Bearer/);
    });

    it('caps registration and token request bodies', async () => {
      const h = await host();
      const big = await h.call(`${h.origin}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(20_000) }),
      });
      expect(big.status).toBe(413);
      const wrongType = await h.call(`${h.origin}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      });
      expect(wrongType.status).toBe(400);
      const bigToken = await tokenEndpoint(h, {}, { ...form({}), body: `code=${'a'.repeat(20_000)}` });
      expect(bigToken.status).toBe(413);
    });
  });
}

/**
 * The access cache with OAuth tokens (T15): a host built with the default cache. Revoking a token through the token
 * endpoint ends it at once; a grant revoked in storage is honoured within the cache lifetime, not later.
 */
export function defineOAuthCacheSuite(name: string, makeHost: () => Promise<OAuthHost>): void {
  describe(`OAuth 2.1 server and the access cache: ${name}`, () => {
    const open: OAuthHost[] = [];
    afterEach(async () => {
      vi.useRealTimers();
      await Promise.all(open.splice(0).map((h) => h.close()));
    });

    it('RFC 7009 revocation clears the cache, so the revoked token stops working at once', async () => {
      const h = await makeHost();
      open.push(h);
      const { tokens, client } = await connectWorkspace(h);
      expect((await mcp(h, 'team-a', tokens.access_token)).status).toBe(200);
      expect((await mcp(h, 'team-a', tokens.access_token)).status).toBe(200);
      const res = await tokenEndpoint(h, {
        token: tokens.refresh_token as string,
        token_type_hint: 'refresh_token',
        client_id: client.client_id,
      });
      expect(res.status).toBe(200);
      expect((await mcp(h, 'team-a', tokens.access_token)).status).toBe(401);
    });

    it('a grant revoked in storage ends the token within the cache lifetime, and never later', async () => {
      const h = await makeHost();
      open.push(h);
      if (h.advance === undefined) return;
      const { tokens } = await connectWorkspace(h);
      expect((await mcp(h, 'team-a', tokens.access_token)).status).toBe(200);
      await h.storage.grants.update(h.ids.aliceGrantA, { revokedAt: Date.now() });
      // Still served from the cache for a moment (T15)...
      expect((await mcp(h, 'team-a', tokens.access_token)).status).toBe(200);
      // ...and refused once the cache entry is older than its lifetime (30 s by default).
      h.advance(31_000);
      await expectDenied(h, 'team-a', tokens.access_token, 'grant_revoked');
    });
  });
}
