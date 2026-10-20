// SPDX-License-Identifier: Apache-2.0
// P0-09 local Worker: the workerd half of the CPU, storage, crypto and outbound-TLS checks. Local `wrangler dev` only.
import type { D1Database } from '@cloudflare/workers-types';
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
}

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/bench': {
        // performance.now() advances only across I/O in workerd, so this measures from the outside (wall, curl).
        const size = Number(url.searchParams.get('size') ?? 10_000);
        const body = new Response(syntheticQueryResult(size)).body as ReadableStream<Uint8Array>;
        const text = await readCapped(body, Number(url.searchParams.get('cap') ?? 8 * 1024 * 1024));
        return json({ rows: parseAndShape(text).rows, bytes: text.length });
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
