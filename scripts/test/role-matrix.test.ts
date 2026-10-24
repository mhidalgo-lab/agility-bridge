// SPDX-License-Identifier: Apache-2.0
// Executable documentation (P4-10, L-133): the role matrix in docs/guide/admin-guide.md is run against the real guards.
// Every row of the table marked <!-- role-matrix --> must have a probe here, and for each role the probe's outcome
// ("no", "yes", or "recent" = yes but only with a sign-in from the last 10 minutes) must equal the table's cell. Change a
// guard or a row and this fails.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Actor,
  accessServices,
  ForbiddenError,
  generateMasterKey,
  guardedServices,
  Keyring,
  ReauthRequiredError,
} from '../../packages/auth/src/index.ts';
import { createMemoryStorage, NotFoundError } from '../../packages/storage/src/index.ts';

const TOOLS = new Map([
  ['whoami', { kind: 'read' as const, group: 'core' }],
  ['add_comment', { kind: 'write' as const, group: 'collaboration' }],
]);

type Guarded = ReturnType<typeof guardedServices>;
type Role = 'owner' | 'admin' | 'member';
interface Ids {
  readonly owner: string;
  readonly admin: string;
  readonly member: string;
  readonly admin2: string;
  readonly bob: string;
  readonly carol: string;
  readonly instance: string;
  readonly shared: string;
  readonly workspace: string;
  readonly bobGrant: string;
  /** A workspace and a grant on it that an owner gave write tools (P4-09). */
  readonly writeWorkspace: string;
  readonly writeGrant: string;
}

async function world() {
  const storage = createMemoryStorage();
  const keyring = await Keyring.create(generateMasterKey(1));
  const svc = accessServices({ storage, keyring, tools: TOOLS });
  const mk = async (email: string, role: Role) => (await svc.users.create({ email, role })).id;
  const owner = await mk('owner@example.test', 'owner');
  const admin = await mk('admin@example.test', 'admin');
  const member = await mk('member@example.test', 'member');
  const admin2 = await mk('admin2@example.test', 'admin');
  const bob = await mk('bob@example.test', 'member');
  const carol = await mk('carol@example.test', 'member');
  await storage.users.bind(bob, 'google', 'sub-bob');
  await svc.users.disable(carol);
  const instance = (
    await svc.instances.create({ label: 'Main', baseUrl: 'https://agility.example.test/Main' })
  ).id;
  const shared = (
    await svc.credentials.create({
      instanceId: instance,
      ownerUserId: null,
      label: 'shared',
      token: '1.SharedTokenNotRealAbCdEfGhIjKlMnOpQrStUv0002',
    })
  ).id;
  const workspace = (
    await svc.workspaces.create({ slug: 'w', name: 'W', instanceId: instance, allowedScopeIds: ['Scope:1'] })
  ).id;
  const bobGrant = (
    await svc.grants.create({ workspaceId: workspace, userId: bob, credentialId: shared, tools: ['whoami'] })
  ).record.id;
  const writeWorkspace = (
    await svc.workspaces.create({
      slug: 'wr',
      name: 'Writes',
      instanceId: instance,
      allowedScopeIds: ['Scope:1', 'Scope:2'],
      enabledTools: ['whoami', 'add_comment'],
      writePolicy: { enabled: true },
    })
  ).id;
  const personal = (
    await svc.credentials.create({
      instanceId: instance,
      ownerUserId: bob,
      label: 'bob',
      token: '1.BobTokenNotRealAbCdEfGhIjKlMnOpQrStUv0004',
    })
  ).id;
  const writeGrant = (
    await svc.grants.create({
      workspaceId: writeWorkspace,
      userId: bob,
      credentialId: personal,
      tools: ['whoami', 'add_comment'],
      scopeIds: ['Scope:1'],
    })
  ).record.id;
  const ids: Ids = {
    owner,
    admin,
    member,
    admin2,
    bob,
    carol,
    instance,
    shared,
    workspace,
    bobGrant,
    writeWorkspace,
    writeGrant,
  };
  const actor = (role: Role, recentAuth: boolean): Actor => ({
    kind: 'user',
    userId: ids[role],
    role,
    recentAuth,
  });
  return {
    ids,
    actor,
    guard: (a: Actor): Guarded => guardedServices(svc, { storage, tools: TOOLS, keyring }, a),
  };
}

const PROBES: Record<string, (g: Guarded, i: Ids) => unknown> = {
  'Add a member': (g) => g.users.create({ email: 'n@example.test', role: 'member' }),
  'Add an admin or an owner': (g) => g.users.create({ email: 'n@example.test', role: 'admin' }),
  'Change a role': (g, i) => g.users.update(i.bob, { role: 'admin' }),
  'Disable a member': (g, i) => g.users.disable(i.bob),
  'Disable an admin': (g, i) => g.users.disable(i.admin2),
  'Enable a disabled member': (g, i) => g.users.enable(i.carol),
  "End a member's sessions": (g, i) => g.users.authorizeEndSessions(i.bob),
  "End an admin's sessions": (g, i) => g.users.authorizeEndSessions(i.admin2),
  'Move a user to another provider': (g, i) => g.users.unbind(i.bob, 'bob@example.test'),
  'Add an instance': (g) =>
    g.instances.create({ label: 'Two', baseUrl: 'https://agility2.example.test/Main' }),
  'Add an instance with its own TLS trust': (g) =>
    g.instances.create({
      label: 'Three',
      baseUrl: 'https://agility3.example.test/Main',
      tls: { caFile: '/etc/agility/ca.pem' },
    }),
  "Change an instance's origin": (g, i) =>
    g.instances.retarget(i.instance, { baseUrl: 'https://other.example.test/X' }),
  'Add a shared credential': (g, i) =>
    g.credentials.create({
      instanceId: i.instance,
      ownerUserId: null,
      label: 'second',
      token: '1.SecondTokenNotRealAbCdEfGhIjKlMnOpQrStUv0003',
    }),
  "Replace a shared credential's token": (g, i) =>
    g.credentials.replaceToken(i.shared, '1.NewTokenNotRealAbCdEfGhIjKlMnOpQrStUv0009'),
  'Create a workspace': (g, i) =>
    g.workspaces.create({ slug: 'x', name: 'X', instanceId: i.instance, allowedScopeIds: ['Scope:1'] }),
  'Enable write settings on a workspace': (g, i) =>
    g.workspaces.update(i.workspace, { writePolicy: { enabled: true } }),
  'Make a workspace pass-through': (g, i) =>
    g.workspaces.create({
      slug: 'x',
      name: 'X',
      instanceId: i.instance,
      allowedScopeIds: ['Scope:1'],
      credentialSource: 'passthrough',
    }),
  'Widen the projects of a workspace that has write tools': (g, i) =>
    g.workspaces.update(i.writeWorkspace, { allowedScopeIds: ['Scope:1', 'Scope:2', 'Scope:3'] }),
  'Create a grant': (g, i) =>
    g.grants.create({ workspaceId: i.workspace, userId: null, label: 'ci', tools: ['whoami'] }),
  'Grant write tools': (g, i) =>
    g.grants.create({ workspaceId: i.workspace, userId: i.carol, tools: ['add_comment'] }),
  'Widen a grant that has write tools': (g, i) =>
    g.grants.update(i.writeGrant, { scopeIds: ['Scope:1', 'Scope:2'] }),
  'Issue a device token that never expires': (g, i) =>
    g.tokens.issue({ grantId: i.bobGrant, label: 'laptop', expiresInDays: 'never' }),
  "Issue a device token on someone else's grant": (g, i) =>
    g.tokens.issue({ grantId: i.bobGrant, label: 'laptop' }),
  "See every person's connected OAuth apps": (g) => g.oauth.authorizeDeviceList(),
  "Disconnect a member's connected OAuth app": (g, i) => g.oauth.authorizeDeviceRevoke(i.bob),
  "Disconnect an admin's connected OAuth app": (g, i) => g.oauth.authorizeDeviceRevoke(i.admin2),
  'See and revoke registered OAuth apps': (g) => g.oauth.authorizeClients(),
  'Create an owner setup link': (g) => g.setupLinks.authorize(),
  'Retire a master-key version': (g) => g.keys.retire(1, 'test'),
};

type Cell = 'no' | 'yes' | 'recent';
type Outcome = 'denied' | 'reauth' | 'allowed';

async function outcome(run: () => unknown): Promise<Outcome> {
  try {
    await run();
    return 'allowed';
  } catch (e) {
    if (e instanceof ReauthRequiredError) return 'reauth';
    if (e instanceof ForbiddenError || e instanceof NotFoundError) return 'denied';
    // Anything else (a conflict, a validation message) came after authorization; a programming error would not.
    if (e instanceof TypeError || e instanceof ReferenceError) throw e;
    return 'allowed';
  }
}

async function cell(row: string, role: Role): Promise<Cell> {
  const probe = PROBES[row] as (g: Guarded, i: Ids) => unknown;
  const stale = await world();
  const first = await outcome(() => probe(stale.guard(stale.actor(role, false)), stale.ids));
  if (first === 'denied') return 'no';
  if (first === 'allowed') return 'yes';
  const fresh = await world();
  const second = await outcome(() => probe(fresh.guard(fresh.actor(role, true)), fresh.ids));
  expect(second, `${row} as ${role} with a recent sign-in`).toBe('allowed');
  return 'recent';
}

const text = readFileSync(new URL('../../docs/guide/admin-guide.md', import.meta.url), 'utf8');
const after = (text.split('<!-- role-matrix -->')[1] ?? '').split('\n');
const start = after.findIndex((l) => l.startsWith('|'));
const table: string[] = [];
for (const l of after.slice(start)) {
  if (!l.startsWith('|')) break;
  table.push(l);
}
const rows = table
  .slice(2)
  .map((l) => l.split('|').map((c) => c.trim()))
  .map((c) => ({ label: c[1] ?? '', member: c[2], admin: c[3], owner: c[4] }));

describe('the role matrix in the admin guide', () => {
  it('lists every probe, and only probed rows', () => {
    expect(rows.map((r) => r.label).sort()).toEqual(Object.keys(PROBES).sort());
  });

  for (const row of rows) {
    it(row.label, async () => {
      expect({
        member: await cell(row.label, 'member'),
        admin: await cell(row.label, 'admin'),
        owner: await cell(row.label, 'owner'),
      }).toEqual({ member: row.member, admin: row.admin, owner: row.owner });
    });
  }
});
