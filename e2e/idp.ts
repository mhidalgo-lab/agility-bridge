// SPDX-License-Identifier: Apache-2.0
// A browser-facing OpenID Connect provider for the E2E and the ZAP scan: the P4-01 fake (discovery, JWKS, token endpoint
// with PKCE checks, self-generated keys) behind a loopback HTTP server that also answers `/authorize` the way a signed-in
// IdP session would (an immediate redirect back with a code). It records each authorization request, so a test can see
// that a re-authentication asked for `prompt=login`.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type FakeOidc, fakeOidc } from '../packages/auth/test/helpers/fake-idp.ts';

export interface IdpUser {
  sub: string;
  email: string;
  name?: string;
  email_verified?: boolean;
}

export interface BrowserIdp {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Who the next sign-in is (the IdP "session" of the browser). */
  user: IdpUser;
  /** Query strings of every `/authorize` request so far. */
  readonly authorizations: URLSearchParams[];
  /** When true, `/authorize` answers an error redirect (`access_denied`) instead of a code. */
  deny: boolean;
  close(): Promise<void>;
}

export async function startIdp(user: IdpUser): Promise<BrowserIdp> {
  let fake: FakeOidc | undefined;
  const authorizations: URLSearchParams[] = [];
  const state: { user: IdpUser; deny: boolean } = { user, deny: false };

  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (c: Buffer) => chunks.push(c));
    incoming.on('end', () => {
      void (async () => {
        const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host}`);
        if (fake === undefined) return outgoing.writeHead(503).end();
        if (url.pathname === '/authorize') {
          authorizations.push(url.searchParams);
          const redirect = url.searchParams.get('redirect_uri');
          if (redirect === null) return outgoing.writeHead(400).end('no redirect_uri');
          const target = new URL(redirect);
          if (state.deny) {
            target.searchParams.set('error', 'access_denied');
            target.searchParams.set('state', url.searchParams.get('state') ?? '');
          } else {
            const { code, state: s } = fake.authorize(url, {
              ...state.user,
              email_verified: state.user.email_verified ?? true,
              auth_time: Math.floor(Date.now() / 1000),
            });
            target.searchParams.set('code', code);
            target.searchParams.set('state', s);
          }
          return outgoing.writeHead(302, { location: target.href }).end();
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(incoming.headers)) if (typeof v === 'string') headers.set(k, v);
        const method = incoming.method ?? 'GET';
        const init: RequestInit = { method, headers };
        if (method !== 'GET' && method !== 'HEAD') init.body = Buffer.concat(chunks);
        const res = await fake.fetch(new Request(url, init));
        const out: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          out[k] = v;
        });
        outgoing.writeHead(res.status, out).end(Buffer.from(await res.arrayBuffer()));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake = await fakeOidc({ issuer });
  return {
    issuer,
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    get user() {
      return state.user;
    },
    set user(next: IdpUser) {
      state.user = next;
    },
    get deny() {
      return state.deny;
    },
    set deny(next: boolean) {
      state.deny = next;
    },
    authorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
