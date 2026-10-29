// SPDX-License-Identifier: Apache-2.0
// A grant's own hourly write limit (P7-15, THREAT_MODEL T31, A2): an owner with a recent sign-in can set it, it can only
// lower the deployment's value, an administrator and a member cannot change it, and the write runtime applies the lower
// of the two. Negative authorization first: a refusal changes nothing.
import { generateMasterKey, Keyring } from '@agility-bridge/auth';
import { AbError, ErrorCode } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { ADMIN_BASE, createHttpWrites } from '../src/index.ts';
import { ORIGIN, type World, world } from './helpers/world.ts';

type Who = 'none' | 'member' | 'admin' | 'owner' | 'owner_stale' | 'break_glass';

const call = (w: World, who: Who, method: string, path: string, body?: unknown) =>
  w.app.fetch(
    new Request(`${ORIGIN}${ADMIN_BASE}${path}`, {
      method,
      headers: {
        ...(who === 'none' ? {} : { 'x-test-actor': who }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const stored = async (w: World) => (await w.storage.grants.get(w.ids.aliceGrant))?.rateLimit ?? null;

describe('setting a grant write limit (admin API)', () => {
  it('an owner with a recent sign-in lowers it; the change is audited with the previous value', async () => {
    const w = await world({}, { admin: true, writeRateCap: 20 });
    const path = `/grants/${w.ids.aliceGrant}`;
    expect((await call(w, 'owner', 'PATCH', path, { rateLimit: { writesPerHour: 5 } })).status).toBe(200);
    expect(await stored(w)).toEqual({ writesPerHour: 5 });
    // Lowering again, and keeping the per-minute rate next to it.
    expect(
      (await call(w, 'owner', 'PATCH', path, { rateLimit: { perMinute: 30, writesPerHour: 2 } })).status,
    ).toBe(200);
    expect(await stored(w)).toEqual({ perMinute: 30, writesPerHour: 2 });
    await w.audit.flush();
    const rows = await w.storage.audit.query({
      kind: 'admin',
      status: 'ok',
      action: 'grant.update',
      limit: 10,
    });
    // Same clock tick, so order by what each row says.
    const seen = rows
      .map((r) => `${String(r.details?.['previousWritesPerHour'])} -> ${String(r.details?.['rateLimit'])}`)
      .sort();
    expect(seen).toEqual(['5 -> {"perMinute":30,"writesPerHour":2}', 'undefined -> {"writesPerHour":5}']);
    // The break-glass token is an owner without a browser session.
    expect((await call(w, 'break_glass', 'PATCH', path, { rateLimit: { writesPerHour: 3 } })).status).toBe(
      200,
    );
  });

  it('refuses a value above the deployment limit, and zero, fractions and unknown keys, changing nothing', async () => {
    const w = await world({}, { admin: true, writeRateCap: 20 });
    const path = `/grants/${w.ids.aliceGrant}`;
    const over = await call(w, 'owner', 'PATCH', path, { rateLimit: { writesPerHour: 21 } });
    expect(over.status).toBe(422);
    expect(JSON.stringify(await over.json())).toContain('at most 20');
    for (const bad of [0, -1, 1.5, 1_001, '5', null]) {
      const res = await call(w, 'owner', 'PATCH', path, { rateLimit: { writesPerHour: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect((await call(w, 'owner', 'PATCH', path, { rateLimit: { perHour: 3 } })).status).toBe(422);
    // At the deployment value is allowed (it equals the default).
    expect((await call(w, 'owner', 'PATCH', path, { rateLimit: { writesPerHour: 20 } })).status).toBe(200);
    // On create too.
    const created = await call(w, 'owner', 'POST', '/grants', {
      workspaceId: w.ids.workspaceA,
      userId: null,
      label: 'svc',
      rateLimit: { writesPerHour: 99 },
    });
    expect(created.status).toBe(422);
    expect((await w.storage.grants.list()).filter((g) => g.label === 'svc')).toEqual([]);
  });

  it('an admin, a member, a stale sign-in and a stranger cannot set, change or remove it; nothing changes', async () => {
    const w = await world({}, { admin: true, writeRateCap: 20 });
    const path = `/grants/${w.ids.aliceGrant}`;
    await call(w, 'owner', 'PATCH', path, { rateLimit: { writesPerHour: 5 } });
    const before = JSON.stringify(await w.storage.grants.list());
    const bodies = [
      { rateLimit: { writesPerHour: 3 } }, // lower
      { rateLimit: { writesPerHour: 10 } }, // loosen
      { rateLimit: { perMinute: 10 } }, // remove it
      { rateLimit: null }, // remove it
    ];
    for (const body of bodies) {
      expect((await call(w, 'none', 'PATCH', path, body)).status, 'none').toBe(401);
      for (const who of ['admin', 'member'] as const) {
        const res = await call(w, who, 'PATCH', path, body);
        expect([403, 404], `${who} ${JSON.stringify(body)}`).toContain(res.status);
      }
      const stale = await call(w, 'owner_stale', 'PATCH', path, body);
      expect(stale.status).toBe(403);
      expect((await stale.json()).error.code).toBe('reauth_required');
    }
    // Creating a grant that carries one is the same.
    const create = {
      workspaceId: w.ids.workspaceA,
      userId: null,
      label: 'svc2',
      rateLimit: { writesPerHour: 3 },
    };
    expect((await call(w, 'admin', 'POST', '/grants', create)).status).toBe(403);
    expect((await call(w, 'owner_stale', 'POST', '/grants', create)).status).toBe(403);
    expect(JSON.stringify(await w.storage.grants.list())).toBe(before);
  });

  it('an admin may still change the per-minute rate while the owner-set limit stays', async () => {
    const w = await world({}, { admin: true, writeRateCap: 20 });
    const path = `/grants/${w.ids.aliceGrant}`;
    await call(w, 'owner', 'PATCH', path, { rateLimit: { writesPerHour: 5 } });
    expect(
      (await call(w, 'admin', 'PATCH', path, { rateLimit: { writesPerHour: 5, perMinute: 7 } })).status,
    ).toBe(200);
    expect(await stored(w)).toEqual({ writesPerHour: 5, perMinute: 7 });
    // An admin can set a limit that is not an owner's decision: the per-minute rate on a grant that has none.
    expect((await call(w, 'admin', 'PATCH', path, { label: 'renamed' })).status).toBe(200);
    expect(await stored(w)).toEqual({ writesPerHour: 5, perMinute: 7 });
  });
});

describe('the write runtime applies the lower of the grant and the deployment limit', () => {
  async function runtime(rateLimit: unknown, perGrant: number) {
    const w = await world({}, {});
    const writes = createHttpWrites({
      storage: w.storage,
      audit: w.audit,
      keyring: await Keyring.create(generateMasterKey(1)),
      clock: { now: () => w.now.t },
      limits: { perGrant, deployment: null },
    });
    const access = {
      grant: { id: 'g-own', userId: 'u-1' },
      tokenId: null,
      clientId: null,
      writeTools: [],
      rateLimit,
    } as never;
    return (await writes.runtimeFor(access)).limiter;
  }
  const info = { tool: 't', requestId: 'r', actor: { id: 'u-1', grantId: 'g-own' } };
  const result = async (p: Promise<void>) =>
    p.then(
      () => 'ok',
      (e: unknown) => (e instanceof AbError ? e.code : 'other'),
    );

  it('a lower grant limit refuses first; a higher one has no effect; none uses the deployment value', async () => {
    const low = await runtime({ writesPerHour: 2 }, 5);
    expect(await result(low.check(info))).toBe('ok');
    expect(await result(low.check(info))).toBe('ok');
    expect(await result(low.check(info))).toBe(ErrorCode.LimitRate);
    const high = await runtime({ writesPerHour: 500 }, 3);
    for (let i = 0; i < 3; i++) expect(await result(high.check(info))).toBe('ok');
    expect(await result(high.check(info))).toBe(ErrorCode.LimitRate);
    const none = await runtime(null, 2);
    expect(await result(none.check(info))).toBe('ok');
    expect(await result(none.check(info))).toBe('ok');
    expect(await result(none.check(info))).toBe(ErrorCode.LimitRate);
  });
});
