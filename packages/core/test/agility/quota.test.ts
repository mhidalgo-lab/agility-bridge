// SPDX-License-Identifier: Apache-2.0
// Per-grant quotas (P8-09, THREAT_MODEL T5, L-116, L-080): logical counting, refusal before any upstream call, UTC
// periods, per-grant isolation, the 80% warning and the fail-open behaviour on a counter outage.
import { describe, expect, it } from 'vitest';
import {
  AbError,
  agilityClient,
  createBudget,
  createLogger,
  createQuotaGate,
  QueryCache,
  type QuotaCounters,
  type QuotaGate,
  type QuotaLimits,
  randomMac,
} from '../../src/index.ts';
import { makeContext } from '../helpers/context.ts';
import { fakeFetch, json } from './fake.ts';

/** In-memory counters that record how often they are touched. */
function counters(over: Partial<QuotaCounters> = {}) {
  const data = new Map<string, number>();
  const stats = { reads: 0, increments: 0 };
  const c: QuotaCounters & { data: Map<string, number>; stats: typeof stats } = {
    data,
    stats,
    async getMany(keys) {
      stats.reads++;
      return new Map(keys.filter((k) => data.has(k)).map((k) => [k, String(data.get(k))]));
    },
    async increment(key, { by }) {
      stats.increments++;
      const next = (data.get(key) ?? 0) + by;
      data.set(key, next);
      return next;
    },
    ...over,
  };
  return c;
}

const NOON = Date.UTC(2026, 9, 30, 12);
const QUERY = { from: 'Story', select: ['Name'] };

function setup(
  limits: QuotaLimits,
  over: { counters?: ReturnType<typeof counters>; now?: { t: number } } = {},
) {
  const store = over.counters ?? counters();
  const clock = over.now ?? { t: NOON };
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
  const gate = createQuotaGate({ counters: store, clock: { now: () => clock.t }, limits, logger });
  return { store, clock, gate, logs };
}

function clientFor(gate: QuotaGate, grant: string, responder = () => json([[{ Name: 'x' }]])) {
  const fetch = fakeFetch(responder);
  const meter = gate.meterFor(grant);
  const ctx = makeContext({ fetch, budget: createBudget(50), quota: meter });
  return { fetch, meter, client: agilityClient(ctx, { sleep: async () => {} }), ctx };
}

const refusal = async (p: Promise<unknown>): Promise<AbError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AbError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('counting', () => {
  it('counts every logical upstream call once, writes the total once, and reads once per request', async () => {
    const { gate, store } = setup({ daily: 100, monthly: 1000 });
    const { client, meter } = clientFor(gate, 'g1');
    for (let i = 0; i < 5; i++) await client.query({ ...QUERY, page: { size: i + 1 } });
    await client.meta('Story');
    expect(store.stats).toEqual({ reads: 1, increments: 0 });
    await meter.flush();
    expect(store.stats).toEqual({ reads: 1, increments: 2 });
    expect([...store.data.entries()].sort()).toEqual([
      ['qt:d:g1:20261030', 6],
      ['qt:m:g1:202610', 6],
    ]);
    // Nothing left to write: a second flush touches nothing.
    await meter.flush();
    expect(store.stats.increments).toBe(2);
  });

  it('counts a retried call once, not once per attempt', async () => {
    const { gate, store } = setup({ daily: 100, monthly: null });
    let n = 0;
    const { client, meter, ctx } = clientFor(gate, 'g1', () =>
      ++n < 3 ? new Response('', { status: 503 }) : json([[{ Name: 'x' }]]),
    );
    await client.query(QUERY);
    expect(ctx.budget.used).toBe(3);
    await meter.flush();
    expect(store.data.get('qt:d:g1:20261030')).toBe(1);
    expect(store.data.has('qt:m:g1:202610')).toBe(false);
  });

  it('counts a call that fails upstream, and a request of cache hits only touches nothing', async () => {
    const { gate, store } = setup({ daily: 100, monthly: 1000 });
    const failing = clientFor(gate, 'g1', () => new Response('{}', { status: 404 }));
    await expect(failing.client.query(QUERY)).rejects.toThrow();
    await failing.meter.flush();
    expect(store.data.get('qt:d:g1:20261030')).toBe(1);

    // The same read answered by the query cache asks nothing and counts nothing.
    const cache = new QueryCache({ ttlMs: 30_000, mac: randomMac(), clock: { now: () => NOON } });
    const scope = { cache, grantId: 'g2', principal: 'cred:c' };
    const first = gate.meterFor('g2');
    const live = agilityClient(
      makeContext({ fetch: fakeFetch(() => json([[{ Name: 'x' }]])), quota: first, queryCache: scope }),
    );
    await live.query(QUERY);
    await first.flush();
    const before = { ...store.stats };
    const again = gate.meterFor('g2');
    const hit = agilityClient(
      makeContext({ fetch: fakeFetch(() => json([[{ Name: 'y' }]])), quota: again, queryCache: scope }),
    );
    expect((await hit.query(QUERY)).data).toEqual([[{ Name: 'x' }]]);
    await again.flush();
    expect(store.stats).toEqual(before);
    expect(store.data.get('qt:d:g2:20261030')).toBe(1);
  });
});

describe('refusal', () => {
  it('refuses a read before it is sent once the day is used up, and says when it restarts', async () => {
    const { gate, store } = setup({ daily: 3, monthly: null });
    store.data.set('qt:d:g1:20261030', 2);
    const { client, fetch, meter } = clientFor(gate, 'g1');
    await client.query(QUERY);
    const e = await refusal(client.query({ ...QUERY, page: { size: 2 } }));
    expect(e.code).toBe('AB_LIMIT_QUOTA');
    expect(e.details).toMatchObject({
      scope: 'daily',
      limit: 3,
      used: 3,
      resetsAt: '2026-10-31T00:00:00.000Z',
    });
    expect(e.hint).toContain('2026-10-31T00:00:00.000Z');
    expect(fetch.calls).toHaveLength(1);
    // The refused call was not counted.
    await meter.flush();
    expect(store.data.get('qt:d:g1:20261030')).toBe(3);
  });

  it('a refused call spends no unit of the request budget (Q-4)', async () => {
    const { gate, store } = setup({ daily: 1, monthly: null });
    store.data.set('qt:d:g1:20261030', 1);
    const { client, ctx } = clientFor(gate, 'g1');
    expect((await refusal(client.query(QUERY))).code).toBe('AB_LIMIT_QUOTA');
    expect(ctx.budget.used).toBe(0);
  });

  it('an exhausted request budget refuses first and does not count a quota unit (Q-4)', async () => {
    const { gate, store } = setup({ daily: 100, monthly: null });
    const fetch = fakeFetch(() => json([[{ Name: 'x' }]]));
    const meter = gate.meterFor('g1');
    const ctx = makeContext({ fetch, budget: createBudget(1), quota: meter });
    const client = agilityClient(ctx, { sleep: async () => {} });
    await client.query(QUERY);
    expect((await refusal(client.query({ ...QUERY, page: { size: 2 } }))).code).toBe('AB_BUDGET_EXHAUSTED');
    await meter.flush();
    expect(store.data.get('qt:d:g1:20261030')).toBe(1);
  });

  it('the monthly period refuses too, and names itself', async () => {
    const { gate, store } = setup({ daily: 1000, monthly: 10 });
    store.data.set('qt:m:g1:202610', 10);
    const { client, fetch } = clientFor(gate, 'g1');
    const e = await refusal(client.query(QUERY));
    expect(e.details).toMatchObject({ scope: 'monthly', limit: 10, resetsAt: '2026-11-01T00:00:00.000Z' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('stops a request in the middle: the calls it already made count against its own limit', async () => {
    const { gate } = setup({ daily: 2, monthly: null });
    const { client, fetch } = clientFor(gate, 'g1');
    await client.query(QUERY);
    await client.meta('Story');
    expect((await refusal(client.query(QUERY))).code).toBe('AB_LIMIT_QUOTA');
    expect(fetch.calls).toHaveLength(2);
  });

  it('counts a write but never refuses it, even over the quota', async () => {
    const { gate, store } = setup({ daily: 1, monthly: null });
    store.data.set('qt:d:g1:20261030', 5);
    const { client, fetch, meter } = clientFor(gate, 'g1', () => new Response('<Asset/>', { status: 200 }));
    await client.restWrite('Story', 1001, '<Asset/>');
    expect(fetch.calls).toHaveLength(1);
    await meter.flush();
    expect(store.data.get('qt:d:g1:20261030')).toBe(6);
    // A read in the same state is refused.
    expect((await refusal(clientFor(gate, 'g1').client.query(QUERY))).code).toBe('AB_LIMIT_QUOTA');
  });

  it('never mixes grants: one grant over its quota leaves another untouched', async () => {
    const { gate, store } = setup({ daily: 2, monthly: 5 });
    store.data.set('qt:d:g1:20261030', 2);
    const a = clientFor(gate, 'g1');
    const b = clientFor(gate, 'g2');
    expect((await refusal(a.client.query(QUERY))).code).toBe('AB_LIMIT_QUOTA');
    await b.client.query(QUERY);
    await b.meter.flush();
    expect(store.data.get('qt:d:g2:20261030')).toBe(1);
    expect(a.fetch.calls).toHaveLength(0);
  });

  it('with no limit configured it gates and counts nothing', async () => {
    const { gate, store } = setup({ daily: null, monthly: null });
    const { client, meter } = clientFor(gate, 'g1');
    await client.query(QUERY);
    await meter.flush();
    expect(store.stats).toEqual({ reads: 0, increments: 0 });
    expect(await gate.usageOf('g1')).toEqual({ status: 'ok' });
  });
});

describe('periods', () => {
  it('start over at the next UTC midnight and the first of the next UTC month', async () => {
    const now = { t: Date.UTC(2026, 9, 31, 23, 59, 59) };
    const { gate, store } = setup({ daily: 1, monthly: 2 }, { now });
    store.data.set('qt:d:g1:20261031', 1);
    store.data.set('qt:m:g1:202610', 1);
    expect((await refusal(clientFor(gate, 'g1').client.query(QUERY))).details).toMatchObject({
      scope: 'daily',
    });
    now.t = Date.UTC(2026, 10, 1, 0, 0, 1);
    // A new day and a new month: both counters are different keys.
    const c = clientFor(gate, 'g1');
    await c.client.query(QUERY);
    await c.meter.flush();
    expect(store.data.get('qt:d:g1:20261101')).toBe(1);
    expect(store.data.get('qt:m:g1:202611')).toBe(1);
  });

  it('give the counters an expiry at the end of their period', async () => {
    const seen: Array<{ key: string; expiresAt: number }> = [];
    const store = counters({
      increment: async (key, o) => {
        seen.push({ key, expiresAt: o.expiresAt });
        return o.by;
      },
    });
    const { gate } = setup({ daily: 10, monthly: 100 }, { counters: store });
    const c = clientFor(gate, 'g1');
    await c.client.query(QUERY);
    await c.meter.flush();
    expect(seen).toEqual([
      { key: 'qt:d:g1:20261030', expiresAt: Date.UTC(2026, 9, 31) },
      { key: 'qt:m:g1:202610', expiresAt: Date.UTC(2026, 10, 1) },
    ]);
  });
});

describe('usage and the 80% warning', () => {
  it('reports used, left, the reset and the warning flag, including this request', async () => {
    const { gate, store } = setup({ daily: 10, monthly: 100 });
    store.data.set('qt:d:g1:20261030', 7);
    const c = clientFor(gate, 'g1');
    await c.client.query(QUERY);
    expect(await c.meter.usage()).toEqual({
      status: 'ok',
      daily: { limit: 10, used: 8, remaining: 2, resetsAt: Date.UTC(2026, 9, 31), warn: true },
      monthly: { limit: 100, used: 1, remaining: 99, resetsAt: Date.UTC(2026, 10, 1), warn: false },
    });
    // The stored view of another read (the panel) sees nothing of the unflushed call.
    expect((await gate.usageOf('g1')).status).toBe('ok');
    await c.meter.flush();
    expect(await c.meter.usage()).toMatchObject({ daily: { used: 8 } });
  });

  it('logs once, in the request that crosses 80% of a period', async () => {
    const { gate, store, logs } = setup({ daily: 10, monthly: null });
    store.data.set('qt:d:g1:20261030', 6);
    const first = clientFor(gate, 'g1');
    await first.client.query(QUERY);
    await first.meter.flush();
    expect(logs.filter((l) => l.includes('grant quota reached 80%'))).toHaveLength(0);
    const second = clientFor(gate, 'g1');
    await second.client.query(QUERY);
    await second.meter.flush();
    expect(logs.filter((l) => l.includes('grant quota reached 80%'))).toHaveLength(1);
    const third = clientFor(gate, 'g1');
    await third.client.query(QUERY);
    await third.meter.flush();
    expect(logs.filter((l) => l.includes('grant quota reached 80%'))).toHaveLength(1);
  });
});

describe('a counter outage fails open (L-080)', () => {
  it('lets reads through when the counters cannot be read, logs it, and reports unknown', async () => {
    const store = counters({ getMany: () => Promise.reject(new Error('d1 down')) });
    const { gate, logs } = setup({ daily: 1, monthly: 1 }, { counters: store });
    const c = clientFor(gate, 'g1');
    await c.client.query(QUERY);
    await c.client.query({ ...QUERY, page: { size: 3 } });
    expect(c.fetch.calls).toHaveLength(2);
    expect(await c.meter.usage()).toEqual({ status: 'unknown' });
    expect(await gate.usageOf('g1')).toEqual({ status: 'unknown' });
    expect(logs.some((l) => l.includes('quota counters could not be read'))).toBe(true);
    expect(logs.join('\n')).not.toContain('d1 down');
  });

  it('survives a failing increment: the result stands, the outage is logged, nothing throws', async () => {
    const store = counters({ increment: () => Promise.reject(new Error('d1 down')) });
    const { gate, logs } = setup({ daily: 10, monthly: 10 }, { counters: store });
    const c = clientFor(gate, 'g1');
    expect((await c.client.query(QUERY)).data).toEqual([[{ Name: 'x' }]]);
    await expect(c.meter.flush()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('quota counters could not be updated'))).toBe(true);
  });

  it('does not trust a counter that is not a whole number', async () => {
    const store = counters();
    store.data.set('qt:d:g1:20261030', Number.NaN);
    const { gate } = setup({ daily: 1, monthly: null }, { counters: store });
    const c = clientFor(gate, 'g1');
    await c.client.query(QUERY);
    expect(await c.meter.usage()).toEqual({ status: 'unknown' });
  });
});
