// SPDX-License-Identifier: Apache-2.0
// Generic OpenID Connect and Google sign-in against a local fake IdP (P4-01, THREAT_MODEL T14): the happy path and every
// refusal that keeps a forged or misdirected ID token out.
import { Secret } from '@agility-bridge/core';
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createGoogleProvider,
  createOidcProvider,
  type IdentityErrorCode,
  isIdentityError,
  JWKS_COOLDOWN_MS,
  type RedirectIdentityProvider,
} from '../../src/index.ts';
import { type FakeOidc, fakeOidc, signingKey } from '../helpers/fake-idp.ts';
import { REDIRECT_URI, signIn } from '../helpers/flow.ts';

let idp: FakeOidc;
// From a code point: a formatter would turn the escape into the raw character (L-166).
const KELVIN = String.fromCodePoint(0x212a);

function provider(over: Partial<Parameters<typeof createOidcProvider>[0]> = {}): RedirectIdentityProvider {
  return createOidcProvider({
    id: 'oidc',
    label: 'Single sign-on',
    idp: 'oidc:corp',
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: new Secret(idp.clientSecret),
    fetch: idp.fetch,
    ...over,
  });
}

async function code(p: Promise<unknown>): Promise<IdentityErrorCode | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (error) {
    if (isIdentityError(error)) return error.code;
    throw error;
  }
}

beforeAll(async () => {
  idp = await fakeOidc();
});

describe('generic OIDC', () => {
  it('signs in: discovery, PKCE S256, nonce, verified email', async () => {
    const p = provider();
    const identity = await signIn(p, idp);
    expect(identity).toEqual({
      idp: 'oidc:corp',
      subject: 'subject-1',
      email: 'ann@example.test',
      emailVerified: true,
      displayName: 'Ann Example',
    });
  });

  it('builds the authorization request with the exact redirect URI, state, nonce and an S256 challenge', async () => {
    const url = await provider().authorizationUrl({
      redirectUri: REDIRECT_URI,
      state: 'state-1',
      nonce: 'nonce-1',
      codeChallenge: 'challenge-1',
    });
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: idp.clientId,
      redirect_uri: REDIRECT_URI,
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      scope: 'openid email profile',
    });
  });

  it('refuses an ID token for another audience, issuer or authorized party', async () => {
    expect(
      await (async () => {
        idp.nextClaims = { aud: 'someone-else' };
        return code(signIn(provider(), idp));
      })(),
    ).toBe('wrong_audience');
    idp.nextClaims = { iss: 'https://evil.example.test' };
    expect(await code(signIn(provider(), idp))).toBe('wrong_issuer');
    idp.nextClaims = { aud: [idp.clientId, 'other'], azp: 'other' };
    expect(await code(signIn(provider(), idp))).toBe('wrong_audience');
    idp.nextClaims = { azp: 'other' };
    expect(await code(signIn(provider(), idp))).toBe('wrong_audience');
    // Several audiences are fine when the authorized party is us.
    idp.nextClaims = { aud: [idp.clientId, 'other'], azp: idp.clientId };
    expect(await code(signIn(provider(), idp))).toBe('ok');
  });

  it('refuses an expired token and one issued too long ago', async () => {
    const now = Math.floor(Date.now() / 1000);
    idp.nextClaims = { exp: now - 3_600, iat: now - 3_700 };
    expect(await code(signIn(provider(), idp))).toBe('token_expired');
    idp.nextClaims = { exp: now + 3_600, iat: now - 3_600 };
    expect(await code(signIn(provider(), idp))).toBe('token_expired');
  });

  it('refuses a missing or different nonce (replayed or injected token)', async () => {
    expect(await code(signIn(provider(), idp, { callbackNonce: 'another-nonce-value' }))).toBe(
      'nonce_mismatch',
    );
    idp.omitClaims = ['nonce'];
    expect(await code(signIn(provider(), idp))).toBe('nonce_mismatch');
  });

  it('refuses a token signed by another key, an unsigned one, and HMAC with the public key', async () => {
    const attacker = await signingKey('ES256', 'key-1');
    idp.forge = (claims) => idp.sign(claims, attacker);
    expect(await code(signIn(provider(), idp))).toBe('invalid_token');

    idp.forge = async (claims) => {
      const enc = (v: unknown) =>
        btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.`;
    };
    expect(await code(signIn(provider(), idp))).toBe('invalid_token');

    // Algorithm confusion: an HS256 token keyed with the public key's text.
    idp.forge = async (claims) =>
      new SignJWT(claims as never)
        .setProtectedHeader({ alg: 'HS256', kid: idp.key.kid })
        .sign(new TextEncoder().encode(JSON.stringify(idp.key.publicJwk)));
    expect(await code(signIn(provider(), idp))).toBe('invalid_token');
  });

  it('follows key rotation: an unknown kid refetches the key set once the cooldown has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const rotating = await fakeOidc({ issuer: 'https://rotate.example.test' });
      const p = provider({
        issuer: rotating.issuer,
        clientId: rotating.clientId,
        clientSecret: new Secret(rotating.clientSecret),
        fetch: rotating.fetch,
      });
      expect(await code(signIn(p, rotating))).toBe('ok');
      const fetches = () => rotating.calls.filter((c) => c.endsWith('/jwks')).length;
      expect(fetches()).toBe(1);
      // The IdP rotates its signing key. Inside the cooldown the key set is not refetched: a flood of unknown kids
      // cannot turn this server into a load generator, and the token is refused.
      rotating.extraKeys.push(rotating.key);
      rotating.key = await signingKey('ES256', 'key-2');
      expect(await code(signIn(p, rotating))).toBe('invalid_token');
      expect(fetches()).toBe(1);
      // After the cooldown the unknown kid triggers one refetch and the new key is trusted.
      vi.setSystemTime(Date.now() + JWKS_COOLDOWN_MS + 1_000);
      expect(await code(signIn(p, rotating))).toBe('ok');
      expect(fetches()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an unverified, missing or non-ASCII email', async () => {
    expect(await code(signIn(provider(), idp, { user: { email_verified: false } }))).toBe('email_unverified');
    expect(await code(signIn(provider(), idp, { user: { email_verified: 'false' } }))).toBe(
      'email_unverified',
    );
    idp.omitClaims = ['email_verified'];
    expect(await code(signIn(provider(), idp))).toBe('email_unverified');
    idp.omitClaims = ['email'];
    expect(await code(signIn(provider(), idp))).toBe('email_missing');
    // The Kelvin sign lowercases to ASCII `k` (L-184): never accepted as an address.
    expect(await code(signIn(provider(), idp, { user: { email: `${KELVIN}evin@example.test` } }))).toBe(
      'email_missing',
    );
    expect(
      await signIn(provider(), idp, { user: { email: 'Ann@Example.TEST', email_verified: 'true' } }),
    ).toMatchObject({
      email: 'ann@example.test',
    });
  });

  it('reads the email from userinfo when the token has none, and only for the same subject', async () => {
    idp.omitClaims = ['email', 'email_verified'];
    idp.userinfo = { sub: 'subject-1', email: 'info@example.test', email_verified: true };
    expect(await signIn(provider(), idp)).toMatchObject({ email: 'info@example.test' });
    idp.omitClaims = ['email', 'email_verified'];
    idp.userinfo = { sub: 'someone-else', email: 'info@example.test', email_verified: true };
    expect(await code(signIn(provider(), idp))).toBe('invalid_token');
    idp.userinfo = undefined;
  });

  it('refuses a subject that is empty or too long', async () => {
    expect(await code(signIn(provider(), idp, { user: { sub: '' } }))).toBe('invalid_token');
    expect(await code(signIn(provider(), idp, { user: { sub: 'x'.repeat(256) } }))).toBe('invalid_token');
  });

  it('refuses a wrong code verifier (PKCE) and an IdP error answer', async () => {
    expect(await code(signIn(provider(), idp, { callbackVerifier: 'a'.repeat(43) }))).toBe('idp_error');
    idp.tokenFailure = new Response(JSON.stringify({ error: 'server_error' }), { status: 500 });
    expect(await code(signIn(provider(), idp))).toBe('idp_unavailable');
    idp.tokenFailure = undefined;
  });

  it('checks RFC 9207: a different iss is refused, a required one must be present', async () => {
    expect(await code(signIn(provider(), idp, { issuer: 'https://evil.example.test' }))).toBe(
      'issuer_mismatch',
    );
    expect(await code(signIn(provider(), idp, { issuer: idp.issuer }))).toBe('ok');
    const strict = await fakeOidc({
      issuer: 'https://strict.example.test',
      discovery: { authorization_response_iss_parameter_supported: true },
    });
    const p = provider({
      issuer: strict.issuer,
      clientId: strict.clientId,
      clientSecret: new Secret(strict.clientSecret),
      fetch: strict.fetch,
    });
    expect(await code(signIn(p, strict))).toBe('issuer_mismatch');
    expect(await code(signIn(p, strict, { issuer: strict.issuer }))).toBe('ok');
  });

  it('refuses discovery that names another issuer, a plain-http endpoint or no PKCE', async () => {
    for (const discovery of [
      { issuer: 'https://lookalike.example.test' },
      { token_endpoint: 'http://idp.example.test/token' },
      { jwks_uri: 'https://user:pw@idp.example.test/jwks' },
      { code_challenge_methods_supported: ['plain'] },
      { id_token_signing_alg_values_supported: ['HS256', 'none'] },
    ]) {
      const bad = await fakeOidc({ issuer: 'https://bad.example.test', discovery });
      const p = provider({ issuer: bad.issuer, clientId: bad.clientId, fetch: bad.fetch });
      expect(
        await code(
          p.authorizationUrl({ redirectUri: REDIRECT_URI, state: 's', nonce: 'n', codeChallenge: 'c' }),
        ),
        JSON.stringify(discovery),
      ).toBe('idp_unavailable');
    }
  });

  it('caps the key set like every other IdP answer (a hostile jwks_uri cannot stream megabytes)', async () => {
    const big = await fakeOidc({ issuer: 'https://big.example.test' });
    const huge = JSON.stringify({ keys: [big.key.publicJwk], pad: 'x'.repeat(300 * 1024) });
    const p = provider({
      issuer: big.issuer,
      clientId: big.clientId,
      clientSecret: new Secret(big.clientSecret),
      fetch: async (request) =>
        request.url === big.jwksUri
          ? new Response(huge, { headers: { 'content-type': 'application/json' } })
          : big.fetch(request),
    });
    expect(await code(signIn(p, big))).toBe('idp_unavailable');
  });

  it('authenticates to the token endpoint with the body when the IdP only supports that', async () => {
    const post = await fakeOidc({ issuer: 'https://post.example.test', tokenAuth: 'post' });
    const p = provider({
      issuer: post.issuer,
      clientId: post.clientId,
      clientSecret: new Secret(post.clientSecret),
      fetch: post.fetch,
    });
    expect(await code(signIn(p, post))).toBe('ok');
  });

  it('never puts the client secret in an error, a URL or the provider object', async () => {
    const p = provider();
    const url = await p.authorizationUrl({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
    });
    expect(url.href).not.toContain(idp.clientSecret);
    expect(JSON.stringify(p)).not.toContain(idp.clientSecret);
    idp.tokenFailure = new Response(JSON.stringify({ error: 'x', error_description: idp.clientSecret }), {
      status: 400,
    });
    try {
      await signIn(p, idp);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(idp.clientSecret);
    }
    idp.tokenFailure = undefined;
  });
});

describe('Google', () => {
  async function google(hostedDomain?: string) {
    const g = await fakeOidc({ issuer: 'https://accounts.google.com' });
    const p = createGoogleProvider({
      clientId: g.clientId,
      clientSecret: new Secret(g.clientSecret),
      ...(hostedDomain === undefined ? {} : { hostedDomain }),
      fetch: g.fetch,
    });
    return { g, p };
  }

  it('signs in and reports the provider as google', async () => {
    const { g, p } = await google();
    expect(await signIn(p, g)).toMatchObject({
      idp: 'google',
      subject: 'subject-1',
      email: 'ann@example.test',
    });
    expect(p.id).toBe('google');
  });

  it('accepts both documented issuer spellings', async () => {
    const { g, p } = await google();
    g.nextClaims = { iss: 'accounts.google.com' };
    expect(await code(signIn(p, g))).toBe('ok');
  });

  it('sends the hosted domain as a hint and enforces the hd claim', async () => {
    const { g, p } = await google('Example.Test');
    const url = await p.authorizationUrl({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
    });
    expect(url.searchParams.get('hd')).toBe('example.test');
    expect(await code(signIn(p, g, { user: { hd: 'example.test' } }))).toBe('ok');
    expect(await code(signIn(p, g, { user: { hd: 'EXAMPLE.test' } }))).toBe('ok');
    // The hint is removable by the user: only the verified claim counts.
    expect(await code(signIn(p, g, { user: { hd: 'other.test' } }))).toBe('hd_mismatch');
    expect(await code(signIn(p, g))).toBe('hd_mismatch');
    expect(await code(signIn(p, g, { user: { hd: 'sub.example.test' } }))).toBe('hd_mismatch');
  });

  it('adds no hd restriction when none is configured (personal accounts are fine)', async () => {
    const { g, p } = await google();
    const url = await p.authorizationUrl({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
    });
    expect(url.searchParams.has('hd')).toBe(false);
    expect(await code(signIn(p, g, { user: { hd: 'whatever.test' } }))).toBe('ok');
  });
});
