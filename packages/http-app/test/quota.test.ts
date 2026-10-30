// SPDX-License-Identifier: Apache-2.0
// Per-grant quotas over HTTP (P8-09, THREAT_MODEL T5, L-116, L-080): a request is counted once per upstream call and
// written once, a grant over its quota is refused with no Agility call and no data, other grants are untouched, a
// counter outage fails open, and the usage shows in `whoami`, the admin API and the panel.
import { createLogger, createQuotaGate, type QuotaGate, type QuotaLimits } from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import { ADMIN_BASE } from '../src/index.ts';
import { setup } from './helpers/panel.ts';
import { ORIGIN, post, type World, world } from './helpers/world.ts';

const WHOAMI = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } };
const GET = (asset: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'get_assets', arguments: { assets: [asset] } },
});

/** A gate over a world's own kv (set after the world exists), counting statements. */
function gateFor(
  limits: QuotaLimits,
  now: () => number,
  failing: { reads?: boolean; writes?: boolean } = {},
) {
  let kv: Storage['kv'] | undefined;
  const stats = { reads: 0, writes: 0 };
  const logs: string[] = [];
  const gate: QuotaGate = createQuotaGate({
    logger: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    limits,
    clock: { now },
    counters: {
      getMany: (keys) => {
        stats.reads++;
        return failing.reads === true
          ? Promise.reject(new Error('kv down'))
          : (kv as Storage['kv']).getMany(keys);
      },
      incrementMany: (entries) => {
        stats.writes++;
        return failing.writes === true
          ? Promise.reject(new Error('kv down'))
          : (kv as Storage['kv']).incrementMany(entries);
      },
    },
  });
  return {
    gate,
    stats,
    logs,
    bind: (w: World) => {
      kv = w.storage.kv;
    },
  };
}

const DAY = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');

async function rig(limits: QuotaLimits, failing: { reads?: boolean; writes?: boolean } = {}) {
  const clock = { t: Date.UTC(2026, 9, 30, 12) };
  const g = gateFor(limits, () => clock.t, failing);
  const w = await world({}, { admin: true, services: { quota: g.gate } });
  g.bind(w);
  return { w, ...g, clock };
}

const counter = (w: World, key: string) => w.storage.kv.get(key);

describe('counting over HTTP', () => {
  it('writes one increment per period for a whole request, whatever it asked of Agility', async () => {
    const { w, stats, clock } = await rig({ daily: 100, monthly: 1000 });
    const before = w.fake.calls.length;
    await (await post(w, 'team-a', w.tokens.alice, GET('B-00001'))).text();
    const calls = w.fake.calls.slice(before);
    // Metadata requests reach Agility but are not counted (D-316).
    const asked = calls.filter((c) => !c.path.startsWith('meta.v1')).length;
    expect(asked).toBeGreaterThan(0);
    expect(stats).toEqual({ reads: 1, writes: 1 });
    expect(await counter(w, `qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`)).toBe(String(asked));
    expect(await counter(w, `qt:m:${w.ids.aliceGrant}:202610`)).toBe(String(asked));
  });

  it('counts concurrent requests of one grant without losing any', async () => {
    const { w, clock } = await rig({ daily: 100_000, monthly: null });
    const before = w.fake.calls.length;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        Promise.resolve(post(w, 'team-a', w.tokens.alice, GET('B-00001'))).then((r) => r.text()),
      ),
    );
    expect(results).toHaveLength(12);
    const asked = w.fake.calls.slice(before).filter((c) => !c.path.startsWith('meta.v1')).length;
    expect(await counter(w, `qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`)).toBe(String(asked));
  });
});

describe('the counters on Workers (P-2)', () => {
  it('are written after the response when the host has a background hook, and not lost', async () => {
    const clock = { t: Date.UTC(2026, 9, 30, 12) };
    const g = gateFor({ daily: 100, monthly: null }, () => clock.t);
    const background: Promise<unknown>[] = [];
    // A counter write that waits for us: the response must not.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: QuotaGate = {
      ...g.gate,
      meterFor: (grant) => {
        const meter = g.gate.meterFor(grant);
        return {
          ...meter,
          flush: async () => {
            await gate;
            await meter.flush();
          },
        };
      },
    };
    const w = await world(
      { background: (_c, work) => background.push(work) },
      { admin: true, services: { quota: slow } },
    );
    g.bind(w);
    const res = await post(w, 'team-a', w.tokens.alice, GET('B-00001'));
    expect(await res.text()).toContain('In A');
    expect(await counter(w, `qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`)).toBeNull();
    release();
    await Promise.all(background);
    expect(await counter(w, `qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`)).not.toBeNull();
  });
});

describe('refusal over HTTP', () => {
  it('refuses a grant over its quota with no Agility call and no data, and leaves other grants alone', async () => {
    const { w, clock } = await rig({ daily: 100, monthly: null });
    await w.storage.kv.set(`qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`, '100');
    const before = w.agilityTokens.length;
    const res = await post(w, 'team-a', w.tokens.alice, GET('B-00001'));
    const text = await res.text();
    expect(text).toContain('AB_LIMIT_QUOTA');
    expect(text).toContain('quota for today');
    expect(text).not.toContain('In A');
    expect(w.agilityTokens.length).toBe(before);
    // The same person's other grant (another workspace) and another person's grant have their own counters.
    const other = await post(w, 'team-b', w.tokens.aliceB, GET('B-00002'));
    expect(await other.text()).toContain('In B');
    expect(await counter(w, `qt:d:${w.ids.aliceGrantB}:${DAY(clock.t)}`)).not.toBeNull();
    // The counter of the refused grant did not move.
    expect(await counter(w, `qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`)).toBe('100');
  });

  it('a denied request never reads or writes a counter', async () => {
    const { w, stats } = await rig({ daily: 5, monthly: 10 });
    const denied = await post(w, 'team-a', w.tokens.bob, GET('B-00001'));
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain('In A');
    const nobody = await post(w, 'team-a', null, GET('B-00001'));
    expect(nobody.status).toBe(401);
    expect(stats).toEqual({ reads: 0, writes: 0 });
  });

  it('resets at the next UTC day', async () => {
    const { w, clock } = await rig({ daily: 100, monthly: null });
    await w.storage.kv.set(`qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`, '100');
    expect(await (await post(w, 'team-a', w.tokens.alice, GET('B-00001'))).text()).toContain(
      'AB_LIMIT_QUOTA',
    );
    clock.t = Date.UTC(2026, 9, 31, 0, 0, 1);
    expect(await (await post(w, 'team-a', w.tokens.alice, GET('B-00001'))).text()).toContain('In A');
  });
});

describe('a counter outage fails open', () => {
  it('answers when the counters cannot be read, and when they cannot be written', async () => {
    for (const failing of [{ reads: true }, { writes: true }]) {
      const { w, logs } = await rig({ daily: 1000, monthly: 1000 }, failing);
      const res = await post(w, 'team-a', w.tokens.alice, GET('B-00001'));
      const text = await res.text();
      expect(text, JSON.stringify(failing)).toContain('In A');
      expect(text).not.toContain('AB_LIMIT_QUOTA');
      expect(logs.join('\n')).toMatch(/quota counters could not be (read|updated)/);
    }
  });
});

describe('whoami', () => {
  it('shows used, left, the UTC reset and the warning, and nothing without a quota', async () => {
    const { w, clock } = await rig({ daily: 10, monthly: 100 });
    await w.storage.kv.set(`qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`, '7');
    const text = await (await post(w, 'team-a', w.tokens.alice, WHOAMI)).text();
    expect(text).toContain('"quota"');
    expect(text).toMatch(
      /"daily":\{"used":\d+,"limit":10,"remaining":\d+,"resetsAt":"2026-10-31T00:00:00.000Z","warning":true\}/,
    );
    expect(text).toContain('8 of 10 Agility requests used today');
    const off = await world();
    expect(await (await post(off, 'team-a', off.tokens.alice, WHOAMI)).text()).not.toContain('"quota"');
  });

  it('says unknown, never unlimited, when the counters cannot be read', async () => {
    const { w } = await rig({ daily: 10, monthly: null }, { reads: true });
    const text = await (await post(w, 'team-a', w.tokens.alice, WHOAMI)).text();
    expect(text).toContain('"quota":{"status":"unknown"}');
  });
});

type Who = 'none' | 'member' | 'admin' | 'owner';
const get = (w: World, who: Who, path: string) =>
  w.app.fetch(
    new Request(`${ORIGIN}${ADMIN_BASE}${path}`, { headers: who === 'none' ? {} : { 'x-test-actor': who } }),
  );

describe('GET /grants/{id}/usage', () => {
  it('shows a manager any grant and a member only their own; another grant and a stranger get nothing', async () => {
    const { w, clock } = await rig({ daily: 10, monthly: 100 });
    await w.storage.kv.set(`qt:d:${w.ids.aliceGrant}:${DAY(clock.t)}`, '4');
    await w.storage.kv.set(`qt:d:${w.ids.bobGrant}:${DAY(clock.t)}`, '9');
    for (const who of ['owner', 'admin', 'member'] as const) {
      const body = await (await get(w, who, `/grants/${w.ids.aliceGrant}/usage`)).json();
      expect(body, who).toMatchObject({
        enabled: true,
        status: 'ok',
        daily: { limit: 10, used: 4, remaining: 6, warn: false },
        monthly: { limit: 100, used: 0 },
      });
    }
    const other = await get(w, 'member', `/grants/${w.ids.bobGrant}/usage`);
    expect(other.status).toBe(404);
    expect(await other.text()).not.toMatch(/used|remaining|limit"/);
    expect((await get(w, 'member', '/grants/grt_missing/usage')).status).toBe(404);
    expect((await get(w, 'none', `/grants/${w.ids.aliceGrant}/usage`)).status).toBe(401);
  });

  it('reads nothing for a hidden grant, says disabled without a quota, and unknown when the counters fail', async () => {
    const { w, stats } = await rig({ daily: 10, monthly: null });
    await get(w, 'member', `/grants/${w.ids.bobGrant}/usage`);
    await get(w, 'none', `/grants/${w.ids.aliceGrant}/usage`);
    expect(stats.reads).toBe(0);
    const off = await world({}, { admin: true });
    expect(await (await get(off, 'owner', `/grants/${off.ids.aliceGrant}/usage`)).json()).toEqual({
      enabled: false,
    });
    const down = await rig({ daily: 10, monthly: null }, { reads: true });
    expect(await (await get(down.w, 'owner', `/grants/${down.w.ids.aliceGrant}/usage`)).json()).toEqual({
      enabled: true,
      status: 'unknown',
    });
  });
});

describe('the panel', () => {
  it('shows the grant usage on its page, and nothing when no quota is set', async () => {
    const clock = { t: Date.UTC(2026, 9, 30, 12) };
    const g = gateFor({ daily: 10, monthly: 100 }, () => clock.t);
    const s = await setup({ services: { quota: g.gate } });
    g.bind(s.w);
    await s.w.storage.kv.set(`qt:d:${s.w.ids.aliceGrant}:${DAY(clock.t)}`, '9');
    const owner = await s.session('owner@example.test');
    const page = await (
      await s.send('GET', `/admin/grants/${s.w.ids.aliceGrant}`, { cookie: owner.cookie, site: 'none' })
    ).text();
    expect(page).toContain('Agility requests');
    expect(page).toContain('9 of 10 today (1 left, over 80%)');
    expect(page).toContain('0 of 100 this month (100 left)');

    const none = await setup();
    const ownerNone = await none.session('owner@example.test');
    const plain = await (
      await none.send('GET', `/admin/grants/${none.w.ids.aliceGrant}`, {
        cookie: ownerNone.cookie,
        site: 'none',
      })
    ).text();
    expect(plain).not.toContain('Agility requests');
  });
});
