// SPDX-License-Identifier: Apache-2.0
// Local fake identity providers for the sign-in tests (P4-01): an OpenID Connect provider (discovery, JWKS, token and
// userinfo endpoints, PKCE checks), GitHub's OAuth and REST endpoints, and Cloudflare Access's key endpoint. They are
// `FetchLike` functions (no network); `scripts/serve-fetch.ts` serves one over a real loopback socket for the Node and
// workerd tests.
// Secrets are built at run time (gitleaks).
import type { FetchLike } from '@agility-bridge/core';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface SigningKey {
  readonly kid: string;
  readonly alg: string;
  readonly privateKey: PrivateKey;
  readonly publicJwk: JWK;
}

export async function signingKey(alg: 'ES256' | 'RS256', kid: string): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, privateKey, publicJwk };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Sends each request to the first handler that answers for its URL. */
export function route(...handlers: Array<(request: Request) => Promise<Response | undefined>>): FetchLike {
  return async (request) => {
    for (const h of handlers) {
      const res = await h(request);
      if (res !== undefined) return res;
    }
    return new Response('not found', { status: 404 });
  };
}

export interface FakeOidcOptions {
  /** The issuer identifier (default `https://idp.example.test`). */
  readonly issuer?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly key?: SigningKey;
  /** Discovery overrides (e.g. `authorization_response_iss_parameter_supported`). */
  readonly discovery?: Record<string, unknown>;
  /** Whether the token endpoint authenticates with the body instead of Basic. */
  readonly tokenAuth?: 'basic' | 'post';
}

interface IssuedCode {
  readonly challenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly claims: Record<string, unknown>;
}

export interface ForgeOptions {
  /** Replaces the whole signed token (e.g. an unsigned `alg: none` one). */
  readonly token?: string;
}

/** An OIDC provider with a user that signs in with `authorize`. */
export class FakeOidc {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  key: SigningKey;
  readonly extraKeys: SigningKey[] = [];
  /** Every request, in order: `METHOD url`. */
  readonly calls: string[] = [];
  /** Claims merged into the next ID token (then cleared). */
  nextClaims: Record<string, unknown> = {};
  /** Removes claims from the next ID token. */
  omitClaims: string[] = [];
  /** Replaces the ID token (then cleared). */
  forge: ((claims: Record<string, unknown>) => Promise<string>) | undefined;
  /** The userinfo answer (default: none, 404). */
  userinfo: Record<string, unknown> | undefined;
  /** What the token endpoint answers instead of success. */
  tokenFailure: Response | undefined;
  readonly #codes = new Map<string, IssuedCode>();
  readonly #options: FakeOidcOptions;

  constructor(key: SigningKey, options: FakeOidcOptions = {}) {
    this.key = key;
    this.#options = options;
    this.issuer = options.issuer ?? 'https://idp.example.test';
    this.clientId = options.clientId ?? 'client-123.example.test';
    this.clientSecret = options.clientSecret ?? `secret-${crypto.randomUUID()}`;
  }

  get jwksUri(): string {
    return `${this.issuer}/jwks`;
  }

  /** The IdP-side half of a login: checks the authorization request and returns the callback parameters. */
  authorize(authorizationUrl: URL, user: Record<string, unknown> = {}): { code: string; state: string } {
    const q = authorizationUrl.searchParams;
    if (q.get('client_id') !== this.clientId) throw new Error('fake idp: wrong client_id');
    if (q.get('response_type') !== 'code') throw new Error('fake idp: response_type');
    if (q.get('code_challenge_method') !== 'S256') throw new Error('fake idp: PKCE method');
    const code = `code-${crypto.randomUUID()}`;
    this.#codes.set(code, {
      challenge: q.get('code_challenge') ?? '',
      nonce: q.get('nonce') ?? '',
      redirectUri: q.get('redirect_uri') ?? '',
      claims: {
        sub: 'subject-1',
        email: 'ann@example.test',
        email_verified: true,
        name: 'Ann Example',
        ...user,
      },
    });
    return { code, state: q.get('state') ?? '' };
  }

  async sign(claims: Record<string, unknown>, key: SigningKey = this.key): Promise<string> {
    return new SignJWT(claims as never)
      .setProtectedHeader({ alg: key.alg, kid: key.kid })
      .sign(key.privateKey as PrivateKey);
  }

  #discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: this.jwksUri,
      userinfo_endpoint: `${this.issuer}/userinfo`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: [this.key.alg],
      token_endpoint_auth_methods_supported: [
        this.#options.tokenAuth === 'post' ? 'client_secret_post' : 'client_secret_basic',
      ],
      ...this.#options.discovery,
    };
  }

  readonly handle = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!request.url.startsWith(this.issuer) && !request.url.startsWith(this.jwksUri)) return undefined;
    this.calls.push(`${request.method} ${request.url}`);
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return json(this.#discovery());
    if (request.url === this.jwksUri) {
      return json({ keys: [this.key, ...this.extraKeys].map((k) => k.publicJwk) });
    }
    if (url.pathname.endsWith('/userinfo')) {
      return this.userinfo === undefined ? json({ error: 'nope' }, 404) : json(this.userinfo);
    }
    if (url.pathname.endsWith('/token') && request.method === 'POST') return this.#token(request);
    return undefined;
  };

  readonly fetch: FetchLike = route(this.handle);

  async #token(request: Request): Promise<Response> {
    if (this.tokenFailure !== undefined) return this.tokenFailure;
    const form = new URLSearchParams(await request.text());
    const basic = request.headers.get('authorization');
    if (this.#options.tokenAuth === 'post') {
      if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) {
        return json({ error: 'invalid_client' }, 401);
      }
    } else {
      const expected = `Basic ${btoa(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`)}`;
      if (basic !== expected) return json({ error: 'invalid_client' }, 401);
    }
    const issued = this.#codes.get(form.get('code') ?? '');
    this.#codes.delete(form.get('code') ?? '');
    if (
      issued === undefined ||
      form.get('grant_type') !== 'authorization_code' ||
      form.get('redirect_uri') !== issued.redirectUri ||
      (await s256(form.get('code_verifier') ?? '')) !== issued.challenge
    ) {
      return json({ error: 'invalid_grant' }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      aud: this.clientId,
      iat: now,
      exp: now + 300,
      nonce: issued.nonce,
      ...issued.claims,
      ...this.nextClaims,
    };
    for (const name of this.omitClaims) delete claims[name];
    const forge = this.forge;
    this.nextClaims = {};
    this.omitClaims = [];
    this.forge = undefined;
    const idToken = forge === undefined ? await this.sign(claims) : await forge(claims);
    return json({ access_token: `at-${crypto.randomUUID()}`, token_type: 'Bearer', id_token: idToken });
  }
}

export async function fakeOidc(options: FakeOidcOptions = {}): Promise<FakeOidc> {
  return new FakeOidc(options.key ?? (await signingKey('ES256', 'key-1')), options);
}

// ------------------------------------------------------------------------------------------------ GitHub

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  emails: Array<{ email: string; primary: boolean; verified: boolean }>;
  /** Organization login (lowercase) -> membership state. */
  orgs: Record<string, 'active' | 'pending'>;
}

/** GitHub's authorization, token and REST endpoints for one user. */
export class FakeGitHub {
  readonly clientId = 'gh-client-id';
  readonly clientSecret = `gh-secret-${crypto.randomUUID()}`;
  user: GitHubUser = {
    id: 4242,
    login: 'ann',
    name: 'Ann Example',
    emails: [{ email: 'ann@example.test', primary: true, verified: true }],
    orgs: {},
  };
  readonly calls: string[] = [];
  /** Revocation requests: the body's token and the Basic header. */
  readonly revocations: Array<{ token: string; authorization: string | null }> = [];
  revokeStatus = 204;
  readonly #codes = new Map<string, { challenge: string; redirectUri: string; token: string }>();
  readonly #tokens = new Set<string>();

  authorize(authorizationUrl: URL): { code: string; state: string } {
    const q = authorizationUrl.searchParams;
    if (q.get('client_id') !== this.clientId) throw new Error('fake github: wrong client_id');
    const code = `ghcode-${crypto.randomUUID()}`;
    this.#codes.set(code, {
      challenge: q.get('code_challenge') ?? '',
      redirectUri: q.get('redirect_uri') ?? '',
      token: `gho-fake-${crypto.randomUUID()}`,
    });
    return { code, state: q.get('state') ?? '' };
  }

  /** Whether any token is still valid at GitHub. */
  get liveTokens(): number {
    return this.#tokens.size;
  }

  readonly handle = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.hostname !== 'github.com' && url.hostname !== 'api.github.com') return undefined;
    this.calls.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
      const form = new URLSearchParams(await request.text());
      const issued = this.#codes.get(form.get('code') ?? '');
      this.#codes.delete(form.get('code') ?? '');
      if (
        issued === undefined ||
        form.get('client_id') !== this.clientId ||
        form.get('client_secret') !== this.clientSecret ||
        form.get('redirect_uri') !== issued.redirectUri ||
        (await s256(form.get('code_verifier') ?? '')) !== issued.challenge
      ) {
        return json({ error: 'bad_verification_code' });
      }
      this.#tokens.add(issued.token);
      return json({ access_token: issued.token, token_type: 'bearer', scope: 'read:user,user:email' });
    }
    if (url.origin !== 'https://api.github.com') return undefined;
    if (request.method === 'DELETE' && url.pathname === `/applications/${this.clientId}/token`) {
      const body = (await request.json()) as { access_token: string };
      this.revocations.push({
        token: body.access_token,
        authorization: request.headers.get('authorization'),
      });
      if (this.revokeStatus === 204) this.#tokens.delete(body.access_token);
      return new Response(null, { status: this.revokeStatus });
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!this.#tokens.has(token)) return json({ message: 'Bad credentials' }, 401);
    if (url.pathname === '/user') {
      return json({ id: this.user.id, login: this.user.login, name: this.user.name });
    }
    if (url.pathname === '/user/emails') return json(this.user.emails);
    const org = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(url.pathname)?.[1];
    if (org !== undefined) {
      const state = this.user.orgs[org.toLowerCase()];
      return state === undefined ? json({ message: 'Not Found' }, 404) : json({ state });
    }
    return json({ message: 'Not Found' }, 404);
  };

  readonly fetch: FetchLike = route(this.handle);
}

// ------------------------------------------------------------------------------------- Cloudflare Access

/** The team's key endpoint, and a signer for assertions. */
export class FakeAccess {
  readonly team = 'acme';
  readonly audience = `aud-${'a1b2c3d4'.repeat(8)}`;
  key: SigningKey;
  readonly calls: string[] = [];

  constructor(key: SigningKey) {
    this.key = key;
  }

  get issuer(): string {
    return `https://${this.team}.cloudflareaccess.com`;
  }

  async assertion(claims: Record<string, unknown> = {}, key: SigningKey = this.key): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      type: 'app',
      sub: 'access-subject-1',
      email: 'ann@example.test',
      iss: this.issuer,
      aud: [this.audience],
      iat: now,
      exp: now + 300,
      ...claims,
    } as never)
      .setProtectedHeader({ alg: key.alg, kid: key.kid })
      .sign(key.privateKey as PrivateKey);
  }

  readonly handle = async (request: Request): Promise<Response | undefined> => {
    if (request.url !== `${this.issuer}/cdn-cgi/access/certs`) return undefined;
    this.calls.push(request.url);
    return json({ keys: [this.key.publicJwk], public_cert: [] });
  };

  readonly fetch: FetchLike = route(this.handle);
}

export async function fakeAccess(): Promise<FakeAccess> {
  return new FakeAccess(await signingKey('RS256', 'access-key-1'));
}
