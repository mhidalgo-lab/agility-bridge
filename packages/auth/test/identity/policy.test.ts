// SPDX-License-Identifier: Apache-2.0
// Who may sign in (P4-01, L-092, THREAT_MODEL T14): deny by default; one identity per user; a verified email binds
// only a user who has none; allowlists need auto-provisioning; a setup link means owner.
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AutoProvision,
  canonicalEmail,
  EMPTY_LOGIN_POLICY,
  type LoginPolicy,
  matchAllowlist,
  resolveLoginUser,
  type VerifiedIdentity,
} from '../../src/index.ts';
import { loginRace } from '../login-race.ts';

let storage: Storage;
beforeEach(() => {
  storage = createMemoryStorage();
});

const id = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  idp: 'google',
  subject: 'sub-ann',
  email: 'ann@example.test',
  emailVerified: true,
  displayName: 'Ann',
  ...over,
});
const policy = (over: Partial<LoginPolicy> = {}): LoginPolicy => ({ ...EMPTY_LOGIN_POLICY, ...over });
const resolve = (identity: VerifiedIdentity, p: LoginPolicy = EMPTY_LOGIN_POLICY, bootstrap = false) =>
  resolveLoginUser(storage.users, identity, p, { ownerBootstrap: bootstrap });

describe('deny by default', () => {
  it('refuses an unknown identity with no allowlist, and creates nothing', async () => {
    expect(await resolve(id())).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await storage.users.list()).toEqual([]);
  });

  it('refuses an unverified identity whatever else matches', async () => {
    await storage.users.create({ id: 'u1', email: 'ann@example.test', role: 'member' });
    const unverified = { ...id(), emailVerified: false } as unknown as VerifiedIdentity;
    expect(
      await resolve(unverified, policy({ emails: ['ann@example.test'], autoProvision: 'member' })),
    ).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect((await storage.users.get('u1'))?.idp).toBeNull();
  });
});

describe('existing users', () => {
  it('signs in a user already bound to this identity, even when the IdP now reports another email', async () => {
    await storage.users.create({
      id: 'u1',
      email: 'ann@example.test',
      role: 'admin',
      idp: 'google',
      idpSubject: 'sub-ann',
    });
    const d = await resolve(id({ email: 'new-address@example.test' }));
    expect(d).toMatchObject({ ok: true, outcome: 'existing', user: { id: 'u1', role: 'admin' } });
  });

  it('binds a verified email to a user with no identity yet, and fills in the name', async () => {
    await storage.users.create({ id: 'u1', email: 'ann@example.test', role: 'member' });
    const d = await resolve(id());
    expect(d).toMatchObject({
      ok: true,
      outcome: 'linked',
      user: { id: 'u1', idp: 'google', idpSubject: 'sub-ann', displayName: 'Ann' },
    });
    expect((await storage.users.getByIdentity('google', 'sub-ann'))?.id).toBe('u1');
  });

  it('keeps a name the admin set', async () => {
    await storage.users.create({
      id: 'u1',
      email: 'ann@example.test',
      role: 'member',
      displayName: 'Dr. Ann',
    });
    expect(await resolve(id())).toMatchObject({ ok: true, user: { displayName: 'Dr. Ann' } });
  });

  it('refuses an email that belongs to a user bound to another identity (no silent cross-provider linking)', async () => {
    await storage.users.create({
      id: 'u1',
      email: 'ann@example.test',
      role: 'owner',
      idp: 'github',
      idpSubject: '4242',
    });
    expect(await resolve(id())).toEqual({ ok: false, reason: 'identity_conflict' });
    // Not even with an allowlist and auto-provisioning that would admit a new user, nor with a setup link.
    const open = policy({ emails: ['ann@example.test'], autoProvision: 'admin' });
    expect(await resolve(id(), open)).toEqual({ ok: false, reason: 'identity_conflict' });
    expect(await resolve(id(), open, true)).toEqual({ ok: false, reason: 'identity_conflict' });
    expect(await storage.users.getByIdentity('google', 'sub-ann')).toBeNull();
    expect((await storage.users.get('u1'))?.idp).toBe('github');
  });

  it('refuses the same subject at another provider, and another subject at the same one', async () => {
    await storage.users.create({
      id: 'u1',
      email: 'ann@example.test',
      role: 'member',
      idp: 'google',
      idpSubject: 'sub-ann',
    });
    expect(await resolve(id({ idp: 'github', subject: 'sub-ann' }))).toEqual({
      ok: false,
      reason: 'identity_conflict',
    });
    expect(await resolve(id({ subject: 'sub-other' }))).toEqual({ ok: false, reason: 'identity_conflict' });
  });

  it('refuses disabled users, bound or not', async () => {
    await storage.users.create({
      id: 'u1',
      email: 'ann@example.test',
      role: 'member',
      idp: 'google',
      idpSubject: 'sub-ann',
      disabledAt: 5,
    });
    await storage.users.create({ id: 'u2', email: 'bob@example.test', role: 'member', disabledAt: 5 });
    expect(await resolve(id())).toEqual({ ok: false, reason: 'user_disabled' });
    expect(
      await resolve(
        id({ subject: 'sub-bob', email: 'bob@example.test' }),
        policy({ emails: ['bob@example.test'], autoProvision: 'member' }),
        true,
      ),
    ).toEqual({
      ok: false,
      reason: 'user_disabled',
    });
    expect((await storage.users.get('u2'))?.idp).toBeNull();
  });

  it('lets exactly one of several concurrent first sign-ins bind the user (L-185)', async () => {
    expect(await loginRace(storage)).toEqual({ ok: 1, conflict: 2, bound: expect.any(String) });
  });
});

describe('allowlists and auto-provisioning', () => {
  const matrix: Array<[string, Partial<LoginPolicy>, VerifiedIdentity, string | null]> = [
    ['exact email', { emails: ['ann@example.test'] }, id(), 'email'],
    ['email domain', { domains: ['example.test'] }, id(), 'domain'],
    [
      'a subdomain is not the domain',
      { domains: ['example.test'] },
      id({ email: 'ann@sub.example.test' }),
      null,
    ],
    [
      'a lookalike domain is not the domain',
      { domains: ['example.test'] },
      id({ email: 'ann@evil-example.test' }),
      null,
    ],
    ['another address', { emails: ['bob@example.test'] }, id(), null],
    ['github org', { githubOrgs: ['acme'] }, id({ idp: 'github', orgs: ['acme'] }), 'github_org'],
    [
      'org of another provider is ignored',
      { githubOrgs: ['acme'] },
      id({ idp: 'google', orgs: ['acme'] }),
      null,
    ],
    ['a different org', { githubOrgs: ['acme'] }, id({ idp: 'github', orgs: ['beta'] }), null],
    ['no allowlist at all', {}, id(), null],
  ];
  for (const [name, over, identity, expected] of matrix) {
    it(`matches ${name}`, () => {
      expect(matchAllowlist(policy(over), identity)).toBe(expected);
    });
  }

  const modes: AutoProvision[] = ['off', 'member', 'admin'];
  for (const mode of modes) {
    it(`with auto-provisioning ${mode}: an allowlisted unknown identity ${mode === 'off' ? 'is refused, not created' : `is created as ${mode}`}`, async () => {
      const d = await resolve(id(), policy({ emails: ['ann@example.test'], autoProvision: mode }));
      if (mode === 'off') {
        expect(d).toEqual({ ok: false, reason: 'not_provisioned' });
        expect(await storage.users.list()).toEqual([]);
      } else {
        expect(d).toMatchObject({
          ok: true,
          outcome: 'provisioned',
          user: { role: mode, idp: 'google', idpSubject: 'sub-ann', email: 'ann@example.test' },
        });
      }
    });
    it(`with auto-provisioning ${mode}: an identity outside the allowlist is refused`, async () => {
      expect(await resolve(id(), policy({ emails: ['bob@example.test'], autoProvision: mode }))).toEqual({
        ok: false,
        reason: 'not_allowed',
      });
      expect(await storage.users.list()).toEqual([]);
    });
  }

  it('auto-provisioning without any allowlist admits nobody', async () => {
    expect(await resolve(id(), policy({ autoProvision: 'admin' }))).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
  });

  it('never provisions an owner', async () => {
    for (const mode of ['member', 'admin'] as const) {
      const d = await resolve(
        id({ subject: `s-${mode}`, email: `${mode}@example.test` }),
        policy({ domains: ['example.test'], autoProvision: mode }),
      );
      expect(d).toMatchObject({ ok: true });
      if (d.ok) expect(d.user.role).not.toBe('owner');
    }
  });

  it('an allowlist does not override a user row bound elsewhere, and a pre-created row binds without it', async () => {
    await storage.users.create({ id: 'u1', email: 'ann@example.test', role: 'member' });
    // Pre-created by an admin: binds although the allowlist and auto-provisioning say nothing.
    expect(await resolve(id())).toMatchObject({
      ok: true,
      outcome: 'linked',
      user: { id: 'u1', role: 'member' },
    });
  });
});

describe('owner setup', () => {
  it('creates the first owner from an identity nobody has seen, skipping the allowlist', async () => {
    expect(await resolve(id(), EMPTY_LOGIN_POLICY, true)).toMatchObject({
      ok: true,
      outcome: 'owner_bootstrap',
      user: { role: 'owner', idp: 'google', idpSubject: 'sub-ann' },
    });
  });

  it('promotes an unbound user and records the role they had', async () => {
    await storage.users.create({ id: 'u1', email: 'ann@example.test', role: 'member' });
    const d = await resolve(id(), EMPTY_LOGIN_POLICY, true);
    expect(d).toMatchObject({
      ok: true,
      outcome: 'owner_bootstrap',
      previousRole: 'member',
      user: { id: 'u1', role: 'owner', idp: 'google' },
    });
  });

  it('promotes a bound user signing in again', async () => {
    await storage.users.create({
      id: 'u1',
      email: 'ann@example.test',
      role: 'admin',
      idp: 'google',
      idpSubject: 'sub-ann',
    });
    expect(await resolve(id(), EMPTY_LOGIN_POLICY, true)).toMatchObject({
      ok: true,
      previousRole: 'admin',
      user: { role: 'owner' },
    });
  });

  it('does not need an unverified identity to be refused here: verification comes first', async () => {
    const unverified = { ...id(), emailVerified: false } as unknown as VerifiedIdentity;
    expect(await resolve(unverified, EMPTY_LOGIN_POLICY, true)).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await storage.users.list()).toEqual([]);
  });
});

describe('canonicalEmail (L-184)', () => {
  it('lowercases printable ASCII addresses', () => {
    expect(canonicalEmail('Ann.Example+tag@Example.TEST')).toBe('ann.example+tag@example.test');
  });

  it('refuses what case folding could map onto another address, and what is not an address', () => {
    const kelvin = String.fromCodePoint(0x212a);
    const dotless = String.fromCodePoint(0x131);
    for (const bad of [
      `${kelvin}evin@example.test`,
      `ann@${kelvin}.test`,
      `ann@exam${dotless}ple.test`,
      'ann@',
      '@example.test',
      'ann example@x.test',
      'ann@@x.test',
      '',
      `${'a'.repeat(65)}@x.test`,
      42,
      null,
      undefined,
    ]) {
      expect(canonicalEmail(bad), String(bad)).toBeNull();
    }
  });
});
