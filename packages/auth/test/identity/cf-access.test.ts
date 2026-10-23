// SPDX-License-Identifier: Apache-2.0
// Cloudflare Access sign-in (P4-01): the assertion header is verified against the team's keys and the application's
// AUD tag; anyone can send the header, so nothing is trusted before that.
import { describe, expect, it } from 'vitest';
import {
  createCloudflareAccessProvider,
  type IdentityErrorCode,
  isIdentityError,
  normalizeAccessTeam,
} from '../../src/index.ts';
import { type FakeAccess, fakeAccess, signingKey } from '../helpers/fake-idp.ts';

async function setup(): Promise<{
  access: FakeAccess;
  verify: (headers: Headers) => ReturnType<ReturnType<typeof createCloudflareAccessProvider>['verify']>;
}> {
  const access = await fakeAccess();
  const provider = createCloudflareAccessProvider({
    team: access.team,
    audience: access.audience,
    fetch: access.fetch,
  });
  return { access, verify: (h) => provider.verify(h) };
}
const withToken = (token: string) => new Headers({ 'cf-access-jwt-assertion': token });

async function code(p: Promise<unknown>): Promise<IdentityErrorCode | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (error) {
    if (isIdentityError(error)) return error.code;
    throw error;
  }
}

describe('Cloudflare Access', () => {
  it('accepts a genuine assertion', async () => {
    const { access, verify } = await setup();
    const identity = await verify(withToken(await access.assertion()));
    expect(identity).toMatchObject({
      idp: 'cf-access',
      subject: 'access-subject-1',
      email: 'ann@example.test',
      emailVerified: true,
      displayName: null,
    });
    // The assertion's issue time is the recency evidence a re-authentication checks (P4-02).
    expect(identity.authenticatedAt).toBeTypeOf('number');
  });

  it('refuses a request without the header, with an empty one, or with only the cookie', async () => {
    const { access, verify } = await setup();
    expect(await code(verify(new Headers()))).toBe('missing_assertion');
    expect(await code(verify(withToken('  ')))).toBe('missing_assertion');
    // The `CF_Authorization` cookie is readable by every application of the team: never used.
    expect(await code(verify(new Headers({ cookie: `CF_Authorization=${await access.assertion()}` })))).toBe(
      'missing_assertion',
    );
    expect(access.calls).toHaveLength(0);
  });

  it('refuses another application (AUD), another team (issuer) and an expired assertion', async () => {
    const { access, verify } = await setup();
    expect(
      await code(verify(withToken(await access.assertion({ aud: ['another-application-tag-0123456789'] })))),
    ).toBe('wrong_audience');
    expect(
      await code(verify(withToken(await access.assertion({ iss: 'https://evil.cloudflareaccess.com' })))),
    ).toBe('wrong_issuer');
    const now = Math.floor(Date.now() / 1000);
    expect(await code(verify(withToken(await access.assertion({ exp: now - 600, iat: now - 900 }))))).toBe(
      'token_expired',
    );
  });

  it('refuses a token signed with a key the team does not publish, and unsigned or HMAC tokens', async () => {
    const { access, verify } = await setup();
    const forged = await signingKey('RS256', access.key.kid);
    expect(await code(verify(withToken(await access.assertion({}, forged))))).toBe('invalid_token');
    const enc = (v: unknown) =>
      btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const none = `${enc({ alg: 'none' })}.${enc({ sub: 'x', email: 'ann@example.test', iss: access.issuer, aud: [access.audience], exp: 9_999_999_999 })}.`;
    expect(await code(verify(withToken(none)))).toBe('invalid_token');
    // ES256 is not what Access signs with: the allowlist is RS256 only.
    expect(
      await code(verify(withToken(await access.assertion({}, await signingKey('ES256', access.key.kid))))),
    ).toBe('invalid_token');
  });

  it('refuses a service token (no email) and a non-application assertion', async () => {
    const { access, verify } = await setup();
    expect(
      await code(verify(withToken(await access.assertion({ email: undefined, sub: '', common_name: 'ci' })))),
    ).toBe('email_missing');
    expect(await code(verify(withToken(await access.assertion({ type: 'service' }))))).toBe('invalid_token');
    expect(await code(verify(withToken(await access.assertion({ sub: '' }))))).toBe('invalid_token');
  });

  it('fetches the team keys from the team domain only', async () => {
    const { access, verify } = await setup();
    await verify(withToken(await access.assertion()));
    expect(access.calls).toEqual([`https://${access.team}.cloudflareaccess.com/cdn-cgi/access/certs`]);
  });

  it('normalises team names and refuses odd ones', () => {
    expect(normalizeAccessTeam('Acme')).toBe('acme');
    expect(normalizeAccessTeam('acme.cloudflareaccess.com')).toBe('acme');
    expect(normalizeAccessTeam('https://acme.cloudflareaccess.com/')).toBe('acme');
    for (const bad of ['', 'a b', 'acme.evil.example', '-acme', 'acme/../x'])
      expect(normalizeAccessTeam(bad), bad).toBeNull();
    expect(() => createCloudflareAccessProvider({ team: 'bad team', audience: 'x'.repeat(40) })).toThrow(
      TypeError,
    );
    expect(() => createCloudflareAccessProvider({ team: 'acme', audience: 'short' })).toThrow(TypeError);
  });
});
