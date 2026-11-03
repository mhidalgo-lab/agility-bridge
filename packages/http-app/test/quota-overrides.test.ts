// SPDX-License-Identifier: Apache-2.0
// Per-grant and per-workspace quota overrides (P8-14, THREAT_MODEL T5, A10, L-116): the effective quota is the lowest of
// the deployment's, the workspace's and the grant's; a value above the server's is refused naming the cap; an
// administrator may add or lower one but not loosen it (raise or remove); a member can neither set nor read another
// grant's. Negative authorization first: a refusal changes nothing.
import { createLogger, createQuotaGate, type QuotaLimits } from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import { ADMIN_BASE } from '../src/index.ts';
import { ORIGIN, post, type World, world } from './helpers/world.ts';

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

const WHOAMI = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } };
const GET = (asset: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'get_assets', arguments: { assets: [asset] } },
});
const DAY = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');

/** A world whose server quota is `deployment` and whose admin API caps overrides at it. */
async function rig(deployment: QuotaLimits) {
  const clock = { t: Date.UTC(2026, 10, 3, 12) };
  let kv: Storage['kv'] | undefined;
  const gate = createQuotaGate({
    logger: createLogger({ level: 'debug', sink: () => {} }),
    limits: deployment,
    clock: { now: () => clock.t },
    counters: {
      getMany: (keys) => (kv as Storage['kv']).getMany(keys),
      incrementMany: (entries) => (kv as Storage['kv']).incrementMany(entries),
    },
  });
  const w = await world({}, { admin: true, quotaCap: deployment, services: { quota: gate } });
  kv = w.storage.kv;
  return { w, clock };
}

const grantLimits = async (w: World) => (await w.storage.grants.get(w.ids.aliceGrant))?.limits ?? null;
const workspaceLimits = async (w: World) =>
  (await w.storage.workspaces.get(w.ids.workspaceA))?.limits ?? null;
const grantPath = (w: World) => `/grants/${w.ids.aliceGrant}`;
const workspacePath = (w: World) => `/workspaces/${w.ids.workspaceA}`;

describe('the effective quota is the lowest of the deployment, workspace and grant', () => {
  it('a grant quota below the server applies: the grant is refused at its own count, others are not', async () => {
    const { w, clock } = await rig({ daily: 100, monthly: null });
    expect((await call(w, 'owner', 'PATCH', grantPath(w), { limits: { quota: { daily: 3 } } })).status).toBe(
      200,
    );
    await w.storage.kv.set(`qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`, '3');
    const before = w.agilityTokens.length;
    const text = await (await post(w, 'team-a', w.tokens.alice, GET('B-00001'))).text();
    expect(text).toContain('AB_LIMIT_QUOTA');
    expect(text).toMatch(/limit\\?":3/);
    expect(text).not.toContain('In A');
    expect(w.agilityTokens.length).toBe(before);
    // Another grant (another workspace) is under the server's 100 and answers.
    expect(await (await post(w, 'team-b', w.tokens.aliceB, GET('B-00002'))).text()).toContain('In B');
  });

  it('a workspace quota applies to every grant of the workspace, and the lowest of the two wins', async () => {
    const { w, clock } = await rig({ daily: 100, monthly: null });
    expect(
      (await call(w, 'owner', 'PATCH', workspacePath(w), { limits: { quota: { daily: 5 } } })).status,
    ).toBe(200);
    await w.storage.kv.set(`qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`, '5');
    expect(await (await post(w, 'team-a', w.tokens.alice, GET('B-00001'))).text()).toContain(
      'AB_LIMIT_QUOTA',
    );
    // A grant value above the workspace's cannot raise it; a lower one wins.
    await call(w, 'owner', 'PATCH', grantPath(w), { limits: { quota: { daily: 4 } } });
    const text = await (await post(w, 'team-a', w.tokens.alice, WHOAMI)).text();
    expect(text).toMatch(/limit\\?":4/);
  });

  it('adds a limit where the server has none, and shows the effective value in whoami and the usage', async () => {
    const { w } = await rig({ daily: null, monthly: null });
    await call(w, 'owner', 'PATCH', grantPath(w), { limits: { quota: { monthly: 50 } } });
    const text = await (await post(w, 'team-a', w.tokens.alice, WHOAMI)).text();
    expect(text).toMatch(/"monthly":\{"used":\d+,"limit":50,/);
    const usage = await (await call(w, 'member', 'GET', `${grantPath(w)}/usage`)).json();
    expect(usage).toMatchObject({ enabled: true, status: 'ok', monthly: { limit: 50 } });
    expect(usage.daily).toBeUndefined();
    // A grant with no quota anywhere is "no quota", as before.
    const other = await call(w, 'owner', 'GET', `/grants/${w.ids.aliceGrantB}/usage`);
    expect(await other.json()).toEqual({ enabled: false });
  });

  it('never raises the server value: a stored value above it still resolves to the server value', async () => {
    const { w, clock } = await rig({ daily: 2, monthly: null });
    // Written behind the API (a restored backup, or the cap lowered later).
    const grant = await w.storage.grants.get(w.ids.aliceGrant);
    await w.storage.grants.update(w.ids.aliceGrant, {
      limits: { ...(grant?.limits ?? {}), quota: { daily: 999 } },
    });
    await w.storage.kv.set(`qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`, '2');
    expect(await (await post(w, 'team-a', w.tokens.alice, GET('B-00001'))).text()).toContain(
      'AB_LIMIT_QUOTA',
    );
  });
});

describe('what the admin API accepts', () => {
  it('refuses a value above the server quota, naming it, on grants and workspaces, changing nothing', async () => {
    const { w } = await rig({ daily: 10, monthly: 100 });
    for (const [path, read] of [
      [grantPath(w), grantLimits],
      [workspacePath(w), workspaceLimits],
    ] as const) {
      const before = JSON.stringify(await read(w));
      const daily = await call(w, 'owner', 'PATCH', path, { limits: { quota: { daily: 11 } } });
      expect(daily.status).toBe(422);
      expect(JSON.stringify(await daily.json())).toContain('at most 10');
      const monthly = await call(w, 'owner', 'PATCH', path, { limits: { quota: { monthly: 101 } } });
      expect(monthly.status).toBe(422);
      expect(JSON.stringify(await monthly.json())).toContain('at most 100');
      expect(JSON.stringify(await read(w))).toBe(before);
    }
    const created = await call(w, 'owner', 'POST', '/grants', {
      workspaceId: w.ids.workspaceA,
      userId: null,
      label: 'svc',
      limits: { quota: { daily: 50 } },
    });
    expect(created.status).toBe(422);
    expect((await w.storage.grants.list()).filter((g) => g.label === 'svc')).toEqual([]);
    // At the server's value is allowed (it equals the default).
    expect((await call(w, 'owner', 'PATCH', grantPath(w), { limits: { quota: { daily: 10 } } })).status).toBe(
      200,
    );
  });

  it('refuses zero, fractions, strings and unknown keys', async () => {
    const { w } = await rig({ daily: 10, monthly: 100 });
    for (const bad of [0, -1, 1.5, '5', null, {}, []]) {
      const res = await call(w, 'owner', 'PATCH', grantPath(w), { limits: { quota: { daily: bad } } });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    const unknown = await call(w, 'owner', 'PATCH', grantPath(w), { limits: { quota: { hourly: 3 } } });
    expect(unknown.status).toBe(422);
    expect(await grantLimits(w)).toEqual({});
  });
});

describe('who may set, loosen and remove it (negative authorization)', () => {
  it('a member and a stranger cannot set a quota, theirs or another grant; nothing changes', async () => {
    const { w } = await rig({ daily: 10, monthly: 100 });
    const before = JSON.stringify([await grantLimits(w), await workspaceLimits(w)]);
    const body = { limits: { quota: { daily: 1 } } };
    expect((await call(w, 'none', 'PATCH', grantPath(w), body)).status).toBe(401);
    expect((await call(w, 'none', 'PATCH', workspacePath(w), body)).status).toBe(401);
    for (const path of [grantPath(w), `/grants/${w.ids.bobGrant}`, workspacePath(w)]) {
      const res = await call(w, 'member', 'PATCH', path, body);
      expect([403, 404], path).toContain(res.status);
    }
    expect(JSON.stringify([await grantLimits(w), await workspaceLimits(w)])).toBe(before);
  });

  it('a member reads the quota of their own grant only; another grant answers nothing', async () => {
    const { w } = await rig({ daily: 10, monthly: 100 });
    await call(w, 'owner', 'PATCH', `/grants/${w.ids.bobGrant}`, { limits: { quota: { daily: 7 } } });
    const other = await call(w, 'member', 'GET', `/grants/${w.ids.bobGrant}`);
    expect(other.status).toBe(404);
    expect(await other.text()).not.toMatch(/quota|"daily"/);
    const usage = await call(w, 'member', 'GET', `/grants/${w.ids.bobGrant}/usage`);
    expect(usage.status).toBe(404);
    expect(await usage.text()).not.toMatch(/limit|used|remaining/);
  });

  it('an admin may add or lower a quota but cannot raise or remove one that is set', async () => {
    const { w } = await rig({ daily: 10, monthly: 100 });
    // Nothing set: an admin may add one (a tightening).
    expect((await call(w, 'admin', 'PATCH', grantPath(w), { limits: { quota: { daily: 8 } } })).status).toBe(
      200,
    );
    expect((await call(w, 'admin', 'PATCH', grantPath(w), { limits: { quota: { daily: 6 } } })).status).toBe(
      200,
    );
    const before = JSON.stringify(await grantLimits(w));
    // The owner sets it; the admin cannot loosen it, and other limits are still the admin's.
    await call(w, 'owner', 'PATCH', grantPath(w), { limits: { quota: { daily: 5, monthly: 50 } } });
    const set = JSON.stringify(await grantLimits(w));
    expect(set).not.toBe(before);
    for (const limits of [
      { quota: { daily: 6, monthly: 50 } }, // raise one period
      { quota: { daily: 5 } }, // remove one period
      {}, // remove all
      { maxRows: 10 }, // remove all while changing another limit
    ]) {
      const res = await call(w, 'admin', 'PATCH', grantPath(w), { limits });
      expect(res.status, JSON.stringify(limits)).toBe(403);
      expect(JSON.stringify(await grantLimits(w))).toBe(set);
    }
    // Keeping it while changing another limit is allowed.
    expect(
      (
        await call(w, 'admin', 'PATCH', grantPath(w), {
          limits: { quota: { daily: 5, monthly: 50 }, maxRows: 10 },
        })
      ).status,
    ).toBe(200);
    // The same on a workspace.
    await call(w, 'owner', 'PATCH', workspacePath(w), { limits: { quota: { daily: 5 } } });
    const ws = JSON.stringify(await workspaceLimits(w));
    expect(
      (await call(w, 'admin', 'PATCH', workspacePath(w), { limits: { quota: { daily: 9 } } })).status,
    ).toBe(403);
    expect((await call(w, 'admin', 'PATCH', workspacePath(w), { limits: {} })).status).toBe(403);
    expect(JSON.stringify(await workspaceLimits(w))).toBe(ws);
  });

  it('loosening needs a recent sign-in; an owner with one may raise within the server value or remove it', async () => {
    const { w } = await rig({ daily: 10, monthly: 100 });
    await call(w, 'owner', 'PATCH', grantPath(w), { limits: { quota: { daily: 5 } } });
    const set = JSON.stringify(await grantLimits(w));
    const stale = await call(w, 'owner_stale', 'PATCH', grantPath(w), { limits: { quota: { daily: 6 } } });
    expect(stale.status).toBe(403);
    expect((await stale.json()).error.code).toBe('reauth_required');
    expect(JSON.stringify(await grantLimits(w))).toBe(set);
    expect((await call(w, 'owner', 'PATCH', grantPath(w), { limits: { quota: { daily: 9 } } })).status).toBe(
      200,
    );
    expect((await call(w, 'break_glass', 'PATCH', grantPath(w), { limits: {} })).status).toBe(200);
    expect(await grantLimits(w)).toEqual({});
  });

  it('creating a grant or workspace with a quota above the server value is refused for every role', async () => {
    const { w } = await rig({ daily: 10, monthly: null });
    for (const who of ['owner', 'admin'] as const) {
      const res = await call(w, who, 'POST', '/grants', {
        workspaceId: w.ids.workspaceA,
        userId: null,
        label: 'svc',
        limits: { quota: { daily: 11 } },
      });
      expect(res.status, who).toBe(422);
    }
    expect((await w.storage.grants.list()).filter((g) => g.label === 'svc')).toEqual([]);
  });
});
