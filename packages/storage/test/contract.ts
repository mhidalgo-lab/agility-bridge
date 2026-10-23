// SPDX-License-Identifier: Apache-2.0
// The Storage contract suite (ADR-0006): every adapter (memory, SQLite, D1) must pass it unchanged.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  ReadOnlyStorageError,
  readOnlyStorage,
  STATS_SCAN_CAP,
  type Storage,
} from '../src/index.ts';

export interface TestClock {
  now: () => number;
  set(ms: number): void;
  advance(ms: number): void;
}

export function testClock(start = 1_760_000_000_000): TestClock {
  let t = start;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export type StorageFactory = (clock: TestClock) => Promise<Storage>;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** Builds the common graph: two instances, users, shared and personal credentials, a workspace. */
async function seed(s: Storage) {
  const owner = await s.users.create({ id: 'u-owner', email: 'owner@example.test', role: 'owner' });
  const alice = await s.users.create({ id: 'u-alice', email: 'alice@example.test', role: 'member' });
  const bob = await s.users.create({ id: 'u-bob', email: 'bob@example.test', role: 'member' });
  const inst = await s.instances.create({
    id: 'i-1',
    label: 'Main',
    baseUrl: 'https://agility.example.test/Main',
  });
  const other = await s.instances.create({
    id: 'i-2',
    label: 'Other',
    baseUrl: 'https://agility.example.test/Other',
  });
  const cred = (id: string, instanceId: string, ownerUserId: string | null) =>
    s.credentials.create({
      id,
      instanceId,
      ownerUserId,
      label: id,
      tokenCiphertext: 'Y2lwaGVy',
      tokenIv: 'aXY',
      keyVersion: 1,
      tokenHint: 'wxyz',
    });
  const shared = await cred('c-shared', 'i-1', null);
  const sharedOther = await cred('c-shared-other', 'i-2', null);
  const aliceCred = await cred('c-alice', 'i-1', 'u-alice');
  const bobCred = await cred('c-bob', 'i-1', 'u-bob');
  const ws = await s.workspaces.create({
    id: 'w-1',
    slug: 'team-a',
    name: 'Team A',
    instanceId: 'i-1',
    allowedScopeIds: ['Scope:1001'],
    defaultCredentialId: 'c-shared',
  });
  return { owner, alice, bob, inst, other, shared, sharedOther, aliceCred, bobCred, ws };
}

export function storageContract(name: string, factory: StorageFactory): void {
  describe(`Storage contract: ${name}`, () => {
    let s: Storage;
    let clock: TestClock;

    beforeEach(async () => {
      clock = testClock();
      s = await factory(clock);
      return () => s.close();
    });

    describe('users', () => {
      it('creates with defaults and timestamps, reads back, and misses as null', async () => {
        const u = await s.users.create({ id: 'u1', email: 'a@example.test', role: 'admin' });
        expect(u).toEqual({
          id: 'u1',
          email: 'a@example.test',
          displayName: null,
          idp: null,
          idpSubject: null,
          role: 'admin',
          createdAt: clock.now(),
          updatedAt: clock.now(),
          disabledAt: null,
        });
        expect(await s.users.get('u1')).toEqual(u);
        expect(await s.users.get('nope')).toBeNull();
        expect(await s.users.getByEmail('A@EXAMPLE.TEST')).toEqual(u);
        expect(await s.users.getByEmail('b@example.test')).toBeNull();
      });

      it('refuses bad values, unknown and server-owned fields', async () => {
        await expect(s.users.create({ id: 'u1', email: 'A@example.test', role: 'member' })).rejects.toThrow(
          InvalidInputError,
        );
        await expect(s.users.create({ id: 'u1', email: 'no-at-sign', role: 'member' })).rejects.toThrow(
          InvalidInputError,
        );
        await expect(
          s.users.create({ id: 'u1', email: 'a@example.test', role: 'root' as never }),
        ).rejects.toThrow(InvalidInputError);
        await expect(
          s.users.create({ id: 'u1', email: 'a@example.test', role: 'member', idp: 'google' }),
        ).rejects.toThrow(InvalidInputError);
        await expect(
          s.users.create({ id: 'u1', email: 'a@example.test', role: 'member', extra: 1 } as never),
        ).rejects.toThrow(InvalidInputError);
        await expect(
          s.users.create({ id: 'u1', email: 'a@example.test', role: 'member', createdAt: 5 } as never),
        ).rejects.toThrow(InvalidInputError);
        await expect(s.users.create({ id: '', email: 'a@example.test', role: 'member' })).rejects.toThrow(
          InvalidInputError,
        );
        expect(await s.users.list()).toEqual([]);
      });

      it('keeps ids, emails and identities unique', async () => {
        await s.users.create({
          id: 'u1',
          email: 'a@example.test',
          role: 'member',
          idp: 'google',
          idpSubject: 's1',
        });
        await expect(s.users.create({ id: 'u1', email: 'b@example.test', role: 'member' })).rejects.toThrow(
          ConflictError,
        );
        await expect(s.users.create({ id: 'u2', email: 'a@example.test', role: 'member' })).rejects.toThrow(
          ConflictError,
        );
        await expect(
          s.users.create({
            id: 'u2',
            email: 'b@example.test',
            role: 'member',
            idp: 'google',
            idpSubject: 's1',
          }),
        ).rejects.toThrow(ConflictError);
        await s.users.create({
          id: 'u2',
          email: 'b@example.test',
          role: 'member',
          idp: 'github',
          idpSubject: 's1',
        });
        expect((await s.users.getByIdentity('google', 's1'))?.id).toBe('u1');
        expect(await s.users.getByIdentity('google', 's2')).toBeNull();
        await expect(s.users.update('u2', { email: 'a@example.test' })).rejects.toThrow(ConflictError);
      });

      it('updates patchable fields and updatedAt; refuses missing rows and fixed fields', async () => {
        await s.users.create({ id: 'u1', email: 'a@example.test', role: 'member' });
        clock.advance(1_000);
        const u = await s.users.update('u1', { role: 'admin', displayName: 'Ann' });
        expect(u).toMatchObject({ role: 'admin', displayName: 'Ann', updatedAt: clock.now() });
        expect(u.createdAt).toBe(clock.now() - 1_000);
        await expect(s.users.update('nope', { role: 'admin' })).rejects.toThrow(NotFoundError);
        await expect(s.users.update('u1', { id: 'u9' } as never)).rejects.toThrow(InvalidInputError);
        await expect(s.users.update('u1', { createdAt: 1 } as never)).rejects.toThrow(InvalidInputError);
        await expect(s.users.update('u1', { idp: 'google' })).rejects.toThrow(InvalidInputError);
        expect(await s.users.update('u1', { idp: 'google', idpSubject: 'x' })).toMatchObject({
          idp: 'google',
        });
        await expect(s.users.delete('nope')).rejects.toThrow(NotFoundError);
      });

      it('hands out copies: mutating a returned record changes nothing stored', async () => {
        const u = await s.users.create({ id: 'u1', email: 'a@example.test', role: 'member' });
        u.role = 'owner';
        const ws = await seed(s).then((x) => x.ws);
        ws.allowedScopeIds.push('Scope:666');
        expect((await s.users.get('u1'))?.role).toBe('member');
        expect((await s.workspaces.get('w-1'))?.allowedScopeIds).toEqual(['Scope:1001']);
      });

      it('lists in creation order', async () => {
        await s.users.create({ id: 'u-b', email: 'b@example.test', role: 'member' });
        clock.advance(1);
        await s.users.create({ id: 'u-a', email: 'a@example.test', role: 'member' });
        expect((await s.users.list()).map((u) => u.id)).toEqual(['u-b', 'u-a']);
      });
    });

    describe('binding a first identity (P4-01, L-185)', () => {
      it('binds only an enabled user with no identity, once, and can promote and name it in the same step', async () => {
        await s.users.create({ id: 'u1', email: 'a@example.test', role: 'member' });
        const bound = await s.users.bind('u1', 'google', 'sub-1', { displayName: 'Ann', role: 'admin' });
        expect(bound).toMatchObject({
          id: 'u1',
          idp: 'google',
          idpSubject: 'sub-1',
          displayName: 'Ann',
          role: 'admin',
        });
        expect((await s.users.getByIdentity('google', 'sub-1'))?.id).toBe('u1');
        // Already bound: nothing changes, not even to the same identity.
        expect(await s.users.bind('u1', 'github', 'g-1')).toBeNull();
        expect(await s.users.bind('u1', 'google', 'sub-1')).toBeNull();
        expect(await s.users.get('u1')).toMatchObject({ idp: 'google', idpSubject: 'sub-1', role: 'admin' });
        // Unknown and disabled users do not bind.
        expect(await s.users.bind('nope', 'google', 'sub-2')).toBeNull();
        await s.users.create({ id: 'u2', email: 'b@example.test', role: 'member', disabledAt: 5 });
        expect(await s.users.bind('u2', 'google', 'sub-3')).toBeNull();
        expect(await s.users.get('u2')).toMatchObject({ idp: null, idpSubject: null });
      });

      it('refuses an identity another user holds and unknown patch fields', async () => {
        await s.users.create({ id: 'u1', email: 'a@example.test', role: 'member' });
        await s.users.create({ id: 'u2', email: 'b@example.test', role: 'member' });
        await s.users.bind('u1', 'google', 'sub-1');
        await expect(s.users.bind('u2', 'google', 'sub-1')).rejects.toThrow(ConflictError);
        expect(await s.users.get('u2')).toMatchObject({ idp: null });
        await expect(
          s.users.bind('u2', 'google', 'sub-2', { email: 'x@example.test' } as never),
        ).rejects.toThrow(InvalidInputError);
      });

      it('lets exactly one of several concurrent first sign-ins win', async () => {
        await s.users.create({ id: 'u1', email: 'a@example.test', role: 'member' });
        const results = await Promise.all(
          ['google', 'github', 'oidc:corp', 'cf-access'].map((idp) =>
            s.users.bind('u1', idp, `subject-${idp}`).then(
              (u) => (u === null ? 'lost' : 'won'),
              () => 'error',
            ),
          ),
        );
        expect(results.filter((r) => r === 'won')).toHaveLength(1);
        expect(results.filter((r) => r === 'error')).toHaveLength(0);
        const row = await s.users.get('u1');
        expect(row?.idp).not.toBeNull();
        expect(await s.users.getByIdentity(row?.idp as string, row?.idpSubject as string)).toMatchObject({
          id: 'u1',
        });
      });
    });

    describe('owners and revocation (P2-17 review)', () => {
      it('never leaves zero active owners, even with concurrent changes', async () => {
        await s.users.create({ id: 'o1', email: 'o1@example.test', role: 'owner' });
        await expect(s.users.update('o1', { role: 'admin' })).rejects.toThrow(ConflictError);
        await expect(s.users.update('o1', { disabledAt: 1 })).rejects.toThrow(ConflictError);
        await expect(s.users.delete('o1')).rejects.toThrow(ConflictError);
        await s.users.create({ id: 'o2', email: 'o2@example.test', role: 'owner' });
        const results = await Promise.allSettled([
          s.users.update('o1', { role: 'member' }),
          s.users.update('o2', { role: 'member' }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect((await s.users.list()).filter((u) => u.role === 'owner')).toHaveLength(1);
        // Changes that keep an active owner stay possible.
        await s.users.create({ id: 'm', email: 'm@example.test', role: 'member' });
        await s.users.update('m', { role: 'owner' });
        expect(await s.users.update('m', { displayName: 'x' })).toMatchObject({ role: 'owner' });
      });

      it('a revocation is final for credentials, grants and device tokens', async () => {
        await seed(s);
        await s.grants.create({ id: 'g', workspaceId: 'w-1', userId: 'u-alice' });
        await s.accessTokens.create({
          id: 't',
          grantId: 'g',
          prefix: 'ab_live_Ab12',
          tokenHash: HASH_A,
          label: 'x',
        });
        await s.credentials.update('c-alice', { revokedAt: 5 });
        await s.grants.update('g', { revokedAt: 5 });
        await s.accessTokens.update('t', { revokedAt: 5 });
        await expect(s.credentials.update('c-alice', { revokedAt: null })).rejects.toThrow(ConflictError);
        await expect(s.grants.update('g', { revokedAt: null })).rejects.toThrow(ConflictError);
        await expect(s.accessTokens.update('t', { revokedAt: null })).rejects.toThrow(ConflictError);
        await expect(s.grants.update('g', { revokedAt: 9 })).rejects.toThrow(ConflictError);
        expect(await s.grants.update('g', { label: 'still editable' })).toMatchObject({ revokedAt: 5 });
      });
    });

    describe('instances and credentials', () => {
      it('validates instance URLs and keeps them unique', async () => {
        await expect(s.instances.create({ id: 'i', label: 'x', baseUrl: 'ftp://x.test' })).rejects.toThrow(
          InvalidInputError,
        );
        await s.instances.create({
          id: 'i',
          label: 'x',
          baseUrl: 'https://x.test/A',
          tls: { caFile: 'ca.pem' },
        });
        expect((await s.instances.get('i'))?.tls).toEqual({ caFile: 'ca.pem' });
        await expect(
          s.instances.create({ id: 'j', label: 'y', baseUrl: 'https://x.test/A' }),
        ).rejects.toThrow(ConflictError);
        await expect(
          s.instances.create({ id: 'j', label: 'y', baseUrl: 'https://x.test/B', tls: [] as never }),
        ).rejects.toThrow(InvalidInputError);
      });

      it('freezes the origin and TLS trust while unrevoked credentials exist (THREAT_MODEL A14)', async () => {
        await seed(s);
        await expect(
          s.instances.update('i-1', { baseUrl: 'https://evil.example.test/Main' }),
        ).rejects.toThrow(ConflictError);
        await expect(s.instances.update('i-1', { tls: { caFile: 'evil.pem' } })).rejects.toThrow(
          ConflictError,
        );
        expect(await s.instances.update('i-1', { label: 'Renamed' })).toMatchObject({ label: 'Renamed' });
        expect(
          await s.instances.update('i-1', { baseUrl: 'https://agility.example.test/Main' }),
        ).toMatchObject({
          baseUrl: 'https://agility.example.test/Main',
        });
        for (const id of ['c-shared', 'c-alice', 'c-bob'])
          await s.credentials.update(id, { revokedAt: clock.now() });
        expect(await s.instances.update('i-1', { baseUrl: 'https://new.example.test/Main' })).toMatchObject({
          baseUrl: 'https://new.example.test/Main',
        });
      });

      it('creates credentials with defaults and refuses missing parents, bad hints and secret changes', async () => {
        const { aliceCred } = await seed(s);
        expect(aliceCred).toMatchObject({
          validationStatus: 'unvalidated',
          validationErrorCode: null,
          reachableScopeIds: null,
          revokedAt: null,
        });
        const base = { label: 'x', tokenCiphertext: 'c', tokenIv: 'i', keyVersion: 1, tokenHint: 'abcd' };
        await expect(s.credentials.create({ ...base, id: 'c-x', instanceId: 'i-404' })).rejects.toThrow(
          InvalidInputError,
        );
        await expect(
          s.credentials.create({ ...base, id: 'c-x', instanceId: 'i-1', ownerUserId: 'u-404' }),
        ).rejects.toThrow(InvalidInputError);
        await expect(
          s.credentials.create({ ...base, id: 'c-x', instanceId: 'i-1', tokenHint: 'abcde' }),
        ).rejects.toThrow(InvalidInputError);
        await expect(
          s.credentials.create({ ...base, id: 'c-x', instanceId: 'i-1', keyVersion: 0 }),
        ).rejects.toThrow(InvalidInputError);
        for (const field of ['tokenCiphertext', 'tokenIv', 'keyVersion', 'instanceId', 'ownerUserId']) {
          await expect(s.credentials.update('c-alice', { [field]: 'x' } as never)).rejects.toThrow(
            InvalidInputError,
          );
        }
        const v = await s.credentials.update('c-alice', {
          validationStatus: 'valid',
          memberOid: 'Member:20',
          reachableScopeIds: ['Scope:1001'],
          validatedAt: clock.now(),
        });
        expect(v).toMatchObject({ validationStatus: 'valid', reachableScopeIds: ['Scope:1001'] });
      });

      it('replaces a sealed token only while the row still holds the expected one (rotation CAS)', async () => {
        await seed(s);
        clock.advance(10);
        const before = (await s.credentials.get('c-alice')) as NonNullable<
          Awaited<ReturnType<typeof s.credentials.get>>
        >;
        const expected = { tokenCiphertext: before.tokenCiphertext, tokenIv: before.tokenIv, keyVersion: 1 };
        const next = { tokenCiphertext: 'bmV3', tokenIv: 'bmV3aXY', keyVersion: 2 };
        expect(await s.credentials.replaceSecret('c-alice', expected, next)).toBe(true);
        const after = await s.credentials.get('c-alice');
        expect(after).toMatchObject({ ...next, updatedAt: before.updatedAt, label: before.label });
        // The old ciphertext is gone: a second rotation from it, a stale IV or version, or a missing row do nothing.
        expect(await s.credentials.replaceSecret('c-alice', expected, next)).toBe(false);
        expect(await s.credentials.replaceSecret('c-alice', { ...next, tokenIv: 'other' }, expected)).toBe(
          false,
        );
        expect(await s.credentials.replaceSecret('c-alice', { ...next, keyVersion: 3 }, expected)).toBe(
          false,
        );
        expect(await s.credentials.replaceSecret('c-404', expected, next)).toBe(false);
        await expect(
          s.credentials.replaceSecret('c-alice', next, { ...next, keyVersion: 0 }),
        ).rejects.toThrow(InvalidInputError);
        expect((await s.credentials.list({ keyVersion: 2 })).map((c) => c.id)).toEqual(['c-alice']);
        expect(await s.credentials.list({ keyVersion: 1 })).toHaveLength(3);
        const racers = await Promise.all(
          ['a', 'b', 'c'].map((n) =>
            s.credentials.replaceSecret('c-alice', next, { tokenCiphertext: n, tokenIv: n, keyVersion: 3 }),
          ),
        );
        expect(racers.filter(Boolean)).toHaveLength(1);
      });

      it('lists credentials by instance and owner, null meaning shared', async () => {
        await seed(s);
        const ids = async (f: Parameters<Storage['credentials']['list']>[0]) =>
          (await s.credentials.list(f)).map((c) => c.id).sort();
        expect(await ids({ ownerUserId: null })).toEqual(['c-shared', 'c-shared-other']);
        expect(await ids({ ownerUserId: 'u-alice' })).toEqual(['c-alice']);
        expect(await ids({ instanceId: 'i-2' })).toEqual(['c-shared-other']);
        expect(await ids({})).toHaveLength(4);
      });
    });

    describe('workspaces', () => {
      it('creates with defaults, finds by slug and keeps slugs valid and unique', async () => {
        const { ws } = await seed(s);
        expect(ws).toMatchObject({
          includeChildScopes: false,
          assetTypes: null,
          enabledTools: null,
          limits: {},
          writePolicy: {},
          credentialSource: 'stored',
          disabledAt: null,
        });
        expect(await s.workspaces.getBySlug('team-a')).toEqual(ws);
        expect((await s.workspaces.update('w-1', { credentialSource: 'passthrough' })).credentialSource).toBe(
          'passthrough',
        );
        await expect(s.workspaces.update('w-1', { credentialSource: 'shared' as never })).rejects.toThrow(
          InvalidInputError,
        );
        expect(await s.workspaces.getBySlug('team-b')).toBeNull();
        const base = { name: 'X', instanceId: 'i-1' };
        for (const slug of ['Team', 'a_b', '-a', 'a-', '', 'a'.repeat(64), 'ä']) {
          await expect(s.workspaces.create({ ...base, id: 'w-x', slug })).rejects.toThrow(InvalidInputError);
        }
        await expect(s.workspaces.create({ ...base, id: 'w-2', slug: 'team-a' })).rejects.toThrow(
          ConflictError,
        );
        await expect(
          s.workspaces.create({ ...base, id: 'w-2', slug: 'b', instanceId: 'i-404' }),
        ).rejects.toThrow(InvalidInputError);
        const w2 = await s.workspaces.create({ ...base, id: 'w-2', slug: 'b', includeChildScopes: true });
        expect(w2.includeChildScopes).toBe(true);
        await expect(s.workspaces.update('w-2', { slug: 'team-a' })).rejects.toThrow(ConflictError);
        await expect(s.workspaces.update('w-2', { instanceId: 'i-2' } as never)).rejects.toThrow(
          InvalidInputError,
        );
        expect((await s.workspaces.list({ instanceId: 'i-1' })).map((w) => w.id)).toEqual(['w-1', 'w-2']);
      });

      it('accepts only a shared credential of its own instance as the default', async () => {
        await seed(s);
        const base = { name: 'X', instanceId: 'i-1' };
        for (const defaultCredentialId of ['c-alice', 'c-shared-other', 'c-404']) {
          await expect(
            s.workspaces.create({ ...base, id: 'w-x', slug: 'x', defaultCredentialId }),
          ).rejects.toThrow(InvalidInputError);
          await expect(s.workspaces.update('w-1', { defaultCredentialId })).rejects.toThrow(
            InvalidInputError,
          );
        }
        expect(
          (await s.workspaces.update('w-1', { defaultCredentialId: null })).defaultCredentialId,
        ).toBeNull();
        expect(
          (await s.workspaces.update('w-1', { defaultCredentialId: 'c-shared' })).defaultCredentialId,
        ).toBe('c-shared');
      });
    });

    describe('grants and access tokens', () => {
      it('bundles a token with every record its access reads, as the sequential reads would (P3-02)', async () => {
        await seed(s);
        // What access resolution read before the bundle: one record after the other.
        const sequential = async (hash: string) => {
          const token = await s.accessTokens.getByHash(hash);
          const grant = token === null ? null : await s.grants.get(token.grantId);
          const workspace = grant === null ? null : await s.workspaces.get(grant.workspaceId);
          const user = grant?.userId == null ? null : await s.users.get(grant.userId);
          const instance = workspace === null ? null : await s.instances.get(workspace.instanceId);
          const credentialId =
            grant === null || workspace === null
              ? null
              : (grant.credentialId ?? workspace.defaultCredentialId);
          const credential = credentialId === null ? null : await s.credentials.get(credentialId);
          return { token, grant, workspace, user, instance, credential };
        };
        const token = (id: string, grantId: string, tokenHash: string) =>
          s.accessTokens.create({ id, grantId, prefix: 'ab_live_Ab12', tokenHash, label: id });
        // A member's grant on their own credential, a service grant on the workspace default.
        await s.grants.create({
          id: 'g-own',
          workspaceId: 'w-1',
          userId: 'u-alice',
          credentialId: 'c-alice',
        });
        await s.grants.create({ id: 'g-svc', workspaceId: 'w-1', label: 'bot' });
        await token('t-own', 'g-own', HASH_A);
        await token('t-svc', 'g-svc', HASH_B);
        const hashC = 'c'.repeat(64);
        const hashD = 'd'.repeat(64);
        // A workspace without a default credential, and a revoked token on a disabled workspace.
        await s.workspaces.create({
          id: 'w-2',
          slug: 'team-b',
          name: 'B',
          instanceId: 'i-1',
          allowedScopeIds: ['Scope:1'],
        });
        await s.grants.create({ id: 'g-none', workspaceId: 'w-2', label: 'no credential' });
        await token('t-none', 'g-none', hashC);
        await token('t-revoked', 'g-svc', hashD);
        await s.accessTokens.update('t-revoked', { revokedAt: clock.now() });
        await s.workspaces.update('w-2', { disabledAt: clock.now() });

        for (const hash of [HASH_A, HASH_B, hashC, hashD, 'e'.repeat(64)]) {
          expect(await s.accessTokens.bundleByHash(hash), hash.slice(0, 1)).toEqual(await sequential(hash));
        }
        const own = await s.accessTokens.bundleByHash(HASH_A);
        expect([own.token?.id, own.grant?.id, own.workspace?.id, own.user?.id, own.instance?.id]).toEqual([
          't-own',
          'g-own',
          'w-1',
          'u-alice',
          'i-1',
        ]);
        expect(own.credential?.id).toBe('c-alice');
        expect((await s.accessTokens.bundleByHash(HASH_B)).credential?.id).toBe('c-shared');
        expect((await s.accessTokens.bundleByHash(HASH_B)).user).toBeNull();
        expect((await s.accessTokens.bundleByHash(hashC)).credential).toBeNull();
        expect(await s.accessTokens.bundleByHash('e'.repeat(64))).toEqual({
          token: null,
          grant: null,
          workspace: null,
          user: null,
          instance: null,
          credential: null,
        });
      });

      it('needs a label on service grants', async () => {
        await seed(s);
        await expect(s.grants.create({ id: 'g', workspaceId: 'w-1' })).rejects.toThrow(InvalidInputError);
        const g = await s.grants.create({ id: 'g', workspaceId: 'w-1', label: 'CI bot' });
        expect(g).toMatchObject({
          userId: null,
          credentialId: null,
          tools: null,
          limits: {},
          revokedAt: null,
        });
        await expect(s.grants.update('g', { label: null })).rejects.toThrow(InvalidInputError);
        await expect(s.grants.create({ id: 'g2', workspaceId: 'w-404', label: 'x' })).rejects.toThrow(
          InvalidInputError,
        );
        await expect(s.grants.create({ id: 'g2', workspaceId: 'w-1', userId: 'u-404' })).rejects.toThrow(
          InvalidInputError,
        );
      });

      it("uses only shared credentials or the grant user's own, of the workspace instance", async () => {
        await seed(s);
        const ok = await s.grants.create({
          id: 'g-a',
          workspaceId: 'w-1',
          userId: 'u-alice',
          credentialId: 'c-alice',
        });
        expect(ok.credentialId).toBe('c-alice');
        await s.grants.create({
          id: 'g-a2',
          workspaceId: 'w-1',
          userId: 'u-alice',
          credentialId: 'c-shared',
        });
        // Another user's personal token (L-065), a credential of another instance, a missing one.
        for (const credentialId of ['c-bob', 'c-shared-other', 'c-404']) {
          await expect(
            s.grants.create({ id: 'g-x', workspaceId: 'w-1', userId: 'u-alice', credentialId }),
          ).rejects.toThrow(InvalidInputError);
          await expect(s.grants.update('g-a', { credentialId })).rejects.toThrow(InvalidInputError);
        }
        await expect(
          s.grants.create({ id: 'g-x', workspaceId: 'w-1', label: 'bot', credentialId: 'c-alice' }),
        ).rejects.toThrow(InvalidInputError);
        for (const field of ['workspaceId', 'userId']) {
          await expect(s.grants.update('g-a', { [field]: 'w-1' } as never)).rejects.toThrow(
            InvalidInputError,
          );
        }
        expect((await s.grants.list({ userId: 'u-alice' })).map((g) => g.id)).toEqual(['g-a', 'g-a2']);
        expect((await s.grants.list({ credentialId: 'c-alice' })).map((g) => g.id)).toEqual(['g-a']);
      });

      it('stores token hashes only, unique, and finds tokens by hash', async () => {
        await seed(s);
        await s.grants.create({ id: 'g', workspaceId: 'w-1', userId: 'u-alice' });
        const t = await s.accessTokens.create({
          id: 't1',
          grantId: 'g',
          prefix: 'ab_live_Ab12',
          tokenHash: HASH_A,
          label: 'laptop',
        });
        expect(t).toMatchObject({
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: clock.now(),
        });
        expect(await s.accessTokens.getByHash(HASH_A)).toEqual(t);
        expect(await s.accessTokens.getByHash(HASH_B)).toBeNull();
        const base = { grantId: 'g', prefix: 'ab_live_Ab12', label: 'x' };
        await expect(s.accessTokens.create({ ...base, id: 't2', tokenHash: HASH_A })).rejects.toThrow(
          ConflictError,
        );
        for (const tokenHash of ['A'.repeat(64), 'a'.repeat(63), `ab_live_${'a'.repeat(56)}`]) {
          await expect(s.accessTokens.create({ ...base, id: 't2', tokenHash })).rejects.toThrow(
            InvalidInputError,
          );
        }
        await expect(
          s.accessTokens.create({ ...base, id: 't2', tokenHash: HASH_B, prefix: 'ab_prod' }),
        ).rejects.toThrow(InvalidInputError);
        await expect(
          s.accessTokens.create({ ...base, id: 't2', tokenHash: HASH_B, grantId: 'g-404' }),
        ).rejects.toThrow(InvalidInputError);
        for (const field of ['tokenHash', 'grantId', 'lastUsedAt']) {
          await expect(s.accessTokens.update('t1', { [field]: 'x' } as never)).rejects.toThrow(
            InvalidInputError,
          );
        }
        expect(await s.accessTokens.update('t1', { revokedAt: clock.now() })).toMatchObject({
          revokedAt: clock.now(),
        });
      });

      it('writes lastUsedAt at most once per interval', async () => {
        await seed(s);
        await s.grants.create({ id: 'g', workspaceId: 'w-1', userId: 'u-alice' });
        await s.accessTokens.create({
          id: 't1',
          grantId: 'g',
          prefix: 'ab_test_Ab12',
          tokenHash: HASH_A,
          label: 'x',
        });
        expect(await s.accessTokens.touch('t1', 300_000)).toBe(true);
        expect((await s.accessTokens.get('t1'))?.lastUsedAt).toBe(clock.now());
        clock.advance(299_999);
        expect(await s.accessTokens.touch('t1', 300_000)).toBe(false);
        clock.advance(1);
        expect(await s.accessTokens.touch('t1', 300_000)).toBe(true);
        expect(await s.accessTokens.touch('t-404', 300_000)).toBe(false);
      });
    });

    describe('deletion rules (ARCHITECTURE §4)', () => {
      async function withTokens() {
        await seed(s);
        await s.grants.create({ id: 'g-a', workspaceId: 'w-1', userId: 'u-alice', credentialId: 'c-alice' });
        await s.grants.create({ id: 'g-b', workspaceId: 'w-1', userId: 'u-bob' });
        await s.accessTokens.create({
          id: 't-a',
          grantId: 'g-a',
          prefix: 'ab_live_Ab12',
          tokenHash: HASH_A,
          label: 'a',
        });
        await s.accessTokens.create({
          id: 't-b',
          grantId: 'g-b',
          prefix: 'ab_live_Ab12',
          tokenHash: HASH_B,
          label: 'b',
        });
      }

      it('deleting a grant removes its tokens', async () => {
        await withTokens();
        await s.grants.delete('g-a');
        expect(await s.accessTokens.get('t-a')).toBeNull();
        expect(await s.accessTokens.get('t-b')).not.toBeNull();
        await expect(s.grants.delete('g-a')).rejects.toThrow(NotFoundError);
      });

      it('deleting a workspace removes its grants and their tokens', async () => {
        await withTokens();
        await s.workspaces.delete('w-1');
        expect(await s.grants.list()).toEqual([]);
        expect(await s.accessTokens.list()).toEqual([]);
        expect(await s.workspaces.get('w-1')).toBeNull();
      });

      it('refuses to delete a referenced credential, instance or user', async () => {
        await withTokens();
        await expect(s.credentials.delete('c-alice')).rejects.toThrow(ConflictError); // grant
        await expect(s.credentials.delete('c-shared')).rejects.toThrow(ConflictError); // workspace default
        await expect(s.instances.delete('i-1')).rejects.toThrow(ConflictError);
        await expect(s.instances.delete('i-2')).rejects.toThrow(ConflictError); // a credential
        await expect(s.users.delete('u-alice')).rejects.toThrow(ConflictError);
        await expect(s.users.delete('u-bob')).rejects.toThrow(ConflictError); // credential and grant
        expect(await s.credentials.get('c-alice')).not.toBeNull();
        await s.credentials.delete('c-bob');
        await s.grants.delete('g-b');
        await s.users.delete('u-bob');
        await s.credentials.delete('c-shared-other');
        await s.instances.delete('i-2');
        await expect(s.users.delete('u-owner')).rejects.toThrow(ConflictError); // the last active owner
        expect((await s.users.list()).map((u) => u.id).sort()).toEqual(['u-alice', 'u-owner']);
      });
    });

    describe('audit log', () => {
      const entry = (id: string, ts: number, extra: Record<string, unknown> = {}) => ({
        id,
        ts,
        kind: 'tool_call' as const,
        action: 'query_assets',
        status: 'ok' as const,
        ...extra,
      });

      it('appends, queries newest first with filters and pages', async () => {
        await s.audit.append(
          entry('a1', 100, { workspaceId: 'w-1', assetNumbers: ['B-1'], details: { n: 1 } }),
        );
        await s.audit.append(entry('a2', 200, { workspaceId: 'w-2', status: 'denied', kind: 'auth' }));
        await s.audit.append(entry('a3', 200, { workspaceId: 'w-1', userId: 'u-1' }));
        await s.audit.append(entry('a4', 300, { workspaceId: 'w-1' }));
        const all = await s.audit.query();
        expect(all.map((a) => a.id)).toEqual(['a4', 'a3', 'a2', 'a1']);
        expect(all[3]).toMatchObject({ assetNumbers: ['B-1'], details: { n: 1 }, durationMs: null });
        expect((await s.audit.query({ workspaceId: 'w-1' })).map((a) => a.id)).toEqual(['a4', 'a3', 'a1']);
        expect((await s.audit.query({ status: 'denied' })).map((a) => a.id)).toEqual(['a2']);
        expect((await s.audit.query({ kind: 'auth' })).map((a) => a.id)).toEqual(['a2']);
        expect((await s.audit.query({ userId: 'u-1' })).map((a) => a.id)).toEqual(['a3']);
        expect((await s.audit.query({ from: 200, to: 300 })).map((a) => a.id)).toEqual(['a3', 'a2']);
        const page1 = await s.audit.query({ limit: 2 });
        expect(page1.map((a) => a.id)).toEqual(['a4', 'a3']);
        const last = page1[1] as { ts: number; id: string };
        const page2 = await s.audit.query({ limit: 2, after: { ts: last.ts, id: last.id } });
        expect(page2.map((a) => a.id)).toEqual(['a2', 'a1']);
      });

      it('filters by exact action and combines every filter', async () => {
        await s.audit.append(
          entry('a1', 100, { action: 'get_work_item', userId: 'u-1', workspaceId: 'w-1' }),
        );
        await s.audit.append(
          entry('a2', 200, { action: 'get_work_item', userId: 'u-2', workspaceId: 'w-1' }),
        );
        await s.audit.append(
          entry('a3', 300, { action: 'get_work_item_x', userId: 'u-1', workspaceId: 'w-1' }),
        );
        await s.audit.append(
          entry('a4', 400, { action: 'get_work_item', userId: 'u-1', workspaceId: 'w-2', status: 'error' }),
        );
        const ids = async (q: Parameters<Storage['audit']['query']>[0]) =>
          (await s.audit.query(q)).map((a) => a.id);
        expect(await ids({ action: 'get_work_item' })).toEqual(['a4', 'a2', 'a1']);
        expect(await ids({ action: 'get_work_item', userId: 'u-1' })).toEqual(['a4', 'a1']);
        expect(await ids({ action: 'get_work_item', userId: 'u-1', workspaceId: 'w-1' })).toEqual(['a1']);
        expect(await ids({ action: 'get_work_item', status: 'error', from: 300 })).toEqual(['a4']);
        expect(await ids({ action: "get_work_item' OR '1'='1" })).toEqual([]);
        expect(await ids({ action: 'get_work%' })).toEqual([]);
      });

      it('keyset paging neither repeats nor skips rows inserted between pages', async () => {
        // Equal timestamps exercise the id tie-break; the new rows are the newest and must not shift the next page.
        for (let i = 0; i < 6; i++) await s.audit.append(entry(`k${i}`, i < 4 ? 100 : 200 + i));
        const seen: string[] = [];
        let after: { ts: number; id: string } | undefined;
        for (let round = 0; round < 10; round++) {
          const page = await s.audit.query({ limit: 2, ...(after === undefined ? {} : { after }) });
          if (page.length === 0) break;
          seen.push(...page.map((a) => a.id));
          const last = page[page.length - 1] as { ts: number; id: string };
          after = { ts: last.ts, id: last.id };
          await s.audit.append(entry(`new${round}`, 1_000 + round));
        }
        const old = seen.filter((id) => id.startsWith('k'));
        expect(old).toEqual(['k5', 'k4', 'k3', 'k2', 'k1', 'k0']);
        expect(new Set(seen).size).toBe(seen.length);
      });

      it('stats: aggregates tool calls per group, bounded to the window and the workspace', async () => {
        const call = (id: string, ts: number, extra: Record<string, unknown> = {}) =>
          s.audit.append(entry(id, ts, { workspaceId: 'w-1', grantId: 'g-1', userId: 'u-1', ...extra }));
        const day = 86_400_000;
        const d0 = 20_000 * day;
        await call('s1', d0 + 1_000, { durationMs: 100, agilityRequests: 2 });
        await call('s2', d0 + 2_000, { durationMs: 300, agilityRequests: 1, status: 'error' });
        await call('s3', d0 + 3_000, { action: 'get_work_item', status: 'denied', grantId: 'g-2' });
        await call('s4', d0 + day + 5, { workspaceId: 'w-2', userId: null, grantId: null, durationMs: 50 });
        // Not tool calls: never counted.
        await s.audit.append(entry('x1', d0 + 10, { kind: 'admin', action: 'grant.revoke' }));
        await s.audit.append(
          entry('x2', d0 + 11, { kind: 'auth', action: 'mcp.unauthenticated', status: 'denied' }),
        );

        const byTool = await s.audit.stats({ groupBy: 'tool' });
        expect(byTool.truncated).toBe(false);
        expect(byTool.scanned).toBe(4);
        expect(byTool.rows).toEqual([
          {
            key: 'query_assets',
            calls: 3,
            errors: 1,
            denied: 0,
            agilityRequests: 3,
            durationSumMs: 450,
            durationCount: 3,
            maxDurationMs: 300,
          },
          {
            key: 'get_work_item',
            calls: 1,
            errors: 0,
            denied: 1,
            agilityRequests: 0,
            durationSumMs: 0,
            durationCount: 0,
            maxDurationMs: null,
          },
        ]);
        const byGrant = await s.audit.stats({ groupBy: 'grant' });
        expect(byGrant.rows.map((r) => [r.key, r.calls])).toEqual([
          ['g-1', 2],
          ['g-2', 1],
          [null, 1],
        ]);
        const byUser = await s.audit.stats({ groupBy: 'user' });
        expect(byUser.rows.map((r) => [r.key, r.calls])).toEqual([
          ['u-1', 3],
          [null, 1],
        ]);
        const byWorkspace = await s.audit.stats({ groupBy: 'workspace', limit: 1 });
        expect(byWorkspace.rows.map((r) => [r.key, r.calls])).toEqual([['w-1', 3]]);
        const byDay = await s.audit.stats({ groupBy: 'day' });
        expect(byDay.rows.map((r) => [r.key, r.calls])).toEqual([
          [new Date(d0).toISOString().slice(0, 10), 3],
          [new Date(d0 + day).toISOString().slice(0, 10), 1],
        ]);
        // The window is half open and the workspace filter narrows it.
        expect((await s.audit.stats({ groupBy: 'tool', from: d0 + 2_000, to: d0 + 3_000 })).scanned).toBe(1);
        expect((await s.audit.stats({ groupBy: 'tool', workspaceId: 'w-2' })).rows).toHaveLength(1);
        expect((await s.audit.stats({ groupBy: 'tool', workspaceId: "w-1' OR '1'='1" })).rows).toEqual([]);
        expect((await s.audit.stats({ groupBy: 'tool', from: d0 + 99 * day })).rows).toEqual([]);
      });

      it('stats: refuses unknown groups and bad bounds', async () => {
        await expect(s.audit.stats({ groupBy: 'password' as never })).rejects.toThrow(InvalidInputError);
        await expect(s.audit.stats({ groupBy: 'tool', from: -1 })).rejects.toThrow(InvalidInputError);
        await expect(s.audit.stats({ groupBy: 'tool', limit: 0 })).rejects.toThrow(InvalidInputError);
        expect((await s.audit.stats({ groupBy: 'tool', limit: 1_000_000 })).rows).toEqual([]);
      });

      it('stats: reads at most the newest scanCap rows and says so', async () => {
        expect(STATS_SCAN_CAP).toBe(10_000);
        for (let i = 0; i < 12; i++) await s.audit.append(entry(`c${String(i).padStart(2, '0')}`, 1_000 + i));
        const stats = await s.audit.stats({ groupBy: 'tool', scanCap: 5 });
        expect(stats.scanned).toBe(5);
        expect(stats.truncated).toBe(true);
        expect(stats.rows[0]?.calls).toBe(5);
        // The oldest rows are the ones left out: the window below the newest five holds seven rows.
        expect((await s.audit.stats({ groupBy: 'tool', to: 1_007, scanCap: 5 })).scanned).toBe(5);
        expect((await s.audit.stats({ groupBy: 'tool', to: 1_003 })).truncated).toBe(false);
        expect((await s.audit.stats({ groupBy: 'tool', scanCap: 10_000_000 })).scanned).toBe(12);
        await expect(s.audit.stats({ groupBy: 'tool', scanCap: 0 })).rejects.toThrow(InvalidInputError);
      });

      it('is append-only, validates rows and purges by age in bounded batches', async () => {
        expect('update' in s.audit).toBe(false);
        await expect(s.audit.append(entry('x', 1, { kind: 'other' }))).rejects.toThrow(InvalidInputError);
        await expect(s.audit.append(entry('x', 1, { durationMs: -1 }))).rejects.toThrow(InvalidInputError);
        for (let i = 0; i < 5; i++) await s.audit.append(entry(`a${i}`, i * 10));
        await expect(s.audit.append(entry('a0', 1))).rejects.toThrow(ConflictError);
        expect(await s.audit.purge(35, 2)).toBe(2);
        expect(await s.audit.purge(35)).toBe(2);
        expect(await s.audit.purge(35)).toBe(0);
        expect((await s.audit.query()).map((a) => a.id)).toEqual(['a4']);
      });
    });

    describe('settings', () => {
      it('stores JSON values by key', async () => {
        expect(await s.settings.get('k')).toBeNull();
        expect(await s.settings.set('k', { a: [1, 'x', null, true] })).toEqual({
          key: 'k',
          value: { a: [1, 'x', null, true] },
          updatedAt: clock.now(),
        });
        clock.advance(5);
        await s.settings.set('k', 'v2');
        await s.settings.set('a', 0);
        expect(await s.settings.get('k')).toEqual({ key: 'k', value: 'v2', updatedAt: clock.now() });
        expect((await s.settings.list()).map((x) => x.key)).toEqual(['a', 'k']);
        expect(await s.settings.delete('k')).toBe(true);
        expect(await s.settings.delete('k')).toBe(false);
        await expect(s.settings.set('k', undefined as never)).rejects.toThrow(InvalidInputError);
      });
    });

    describe('kv', () => {
      it('gets, sets and expires', async () => {
        expect(await s.kv.get('k')).toBeNull();
        await s.kv.set('k', 'v', { expiresAt: clock.now() + 10 });
        await s.kv.set('forever', 'f');
        expect(await s.kv.get('k')).toBe('v');
        clock.advance(10);
        expect(await s.kv.get('k')).toBeNull();
        expect(await s.kv.get('forever')).toBe('f');
        await s.kv.set('k', 'v2');
        expect(await s.kv.get('k')).toBe('v2');
        for (const key of ['', 'with space', 'ü', 'x'.repeat(513)]) {
          await expect(s.kv.set(key, 'v')).rejects.toThrow(InvalidInputError);
        }
        await expect(s.kv.set('k', 1 as never)).rejects.toThrow(InvalidInputError);
        await expect(s.kv.set('k', 'v', { expiresAt: 1.5 })).rejects.toThrow(InvalidInputError);
      });

      it('setIfAbsent stores only when absent or expired', async () => {
        expect(await s.kv.setIfAbsent('k', 'first', { expiresAt: clock.now() + 10 })).toBe(true);
        expect(await s.kv.setIfAbsent('k', 'second')).toBe(false);
        expect(await s.kv.get('k')).toBe('first');
        clock.advance(10);
        expect(await s.kv.setIfAbsent('k', 'third')).toBe(true);
        expect(await s.kv.get('k')).toBe('third');
      });

      it('take returns a live value once and never an expired one', async () => {
        await s.kv.set('code', 'secret-state', { expiresAt: clock.now() + 10 });
        expect(await s.kv.take('code')).toBe('secret-state');
        expect(await s.kv.take('code')).toBeNull();
        await s.kv.set('old', 'x', { expiresAt: clock.now() + 1 });
        clock.advance(1);
        expect(await s.kv.take('old')).toBeNull();
        expect(await s.kv.setIfAbsent('old', 'y')).toBe(true);
      });

      it('deletes, lists live keys by prefix and purges expired entries', async () => {
        await s.kv.set('oauth:b', '1');
        await s.kv.set('oauth:a', '1');
        await s.kv.set('oauth:c', '1', { expiresAt: clock.now() + 5 });
        await s.kv.set('oauthx', '1');
        await s.kv.set('other:a', '1', { expiresAt: clock.now() + 5 });
        expect(await s.kv.list('oauth:')).toEqual(['oauth:a', 'oauth:b', 'oauth:c']);
        expect(await s.kv.list('oauth:', { limit: 1 })).toEqual(['oauth:a']);
        expect(await s.kv.list('oauth:', { after: 'oauth:a' })).toEqual(['oauth:b', 'oauth:c']);
        expect(await s.kv.list('')).toHaveLength(5);
        clock.advance(5);
        expect(await s.kv.list('oauth:')).toEqual(['oauth:a', 'oauth:b']);
        expect(await s.kv.delete('oauth:c')).toBe(false); // expired: gone, but nothing live was deleted
        expect(await s.kv.delete('oauth:a')).toBe(true);
        expect(await s.kv.delete('oauth:a')).toBe(false);
        expect(await s.kv.purgeExpired()).toBe(1);
        expect(await s.kv.purgeExpired()).toBe(0);
        expect(await s.kv.list('')).toEqual(['oauth:b', 'oauthx']);
      });

      it('deletes a prefix in one call, live and expired alike, and refuses the empty prefix', async () => {
        await s.kv.set('sess:u1:a', '1');
        await s.kv.set('sess:u1:b', '1', { expiresAt: clock.now() + 5 });
        await s.kv.set('sess:u10:a', '1');
        await s.kv.set('sess-seen:u1:a', '1');
        clock.advance(5);
        expect(await s.kv.deletePrefix('sess:u1:')).toBe(2);
        expect(await s.kv.list('')).toEqual(['sess-seen:u1:a', 'sess:u10:a']);
        expect(await s.kv.deletePrefix('sess:u1:')).toBe(0);
        await expect(s.kv.deletePrefix('')).rejects.toThrow(InvalidInputError);
        await expect(s.kv.deletePrefix('has space')).rejects.toThrow(InvalidInputError);
      });

      it('increments counters atomically with a cap and an expiry window', async () => {
        const window = { expiresAt: clock.now() + 1_000, max: 3 };
        expect(await s.kv.increment('rl', window)).toBe(1);
        expect(await s.kv.increment('rl', { ...window, expiresAt: clock.now() + 99_999 })).toBe(2);
        expect(await s.kv.increment('rl', window)).toBe(3);
        expect(await s.kv.increment('rl', window)).toBeNull();
        expect(await s.kv.get('rl')).toBe('3');
        clock.advance(1_000); // the window (kept from the first increment) ends
        expect(await s.kv.increment('rl', { expiresAt: clock.now() + 1_000, max: 3 })).toBe(1);
        expect(await s.kv.increment('n', { by: 5 })).toBe(5);
        expect(await s.kv.increment('n', { by: 2 })).toBe(7);
        expect(await s.kv.increment('n', { by: 10, max: 5 })).toBeNull();
        expect(await s.kv.get('n')).toBe('7');
        await expect(s.kv.increment('n', { by: 0 })).rejects.toThrow(InvalidInputError);
        await expect(s.kv.increment('n', { by: 1.5 })).rejects.toThrow(InvalidInputError);
      });
    });

    describe('concurrency (L-072, L-073)', () => {
      it('of concurrent takes, exactly one gets the value', async () => {
        await s.kv.set('once', 'v');
        const results = await Promise.all(Array.from({ length: 50 }, () => s.kv.take('once')));
        expect(results.filter((r) => r === 'v')).toHaveLength(1);
        expect(results.filter((r) => r === null)).toHaveLength(49);
      });

      it('of concurrent setIfAbsent calls, exactly one stores', async () => {
        const results = await Promise.all(
          Array.from({ length: 50 }, (_, i) => s.kv.setIfAbsent('lock', `v${i}`)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = results.indexOf(true);
        expect(await s.kv.get('lock')).toBe(`v${winner}`);
      });

      it('concurrent increments neither lose updates nor pass the cap', async () => {
        const all = await Promise.all(Array.from({ length: 100 }, () => s.kv.increment('c')));
        expect([...all].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
          Array.from({ length: 100 }, (_, i) => i + 1),
        );
        const capped = await Promise.all(
          Array.from({ length: 50 }, () => s.kv.increment('capped', { max: 10 })),
        );
        expect(capped.filter((v) => v !== null)).toHaveLength(10);
        expect(await s.kv.get('capped')).toBe('10');
      });

      it('of concurrent touches, exactly one writes', async () => {
        await seed(s);
        await s.grants.create({ id: 'g', workspaceId: 'w-1', userId: 'u-alice' });
        await s.accessTokens.create({
          id: 't',
          grantId: 'g',
          prefix: 'ab_live_Ab12',
          tokenHash: HASH_A,
          label: 'x',
        });
        const results = await Promise.all(
          Array.from({ length: 20 }, () => s.accessTokens.touch('t', 300_000)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('of concurrent creates with one id, exactly one succeeds', async () => {
        const results = await Promise.allSettled(
          Array.from({ length: 20 }, (_, i) =>
            s.users.create({ id: 'same', email: `u${i}@example.test`, role: 'member' }),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictError);
      });
    });

    describe('read-only view', () => {
      it('reads through and refuses every write', async () => {
        await seed(s);
        await s.kv.set('k', 'v');
        const ro = readOnlyStorage(s);
        expect(ro.readOnly).toBe(true);
        expect((await ro.workspaces.getBySlug('team-a'))?.id).toBe('w-1');
        expect(await ro.kv.get('k')).toBe('v');
        const writes = [
          () => ro.users.create({ id: 'x', email: 'x@example.test', role: 'member' }),
          () => ro.users.update('u-alice', { role: 'owner' }),
          () => ro.workspaces.delete('w-1'),
          () => ro.credentials.update('c-alice', { label: 'x' }),
          () =>
            ro.credentials.replaceSecret(
              'c-alice',
              { tokenCiphertext: 'a', tokenIv: 'b', keyVersion: 1 },
              { tokenCiphertext: 'c', tokenIv: 'd', keyVersion: 2 },
            ),
          () => ro.grants.create({ id: 'g', workspaceId: 'w-1', label: 'x' }),
          () => ro.accessTokens.touch('t', 0),
          () => ro.audit.append({ id: 'a', ts: 1, kind: 'admin', action: 'x', status: 'ok' }),
          () => ro.audit.purge(1),
          () => ro.settings.set('k', 1),
          () => ro.kv.take('k'),
          () => ro.kv.increment('c'),
          () => ro.kv.setIfAbsent('n', 'v'),
        ];
        for (const write of writes) await expect(write()).rejects.toThrow(ReadOnlyStorageError);
        expect(await s.kv.get('k')).toBe('v');
        expect((await s.users.get('u-alice'))?.role).toBe('member');
      });
    });
  });
}
