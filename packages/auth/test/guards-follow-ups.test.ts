// SPDX-License-Identifier: Apache-2.0
// Panel follow-ups at the guard (P4-15, THREAT_MODEL T14, A5): enabling a disabled user, the device tokens an actor may list,
// and the one number-prefix validator. The HTTP and panel layers have their own suites; here every refusal is checked to write
// nothing and to return nothing.
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Actor,
  accessServices,
  checkNumberPrefixes,
  ForbiddenError,
  guardedServices,
  MAX_NUMBER_PREFIXES,
  ReauthRequiredError,
} from '../src/index.ts';
import { TOOLS } from './helpers/access.ts';

let storage: Storage;
let clock: { t: number };
let svc: ReturnType<typeof accessServices>;
let guard: (actor: Actor) => ReturnType<typeof guardedServices>;
const ids = {} as Record<string, string>;

beforeEach(async () => {
  clock = { t: 1_760_000_000_000 };
  storage = createMemoryStorage({ now: () => clock.t });
  svc = accessServices({ storage, tools: TOOLS, now: () => clock.t });
  for (const [key, role] of [
    ['owner', 'owner'],
    ['owner2', 'owner'],
    ['admin', 'admin'],
    ['alice', 'member'],
    ['bob', 'member'],
  ] as const) {
    ids[key] = (await svc.users.create({ email: `${key}@example.test`, role })).id;
  }
  guard = (actor) => guardedServices(svc, { storage, tools: TOOLS }, actor);
});

const user = (key: string, role: 'owner' | 'admin' | 'member', recentAuth = true): Actor => ({
  kind: 'user',
  userId: ids[key] as string,
  role,
  recentAuth,
});
const BREAK_GLASS: Actor = { kind: 'break_glass' };
const snapshot = async () => JSON.stringify(await storage.users.list());
const disabled = async (key: string) => {
  await svc.users.disable(ids[key] as string);
};

describe('users.enable', () => {
  it('re-enables a disabled user for the actors who may disable them', async () => {
    await disabled('alice');
    expect((await guard(user('admin', 'admin')).users.enable(ids['alice'] as string)).disabledAt).toBeNull();
    await disabled('admin');
    await guard(user('owner', 'owner')).users.enable(ids['admin'] as string);
    await disabled('owner2');
    await guard(BREAK_GLASS).users.enable(ids['owner2'] as string);
    expect((await storage.users.list()).every((u) => u.disabledAt === null)).toBe(true);
  });

  it('refuses members, admins above members, and stale sign-ins, and writes nothing', async () => {
    await disabled('alice');
    await disabled('admin');
    await disabled('owner2');
    const before = await snapshot();
    const cases: Array<[string, Actor, string, new (...a: never[]) => Error]> = [
      ['a member on a member', user('bob', 'member'), 'alice', ForbiddenError],
      ['an admin on an admin', user('admin', 'admin'), 'admin', ForbiddenError],
      ['an admin on an owner', user('admin', 'admin'), 'owner2', ForbiddenError],
      [
        'an owner with an old sign-in on an admin',
        user('owner', 'owner', false),
        'admin',
        ReauthRequiredError,
      ],
      [
        'an owner with an old sign-in on an owner',
        user('owner', 'owner', false),
        'owner2',
        ReauthRequiredError,
      ],
    ];
    for (const [name, actor, target, error] of cases) {
      const caught = await guard(actor)
        .users.enable(ids[target] as string)
        .catch((e: unknown) => e);
      expect(caught, name).toBeInstanceOf(error);
    }
    expect(await snapshot()).toBe(before);
  });

  it('lets an owner with an old sign-in enable a member, as for disabling', async () => {
    await disabled('alice');
    await guard(user('owner', 'owner', false)).users.enable(ids['alice'] as string);
    expect((await storage.users.get(ids['alice'] as string))?.disabledAt).toBeNull();
  });

  it('refuses a user who is not disabled and a missing user, after the role check', async () => {
    const before = await snapshot();
    const conflict = await guard(user('admin', 'admin'))
      .users.enable(ids['alice'] as string)
      .catch((e: unknown) => e);
    expect((conflict as Error).name).toBe('ConflictError');
    // A caller who may not enable never learns whether the user is disabled: the same refusal either way.
    const refused = await guard(user('bob', 'member'))
      .users.enable(ids['alice'] as string)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    const missing = await guard(user('owner', 'owner'))
      .users.enable('usr_missing')
      .catch((e: unknown) => e);
    expect((missing as Error).name).toBe('NotFoundError');
    expect(await snapshot()).toBe(before);
  });
});

describe('tokens.listAll', () => {
  async function world() {
    const instance = await storage.instances.create({
      id: 'ins_1',
      label: 'Main',
      baseUrl: 'https://a.example.test/Main',
    });
    const workspace = await storage.workspaces.create({
      id: 'wsp_1',
      slug: 'team-a',
      name: 'Team A',
      instanceId: instance.id,
      allowedScopeIds: ['Scope:1'],
      includeChildScopes: false,
      assetTypes: null,
      enabledTools: null,
      limits: {},
      defaultCredentialId: null,
      writePolicy: {},
      credentialSource: 'stored',
    });
    const grants: Record<string, string> = {};
    for (const [key, userId] of [
      ['alice', ids['alice']],
      ['bob', ids['bob']],
      ['service', null],
    ] as const) {
      grants[key] = (
        await storage.grants.create({
          id: `grt_${key}`,
          workspaceId: workspace.id,
          userId: userId ?? null,
          label: key === 'service' ? 'ci' : null,
          credentialId: null,
          tools: null,
          scopeIds: null,
          assetTypes: null,
          limits: {},
          rateLimit: null,
          expiresAt: null,
        })
      ).id;
    }
    let n = 0;
    const add = async (grant: string, label: string) => {
      clock.t += 10;
      n++;
      return (
        await storage.accessTokens.create({
          id: `tok_${label}`,
          grantId: grant,
          prefix: 'ab_live_abcd',
          tokenHash: n.toString(16).padStart(64, '0'),
          label,
        })
      ).id;
    };
    return { grants, add };
  }

  it('gives owners, admins and the break-glass token every token, and a member only their own', async () => {
    const w = await world();
    await w.add(w.grants['alice'] as string, 'a1');
    await w.add(w.grants['bob'] as string, 'b1');
    await w.add(w.grants['service'] as string, 's1');
    for (const actor of [user('owner', 'owner'), user('admin', 'admin'), BREAK_GLASS]) {
      const all = await guard(actor).tokens.listAll();
      expect(all.data.map((t) => t.label)).toEqual(['s1', 'b1', 'a1']);
      expect(all.next).toBeNull();
    }
    const mine = await guard(user('alice', 'member')).tokens.listAll();
    expect(mine.data.map((t) => t.label)).toEqual(['a1']);
    // Bob's token and grant by id (a bare 'b1' also matches random hex ids now and then).
    expect(JSON.stringify(mine)).not.toContain('"tok_b1"');
    expect(JSON.stringify(mine)).not.toContain(w.grants['bob'] as string);
    const none = await guard(user('alice', 'member')).tokens.listAll({ userId: ids['bob'] as string });
    expect(none.data).toEqual([]);
    const foreign = await guard(user('alice', 'member'))
      .tokens.listAll({ grantId: w.grants['bob'] as string })
      .catch((e: unknown) => e);
    expect((foreign as Error).name).toBe('NotFoundError');
  });

  it('returns each token with its grant', async () => {
    const w = await world();
    await w.add(w.grants['service'] as string, 's1');
    const [item] = (await guard(user('owner', 'owner')).tokens.listAll()).data;
    expect(item).toMatchObject({
      grantId: w.grants['service'],
      userId: null,
      workspaceId: 'wsp_1',
      grantLabel: 'ci',
    });
  });

  it('pages without repeats or gaps, breaks timestamp ties by id, and refuses a bad cursor', async () => {
    const w = await world();
    const g = w.grants['service'] as string;
    for (const label of ['t1', 't2']) await w.add(g, label);
    // Three tokens in one millisecond.
    clock.t += 10;
    for (const [i, label] of ['x1', 'x2', 'x3'].entries()) {
      await storage.accessTokens.create({
        id: `tok_${label}`,
        grantId: g,
        prefix: 'ab_live_abcd',
        tokenHash: (100 + i).toString(16).padStart(64, '0'),
        label,
      });
    }
    const admin = guard(user('admin', 'admin'));
    const seen: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await admin.tokens.listAll({ limit: 2, ...(after === undefined ? {} : { after }) });
      seen.push(...page.data.map((t) => t.label));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual(['x3', 'x2', 'x1', 't2', 't1']);
    for (const bad of ['', 'x', '1:', ':a', '1:a b', '1.5:a', `${'9'.repeat(30)}:a`]) {
      const caught = await admin.tokens.listAll({ after: bad }).catch((e: unknown) => e);
      expect((caught as Error).name, bad).toBe('InvalidInputError');
    }
  });
});

describe('checkNumberPrefixes', () => {
  it('accepts null and a map of asset type names to one to four capital letters', () => {
    expect(checkNumberPrefixes(null)).toBeNull();
    expect(checkNumberPrefixes(undefined)).toBeNull();
    expect(checkNumberPrefixes({})).toEqual({});
    expect(checkNumberPrefixes({ Story: 'S', Test_1: 'ABCD' })).toEqual({ Story: 'S', Test_1: 'ABCD' });
  });

  it('refuses anything else, whatever it looks like', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_NUMBER_PREFIXES + 1 }, (_, i) => [`T${i}`, 'A']),
    );
    for (const bad of [
      'Story=S',
      42,
      true,
      ['S'],
      { Story: 's' },
      { Story: 'ABCDE' },
      { Story: '' },
      { Story: 1 },
      { Story: null },
      { Story: { a: 'S' } },
      { 'a b': 'S' },
      { 'a"b': 'S' },
      { '': 'S' },
      { '1a': 'S' },
      { ['x'.repeat(65)]: 'S' },
      many,
    ]) {
      expect(() => checkNumberPrefixes(bad), JSON.stringify(bad)?.slice(0, 40)).toThrow(/numberPrefixes/);
    }
  });
});
