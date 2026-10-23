// SPDX-License-Identifier: Apache-2.0
// Re-authentication in the guards (P4-02, L-093): every high-impact action needs a sign-in from the last ten minutes,
// the break-glass token is exempt, and a refusal changes nothing.
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
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
let guard: (actor: Actor) => ReturnType<typeof guardedServices>;
let ids: {
  owner: string;
  admin: string;
  alice: string;
  instance: string;
  workspace: string;
  cred: string;
  shared: string;
};

beforeEach(async () => {
  storage = createMemoryStorage();
  const keyring = await Keyring.create(generateMasterKey(1));
  const svc = accessServices({ storage, keyring, tools: TOOLS });
  const owner = await svc.users.create({ email: 'o@example.test', role: 'owner' });
  const admin = await svc.users.create({ email: 'a@example.test', role: 'admin' });
  const alice = await svc.users.create({ email: 'm@example.test', role: 'member' });
  const instance = await svc.instances.create({
    label: 'Main',
    baseUrl: 'https://agility.example.test/Main',
  });
  const cred = await svc.credentials.create({
    instanceId: instance.id,
    ownerUserId: alice.id,
    label: 'mine',
    token: '1.AliceTokenNotRealAbCdEfGhIjKlMnOpQrStUv0001',
  });
  const shared = await svc.credentials.create({
    instanceId: instance.id,
    ownerUserId: null,
    label: 'shared',
    token: '1.SharedTokenNotRealAbCdEfGhIjKlMnOpQrStUv0002',
  });
  const workspace = await svc.workspaces.create({
    slug: 'w',
    name: 'W',
    instanceId: instance.id,
    allowedScopeIds: ['Scope:1'],
  });
  ids = {
    owner: owner.id,
    admin: admin.id,
    alice: alice.id,
    instance: instance.id,
    workspace: workspace.id,
    cred: cred.id,
    shared: shared.id,
  };
  guard = (actor) => guardedServices(svc, { storage, tools: TOOLS, keyring }, actor);
});

const owner = (recentAuth: boolean): Actor => ({
  kind: 'user',
  userId: ids.owner,
  role: 'owner',
  recentAuth,
});
const member = (recentAuth: boolean): Actor => ({
  kind: 'user',
  userId: ids.alice,
  role: 'member',
  recentAuth,
});
const BREAK_GLASS: Actor = { kind: 'break_glass' };

const actions: Array<[string, (g: ReturnType<typeof guardedServices>) => Promise<unknown>]> = [
  ['create an admin', (g) => g.users.create({ email: 'n@example.test', role: 'admin' })],
  ['create an owner', (g) => g.users.create({ email: 'n@example.test', role: 'owner' })],
  ['promote a member', (g) => g.users.update(ids.alice, { role: 'admin' })],
  ['demote an admin', (g) => g.users.update(ids.admin, { role: 'member' })],
  ['disable an admin', (g) => g.users.disable(ids.admin)],
  ['clear a sign-in identity', (g) => g.users.unbind(ids.alice, 'm@example.test')],
  [
    'retarget an instance',
    (g) => g.instances.retarget(ids.instance, { baseUrl: 'https://other.example.test/X' }),
  ],
  [
    'replace a credential token',
    (g) => g.credentials.replaceToken(ids.shared, '1.NewTokenNotRealAbCdEfGhIjKlMnOpQrStUv0009'),
  ],
  ['change write settings', (g) => g.workspaces.update(ids.workspace, { writePolicy: { enabled: true } })],
  [
    'enable write tools on a workspace',
    (g) => g.workspaces.update(ids.workspace, { enabledTools: ['add_comment'] }),
  ],
  [
    'create a workspace with write tools',
    (g) =>
      g.workspaces.create({
        slug: 'x',
        name: 'X',
        instanceId: ids.instance,
        allowedScopeIds: ['Scope:1'],
        enabledTools: ['add_comment'],
      }),
  ],
  [
    'grant write tools',
    (g) => g.grants.create({ workspaceId: ids.workspace, userId: ids.alice, tools: ['add_comment'] }),
  ],
  ['create a setup link', async (g) => g.setupLinks.authorize()],
  ['retire a key version', (g) => g.keys.retire(1, 'test')],
];

describe('re-authentication guards', () => {
  for (const [name, run] of actions) {
    it(`${name}: refused without a recent sign-in, with a ReauthRequiredError and no change`, async () => {
      const before = JSON.stringify([
        await storage.users.list(),
        await storage.workspaces.list(),
        await storage.grants.list(),
      ]);
      const error = await run(guard(owner(false))).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(ReauthRequiredError);
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as Error).message).toMatch(/^Sign in again before/);
      expect(
        JSON.stringify([
          await storage.users.list(),
          await storage.workspaces.list(),
          await storage.grants.list(),
        ]),
      ).toBe(before);
    });

    it(`${name}: allowed with a recent sign-in, and for the break-glass token`, async () => {
      for (const actor of [owner(true), BREAK_GLASS]) {
        const error = await run(guard(actor)).catch((e: unknown) => e);
        expect(error instanceof ReauthRequiredError, `${name} as ${actor.kind}`).toBe(false);
      }
    });
  }

  it('asks for the role before the sign-in: a member learns nothing about re-authentication', async () => {
    const error = await guard(member(false))
      .users.create({ email: 'n@example.test', role: 'admin' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).not.toBeInstanceOf(ReauthRequiredError);
  });

  it("a member replacing their own credential also needs a recent sign-in, and not another member's", async () => {
    const error = await guard(member(false))
      .credentials.replaceToken(ids.cred, '1.NewTokenNotRealAbCdEfGhIjKlMnOpQrStUv0009')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReauthRequiredError);
    await expect(
      guard(member(true)).credentials.replaceToken(ids.cred, '1.NewTokenNotRealAbCdEfGhIjKlMnOpQrStUv0009'),
    ).resolves.toBeDefined();
  });

  it('does not ask for it for ordinary changes', async () => {
    const g = guard(owner(false));
    await expect(g.users.create({ email: 'plain@example.test', role: 'member' })).resolves.toBeDefined();
    await expect(g.users.update(ids.alice, { displayName: 'Alice' })).resolves.toBeDefined();
    await expect(g.workspaces.update(ids.workspace, { name: 'Renamed' })).resolves.toBeDefined();
  });

  it('ending sessions: yourself, owners anyone, admins members only, members nobody else', async () => {
    const admin: Actor = { kind: 'user', userId: ids.admin, role: 'admin', recentAuth: false };
    await expect(guard(member(false)).users.authorizeEndSessions(ids.alice)).resolves.toBeDefined();
    await expect(guard(member(false)).users.authorizeEndSessions(ids.owner)).rejects.toThrow(
      /not found|No user/i,
    );
    await expect(guard(admin).users.authorizeEndSessions(ids.alice)).resolves.toBeDefined();
    await expect(guard(admin).users.authorizeEndSessions(ids.admin)).resolves.toBeDefined();
    await expect(guard(admin).users.authorizeEndSessions(ids.owner)).rejects.toThrow(ForbiddenError);
    await expect(guard(owner(false)).users.authorizeEndSessions(ids.admin)).resolves.toBeDefined();
    await expect(guard(BREAK_GLASS).users.authorizeEndSessions(ids.owner)).resolves.toBeDefined();
  });
});
