// SPDX-License-Identifier: Apache-2.0
// A complete server with sign-in for the panel's tests (P4-03): a local fake identity provider, real sessions, and
// helpers that behave like a browser (fetch metadata, `Origin`, cookies). Same shape as the session tests' own setup.
import { createIdentityProviders, EMPTY_LOGIN_POLICY, type ToolInfo } from '@agility-bridge/auth';
import { Secret } from '@agility-bridge/core';
import { type FakeOidc, fakeOidc, route } from '../../../auth/test/helpers/fake-idp.ts';
import { ADMIN_BASE, type OAuthOptions, type SessionOptions } from '../../src/index.ts';
import { type World, world } from './world.ts';

export const MIN = 60_000;
const ISSUER = 'https://login.example.test';

export interface Opts {
  allowedOrigins?: string[];
  publicUrl?: string;
  session?: SessionOptions;
  /** `request`: the Workers configuration (L-096): linear routers, nothing shared between requests. */
  isolation?: 'request';
  /** The tool catalogue (default: the core tools, all read-only). */
  tools?: ReadonlyMap<string, ToolInfo>;
  /** Validate stored tokens against the fake Agility (P4-07); `reject` picks tokens it answers 401 for. */
  validate?: { reject?: (token: string) => boolean };
  /** The OAuth server with the built-in consent screen (P5-04; the provider reads the real clock, L-243). */
  oauth?: OAuthOptions;
  /** A second configured provider, `oidc:other`, nobody signs in with (P4-39: a claim for a configured provider). */
  secondProvider?: boolean;
}

export async function setup(options: Opts = {}) {
  const publicUrl = options.publicUrl ?? 'http://127.0.0.1:8787';
  const host = new URL(publicUrl).host;
  const secure = publicUrl.startsWith('https:');
  const cookieName = secure ? '__Host-ab_session' : 'ab_session';
  const idp: FakeOidc = await fakeOidc({ issuer: ISSUER });
  const providers = createIdentityProviders(
    {
      providers: [
        {
          kind: 'oidc',
          name: 'corp',
          label: 'Corporate login',
          issuer: idp.issuer,
          clientId: idp.clientId,
          clientSecret: new Secret(idp.clientSecret),
        },
        ...(options.secondProvider === true
          ? [
              {
                kind: 'oidc' as const,
                name: 'other',
                label: 'Other login',
                issuer: idp.issuer,
                clientId: idp.clientId,
                clientSecret: new Secret(idp.clientSecret),
              },
            ]
          : []),
      ],
      policy: EMPTY_LOGIN_POLICY,
    },
    { fetch: route(idp.handle) },
  );
  const w: World = await world(
    {
      identity: {
        publicUrl,
        providers,
        policy: EMPTY_LOGIN_POLICY,
        audit: (e) => w.audit.login(e),
        auditAdmin: (c) => w.audit.admin(c),
      },
      publicUrl,
      ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
      ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
    },
    {
      admin: true,
      ...(options.oauth === undefined ? {} : { liveClock: true }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.validate === undefined ? {} : { validate: options.validate }),
    },
  );
  const send = (
    method: string,
    path: string,
    init: {
      cookie?: string;
      headers?: Record<string, string>;
      body?: unknown;
      form?: string;
      site?: string | null;
    } = {},
  ): Promise<Response> => {
    const unsafe = method !== 'GET';
    const headers: Record<string, string> = {
      host,
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    };
    // A browser's own request: same-origin, with an Origin on unsafe methods.
    if (init.site !== null) headers['sec-fetch-site'] = init.site ?? 'same-origin';
    if (unsafe && init.site !== null) headers['origin'] = publicUrl;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    Object.assign(headers, init.headers);
    return Promise.resolve(
      w.app.fetch(
        new Request(`${publicUrl}${path}`, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          ...(init.form === undefined ? {} : { body: init.form }),
        }),
      ),
    );
  };
  const cookieOf = (res: Response, name = cookieName) => {
    const all = res.headers.getSetCookie();
    const found = all.find((c) => c.startsWith(`${name}=`));
    return found === undefined ? undefined : (found.split(';')[0] as string);
  };
  /** A full sign-in as `email` (a user of the test world); returns the callback response. */
  const signIn = async (
    email: string,
    over: { cookie?: string; claims?: Record<string, unknown>; path?: string } = {},
  ): Promise<Response> => {
    const start = await send('GET', over.path ?? '/auth/login/oidc-corp', {
      ...(over.cookie === undefined ? {} : { cookie: over.cookie }),
      site: 'none',
    });
    if (start.status !== 302) throw new Error(`login did not redirect (${start.status})`);
    const location = new URL(start.headers.get('location') as string);
    const binding = cookieOf(start, secure ? '__Host-ab_login' : 'ab_login') as string;
    const { code, state } = idp.authorize(location, { email, sub: `sub-${email}`, ...over.claims });
    return send('GET', `/auth/callback/oidc-corp?code=${code}&state=${state}`, {
      cookie: [binding, over.cookie].filter(Boolean).join('; '),
      site: 'cross-site',
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
  };
  /** Signs in and returns the cookie and the CSRF token. */
  const session = async (email: string) => {
    const res = await signIn(email);
    const cookie = cookieOf(res);
    if (res.status !== 303 || cookie === undefined) throw new Error(`sign-in failed (${res.status})`);
    // biome-ignore lint/suspicious/noExplicitAny: the tests read many fields of the session document
    const info = (await (await send('GET', `${ADMIN_BASE}/session`, { cookie })).json()) as any;
    return { cookie, csrf: info.csrfToken as string, res, info };
  };
  const api = (
    method: string,
    path: string,
    s: { cookie: string; csrf?: string },
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    send(method, `${ADMIN_BASE}${path}`, {
      cookie: s.cookie,
      ...(body === undefined ? {} : { body }),
      headers: { ...(s.csrf === undefined ? {} : { 'x-csrf-token': s.csrf }), ...headers },
    });
  const rows = async () => {
    await w.audit.flush();
    return w.storage.audit.query({ limit: 1_000 });
  };
  return { w, idp, send, signIn, session, api, cookieOf, cookieName, publicUrl, host, secure, rows };
}
