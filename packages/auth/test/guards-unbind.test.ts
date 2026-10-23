// SPDX-License-Identifier: Apache-2.0
// Moving a user to another identity on purpose (P4-12, THREAT_MODEL T14, L-092, L-093, L-220), at the guard: who may do
// it, what it needs, and that a refusal writes nothing. The HTTP, panel and CLI layers have their own suites.
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Actor,
  accessServices,
  ForbiddenError,
  guardedServices,
  ReauthRequiredError,
} from '../src/index.ts';
import { TOOLS } from './helpers/access.ts';
import { unbindRace } from './login-race.ts';

let storage: Storage;
let guard: (actor: Actor) => ReturnType<typeof guardedServices>;
let ids: { owner: string; owner2: string; admin: string; alice: string; unbound: string };

beforeEach(async () => {
  storage = createMemoryStorage();
  const svc = accessServices({ storage, tools: TOOLS });
  const owner = await svc.users.create({ email: 'o@example.test', role: 'owner' });
  const owner2 = await svc.users.create({ email: 'o2@example.test', role: 'owner' });
  const admin = await svc.users.create({ email: 'a@example.test', role: 'admin' });
  const alice = await svc.users.create({ email: 'm@example.test', role: 'member' });
  const unbound = await svc.users.create({ email: 'u@example.test', role: 'member' });
  for (const [u, subject] of [
    [owner, 'sub-o'],
    [owner2, 'sub-o2'],
    [admin, 'sub-a'],
    [alice, 'sub-m'],
  ] as const) {
    await storage.users.bind(u.id, 'google', subject);
  }
  ids = { owner: owner.id, owner2: owner2.id, admin: admin.id, alice: alice.id, unbound: unbound.id };
  guard = (actor) => guardedServices(svc, { storage, tools: TOOLS }, actor);
});

const user = (id: string, role: 'owner' | 'admin' | 'member', recentAuth = true): Actor => ({
  kind: 'user',
  userId: id,
  role,
  recentAuth,
});
const BREAK_GLASS: Actor = { kind: 'break_glass' };
const snapshot = async () => JSON.stringify(await storage.users.list());

describe('users.unbind', () => {
  it('clears the identity for an owner with a recent sign-in and for the break-glass token', async () => {
    const done = await guard(user(ids.owner, 'owner')).users.unbind(ids.alice, 'm@example.test');
    expect(done.previousIdp).toBe('google');
    expect(done.user).toMatchObject({ id: ids.alice, idp: null, idpSubject: null, role: 'member' });
    expect(await storage.users.getByIdentity('google', 'sub-m')).toBeNull();
    // The break-glass token has no user and no session: no recent sign-in is needed, and it may clear an owner.
    await guard(BREAK_GLASS).users.unbind(ids.owner2, 'O2@Example.test ');
    expect(await storage.users.get(ids.owner2)).toMatchObject({ idp: null, idpSubject: null });
  });

  it('refuses an admin and a member, and an owner without a recent sign-in, writing nothing', async () => {
    const before = await snapshot();
    const cases: Array<[string, Actor, new (...a: never[]) => Error]> = [
      ['an admin', user(ids.admin, 'admin'), ForbiddenError],
      ['a member', user(ids.alice, 'member'), ForbiddenError],
      ['an owner whose sign-in is old', user(ids.owner, 'owner', false), ReauthRequiredError],
    ];
    for (const [name, actor, error] of cases) {
      const caught = await guard(actor)
        .users.unbind(ids.alice, 'm@example.test')
        .catch((e: unknown) => e);
      expect(caught, name).toBeInstanceOf(error);
      if (error === ForbiddenError) expect(caught).not.toBeInstanceOf(ReauthRequiredError);
    }
    expect(await snapshot()).toBe(before);
  });

  it('never clears your own identity through a session, and a refusal keeps the binding', async () => {
    const before = await snapshot();
    const error = await guard(user(ids.owner, 'owner'))
      .users.unbind(ids.owner, 'o@example.test')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toMatch(/your own/);
    expect(await snapshot()).toBe(before);
  });

  it('needs the exact email, a user that exists and a binding to clear, and writes nothing otherwise', async () => {
    const before = await snapshot();
    const g = guard(user(ids.owner, 'owner'));
    const wrong = await g.users.unbind(ids.alice, 'someone@example.test').catch((e: unknown) => e);
    expect((wrong as Error).name).toBe('InvalidInputError');
    expect((wrong as Error).message).not.toContain('someone@example.test');
    for (const bad of ['', '   ', 'm@example.test.', 'M@example.test\u0000']) {
      expect(await g.users.unbind(ids.alice, bad).catch((e: unknown) => e)).toBeInstanceOf(Error);
    }
    expect(await g.users.unbind(ids.alice, undefined as never).catch((e: unknown) => e)).toBeInstanceOf(
      Error,
    );
    expect(((await g.users.unbind('nope', 'x@example.test').catch((e: unknown) => e)) as Error).name).toBe(
      'NotFoundError',
    );
    expect(
      ((await g.users.unbind(ids.unbound, 'u@example.test').catch((e: unknown) => e)) as Error).name,
    ).toBe('ConflictError');
    expect(await snapshot()).toBe(before);
  });

  it('lets exactly one concurrent unbind win and never undoes a binding made afterwards (L-220)', async () => {
    expect(await unbindRace(storage, ids.alice, 'm@example.test')).toEqual({
      ok: 1,
      conflict: 3,
      later: 'conflict',
    });
    // The user is bound again by a first sign-in: the old confirmation cannot clear the new binding.
    const row = await storage.users.get(ids.alice);
    expect(row).toMatchObject({ idp: 'github', idpSubject: 'gh-new' });
  });
});
