// SPDX-License-Identifier: Apache-2.0
// GitHub sign-in against a local fake GitHub (P4-01): numeric id as subject, the verified primary email, organization
// membership, and the access token revoked after the lookup (L-188).
import { Secret } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { createGitHubProvider, type IdentityErrorCode, isIdentityError } from '../../src/index.ts';
import { FakeGitHub } from '../helpers/fake-idp.ts';
import { REDIRECT_URI, signIn } from '../helpers/flow.ts';

function setup(orgs: string[] = []) {
  const gh = new FakeGitHub();
  const warnings: Array<[string, Record<string, unknown>]> = [];
  const provider = createGitHubProvider({
    clientId: gh.clientId,
    clientSecret: new Secret(gh.clientSecret),
    orgs,
    fetch: gh.fetch,
  });
  const hooks = { warn: (m: string, f: Record<string, unknown>) => warnings.push([m, f]) };
  return { gh, provider, warnings, hooks };
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

describe('GitHub', () => {
  it('signs in with the numeric id as subject and the verified primary email', async () => {
    const { gh, provider, hooks } = setup();
    expect(await signIn(provider, gh, {}, hooks)).toEqual({
      idp: 'github',
      subject: '4242',
      email: 'ann@example.test',
      emailVerified: true,
      displayName: 'Ann Example',
      orgs: [],
    });
  });

  it('asks for PKCE S256, the exact redirect URI, no signup and only the scopes it needs', async () => {
    const { provider } = setup();
    const url = await provider.authorizationUrl({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
    });
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      redirect_uri: REDIRECT_URI,
      state: 's',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      allow_signup: 'false',
      scope: 'read:user user:email',
    });
    expect(url.searchParams.has('nonce')).toBe(false);
    const withOrgs = await setup(['acme']).provider.authorizationUrl({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
    });
    expect(withOrgs.searchParams.get('scope')).toBe('read:user user:email read:org');
  });

  it('refuses an account without a verified primary email, however many other addresses it has', async () => {
    const { gh, provider, hooks } = setup();
    gh.user.emails = [
      { email: 'ann@example.test', primary: true, verified: false },
      { email: 'other@example.test', primary: false, verified: true },
    ];
    expect(await code(signIn(provider, gh, {}, hooks))).toBe('email_unverified');
    gh.user.emails = [{ email: 'other@example.test', primary: false, verified: true }];
    expect(await code(signIn(provider, gh, {}, hooks))).toBe('email_missing');
    gh.user.emails = [];
    expect(await code(signIn(provider, gh, {}, hooks))).toBe('email_missing');
    gh.user.emails = [
      { email: `${String.fromCodePoint(0x212a)}ann@example.test`, primary: true, verified: true },
    ];
    expect(await code(signIn(provider, gh, {}, hooks))).toBe('email_missing');
  });

  it('reports active members of the configured organizations only; a pending invitation is not membership', async () => {
    const { gh, provider, hooks } = setup(['acme', 'beta', 'gamma']);
    gh.user.orgs = { acme: 'active', beta: 'pending' };
    expect(await signIn(provider, gh, {}, hooks)).toMatchObject({ orgs: ['acme'] });
  });

  it('uses the user id, never the login, as the subject (logins can be renamed and reused)', async () => {
    const { gh, provider, hooks } = setup();
    gh.user.login = 'renamed';
    expect(await signIn(provider, gh, {}, hooks)).toMatchObject({ subject: '4242' });
  });

  it('refuses a wrong verifier, and answers an unavailable GitHub as such', async () => {
    const { gh, provider, hooks } = setup();
    expect(await code(signIn(provider, gh, { callbackVerifier: 'a'.repeat(43) }, hooks))).toBe('idp_error');
    const down = createGitHubProvider({
      clientId: gh.clientId,
      clientSecret: new Secret(gh.clientSecret),
      fetch: async () => new Response('bad gateway', { status: 502 }),
    });
    expect(await code(signIn(down, gh))).toBe('idp_unavailable');
  });

  it('revokes the access token after the lookup, on success and when the lookup refuses', async () => {
    const { gh, provider, hooks } = setup();
    await signIn(provider, gh, {}, hooks);
    expect(gh.revocations).toHaveLength(1);
    expect(gh.liveTokens).toBe(0);
    expect(gh.revocations[0]?.authorization).toBe(`Basic ${btoa(`${gh.clientId}:${gh.clientSecret}`)}`);

    gh.user.emails = [{ email: 'ann@example.test', primary: true, verified: false }];
    expect(await code(signIn(provider, gh, {}, hooks))).toBe('email_unverified');
    expect(gh.revocations).toHaveLength(2);
    expect(gh.liveTokens).toBe(0);
  });

  it('does not fail the sign-in when the revocation fails, and logs the status, never the token', async () => {
    const { gh, provider, hooks, warnings } = setup();
    gh.revokeStatus = 500;
    expect(await code(signIn(provider, gh, {}, hooks))).toBe('ok');
    expect(warnings).toHaveLength(1);
    const text = JSON.stringify(warnings);
    expect(text).toContain('500');
    expect(text).not.toContain(gh.revocations[0]?.token ?? 'x-missing');
    expect(text).not.toContain(gh.clientSecret);
  });

  it('hands the revocation to the background hook when there is one (Workers: waitUntil)', async () => {
    const { gh, provider } = setup();
    const tasks: Promise<unknown>[] = [];
    await signIn(provider, gh, {}, { background: (t) => tasks.push(t) });
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(gh.revocations).toHaveLength(1);
  });
});
