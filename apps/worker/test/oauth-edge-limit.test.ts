// SPDX-License-Identifier: Apache-2.0
// The RL_OAUTH backstop in workerd (P5-19, THREAT_MODEL T20): a synthetic flood of one address at the OAuth routes, with
// and without the Rate Limiting binding, counting the counter writes that reach D1 (each taken unit is one `kv`
// increment, so the sum of the counter values is the number of row writes). Local only: no real service is probed.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAdminToken, generateMasterKey } from '@agility-bridge/auth';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'dist', 'oauth-test', 'oauth-entry.js');
const ORIGIN = 'http://127.0.0.1';
const running: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((mf) => mf.dispose()));
});

function worker(limit?: number): Miniflare {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: SCRIPT,
      compatibilityDate: '2026-09-26',
      compatibilityFlags: ['global_fetch_strictly_public'],
      d1Databases: ['DB'],
      ...(limit === undefined
        ? {}
        : { ratelimits: { RL_OAUTH: { namespace_id: '1003', simple: { limit, period: 60 } } } }),
      bindings: {
        AB_ENVIRONMENT: 'test',
        AB_MASTER_KEY: generateMasterKey(1),
        AB_ADMIN_TOKEN: generateAdminToken(),
        AB_PUBLIC_URL: ORIGIN,
        AB_OAUTH: 'on',
      },
    }),
  );
  running.push(mf);
  return mf;
}

const send = async (
  mf: Miniflare,
  path: string,
  init: RequestInit = {},
  ip = '203.0.113.50',
): Promise<number> => {
  const res = await mf.dispatchFetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { 'cf-connecting-ip': ip, ...init.headers },
  } as never);
  await res.arrayBuffer();
  return res.status;
};

/** Counter increments that reached D1: the sum of the abuse counters' values. */
async function counterWrites(mf: Miniflare): Promise<number> {
  const db = await mf.getD1Database('DB');
  const rows = await db
    .prepare("SELECT value FROM kv WHERE key LIKE 'oauth-abuse:%' AND key NOT LIKE 'oauth-abuse-audit:%'")
    .all<{ value: string }>();
  return (rows.results as { value: string }[]).reduce((sum: number, r) => sum + Number(r.value), 0);
}

const FLOOD = 150;
const authorize = (mf: Miniflare, ip?: string) => send(mf, '/oauth/authorize?response_type=code', {}, ip);

describe('RL_OAUTH (P5-19)', () => {
  it('without the binding the D1 counters take the flood up to their limits (unchanged)', async () => {
    const mf = worker();
    const statuses: number[] = [];
    for (let i = 0; i < FLOOD; i++) statuses.push(await authorize(mf));
    // The per-address limit is 30 per ten minutes: 30 units on the address counter and 30 on the deployment's.
    expect(statuses.filter((s) => s === 429)).toHaveLength(FLOOD - 30);
    expect(await counterWrites(mf)).toBe(60);
  });

  it('with the binding a flood causes no D1 write after the binding refuses', async () => {
    const mf = worker(5);
    const statuses: number[] = [];
    for (let i = 0; i < FLOOD; i++) statuses.push(await authorize(mf));
    expect(statuses.filter((s) => s !== 429)).toHaveLength(5);
    expect(await counterWrites(mf)).toBe(10);
    // The token and registration routes are behind it too (consent has its own test in the http-app package).
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    expect(await send(mf, '/oauth/token', { method: 'POST', headers: form, body: 'grant_type=x' })).toBe(429);
    expect(
      await send(mf, '/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ).toBe(429);
    expect(await counterWrites(mf)).toBe(10);
  });

  it('one flooding address does not refuse another', async () => {
    const mf = worker(2);
    for (let i = 0; i < 5; i++) await authorize(mf);
    expect(await authorize(mf, '198.51.100.7')).not.toBe(429);
  });
});
