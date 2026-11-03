// SPDX-License-Identifier: Apache-2.0
// The Durable Object limiter in workerd (P3-12, THREAT_MODEL T1, T20, L-080, L-081): two Miniflare workers, so two
// isolates with separate module state, share one object; the exact limit holds across them, request limits fail open
// and write limits fail closed when the object is broken or never answers. No Cloudflare account is used.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDeviceToken, generateMasterKey } from '@agility-bridge/auth';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROBE = join(ROOT, 'dist', 'shared-limiter-test', 'shared-limiter-entry.js');
const WORKER = join(ROOT, 'dist', 'index.js');
const ORIGIN = 'http://127.0.0.1';
const running: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((mf) => mf.dispose()));
});

/** The worker that hosts the object classes: both isolates under test bind to the object it owns. */
const probeHost = (className: string) => ({
  name: 'host',
  modules: true,
  scriptPath: PROBE,
  compatibilityDate: '2026-09-26',
  durableObjects: { RL_SHARED: { className, useSQLite: true } },
});

interface WorkerFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

interface Pair {
  readonly mf: Miniflare;
  readonly a: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  readonly b: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
}

/** Two probe workers (two isolates) bound to the same object class, which lives in the first. */
async function pair(className = 'SharedLimiter'): Promise<Pair> {
  const worker = (name: string) => ({
    name,
    modules: true,
    scriptPath: PROBE,
    compatibilityDate: '2026-09-26',
    durableObjects: { RL_SHARED: { className, scriptName: 'host', useSQLite: true } },
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({ workers: [probeHost(className), worker('a'), worker('b')] } as never),
  );
  running.push(mf);
  const to =
    (name: string) =>
    async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const w = (await mf.getWorker(name)) as unknown as WorkerFetcher;
      const res = await w.fetch(`${ORIGIN}${path}`, { method: 'POST', body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
  return { mf, a: to('a'), b: to('b') };
}

const rate = { limit: 4, windowMs: 60_000 };

describe('the limiter object across two isolates', () => {
  it('holds one exact bucket: four takes split over two isolates, the fifth is refused in either', async () => {
    const p = await pair();
    const key = 'authfail:203.0.113.1';
    expect((await p.a('/take', { key, rate })).body).toEqual({ ok: true });
    expect((await p.b('/take', { key, rate })).body).toEqual({ ok: true });
    expect((await p.a('/take', { key, rate })).body).toEqual({ ok: true });
    expect((await p.b('/take', { key, rate })).body).toEqual({ ok: true });
    expect((await p.a('/take', { key, rate })).body).toMatchObject({ ok: false });
    expect((await p.b('/take', { key, rate })).body).toMatchObject({ ok: false });
    expect((await p.b('/peek', { key, rate })).body).toEqual({ ok: false });
    // Another key is untouched.
    expect((await p.b('/take', { key: 'authfail:203.0.113.2', rate })).body).toEqual({ ok: true });
  });

  it('serialises parallel takes from both isolates: exactly the limit succeeds', async () => {
    const p = await pair();
    const key = 'oauth:198.51.100.1';
    const runs = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? p.a : p.b)('/take', { key, rate })),
    );
    expect(runs.filter((r) => r.body['ok'] === true)).toHaveLength(rate.limit);
  });

  it('counts write units exactly across isolates, per grant and for the deployment', async () => {
    const p = await pair();
    expect((await p.a('/write', { grant: 'g1' })).body).toEqual({ allowed: true });
    expect((await p.b('/write', { grant: 'g1' })).body).toEqual({ allowed: true });
    // The grant's two are used up, in either isolate.
    for (const side of [p.a, p.b]) {
      const r = await side('/write', { grant: 'g1' });
      expect([r.status, r.body['code']]).toEqual([500, 'AB_LIMIT_RATE']);
    }
    expect((await p.b('/write', { grant: 'g2' })).body).toEqual({ allowed: true });
    // The deployment's three are used up: another grant is refused too.
    const wide = await p.a('/write', { grant: 'g3' });
    expect(wide.body['code']).toBe('AB_LIMIT_RATE');
  });
});

describe('failure policy of a broken or silent object', () => {
  it.each(['BrokenLimiter', 'SlowLimiter'])(
    'surfaces %s as an error the callers can decide on: writes are refused (closed), nothing is allowed',
    async (className) => {
      const p = await pair(className);
      const taken = await p.a('/take', { key: 'authfail:1.2.3.4', rate });
      expect([taken.status, taken.body['error']]).toEqual([500, 'SharedLimiterError']);
      const write = await p.b('/write', { grant: 'g1' });
      expect(write.body).toMatchObject({ error: 'AbError', closed: true });
    },
  );
});

describe('the shipped Worker with the object bound (P3-12)', () => {
  const masterKey = generateMasterKey(1);
  function worker(name: string, className = 'SharedLimiter') {
    return {
      name,
      modules: true,
      scriptPath: WORKER,
      compatibilityDate: '2026-09-26',
      d1Databases: { DB: 'shared' },
      durableObjects: { RL_SHARED: { className, scriptName: 'host', useSQLite: true } },
      bindings: {
        AB_ENVIRONMENT: 'test',
        AB_MASTER_KEY: masterKey,
        AB_ALLOW_HTTP_INSTANCES: 'on',
        // Three failed authentications per address in all.
        AB_RATE_LIMIT_AUTH_FAILURES: '3',
      },
    };
  }
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const MCP = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };

  async function twoWorkers(className?: string) {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [probeHost(className ?? 'SharedLimiter'), worker('a', className), worker('b', className)],
      } as never),
    );
    running.push(mf);
    // Well formed, so it reaches the lookup and fails there: a failed authentication, not a malformed header.
    const wrong = (await generateDeviceToken('test')).token;
    const send = (name: string) => async (): Promise<number> => {
      const w = (await mf.getWorker(name)) as unknown as WorkerFetcher;
      const res = await w.fetch(`${ORIGIN}/w/team/mcp`, {
        method: 'POST',
        headers: {
          ...MCP,
          authorization: `Bearer ${wrong}`,
          'cf-connecting-ip': '203.0.113.77',
        },
        body: JSON.stringify(list),
      });
      await res.arrayBuffer();
      return res.status;
    };
    return { a: send('a'), b: send('b') };
  }

  it('failed authentications count exactly across two Workers, so the limit does not multiply by isolates', async () => {
    const w = await twoWorkers();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push(await (i % 2 === 0 ? w.a : w.b)());
    // Three failures in all (alternating isolates), then 429 in either; per isolate each would have had three.
    expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429, 429]);
  });

  it('a broken object fails open: failed authentications are still counted per isolate and nothing breaks', async () => {
    const w = await twoWorkers('BrokenLimiter');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push(await (i % 2 === 0 ? w.a : w.b)());
    // No 5xx: the object failing never turns a request into an error, and each isolate's own buckets still decide.
    expect(statuses.every((s) => s === 401)).toBe(true);
  });
});
