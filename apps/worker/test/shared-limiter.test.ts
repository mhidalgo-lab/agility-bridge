// SPDX-License-Identifier: Apache-2.0
// The exact limiter on a Durable Object (P3-12) without workerd: the object over a fake storage and clock, the client
// over a fake namespace, and the failure policy of each control (L-080): request limits fail open, write limits closed.
import { type Clock, createLogger, createWriteLimiter, ErrorCode } from '@agility-bridge/core';
import { MemoryRateLimiter, type Rate } from '@agility-bridge/http-app';
import { describe, expect, it } from 'vitest';
import { BackstopRateLimiter } from '../src/rate-limit.ts';
import {
  type ObjectStorage,
  SHARDS,
  SharedLimiter,
  SharedLimiterClient,
  type SharedLimiterNamespace,
  shardOf,
} from '../src/shared-limiter.ts';

function fakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: ObjectStorage = {
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(keys) {
      let n = 0;
      for (const k of keys) if (data.delete(k)) n++;
      return n;
    },
    async list<T>({ prefix, limit }: { prefix: string; limit: number }) {
      const out = new Map<string, T>();
      for (const [k, v] of data) if (k.startsWith(prefix) && out.size < limit) out.set(k, v as T);
      return out;
    },
    async setAlarm(time) {
      alarm = time;
    },
    async getAlarm() {
      return alarm;
    },
  };
  return { data, storage, alarm: () => alarm };
}

function world() {
  const t = { now: 1_000_000 };
  const objects = new Map<string, { store: ReturnType<typeof fakeStorage>; object: SharedLimiter }>();
  const calls: string[] = [];
  const namespace: SharedLimiterNamespace & { fail?: 'throw' | 'status' | 'garbage' | 'timeout' } = {
    idFromName: (name) => name,
    get: (id) => ({
      async fetch(request) {
        calls.push(new URL(request.url).pathname);
        if (namespace.fail === 'throw') throw new Error('object unreachable');
        if (namespace.fail === 'status') return new Response('no', { status: 503 });
        if (namespace.fail === 'garbage') return new Response('{"ok":"yes"}');
        if (namespace.fail === 'timeout') throw new DOMException('timed out', 'TimeoutError');
        let entry = objects.get(id as string);
        if (entry === undefined) {
          const store = fakeStorage();
          entry = { store, object: new SharedLimiter({ storage: store.storage }, undefined, () => t.now) };
          objects.set(id as string, entry);
        }
        return entry.object.fetch(request);
      },
    }),
  };
  return { t, namespace, objects, calls, client: new SharedLimiterClient(namespace) };
}

const rate: Rate = { limit: 3, windowMs: 60_000 };

describe('the Durable Object', () => {
  it('takes from an exact token bucket, refills over time and reports the wait', async () => {
    const w = world();
    for (let i = 0; i < 3; i++) expect(await w.client.take('authfail:1.2.3.4', rate)).toEqual({ ok: true });
    expect(await w.client.take('authfail:1.2.3.4', rate)).toEqual({ ok: false, retryAfterSeconds: 20 });
    expect(await w.client.peek('authfail:1.2.3.4', rate)).toBe(false);
    expect(await w.client.take('authfail:5.6.7.8', rate)).toEqual({ ok: true });
    w.t.now += 20_000;
    expect(await w.client.peek('authfail:1.2.3.4', rate)).toBe(true);
    expect(await w.client.take('authfail:1.2.3.4', rate)).toEqual({ ok: true });
  });

  it('peek takes nothing', async () => {
    const w = world();
    for (let i = 0; i < 10; i++) expect(await w.client.peek('k', rate)).toBe(true);
    for (let i = 0; i < 3; i++) expect((await w.client.take('k', rate)).ok).toBe(true);
    expect((await w.client.take('k', rate)).ok).toBe(false);
  });

  it('counts a fixed window: the new count, null over max (nothing written), null once the window ended', async () => {
    const w = world();
    const end = w.t.now + 60_000;
    expect(await w.client.get('wl:all:1')).toBeNull();
    expect(await w.client.increment('wl:all:1', { expiresAt: end, max: 2 })).toBe(1);
    expect(await w.client.increment('wl:all:1', { expiresAt: end, max: 2 })).toBe(2);
    expect(await w.client.increment('wl:all:1', { expiresAt: end, max: 2 })).toBeNull();
    expect(await w.client.get('wl:all:1')).toBe('2');
    w.t.now = end + 1;
    expect(await w.client.get('wl:all:1')).toBeNull();
    expect(await w.client.increment('wl:all:1', { expiresAt: end + 60_000, max: 2 })).toBe(1);
  });

  it('uses its own clock: a caller cannot move a window by what it sends', async () => {
    const w = world();
    // An absurdly far window end is refused rather than stored.
    const stub = w.namespace.get('x');
    const bad = await stub.fetch(
      new Request('https://limiter.invalid/increment', {
        method: 'POST',
        body: JSON.stringify({ key: 'k', max: 1, expiresAt: w.t.now + 10 * 86_400_000 }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  it('refuses malformed requests without touching storage', async () => {
    const w = world();
    const stub = w.namespace.get('x');
    const post = (path: string, body: unknown, method = 'POST') =>
      stub.fetch(
        new Request(`https://limiter.invalid/${path}`, {
          method,
          ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        }),
      );
    expect((await post('take', { key: '', rate })).status).toBe(400);
    expect((await post('take', { key: 'x'.repeat(257), rate })).status).toBe(400);
    expect((await post('take', { key: 'k', rate: { limit: 0, windowMs: 1000 } })).status).toBe(400);
    expect((await post('take', { key: 'k', rate: { limit: 5, windowMs: 1 } })).status).toBe(400);
    expect((await post('increment', { key: 'k', max: -1, expiresAt: w.t.now })).status).toBe(400);
    expect((await post('take', 'not json')).status).toBe(400);
    expect((await post('explode', { key: 'k' })).status).toBe(404);
    expect((await post('take', {}, 'GET')).status).toBe(405);
    expect(w.objects.size).toBe(1);
    expect([...w.objects.values()][0]?.store.data.size).toBe(0);
  });

  it('spreads keys over shards, always the same shard for a key', async () => {
    const w = world();
    expect(shardOf('authfail:1.2.3.4')).toBe(shardOf('authfail:1.2.3.4'));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(shardOf(`authfail:10.0.${i}.1`));
    expect(seen.size).toBeGreaterThan(SHARDS / 2);
    for (const s of seen) expect(s).toBeLessThan(SHARDS);
    await w.client.take('authfail:1.2.3.4', rate);
    await w.client.take('authfail:1.2.3.4', rate);
    expect(w.objects.size).toBe(1);
  });

  it('sweeps expired rows in the alarm and stops when nothing is left', async () => {
    const t = { now: 0 };
    const store = fakeStorage();
    const object = new SharedLimiter({ storage: store.storage }, undefined, () => t.now);
    const post = (path: string, body: unknown) =>
      object.fetch(
        new Request(`https://limiter.invalid/${path}`, { method: 'POST', body: JSON.stringify(body) }),
      );
    await post('take', { key: 'a', rate });
    await post('increment', { key: 'b', max: 5, expiresAt: 30_000 });
    expect(store.data.size).toBe(2);
    expect(store.alarm()).not.toBeNull();
    t.now = 10_000;
    await object.alarm();
    expect(store.data.size).toBe(2); // nothing expired yet; asks to run again
    expect(store.alarm()).toBe(10_000 + 15 * 60_000);
    t.now = 2 * 3_600_000;
    await object.alarm();
    expect(store.data.size).toBe(0);
  });
});

const quiet = () => {
  const logs: string[] = [];
  return { logs, logger: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) };
};

describe('the composite limiter with the Durable Object (request limits fail open)', () => {
  const limiter = (w: ReturnType<typeof world>, logs = quiet()) =>
    new BackstopRateLimiter(
      new MemoryRateLimiter(),
      { shared: w.client, sharedPrefixes: ['authfail:', 'oauth:'] },
      logs.logger,
    );

  it('decides the shared prefixes exactly, and remembers a refusal so a flood costs no more calls', async () => {
    const w = world();
    const a = limiter(w);
    const b = limiter(w);
    for (let i = 0; i < 3; i++) expect((await a.take('authfail:9.9.9.9', rate, w.t.now)).ok).toBe(true);
    // Another isolate has a clean local bucket, and the object says the deployment-wide limit is used up.
    expect(await b.take('authfail:9.9.9.9', rate, w.t.now)).toEqual({ ok: false, retryAfterSeconds: 20 });
    const before = w.calls.length;
    for (let i = 0; i < 50; i++) expect((await b.take('authfail:9.9.9.9', rate, w.t.now)).ok).toBe(false);
    expect(w.calls.length).toBe(before);
    // Keys that are not shared never reach the object.
    for (let i = 0; i < 3; i++) await b.take('ip:9.9.9.9', rate, w.t.now);
    expect(w.calls.length).toBe(before);
  });

  it('two isolates (two limiters) share one count', async () => {
    const w = world();
    const a = limiter(w);
    const b = limiter(w);
    expect((await a.take('oauth:1.1.1.1', rate, w.t.now)).ok).toBe(true);
    expect((await b.take('oauth:1.1.1.1', rate, w.t.now)).ok).toBe(true);
    expect((await a.take('oauth:1.1.1.1', rate, w.t.now)).ok).toBe(true);
    expect((await b.take('oauth:1.1.1.1', rate, w.t.now)).ok).toBe(false);
    expect(await a.peek('oauth:1.1.1.1', rate, w.t.now)).toBe(false);
  });

  it.each(['throw', 'status', 'garbage', 'timeout'] as const)(
    'fails open when the object %s, logging at most once a minute',
    async (mode) => {
      const w = world();
      w.namespace.fail = mode;
      const q = quiet();
      const l = limiter(w, q);
      expect(await l.peek('authfail:2.2.2.2', rate, w.t.now)).toBe(true);
      for (let i = 0; i < 3; i++) expect((await l.take('authfail:2.2.2.2', rate, w.t.now + i)).ok).toBe(true);
      expect(q.logs.filter((x) => x.includes('shared rate limiter failed'))).toHaveLength(1);
      // The per-isolate buckets still apply.
      expect((await l.take('authfail:2.2.2.2', rate, w.t.now + 3)).ok).toBe(false);
    },
  );
});

describe('write counters on the Durable Object fail closed', () => {
  const clock = (w: ReturnType<typeof world>): Clock => ({ now: () => w.t.now });
  const writes = (w: ReturnType<typeof world>) =>
    createWriteLimiter({
      counters: w.client,
      clock: clock(w),
      limits: { perGrant: 2, deployment: 3 },
    });
  const check = (l: ReturnType<typeof writes>, grant = 'g1') =>
    l.check({ tool: 'update_status', actor: { id: grant, grantId: grant } as never, requestId: 'r' });

  it('counts exactly across limiters on the same object', async () => {
    const w = world();
    // Window starts at a whole hour so the counters stay in one window.
    w.t.now = 5 * 3_600_000 + 1_000;
    const a = writes(w);
    const b = writes(w);
    await check(a);
    await check(b);
    await expect(check(a)).rejects.toMatchObject({ code: ErrorCode.LimitRate });
    await check(b, 'g2');
    await expect(check(a, 'g3')).rejects.toMatchObject({ code: ErrorCode.LimitRate });
  });

  it.each(['throw', 'status', 'garbage', 'timeout'] as const)(
    'refuses the write when the object %s, with nothing changed',
    async (mode) => {
      const w = world();
      w.t.now = 5 * 3_600_000 + 1_000;
      w.namespace.fail = mode;
      await expect(check(writes(w))).rejects.toMatchObject({ code: ErrorCode.WriteLimitUnavailable });
      expect(await writes(w).budget?.({ actor: { id: 'g1', grantId: 'g1' } as never })).toEqual({
        status: 'unknown',
      });
    },
  );
});
