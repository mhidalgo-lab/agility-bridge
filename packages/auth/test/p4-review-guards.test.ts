// SPDX-License-Identifier: Apache-2.0
// Phase 4 admin security review at the guards (P4-09, THREAT_MODEL T14, A5, A14, ADR-0013, L-065, L-093, L-121). Each test named
// `fix: ...` failed with its fix reverted (checked one by one); the others record what holds. A refusal changes nothing.
import { ConflictError, createMemoryStorage, type JsonObject, type Storage } from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Actor,
  accessServices,
  ForbiddenError,
  generateMasterKey,
  guardedServices,
  Keyring,
  ReauthRequiredError,
} from '../src/index.ts';
import { TOOLS } from './helpers/access.ts';

let storage: Storage;
let svc: ReturnType<typeof accessServices>;
let guard: (actor: Actor) => ReturnType<typeof guardedServices>;
const ids = {} as Record<string, string>;

/** A token-shaped value built at run time, so no file holds a literal (gitleaks). */
const secret = (label: string): string => `1.${label}${crypto.randomUUID().replaceAll('-', '')}`;

beforeEach(async () => {
  storage = createMemoryStorage();
  const keyring = await Keyring.create(generateMasterKey(1));
  svc = accessServices({ storage, keyring, tools: TOOLS });
  guard = (actor) => guardedServices(svc, { storage, tools: TOOLS, keyring }, actor);
  for (const [key, role] of [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['alice', 'member'],
    ['bob', 'member'],
  ] as const) {
    ids[key] = (await svc.users.create({ email: `${key}@example.test`, role })).id;
  }
  ids['instance'] = (
    await svc.instances.create({ label: 'Main', baseUrl: 'https://agility.example.test/Main' })
  ).id;
  ids['shared'] = (
    await svc.credentials.create({
      instanceId: ids['instance'] as string,
      ownerUserId: null,
      label: 'shared',
      token: secret('Shared'),
    })
  ).id;
  ids['aliceKey'] = (
    await svc.credentials.create({
      instanceId: ids['instance'] as string,
      ownerUserId: ids['alice'] as string,
      label: 'alice',
      token: secret('Alice'),
    })
  ).id;
  await storage.credentials.update(ids['aliceKey'] as string, { validationStatus: 'valid' });
  // A workspace an owner gave write tools, with a grant that has them; and one without writes.
  ids['writes'] = (
    await svc.workspaces.create({
      slug: 'writes',
      name: 'Writes',
      instanceId: ids['instance'] as string,
      allowedScopeIds: ['Scope:1', 'Scope:2'],
      enabledTools: ['whoami', 'add_comment'],
      writePolicy: { enabled: true },
      assetTypes: { allow: ['Story', 'Defect'], deny: ['Epic'] },
      defaultCredentialId: ids['shared'] as string,
    })
  ).id;
  ids['writeGrant'] = (
    await svc.grants.create({
      workspaceId: ids['writes'] as string,
      userId: ids['alice'] as string,
      credentialId: ids['aliceKey'] as string,
      tools: ['whoami', 'add_comment'],
      scopeIds: ['Scope:1'],
      assetTypes: { allow: ['Story'] },
      expiresAt: 2_000_000_000_000,
    })
  ).record.id;
  ids['plain'] = (
    await svc.workspaces.create({
      slug: 'plain',
      name: 'Plain',
      instanceId: ids['instance'] as string,
      allowedScopeIds: ['Scope:1'],
      defaultCredentialId: ids['shared'] as string,
    })
  ).id;
  ids['plainGrant'] = (
    await svc.grants.create({
      workspaceId: ids['plain'] as string,
      userId: ids['bob'] as string,
      tools: ['whoami'],
      scopeIds: ['Scope:1'],
    })
  ).record.id;
});

const user = (key: string, role: 'owner' | 'admin' | 'member', recentAuth = true): Actor => ({
  kind: 'user',
  userId: ids[key] as string,
  role,
  recentAuth,
});
const BREAK_GLASS: Actor = { kind: 'break_glass' };
const caught = (run: () => Promise<unknown>) =>
  run().then(
    () => null,
    (e: unknown) => e,
  );

describe('instances: TLS trust is the owners (A14), whichever route sets it', () => {
  let n = 0;
  const create = (actor: Actor, tls: JsonObject | null | undefined) =>
    guard(actor).instances.create({
      label: 'Second',
      baseUrl: `https://second${++n}.example.test/Main`,
      ...(tls === undefined ? {} : { tls }),
    });

  it('fix: an admin cannot add an instance with a CA file; with none it still can', async () => {
    const before = (await storage.instances.list()).length;
    expect(
      await caught(() => create(user('admin', 'admin'), { caFile: '/etc/ssl/anything.pem' })),
    ).toBeInstanceOf(ForbiddenError);
    expect(await caught(() => create(user('admin', 'admin'), {}))).toBeInstanceOf(ForbiddenError);
    expect((await storage.instances.list()).length).toBe(before);
    expect((await create(user('admin', 'admin'), undefined)).tls).toBeNull();
    expect((await create(user('admin', 'admin', false), null)).label).toBe('Second');
  });

  it('fix: an owner needs a recent sign-in to set it; the break-glass token is exempt', async () => {
    const before = (await storage.instances.list()).length;
    const stale = await caught(() => create(user('owner', 'owner', false), { caFile: '/ca.pem' }));
    expect(stale).toBeInstanceOf(ReauthRequiredError);
    expect((await storage.instances.list()).length).toBe(before);
    expect((await create(user('owner', 'owner'), { caFile: '/ca.pem' })).tls).toEqual({ caFile: '/ca.pem' });
    expect((await create(BREAK_GLASS, { caFile: '/other.pem' })).tls).toEqual({ caFile: '/other.pem' });
  });
});

describe('pass-through needs a recent sign-in, like every other widening of who may read', () => {
  const body = { slug: 'open', name: 'Open', instanceId: '', allowedScopeIds: ['Scope:1'] };
  const make = (actor: Actor) =>
    guard(actor).workspaces.create({
      ...body,
      instanceId: ids['instance'] as string,
      credentialSource: 'passthrough',
    });

  it('fix: an owner with an old sign-in is sent to sign in again, on create and on update', async () => {
    expect(await caught(() => make(user('owner', 'owner', false)))).toBeInstanceOf(ReauthRequiredError);
    expect(await storage.workspaces.getBySlug('open')).toBeNull();
    const stale = await caught(() =>
      guard(user('owner', 'owner', false)).workspaces.update(ids['plain'] as string, {
        credentialSource: 'passthrough',
      }),
    );
    expect(stale).toBeInstanceOf(ReauthRequiredError);
    expect((await storage.workspaces.get(ids['plain'] as string))?.credentialSource).toBe('stored');
  });

  it('holds: an admin is refused, an owner with a recent sign-in and the token may, and going back needs nothing', async () => {
    expect(await caught(() => make(user('admin', 'admin')))).toBeInstanceOf(ForbiddenError);
    expect((await make(user('owner', 'owner'))).credentialSource).toBe('passthrough');
    const back = await guard(user('admin', 'admin', false)).workspaces.update(
      (await storage.workspaces.getBySlug('open'))?.id as string,
      { credentialSource: 'stored' },
    );
    expect(back.credentialSource).toBe('stored');
    expect(
      (
        await guard(BREAK_GLASS).workspaces.update(ids['plain'] as string, {
          credentialSource: 'passthrough',
        })
      ).credentialSource,
    ).toBe('passthrough');
  });
});

describe('where an owner enabled writes, the owners decide where they may land (ADR-0013)', () => {
  const ws = (actor: Actor, patch: Record<string, unknown>) =>
    guard(actor).workspaces.update(ids['writes'] as string, patch as never);
  const stored = () => storage.workspaces.get(ids['writes'] as string);

  it('fix: an admin cannot add a project, child projects or an asset type to a workspace that has write tools', async () => {
    const before = JSON.stringify(await stored());
    const widenings: Array<[string, Record<string, unknown>]> = [
      ['a new project', { allowedScopeIds: ['Scope:1', 'Scope:2', 'Scope:3'] }],
      ['another project instead', { allowedScopeIds: ['Scope:9'] }],
      ['child projects', { includeChildScopes: true }],
      ['a new allowed type', { assetTypes: { allow: ['Story', 'Defect', 'Task'], deny: ['Epic'] } }],
      ['no allow list', { assetTypes: { deny: ['Epic'] } }],
      ['a shorter deny list', { assetTypes: { allow: ['Story', 'Defect'], deny: [] } }],
      ['no policy', { assetTypes: null }],
    ];
    for (const [name, patch] of widenings) {
      expect(await caught(() => ws(user('admin', 'admin'), patch)), name).toBeInstanceOf(ForbiddenError);
    }
    expect(JSON.stringify(await stored())).toBe(before);
  });

  it('fix: an owner needs a recent sign-in for it; with one, or with the token, it works', async () => {
    const patch = { allowedScopeIds: ['Scope:1', 'Scope:2', 'Scope:3'] };
    expect(await caught(() => ws(user('owner', 'owner', false), patch))).toBeInstanceOf(ReauthRequiredError);
    expect((await stored())?.allowedScopeIds).toEqual(['Scope:1', 'Scope:2']);
    expect((await ws(user('owner', 'owner'), patch)).allowedScopeIds).toContain('Scope:3');
    expect((await ws(BREAK_GLASS, { allowedScopeIds: ['Scope:1'] })).allowedScopeIds).toEqual(['Scope:1']);
  });

  it('holds: an admin may narrow, repeat what is there in another order, or change anything else', async () => {
    const a = user('admin', 'admin', false);
    expect((await ws(a, { allowedScopeIds: ['Scope:2'] })).allowedScopeIds).toEqual(['Scope:2']);
    expect(
      (await ws(a, { allowedScopeIds: ['Scope:2', 'Scope:2'], includeChildScopes: false })).allowedScopeIds,
    ).toEqual(['Scope:2']);
    expect((await ws(a, { assetTypes: { allow: ['Defect'], deny: ['Epic', 'Task'] } })).assetTypes).toEqual({
      allow: ['Defect'],
      deny: ['Epic', 'Task'],
    });
    expect((await ws(a, { name: 'Renamed', limits: { maxRows: 50 } })).name).toBe('Renamed');
  });

  it("holds: a workspace without write tools stays an administrator's to widen", async () => {
    const wide = await guard(user('admin', 'admin', false)).workspaces.update(ids['plain'] as string, {
      allowedScopeIds: ['Scope:1', 'Scope:2'],
      includeChildScopes: true,
      assetTypes: null,
    });
    expect(wide.allowedScopeIds).toEqual(['Scope:1', 'Scope:2']);
  });
});

describe('a grant an owner gave write tools keeps the projects, types and end date the owner chose', () => {
  const grant = (actor: Actor, patch: Record<string, unknown>) =>
    guard(actor).grants.update(ids['writeGrant'] as string, patch as never);
  const stored = () => storage.grants.get(ids['writeGrant'] as string);

  it('fix: an admin cannot add a project, drop the project list, add a type or extend the end date', async () => {
    const before = JSON.stringify(await stored());
    const widenings: Array<[string, Record<string, unknown>]> = [
      ['a new project', { scopeIds: ['Scope:1', 'Scope:2'] }],
      ['every project of the workspace', { scopeIds: null }],
      ['a new type', { assetTypes: { allow: ['Story', 'Task'] } }],
      ['no type policy', { assetTypes: null }],
      ['a later end', { expiresAt: 2_100_000_000_000 }],
      ['no end', { expiresAt: null }],
    ];
    for (const [name, patch] of widenings) {
      expect(await caught(() => grant(user('admin', 'admin'), patch)), name).toBeInstanceOf(ForbiddenError);
    }
    expect(JSON.stringify(await stored())).toBe(before);
  });

  it('fix: an owner needs a recent sign-in for it', async () => {
    expect(
      await caught(() => grant(user('owner', 'owner', false), { scopeIds: ['Scope:1', 'Scope:2'] })),
    ).toBeInstanceOf(ReauthRequiredError);
    expect(
      (await grant(user('owner', 'owner'), { scopeIds: ['Scope:1', 'Scope:2'] })).record.scopeIds,
    ).toEqual(['Scope:1', 'Scope:2']);
  });

  it('holds: narrowing, an earlier end and unrelated changes stay with an administrator', async () => {
    const a = user('admin', 'admin', false);
    expect((await grant(a, { expiresAt: 1_900_000_000_000 })).record.expiresAt).toBe(1_900_000_000_000);
    expect((await grant(a, { label: 'laptop', limits: { maxRows: 10 } })).record.label).toBe('laptop');
    expect((await grant(a, { scopeIds: ['Scope:1'] })).record.scopeIds).toEqual(['Scope:1']);
  });

  it("holds: a grant without write tools is still an administrator's to widen", async () => {
    const wider = await guard(user('admin', 'admin', false)).grants.update(ids['plainGrant'] as string, {
      scopeIds: null,
    });
    expect(wider.record.scopeIds).toBeNull();
  });
});

describe('device tokens that outlive the default need a recent sign-in', () => {
  const issue = (actor: Actor, expiresInDays?: number | 'never') =>
    guard(actor).tokens.issue({
      grantId: ids['writeGrant'] as string,
      label: 'persist',
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
    });
  const live = async () =>
    (await storage.accessTokens.list({ grantId: ids['writeGrant'] as string })).filter(
      (t) => t.revokedAt === null,
    );

  it('fix: a member with an old sign-in cannot mint a token that never expires or lasts more than 90 days', async () => {
    const stale = user('alice', 'member', false);
    expect(await caught(() => issue(stale, 'never'))).toBeInstanceOf(ReauthRequiredError);
    expect(await caught(() => issue(stale, 91))).toBeInstanceOf(ReauthRequiredError);
    expect(await caught(() => issue(stale, 3650))).toBeInstanceOf(ReauthRequiredError);
    expect(await live()).toHaveLength(0);
  });

  it('holds: the default and shorter lifetimes stay open to an old session; a recent sign-in may choose any', async () => {
    const stale = user('alice', 'member', false);
    expect((await issue(stale)).record.expiresAt).not.toBeNull();
    expect((await issue(stale, 90)).record.label).toBe('persist');
    expect((await issue(stale, 7)).record.label).toBe('persist');
    expect((await issue(user('alice', 'member'), 'never')).record.expiresAt).toBeNull();
    expect((await issue(user('alice', 'member'), 365)).record.label).toBe('persist');
    // The break-glass token is nobody's session: exempt (and not the grant's person either: a shared grant).
    const shared = await guard(BREAK_GLASS).tokens.issue({
      grantId: ids['plainGrant'] as string,
      label: 'ci',
      expiresInDays: 'never',
    });
    expect(shared.record.expiresAt).toBeNull();
  });
});

describe("a token issued while its grant moves to someone's personal token does not survive (L-065, a race)", () => {
  it("fix: an administrator's token inserted after the member switched the grant is revoked, and nothing is issued", async () => {
    // The grant starts on the workspace's shared default, so an administrator may issue on it.
    const aliceGrant = (
      await svc.grants.create({
        workspaceId: ids['plain'] as string,
        userId: ids['alice'] as string,
        tools: ['whoami'],
        scopeIds: ['Scope:1'],
      })
    ).record.id;
    // Between the administrator's check and the insert, Alice points the grant at her own token.
    const real = storage.accessTokens.create.bind(storage.accessTokens);
    let switched = false;
    storage.accessTokens.create = async (row) => {
      if (!switched) {
        switched = true;
        await guard(user('alice', 'member')).me.setGrantCredential(aliceGrant, ids['aliceKey'] as string);
      }
      return real(row);
    };
    const outcome = await caught(() =>
      guard(user('admin', 'admin')).tokens.issue({ grantId: aliceGrant, label: 'sneaky' }),
    );
    expect(outcome).toBeInstanceOf(ConflictError);
    const tokens = await storage.accessTokens.list({ grantId: aliceGrant });
    expect(tokens.filter((t) => t.revokedAt === null)).toHaveLength(0);
    expect((await storage.grants.get(aliceGrant))?.credentialId).toBe(ids['aliceKey']);
  });

  it('holds: without a switch the token is issued, and the owner of the personal token may issue on it', async () => {
    const aliceGrant = (
      await svc.grants.create({
        workspaceId: ids['plain'] as string,
        userId: ids['alice'] as string,
        tools: ['whoami'],
      })
    ).record.id;
    expect(
      (await guard(user('admin', 'admin')).tokens.issue({ grantId: aliceGrant, label: 'ok' })).record.label,
    ).toBe('ok');
    await guard(user('alice', 'member')).me.setGrantCredential(aliceGrant, ids['aliceKey'] as string);
    expect(
      (await guard(user('alice', 'member')).tokens.issue({ grantId: aliceGrant, label: 'mine' })).record
        .label,
    ).toBe('mine');
    expect(
      await caught(() => guard(user('admin', 'admin')).tokens.issue({ grantId: aliceGrant, label: 'no' })),
    ).toBeInstanceOf(ForbiddenError);
  });
});

describe('a validation that started before a token replacement cannot vouch for the new token', () => {
  it('fix: the late answer for the old token is dropped, so the new one keeps the result of its own check', async () => {
    const oldToken = secret('Old');
    const newToken = secret('New');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validator = {
      probe: async () => ({ ok: true as const, fingerprint: null }),
      validate: async (_instance: unknown, _id: string, token: string) => {
        if (token !== oldToken)
          return { status: 'invalid' as const, code: 'AB_AGILITY_AUTH', message: 'refused' };
        await gate; // the answer for the old token arrives late
        return {
          status: 'valid' as const,
          memberOid: 'Member:20',
          memberName: 'Old Owner',
          memberUsername: 'old',
          reachableScopeIds: ['Scope:1'],
        };
      },
    };
    const keyring = await Keyring.create(generateMasterKey(1));
    const plain = accessServices({ storage, keyring, tools: TOOLS });
    const racing = accessServices({ storage, keyring, tools: TOOLS, validator: validator as never });
    const made = await plain.credentials.create({
      instanceId: ids['instance'] as string,
      ownerUserId: ids['bob'] as string,
      label: 'racing',
      token: oldToken,
    });
    const late = racing.credentials.validate(made.id); // reads the old token, then waits at the gate
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replaced = await racing.credentials.replaceToken(made.id, newToken); // its own check: refused
    expect(replaced.validationStatus).toBe('invalid');
    release();
    await late;
    const after = await storage.credentials.get(made.id);
    expect(after?.validationStatus).toBe('invalid');
    expect(after?.memberName).toBeNull();
  });
});
