// SPDX-License-Identifier: Apache-2.0
// The query cache (P8-01, THREAT_MODEL T16, L-113): every scope dimension changes the entry id, a hit costs no budget,
// writers and `fresh` reads never use it, and failures of the cache never fail a read.
import { describe, expect, it } from 'vitest';
import {
  agilityClient,
  createBudget,
  DEFAULT_LIMITS,
  QueryCache,
  type QueryCacheScope,
  randomMac,
  type SharedTier,
  type ToolContext,
  type WriteRuntime,
} from '../../src/index.ts';
import { makeContext } from '../helpers/context.ts';
import { fakeFetch, json } from './fake.ts';

const QUERY = { from: 'Story', select: ['Name'], page: { size: 5, start: 0 } };
const ROWS = [[{ _oid: 'Story:1', Name: 'A synthetic story' }]];

function cacheWith(over: Partial<ConstructorParameters<typeof QueryCache>[0]> = {}, clock = { t: 0 }) {
  const cache = new QueryCache({ ttlMs: 10_000, mac: randomMac(), clock: { now: () => clock.t }, ...over });
  return { cache, clock };
}

function scopeFor(cache: QueryCache, over: Partial<QueryCacheScope> = {}): QueryCacheScope {
  return { cache, grantId: 'grant-1', principal: 'cred:c1', ...over };
}

describe('QueryCache entry ids', () => {
  it('differ for every scope dimension and agree for the same scope and a reordered query', async () => {
    const { cache } = cacheWith();
    const ctx = makeContext();
    const scope = scopeFor(cache);
    const base = await cache.key(ctx, scope, 'query.v1', QUERY);
    const reordered = { page: { start: 0, size: 5 }, select: ['Name'], from: 'Story' };
    expect(await cache.key(ctx, scope, 'query.v1', reordered)).toBe(base);
    const other = (over: Partial<ToolContext>) => cache.key({ ...ctx, ...over }, scope, 'query.v1', QUERY);
    const variants: Array<[string, () => Promise<string>]> = [
      ['endpoint', () => cache.key(ctx, scope, 'query.legacy.v1', QUERY)],
      ['query', () => cache.key(ctx, scope, 'query.v1', { ...QUERY, select: ['Number'] })],
      ['grant', () => cache.key(ctx, scopeFor(cache, { grantId: 'grant-2' }), 'query.v1', QUERY)],
      ['principal', () => cache.key(ctx, scopeFor(cache, { principal: 'pt:abc' }), 'query.v1', QUERY)],
      ['workspace', () => other({ workspace: { ...ctx.workspace, id: 'other' } })],
      ['instance id', () => other({ instance: { ...ctx.instance, id: 'other' } })],
      [
        'instance url',
        () => other({ instance: { ...ctx.instance, baseUrl: 'https://other.example.com/X' } }),
      ],
      ['projects', () => other({ projects: { allowed: ['Scope:1'], includeChildren: true } })],
      ['include children', () => other({ projects: { allowed: [], includeChildren: false } })],
      ['asset types', () => other({ assetTypes: { deny: ['Epic'] } })],
      ['limits', () => other({ limits: { ...DEFAULT_LIMITS, maxRows: 7 } })],
      ['credential kind', () => other({ credential: { ...ctx.credential, kind: 'shared' } })],
    ];
    const seen = new Set([base]);
    for (const [name, make] of variants) {
      const id = await make();
      expect(seen.has(id), name).toBe(false);
      seen.add(id);
    }
  });

  it('are keyed: two caches (two processes) never agree on an id', async () => {
    const ctx = makeContext();
    const a = cacheWith().cache;
    const b = cacheWith().cache;
    const idA = await a.key(ctx, scopeFor(a), 'query.v1', QUERY);
    expect(idA).not.toBe(await b.key(ctx, scopeFor(b), 'query.v1', QUERY));
  });
});

describe('QueryCache storage', () => {
  it('expires entries after the TTL', async () => {
    const { cache, clock } = cacheWith();
    await cache.put('a', 'x', false);
    expect(await cache.get('a', false)).toBe('x');
    clock.t = 10_000;
    expect(await cache.get('a', false)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry past the entry bound and the byte bound', async () => {
    const { cache } = cacheWith({ maxEntries: 2 });
    await cache.put('a', '1', false);
    await cache.put('b', '2', false);
    await cache.get('a', false);
    await cache.put('c', '3', false);
    expect(await cache.get('b', false)).toBeUndefined();
    expect(await cache.get('a', false)).toBe('1');
    expect(await cache.get('c', false)).toBe('3');

    const bytes = cacheWith({ maxBytes: 10, maxEntryBytes: 8 }).cache;
    await bytes.put('a', '123456', false);
    await bytes.put('b', '123456', false);
    expect(bytes.size).toBe(1);
    await bytes.put('c', '123456789', false);
    expect(await bytes.get('c', false)).toBeUndefined();
  });

  it('rejects a TTL outside 1 ms to 60 s', () => {
    for (const ttlMs of [0, 60_001, 1.5]) expect(() => cacheWith({ ttlMs })).toThrow(RangeError);
  });

  it('uses the shared tier on a miss, promotes the answer, and treats a failing tier as a miss', async () => {
    const stored = new Map<string, string>([['k', '0:from-tier']]);
    const tier: SharedTier = {
      get: async (id) => stored.get(id),
      set: async (id, text) => void stored.set(id, text),
      status: () => 'verified',
    };
    const { cache } = cacheWith({ shared: tier });
    expect(await cache.get('k', true)).toBe('from-tier');
    expect(await cache.get('k', false)).toBe('from-tier');
    expect(await cacheWith({ shared: tier }).cache.get('k', false)).toBeUndefined();
    await cache.put('n', 'new', true);
    expect(stored.get('n')).toBe('0:new');
    await cache.put('only-memory', 'v', false);
    expect(stored.has('only-memory')).toBe(false);
    const broken = cacheWith({
      shared: {
        get: () => Promise.reject(new Error('down')),
        set: () => Promise.reject(new Error('down')),
        status: () => 'unavailable',
      },
    }).cache;
    await broken.put('x', 'y', true);
    expect(await broken.get('z', true)).toBeUndefined();
    expect(broken.info().shared).toBe('unavailable');
  });
});

describe('the shared tier and the clock (Q-1)', () => {
  const tierOver = (stored: Map<string, string>): SharedTier => ({
    get: async (id) => stored.get(id),
    set: async (id, text) => void stored.set(id, text),
    status: () => 'verified',
  });

  it('a promoted copy keeps the age it had in the shared tier, so an answer never lives past one TTL', async () => {
    const stored = new Map<string, string>();
    const a = cacheWith({ shared: tierOver(stored), ttlMs: 30_000 }, { t: 0 });
    await a.cache.put('k', 'v', true);
    // Another isolate reads it at 29 s and keeps it in memory.
    const b = cacheWith({ shared: tierOver(stored), ttlMs: 30_000 }, { t: 29_000 });
    expect(await b.cache.get('k', true)).toBe('v');
    // At 31 s the data is older than the TTL: neither the promoted copy nor the shared tier may answer.
    b.clock.t = 31_000;
    expect(await b.cache.get('k', true)).toBeUndefined();
    b.clock.t = 55_000;
    expect(await b.cache.get('k', true)).toBeUndefined();
  });

  it('treats an entry without a readable write time, or from the future, as a miss or as fresh-now', async () => {
    const stored = new Map<string, string>([
      ['bare', 'no-prefix'],
      ['future', '99999:later'],
    ]);
    const { cache } = cacheWith({ shared: tierOver(stored), ttlMs: 30_000 }, { t: 1_000 });
    expect(await cache.get('bare', true)).toBeUndefined();
    expect(await cache.get('future', true)).toBe('later');
  });
});

describe('the client with a cache', () => {
  function build(over: Partial<ToolContext> = {}, cacheOver: Partial<QueryCacheScope> = {}) {
    const { cache } = cacheWith();
    const fetch = fakeFetch(() => json(ROWS));
    const ctx = makeContext({
      fetch,
      budget: createBudget(10),
      queryCache: scopeFor(cache, cacheOver),
      ...over,
    });
    return { cache, fetch, ctx, client: agilityClient(ctx) };
  }

  it('answers a repeated read from memory without a request or a budget unit', async () => {
    const { client, fetch, ctx } = build();
    const first = await client.query(QUERY);
    const second = await client.query(QUERY);
    expect(second.data).toEqual(first.data);
    expect(second.bytes).toBe(first.bytes);
    expect(fetch.calls).toHaveLength(1);
    expect(ctx.budget.used).toBe(1);
  });

  it('hands every hit its own copy of the data', async () => {
    const { client } = build();
    await client.query(QUERY);
    const a = await client.query<unknown[][]>(QUERY);
    (a.data[0] as unknown[]).length = 0;
    expect(((await client.query<unknown[][]>(QUERY)).data[0] as unknown[]).length).toBe(1);
  });

  it('never shares an answer between scopes of one cache', async () => {
    const { cache } = cacheWith();
    const calls: string[] = [];
    const mk = (id: string, scope: Partial<QueryCacheScope>, over: Partial<ToolContext> = {}) =>
      agilityClient(
        makeContext({
          fetch: fakeFetch(() => {
            calls.push(id);
            return json([[{ Name: `answer for ${id}` }]]);
          }),
          queryCache: scopeFor(cache, scope),
          ...over,
        }),
      );
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const answers = [
      await mk('a', {}).query(QUERY),
      await mk('b', { grantId: 'grant-2' }).query(QUERY),
      await mk('c', { principal: 'pt:other' }).query(QUERY),
      await mk('d', {}, { workspace: { ...makeContext().workspace, id: 'ws-2' } }).query(QUERY),
      await mk('e', {}, { projects: { allowed: ['Scope:9'], includeChildren: false } }).query(QUERY),
    ];
    expect(calls).toEqual(ids);
    expect(answers.map((r) => JSON.stringify(r.data))).toEqual(
      ids.map((id) => JSON.stringify([[{ Name: `answer for ${id}` }]])),
    );
    // And each scope now hits its own entry.
    await mk('again', {}).query(QUERY);
    expect(calls).not.toContain('again');
  });

  it('skips the cache for `fresh` reads and for callers with write tools, and stores nothing then', async () => {
    const fresh = build();
    await fresh.client.query(QUERY, { fresh: true });
    await fresh.client.query(QUERY, { fresh: true });
    expect(fresh.fetch.calls).toHaveLength(2);
    expect(fresh.cache.size).toBe(0);

    const writer = build({ writes: {} as WriteRuntime });
    await writer.client.query(QUERY);
    await writer.client.query(QUERY);
    expect(writer.fetch.calls).toHaveLength(2);
    expect(writer.cache.size).toBe(0);
  });

  it('is bypassed by the caller own write tools, not by the workspace enabling writes (Q-11)', async () => {
    const readOnly = build({
      workspace: { ...makeContext().workspace, writes: { enabled: true, approval: 'page' } },
    });
    await readOnly.client.query(QUERY);
    await readOnly.client.query(QUERY);
    expect(readOnly.fetch.calls).toHaveLength(1);
  });

  it('does not encode or store an answer above the entry cap (P-4)', async () => {
    const { cache } = cacheWith({ maxEntryBytes: 20 });
    const fetch = fakeFetch(() => json(ROWS));
    const client = agilityClient(makeContext({ fetch, queryCache: scopeFor(cache) }));
    await client.query(QUERY);
    await client.query(QUERY);
    expect(fetch.calls).toHaveLength(2);
    expect(cache.size).toBe(0);
    expect(cache.accepts(21)).toBe(false);
    expect(cache.accepts(20)).toBe(true);
  });

  it('does not cache a failed read and keeps working when the cache itself fails', async () => {
    const { cache } = cacheWith();
    let n = 0;
    const fetch = fakeFetch(() => (++n === 1 ? json({ error: 'x' }, { status: 404 }) : json(ROWS)));
    const client = agilityClient(makeContext({ fetch, queryCache: scopeFor(cache) }));
    await expect(client.query(QUERY)).rejects.toThrow();
    expect((await client.query(QUERY)).data).toEqual(ROWS);
    expect(cache.size).toBe(1);

    const broken = { key: () => Promise.reject(new Error('mac')) } as unknown as QueryCache;
    const fetch2 = fakeFetch(() => json(ROWS));
    const c2 = agilityClient(makeContext({ fetch: fetch2, queryCache: scopeFor(broken) }));
    expect((await c2.query(QUERY)).data).toEqual(ROWS);
    expect(fetch2.calls).toHaveLength(1);
  });

  it('keeps meta, data and history requests out of the cache', async () => {
    const { client, fetch, cache } = build();
    await client.meta('Story');
    await client.meta('Story');
    await client.data('Story', 1);
    await client.data('Story', 1);
    expect(fetch.calls).toHaveLength(4);
    expect(cache.size).toBe(0);
  });
});
