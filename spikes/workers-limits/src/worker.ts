// SPDX-License-Identifier: Apache-2.0
// P0-09 local Worker: the workerd half of the CPU, storage, crypto and outbound-TLS checks. Local `wrangler dev` only.
import type { D1Database, Fetcher, RateLimit } from '@cloudflare/workers-types';
import {
  deriveKey,
  open,
  parseAndShape,
  readCapped,
  seal,
  syntheticQueryResult,
  TEST_MASTER_KEY,
} from './hotpath.ts';
import { errorKind, SCHEMA, STEPS } from './storage.ts';

interface Env {
  DB: D1Database;
  /** Mock Agility upstream (src/mock.ts); deployed only. */
  MOCK?: Fetcher;
  /** Workers Rate Limiting binding; deployed only. */
  RATE_LIMITER?: RateLimit;
}

const META_STORY = 'https://www14.v1host.com/v1sdktesting/meta.v1/Story';

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/bench': {
        // CPU is read from Workers analytics or logs; performance.now() advances only across I/O in workerd.
        // Deployed: the payload comes from the mock Worker (not billed here); locally it is generated in place.
        const size = Number(url.searchParams.get('size') ?? 10_000);
        const cap = Number(url.searchParams.get('cap') ?? 8 * 1024 * 1024);
        const upstream = env.MOCK
          ? await env.MOCK.fetch(`https://mock/payload?size=${size}`)
          : new Response(syntheticQueryResult(size));
        try {
          const text = await readCapped(upstream.body as ReadableStream<Uint8Array>, cap);
          return json({ rows: parseAndShape(text).rows, bytes: text.length });
        } catch (e) {
          return json({ error: (e as Error).message }, 413);
        }
      }
      case '/meta': {
        // The real, public meta.v1 of Digital.ai's example instance, as JSON (schema only, no authentication).
        const res = await fetch(META_STORY, { headers: { accept: 'application/json' } });
        const text = await readCapped(res.body as ReadableStream<Uint8Array>, 512 * 1024);
        const meta = JSON.parse(text) as { Attributes?: Record<string, unknown> };
        return json({
          status: res.status,
          bytes: text.length,
          attributes: Object.keys(meta.Attributes ?? {}).length,
        });
      }
      case '/cache': {
        // Cache API behaviour on this hostname: put then match the same key.
        const key = new Request(`https://${url.host}/__cache-probe/${url.searchParams.get('key') ?? 'k'}`);
        const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
        if (url.searchParams.get('put') === '1') {
          await cache.put(key, new Response('cached', { headers: { 'cache-control': 'max-age=300' } }));
        }
        const hit = await cache.match(key);
        return json({ host: url.host, hit: hit !== undefined });
      }
      case '/rl': {
        if (!env.RATE_LIMITER) return json({ error: 'no binding' }, 501);
        const { success } = await env.RATE_LIMITER.limit({ key: url.searchParams.get('key') ?? 'k' });
        return json({ success });
      }
      case '/crypto/seal': {
        const key = await deriveKey(TEST_MASTER_KEY, 'credentials');
        return json({
          sealed: await seal(key, url.searchParams.get('text') ?? '', url.searchParams.get('aad') ?? ''),
        });
      }
      case '/crypto/open': {
        const key = await deriveKey(TEST_MASTER_KEY, 'credentials');
        try {
          return json({
            text: await open(key, url.searchParams.get('sealed') ?? '', url.searchParams.get('aad') ?? ''),
          });
        } catch (e) {
          return json({ error: (e as Error).name }, 400);
        }
      }
      case '/d1': {
        await env.DB.exec(
          'DROP TABLE IF EXISTS credentials; DROP TABLE IF EXISTS usage; DROP TABLE IF EXISTS workspaces;',
        );
        for (const s of SCHEMA) await env.DB.prepare(s).run();
        const out: Record<string, unknown> = {};
        for (const step of STEPS) {
          try {
            const stmt = env.DB.prepare(step.sql).bind(...step.params);
            out[step.name] =
              step.mode === 'all' ? (await stmt.all()).results : { changes: (await stmt.run()).meta.changes };
          } catch (e) {
            out[step.name] = { error: errorKind((e as Error).message) };
          }
        }
        return json(out);
      }
      case '/tls': {
        const target = url.searchParams.get('url') ?? '';
        try {
          const res = await fetch(target, { redirect: 'manual' });
          return json({ target, status: res.status });
        } catch (e) {
          return json({ target, error: (e as Error).message.slice(0, 200) });
        }
      }
      default:
        return json({ error: 'not found' }, 404);
    }
  },
};
