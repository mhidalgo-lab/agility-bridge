// SPDX-License-Identifier: Apache-2.0
// Domain services: the rules every writer shares (P2-04, ADR-0008, L-065, THREAT_MODEL A5, A14).
import {
  ConflictError,
  createMemoryStorage,
  InvalidInputError,
  NotFoundError,
  type Storage,
} from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AccessServices,
  accessServices,
  generateMasterKey,
  Keyring,
  loadAccessRecords,
  openCredentialToken,
  resolveAccess,
} from '../src/index.ts';
import { NOW, SETTINGS, TOOLS, token } from './helpers/access.ts';

const TOKEN_A = '1.AliceTokenNotRealAbCdEfGhIjKlMnOpQrStUv0001';
const TOKEN_B = '1.BobTokenNotRealAbCdEfGhIjKlMnOpQrStUvWx0002';
const TOKEN_S = '1.ServiceTokenNotRealAbCdEfGhIjKlMnOpQrSt0003';

let storage: Storage;
let keyring: Keyring;
let svc: AccessServices;
let n: number;

async function world() {
  const alice = await svc.users.create({ email: ' Alice@Example.TEST ', role: 'member' });
  const bob = await svc.users.create({ email: 'bob@example.test', role: 'member' });
  const inst = await svc.instances.create({ label: 'Main', baseUrl: 'https://Agility.Example.test/Main/' });
  const other = await svc.instances.create({ label: 'Other', baseUrl: 'https://agility.example.test/Other' });
  const shared = await svc.credentials.create({
    instanceId: inst.id,
    ownerUserId: null,
    label: 'svc',
    token: TOKEN_S,
  });
  const aliceCred = await svc.credentials.create({
    instanceId: inst.id,
    ownerUserId: alice.id,
    label: 'a',
    token: TOKEN_A,
  });
  const bobCred = await svc.credentials.create({
    instanceId: inst.id,
    ownerUserId: bob.id,
    label: 'b',
    token: TOKEN_B,
  });
  const otherShared = await svc.credentials.create({
    instanceId: other.id,
    ownerUserId: null,
    label: 'o',
    token: TOKEN_S,
  });
  for (const c of [shared, aliceCred, bobCred, otherShared]) {
    await storage.credentials.update(c.id, { validationStatus: 'valid', validatedAt: NOW });
  }
  const ws = await svc.workspaces.create({
    slug: 'team-a',
    name: 'Team A',
    instanceId: inst.id,
    allowedScopeIds: ['Scope:1001', 'Scope:1002'],
    includeChildScopes: true,
    defaultCredentialId: shared.id,
    limits: { maxRows: 200 },
    enabledTools: ['whoami', 'query_assets', 'add_comment'],
    writePolicy: { enabled: true },
  });
  return { alice, bob, inst, other, shared, aliceCred, bobCred, otherShared, ws };
}

beforeEach(async () => {
  storage = createMemoryStorage({ now: () => NOW });
  keyring = await Keyring.create(generateMasterKey(1));
  n = 0;
  svc = accessServices({ storage, keyring, tools: TOOLS, now: () => NOW, newId: (p) => `${p}_${++n}` });
});

describe('instances', () => {
  it('stores canonical URLs and refuses non-HTTPS or credentialed ones', async () => {
    const i = await svc.instances.create({ label: 'x', baseUrl: 'https://Agility.Example.test/Main/' });
    expect(i.baseUrl).toBe('https://agility.example.test/Main');
    for (const baseUrl of [
      'http://agility.example.test/x',
      'https://user:pw@agility.example.test/x',
      'not a url',
    ]) {
      await expect(svc.instances.create({ label: 'x', baseUrl })).rejects.toThrow(InvalidInputError);
    }
  });

  it('changes the origin only through a retarget, which revokes the credentials and grants first (A14)', async () => {
    const w = await world();
    await expect(
      svc.instances.update(w.inst.id, { baseUrl: 'https://evil.example.test' } as never),
    ).rejects.toThrow(InvalidInputError);
    const { record: g } = await svc.grants.create({
      workspaceId: w.ws.id,
      userId: w.alice.id,
      credentialId: w.aliceCred.id,
    });
    const result = await svc.instances.retarget(w.inst.id, { baseUrl: 'https://new.example.test/Main' });
    expect(result).toMatchObject({ revokedCredentials: 3, revokedGrants: 1 });
    expect(result.instance.baseUrl).toBe('https://new.example.test/Main');
    expect((await storage.credentials.get(w.aliceCred.id))?.revokedAt).toBe(NOW);
    expect((await storage.grants.get(g.id))?.revokedAt).toBe(NOW);
    expect((await storage.credentials.get(w.otherShared.id))?.revokedAt).toBeNull();
  });
});

describe('credentials', () => {
  it('store the token encrypted for its id, with a hint and unvalidated', async () => {
    const w = await world();
    const c = await svc.credentials.create({
      instanceId: w.inst.id,
      ownerUserId: w.alice.id,
      label: 'new',
      token: TOKEN_A,
    });
    expect(c).toMatchObject({ validationStatus: 'unvalidated', tokenHint: '0001', keyVersion: 1 });
    expect(JSON.stringify(c).includes(TOKEN_A)).toBe(false);
    expect(await openCredentialToken(keyring, c)).toBe(TOKEN_A);
  });

  it('refuse tokens with spaces or control characters, and disabled or missing instances', async () => {
    const w = await world();
    for (const token of ['', 'two words', `line\nbreak`, 'x'.repeat(4_001)]) {
      await expect(
        svc.credentials.create({ instanceId: w.inst.id, ownerUserId: null, label: 'x', token }),
      ).rejects.toThrow(InvalidInputError);
    }
    await expect(
      svc.credentials.create({ instanceId: 'ins_404', ownerUserId: null, label: 'x', token: TOKEN_S }),
    ).rejects.toThrow(NotFoundError);
  });

  it('replacing a token makes the credential unvalidated before the new token is stored', async () => {
    const w = await world();
    const replaced = await svc.credentials.replaceToken(w.aliceCred.id, TOKEN_B);
    expect(replaced).toMatchObject({ validationStatus: 'unvalidated', validatedAt: null, tokenHint: '0002' });
    expect(await openCredentialToken(keyring, replaced)).toBe(TOKEN_B);
    await svc.credentials.revoke(w.aliceCred.id);
    await expect(svc.credentials.replaceToken(w.aliceCred.id, TOKEN_A)).rejects.toThrow(ConflictError);
  });
});

describe('workspaces', () => {
  it('validate projects, tools, asset types, limits and write policy', async () => {
    const w = await world();
    const base = { slug: 'b', name: 'B', instanceId: w.inst.id, allowedScopeIds: ['Scope:1'] };
    const bad = [
      { allowedScopeIds: [] },
      { allowedScopeIds: ['Epic:1'] },
      { enabledTools: ['no_such_tool'] },
      { enabledTools: ['Bad Name'] },
      { assetTypes: { allow: ['Story; DROP'] } },
      { assetTypes: { only: ['Story'] } },
      { limits: { maxRows: 5_000 } },
      { limits: { maxRows: 'all' } },
      { limits: { unknownLimit: 1 } },
      { writePolicy: { enabled: 'yes' } },
    ];
    for (const patch of bad) {
      await expect(
        svc.workspaces.create({ ...base, ...patch } as never),
        JSON.stringify(patch),
      ).rejects.toThrow(InvalidInputError);
      await expect(svc.workspaces.update(w.ws.id, patch as never), JSON.stringify(patch)).rejects.toThrow(
        InvalidInputError,
      );
    }
    // The storage rules apply too: a personal credential is never a workspace default.
    await expect(svc.workspaces.create({ ...base, defaultCredentialId: w.aliceCred.id })).rejects.toThrow(
      InvalidInputError,
    );
    const ok = await svc.workspaces.create({
      ...base,
      allowedScopeIds: ['Scope:1', 'Scope:1'],
      limits: { maxRows: 50 },
    });
    expect(ok).toMatchObject({ allowedScopeIds: ['Scope:1'], includeChildScopes: false, enabledTools: null });
  });
});

describe('grants: the token policy (ADR-0008)', () => {
  it("never uses another user's personal credential, nor one of another instance (L-065)", async () => {
    const w = await world();
    await expect(
      svc.grants.create({ workspaceId: w.ws.id, userId: w.alice.id, credentialId: w.bobCred.id }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      svc.grants.create({ workspaceId: w.ws.id, userId: w.alice.id, credentialId: w.otherShared.id }),
    ).rejects.toThrow(InvalidInputError);
    const { record } = await svc.grants.create({
      workspaceId: w.ws.id,
      userId: w.alice.id,
      credentialId: w.aliceCred.id,
    });
    await expect(svc.grants.update(record.id, { credentialId: w.bobCred.id })).rejects.toThrow(
      InvalidInputError,
    );
  });

  it("gives write tools only with the user's own credential: never shared, never to a service grant", async () => {
    const w = await world();
    await expect(
      svc.grants.create({ workspaceId: w.ws.id, userId: w.alice.id, tools: ['whoami', 'add_comment'] }),
    ).rejects.toThrow(/Shared credentials are for read-only grants/);
    await expect(
      svc.grants.create({ workspaceId: w.ws.id, userId: null, label: 'bot', tools: ['add_comment'] }),
    ).rejects.toThrow(InvalidInputError);
    const { record } = await svc.grants.create({
      workspaceId: w.ws.id,
      userId: w.alice.id,
      credentialId: w.aliceCred.id,
      tools: ['whoami', 'add_comment'],
    });
    await expect(svc.grants.update(record.id, { credentialId: null })).rejects.toThrow(/read-only grants/);
  });

  it('refuses projects outside the workspace and warns about access that will not be effective', async () => {
    const w = await world();
    await expect(
      svc.grants.create({ workspaceId: w.ws.id, userId: w.alice.id, scopeIds: ['Scope:9999'] }),
    ).rejects.toThrow(/not projects of the workspace/);
    const { warnings } = await svc.grants.create({
      workspaceId: w.ws.id,
      userId: w.alice.id,
      tools: ['whoami', 'list_teams'],
      limits: { maxRows: 500 },
    });
    expect(warnings).toEqual([
      'The workspace does not enable list_teams.',
      "limits.maxRows (500) is above the workspace's (200); the workspace's applies.",
    ]);
  });

  it('a grant made through the services resolves end to end', async () => {
    const w = await world();
    const { record } = await svc.grants.create({
      workspaceId: w.ws.id,
      userId: w.alice.id,
      credentialId: w.aliceCred.id,
      tools: ['whoami', 'query_assets', 'add_comment'],
      scopeIds: ['Scope:1002'],
    });
    const d = resolveAccess(
      { kind: 'device_token', token: token({ grantId: record.id }) },
      'team-a',
      await loadAccessRecords(storage, record.id),
      SETTINGS,
      NOW,
    );
    expect(d.ok && d.access).toMatchObject({
      tools: ['whoami', 'query_assets', 'add_comment'],
      writeTools: ['add_comment'],
      projects: { allowed: ['Scope:1002'], includeChildren: true },
      credential: { id: w.aliceCred.id, kind: 'personal' },
      limits: { maxRows: 200 },
    });
    expect(await loadAccessRecords(storage, 'grt_404')).toEqual({
      grant: null,
      workspace: null,
      instance: null,
      credential: null,
      user: null,
    });
  });
});
