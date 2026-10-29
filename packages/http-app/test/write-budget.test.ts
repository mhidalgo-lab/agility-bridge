// SPDX-License-Identifier: Apache-2.0
// The write budget an owner can read without taking a unit (P7-16, THREAT_MODEL T31, T3): the admin routes, who may read
// which count, the failing store shown as unknown, and the panel's overview and grant page. Negative authorization first.
import { generateMasterKey, Keyring } from '@agility-bridge/auth';
import { WRITE_LIMIT_WINDOW_MS } from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import { ADMIN_BASE, createHttpWrites, type HttpWrites } from '../src/index.ts';
import { setup } from './helpers/panel.ts';
import { ORIGIN, type World, world } from './helpers/world.ts';

type Who = 'none' | 'member' | 'admin' | 'owner';

const get = (w: World, who: Who, path: string) =>
  w.app.fetch(
    new Request(`${ORIGIN}${ADMIN_BASE}${path}`, {
      headers: who === 'none' ? {} : { 'x-test-actor': who },
    }),
  );

async function rig(opts: { writes?: boolean; failing?: boolean } = {}) {
  let writes: HttpWrites | undefined;
  const w = await world(
    opts.writes === false
      ? {}
      : {
          writes: {
            runtimeFor: (a) => (writes as HttpWrites).runtimeFor(a),
            budget: (g, l) =>
              (writes as HttpWrites).budget?.(g, l) ?? Promise.resolve({ status: 'unknown' as const }),
          },
        },
    { admin: true },
  );
  const storage: Storage =
    opts.failing === true
      ? ({
          ...w.storage,
          kv: {
            ...w.storage.kv,
            get: () => Promise.reject(new Error('kv down')),
          },
        } as Storage)
      : w.storage;
  writes = createHttpWrites({
    storage,
    audit: w.audit,
    keyring: await Keyring.create(generateMasterKey(1)),
    clock: { now: () => w.now.t },
    limits: { perGrant: 5, deployment: 20 },
  });
  /** Takes `n` units for a grant the way a write does. */
  const spend = async (grantId: string, n: number) => {
    const rt = await (writes as HttpWrites).runtimeFor({
      grant: { id: grantId, userId: 'u' },
      tokenId: null,
      clientId: null,
      writeTools: [],
      rateLimit: null,
    } as never);
    for (let i = 0; i < n; i++)
      await rt.limiter.check({ tool: 't', requestId: 'r', actor: { id: 'u', grantId } });
  };
  const counters = async () => (await w.storage.kv.list('wl:')).sort().join(',');
  return { w, spend, counters };
}

describe('GET /writes/budget', () => {
  it('owner and admin read the deployment use this hour; reading takes nothing', async () => {
    const { w, spend, counters } = await rig();
    await spend(w.ids.aliceGrant, 2);
    const before = await counters();
    for (const who of ['owner', 'admin'] as const) {
      const res = await get(w, who, '/writes/budget');
      expect(res.status, who).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        enabled: true,
        status: 'ok',
        deployment: { limit: 20, used: 2, remaining: 18 },
      });
      expect(body).not.toHaveProperty('grant');
      expect(body['windowEndsAt']).toBe(
        (Math.floor(w.now.t / WRITE_LIMIT_WINDOW_MS) + 1) * WRITE_LIMIT_WINDOW_MS,
      );
    }
    expect(await counters()).toBe(before);
    // Still admitted at the same count after any number of reads.
    await spend(w.ids.aliceGrant, 3);
    await expect(spend(w.ids.aliceGrant, 1)).rejects.toMatchObject({ code: 'AB_LIMIT_RATE' });
  });

  it('is refused to a member and a stranger, and reads no counter', async () => {
    const { w, spend } = await rig();
    await spend(w.ids.aliceGrant, 1);
    const reads: string[] = [];
    const original = w.storage.kv.get.bind(w.storage.kv);
    w.storage.kv.get = (key: string) => {
      reads.push(key);
      return original(key);
    };
    expect((await get(w, 'none', '/writes/budget')).status).toBe(401);
    const denied = await get(w, 'member', '/writes/budget');
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toMatch(/limit|used|remaining/);
    expect(reads.filter((k) => k.startsWith('wl:'))).toEqual([]);
  });

  it('says so when write tools are off, and unknown (never unlimited) when the counters cannot be read', async () => {
    const off = await rig({ writes: false });
    expect(await (await get(off.w, 'owner', '/writes/budget')).json()).toEqual({ enabled: false });
    expect(await (await get(off.w, 'owner', `/grants/${off.w.ids.aliceGrant}/write-budget`)).json()).toEqual({
      enabled: false,
    });
    const down = await rig({ failing: true });
    const body = await (await get(down.w, 'owner', '/writes/budget')).json();
    expect(body).toEqual({ enabled: true, status: 'unknown' });
    const grant = await (await get(down.w, 'owner', `/grants/${down.w.ids.aliceGrant}/write-budget`)).json();
    expect(grant).toEqual({ enabled: true, status: 'unknown' });
  });
});

describe('GET /grants/{id}/write-budget', () => {
  it("shows one grant's count against the lower of the server's limit and the grant's own cap, to a manager", async () => {
    const { w, spend } = await rig();
    await spend(w.ids.aliceGrant, 2);
    for (const who of ['owner', 'admin'] as const) {
      const body = await (await get(w, who, `/grants/${w.ids.aliceGrant}/write-budget`)).json();
      expect(body).toMatchObject({ enabled: true, status: 'ok', grant: { limit: 5, used: 2, remaining: 3 } });
      expect(body).not.toHaveProperty('deployment');
    }
    await w.storage.grants.update(w.ids.aliceGrant, { rateLimit: { writesPerHour: 3 } });
    const lowered = await (await get(w, 'owner', `/grants/${w.ids.aliceGrant}/write-budget`)).json();
    expect(lowered).toMatchObject({ grant: { limit: 3, used: 2, remaining: 1 } });
    // A cap above the server's does not raise the limit.
    await w.storage.grants.update(w.ids.aliceGrant, { rateLimit: { writesPerHour: 900 } });
    const higher = await (await get(w, 'owner', `/grants/${w.ids.aliceGrant}/write-budget`)).json();
    expect(higher).toMatchObject({ grant: { limit: 5 } });
  });

  it('a member reads only their own grant; another grant, a stranger and a bad id get nothing and no counter is read', async () => {
    const { w, spend } = await rig();
    await spend(w.ids.aliceGrant, 1);
    await spend(w.ids.bobGrant, 4);
    const own = await get(w, 'member', `/grants/${w.ids.aliceGrant}/write-budget`);
    expect(own.status).toBe(200);
    const mine = (await own.json()) as Record<string, unknown>;
    expect(mine).toMatchObject({ grant: { used: 1, remaining: 4 } });
    // The deployment's use and another grant's are not in a member's answer.
    expect(JSON.stringify(mine)).not.toMatch(/deployment/);
    const reads: string[] = [];
    const original = w.storage.kv.get.bind(w.storage.kv);
    w.storage.kv.get = (key: string) => {
      reads.push(key);
      return original(key);
    };
    for (const id of [w.ids.bobGrant, 'grt_missing']) {
      const other = await get(w, 'member', `/grants/${id}/write-budget`);
      expect(other.status, id).toBe(404);
      expect(await other.text()).not.toMatch(/used|remaining|limit"/);
    }
    expect((await get(w, 'none', `/grants/${w.ids.aliceGrant}/write-budget`)).status).toBe(401);
    expect(reads.filter((k) => k.startsWith('wl:'))).toEqual([]);
  });
});

describe('the panel', () => {
  async function panel() {
    let writes: HttpWrites | undefined;
    const s = await setup({
      writes: {
        runtimeFor: () => Promise.reject(new Error('not used')),
        budget: (g, l) =>
          (writes as HttpWrites).budget?.(g, l) ?? Promise.resolve({ status: 'unknown' as const }),
      },
    });
    writes = createHttpWrites({
      storage: s.w.storage,
      audit: s.w.audit,
      keyring: await Keyring.create(generateMasterKey(1)),
      clock: { now: () => s.w.now.t },
      limits: { perGrant: 5, deployment: 20 },
    });
    const rt = await writes.runtimeFor({
      grant: { id: s.w.ids.aliceGrant, userId: 'u' },
      tokenId: null,
      clientId: null,
      writeTools: [],
      rateLimit: null,
    } as never);
    await rt.limiter.check({ tool: 't', requestId: 'r', actor: { id: 'u', grantId: s.w.ids.aliceGrant } });
    return s;
  }
  const html = async (s: Awaited<ReturnType<typeof panel>>, path: string, email: string) => {
    const who = await s.session(email);
    const res = await s.send('GET', path, { cookie: who.cookie, site: 'none' });
    return { status: res.status, text: await res.text() };
  };

  it('the overview shows the server use to owners and admins only, and the grant page its own count', async () => {
    const s = await panel();
    const owner = await html(s, '/admin', 'owner@example.test');
    expect(owner.text).toContain('Writes this hour');
    expect(owner.text).toContain('1 of 20 used this hour (19 left)');
    expect((await html(s, '/admin', 'admin@example.test')).text).toContain('Writes this hour');
    const member = await html(s, '/admin', 'alice@example.test');
    expect(member.status).toBe(200);
    expect(member.text).not.toContain('Writes this hour');
    expect(member.text).not.toContain('of 20 used');
    const grant = await html(s, `/admin/grants/${s.w.ids.aliceGrant}`, 'admin@example.test');
    expect(grant.text).toContain('1 of 5 used this hour (4 left)');
  });

  it('shows nothing about writes when write tools are off', async () => {
    const s = await setup();
    const owner = await html(s as never, '/admin', 'owner@example.test');
    expect(owner.text).not.toContain('Writes this hour');
    const grant = await html(s as never, `/admin/grants/${s.w.ids.aliceGrant}`, 'owner@example.test');
    expect(grant.text).not.toContain('used this hour');
  });
});
