// SPDX-License-Identifier: Apache-2.0
// Identity settings from `AB_*` variables (P4-01): half-configured providers and bad values are refused at boot with the
// variable's name and never its value; secrets are wrapped at once; risky combinations warn.
import { Secret } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import {
  createIdentityProviders,
  IdentityConfigError,
  identitySettingsFromEnv,
  parsePublicUrl,
  providerRouteId,
} from '../../src/index.ts';

const BASE = { AB_PUBLIC_URL: 'https://bridge.example.test' };
const google = { AB_GOOGLE_CLIENT_ID: 'gid.example.test', AB_GOOGLE_CLIENT_SECRET: 'gsecret-value' };

function refused(env: Record<string, string>): { variable: string; message: string } {
  try {
    identitySettingsFromEnv(env);
  } catch (error) {
    if (error instanceof IdentityConfigError) return { variable: error.variable, message: error.message };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('identitySettingsFromEnv', () => {
  it('is off without any provider', () => {
    expect(identitySettingsFromEnv({})).toBeNull();
    expect(identitySettingsFromEnv({ AB_PUBLIC_URL: 'https://bridge.example.test' })).toBeNull();
  });

  it('reads every provider and the policy', () => {
    const s = identitySettingsFromEnv({
      ...BASE,
      ...google,
      AB_GOOGLE_HOSTED_DOMAIN: 'Example.Test',
      AB_GITHUB_CLIENT_ID: 'ghid',
      AB_GITHUB_CLIENT_SECRET: 'ghsecret',
      AB_OIDC_ISSUER: 'https://login.example.test',
      AB_OIDC_CLIENT_ID: 'oid',
      AB_OIDC_CLIENT_SECRET: 'osecret',
      AB_OIDC_NAME: 'Corp',
      AB_OIDC_LABEL: 'Corporate login',
      AB_OIDC_SCOPES: 'openid email',
      AB_CF_ACCESS_TEAM: 'Acme',
      AB_CF_ACCESS_AUD: 'a'.repeat(64),
      AB_LOGIN_ALLOW_EMAILS: 'Ann@Example.test, bob@example.test',
      AB_LOGIN_ALLOW_DOMAINS: '@example.test',
      AB_LOGIN_ALLOW_GITHUB_ORGS: 'Acme',
      AB_LOGIN_AUTO_PROVISION: 'member',
    });
    expect(s).not.toBeNull();
    expect(s?.publicUrl).toBe('https://bridge.example.test');
    expect(s?.providers.map((p) => p.kind)).toEqual(['google', 'github', 'oidc', 'cf-access']);
    expect(s?.providers[0]).toMatchObject({ hostedDomain: 'example.test' });
    expect(s?.providers[2]).toMatchObject({ name: 'corp', scopes: ['openid', 'email'] });
    expect(s?.providers[3]).toMatchObject({ team: 'acme' });
    expect(s?.policy).toEqual({
      emails: ['ann@example.test', 'bob@example.test'],
      domains: ['example.test'],
      githubOrgs: ['acme'],
      autoProvision: 'member',
    });
    expect(s?.warnings).toEqual([]);
  });

  it('wraps client secrets so that logging or serialising the settings cannot leak them', () => {
    const s = identitySettingsFromEnv({ ...BASE, ...google });
    const provider = s?.providers[0] as { clientSecret: Secret };
    expect(provider.clientSecret).toBeInstanceOf(Secret);
    expect(JSON.stringify(s)).not.toContain('gsecret-value');
    expect(String(provider.clientSecret)).not.toContain('gsecret-value');
  });

  it('refuses half-configured providers, naming the variable', () => {
    expect(refused({ ...BASE, AB_GOOGLE_CLIENT_ID: 'x' })).toMatchObject({
      variable: 'AB_GOOGLE_CLIENT_SECRET',
    });
    expect(refused({ ...BASE, AB_GOOGLE_CLIENT_SECRET: 'x' })).toMatchObject({
      variable: 'AB_GOOGLE_CLIENT_ID',
    });
    expect(refused({ ...BASE, AB_GITHUB_CLIENT_ID: 'x' })).toMatchObject({
      variable: 'AB_GITHUB_CLIENT_SECRET',
    });
    expect(refused({ ...BASE, AB_OIDC_ISSUER: 'https://i.example.test' })).toMatchObject({
      variable: 'AB_OIDC_CLIENT_ID',
    });
    expect(refused({ ...BASE, AB_OIDC_CLIENT_ID: 'x', AB_OIDC_CLIENT_SECRET: 'y' })).toMatchObject({
      variable: 'AB_OIDC_ISSUER',
    });
    expect(refused({ ...BASE, AB_CF_ACCESS_TEAM: 'acme' })).toMatchObject({ variable: 'AB_CF_ACCESS_AUD' });
    expect(refused({ ...BASE, AB_CF_ACCESS_AUD: 'a'.repeat(64) })).toMatchObject({
      variable: 'AB_CF_ACCESS_TEAM',
    });
  });

  it('refuses invalid values without repeating them', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ AB_GOOGLE_HOSTED_DOMAIN: 'bad_value_7' }, 'AB_GOOGLE_HOSTED_DOMAIN'],
      [
        { AB_OIDC_ISSUER: 'http://login.example.test', AB_OIDC_CLIENT_ID: 'a', AB_OIDC_CLIENT_SECRET: 'b' },
        'AB_OIDC_ISSUER',
      ],
      [
        {
          AB_OIDC_ISSUER: 'https://u:p@login.example.test',
          AB_OIDC_CLIENT_ID: 'a',
          AB_OIDC_CLIENT_SECRET: 'b',
        },
        'AB_OIDC_ISSUER',
      ],
      [
        {
          AB_OIDC_ISSUER: 'https://login.example.test/?x=1',
          AB_OIDC_CLIENT_ID: 'a',
          AB_OIDC_CLIENT_SECRET: 'b',
        },
        'AB_OIDC_ISSUER',
      ],
      [
        {
          AB_OIDC_ISSUER: 'https://login.example.test',
          AB_OIDC_CLIENT_ID: 'a',
          AB_OIDC_CLIENT_SECRET: 'b',
          AB_OIDC_NAME: 'Bad Name!',
        },
        'AB_OIDC_NAME',
      ],
      [
        {
          AB_OIDC_ISSUER: 'https://login.example.test',
          AB_OIDC_CLIENT_ID: 'a',
          AB_OIDC_CLIENT_SECRET: 'b',
          AB_OIDC_SCOPES: 'email profile',
        },
        'AB_OIDC_SCOPES',
      ],
      [{ AB_CF_ACCESS_TEAM: 'bad team!', AB_CF_ACCESS_AUD: 'a'.repeat(64) }, 'AB_CF_ACCESS_TEAM'],
      [{ AB_CF_ACCESS_TEAM: 'acme', AB_CF_ACCESS_AUD: 'short' }, 'AB_CF_ACCESS_AUD'],
      [{ AB_LOGIN_ALLOW_EMAILS: 'bad-value-8' }, 'AB_LOGIN_ALLOW_EMAILS'],
      [{ AB_LOGIN_ALLOW_DOMAINS: 'nodot' }, 'AB_LOGIN_ALLOW_DOMAINS'],
      [{ AB_LOGIN_ALLOW_GITHUB_ORGS: 'bad/org' }, 'AB_LOGIN_ALLOW_GITHUB_ORGS'],
      [{ AB_LOGIN_AUTO_PROVISION: 'owner' }, 'AB_LOGIN_AUTO_PROVISION'],
      [{ AB_LOGIN_AUTO_PROVISION: 'yes' }, 'AB_LOGIN_AUTO_PROVISION'],
    ];
    for (const [extra, variable] of cases) {
      const env = { ...BASE, ...google, ...extra };
      const r = refused(env);
      expect(r.variable, JSON.stringify(extra)).toBe(variable);
      // The refused value itself is never echoed (the variable name may share letters with it).
      expect(r.message).not.toContain(extra[variable] as string);
      expect(r.message).not.toContain('gsecret-value');
    }
  });

  it('refuses an allowlist without a provider, and sign-in without a usable public URL', () => {
    expect(refused({ AB_LOGIN_ALLOW_EMAILS: 'ann@example.test' })).toMatchObject({
      variable: 'AB_LOGIN_ALLOW_EMAILS',
    });
    for (const url of [
      '',
      'http://bridge.example.test',
      'https://bridge.example.test/path',
      'https://bridge.example.test/?x',
      'https://u:p@bridge.example.test',
      'ftp://x.test',
    ]) {
      expect(refused({ ...google, AB_PUBLIC_URL: url }), url).toMatchObject({ variable: 'AB_PUBLIC_URL' });
    }
    expect(refused(google)).toMatchObject({ variable: 'AB_PUBLIC_URL' });
  });

  it('accepts http only for a loopback public URL and a loopback issuer', () => {
    expect(parsePublicUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(parsePublicUrl('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(parsePublicUrl('http://192.168.1.5:8787')).toBeNull();
    expect(parsePublicUrl('https://bridge.example.test')).toBe('https://bridge.example.test');
    expect(
      identitySettingsFromEnv({
        AB_PUBLIC_URL: 'http://127.0.0.1:8787',
        AB_OIDC_ISSUER: 'http://127.0.0.1:9000',
        AB_OIDC_CLIENT_ID: 'a',
        AB_OIDC_CLIENT_SECRET: 'b',
      })?.providers[0],
    ).toMatchObject({ kind: 'oidc', issuer: 'http://127.0.0.1:9000' });
  });

  describe('warnings', () => {
    const w = (extra: Record<string, string>) =>
      identitySettingsFromEnv({ ...BASE, ...google, ...extra })?.warnings ?? [];

    it('warns about an allowlist without auto-provisioning: only existing users can sign in', () => {
      expect(w({ AB_LOGIN_ALLOW_DOMAINS: 'example.test' }).join()).toMatch(/only users who already exist/);
      expect(w({ AB_LOGIN_ALLOW_DOMAINS: 'example.test', AB_LOGIN_AUTO_PROVISION: 'off' }).join()).toMatch(
        /only users who already exist/,
      );
    });

    it('warns about auto-provisioning without an allowlist, and about admin auto-provisioning', () => {
      expect(w({ AB_LOGIN_AUTO_PROVISION: 'member' }).join()).toMatch(
        /no effect without an AB_LOGIN_ALLOW_\*/,
      );
      const admin = w({ AB_LOGIN_ALLOW_DOMAINS: 'example.test', AB_LOGIN_AUTO_PROVISION: 'admin' });
      expect(admin.join()).toMatch(/becomes an administrator/);
    });

    it('warns about GitHub organizations without GitHub sign-in', () => {
      expect(w({ AB_LOGIN_ALLOW_GITHUB_ORGS: 'acme', AB_LOGIN_AUTO_PROVISION: 'member' }).join()).toMatch(
        /GitHub sign-in is not configured/,
      );
    });

    it('is quiet for the sensible combinations', () => {
      expect(w({})).toEqual([]);
      expect(w({ AB_LOGIN_ALLOW_DOMAINS: 'example.test', AB_LOGIN_AUTO_PROVISION: 'member' })).toEqual([]);
    });
  });
});

describe('providers', () => {
  it('are built with route ids that match the sign-in URLs', () => {
    const s = identitySettingsFromEnv({
      ...BASE,
      ...google,
      AB_GITHUB_CLIENT_ID: 'a',
      AB_GITHUB_CLIENT_SECRET: 'b',
      AB_OIDC_ISSUER: 'https://login.example.test',
      AB_OIDC_CLIENT_ID: 'a',
      AB_OIDC_CLIENT_SECRET: 'b',
      AB_OIDC_NAME: 'corp',
      AB_CF_ACCESS_TEAM: 'acme',
      AB_CF_ACCESS_AUD: 'a'.repeat(64),
    });
    expect(s?.providers.map(providerRouteId)).toEqual(['google', 'github', 'oidc-corp', 'cf-access']);
    const built = createIdentityProviders(s as NonNullable<typeof s>);
    expect(built.map((p) => [p.id, p.idp, p.kind])).toEqual([
      ['google', 'google', 'redirect'],
      ['github', 'github', 'redirect'],
      ['oidc-corp', 'oidc:corp', 'redirect'],
      ['cf-access', 'cf-access', 'header'],
    ]);
    const plain = identitySettingsFromEnv({
      ...BASE,
      AB_OIDC_ISSUER: 'https://login.example.test',
      AB_OIDC_CLIENT_ID: 'a',
      AB_OIDC_CLIENT_SECRET: 'b',
    });
    expect(plain?.providers.map(providerRouteId)).toEqual(['oidc']);
  });
});
