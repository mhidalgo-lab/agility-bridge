// SPDX-License-Identifier: Apache-2.0
// The Worker's boot rule (P3-01, L-096), at unit level: local workerd does not flag a boot promise shared between
// requests, production may hang on it, so the rule is checked on the handler itself.
import { describe, expect, it } from 'vitest';
import type { Booted, WorkerEnv } from '../src/boot.ts';
import { createWorker } from '../src/index.ts';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const booted: Booted = {
  app: { fetch: () => new Response('ok') } as unknown as Booted['app'],
  logger: {} as Booted['logger'],
  jobs: {} as Booted['jobs'],
};

describe('createWorker', () => {
  it('boots each concurrent first request on its own, then reuses only the completed boot', async () => {
    let boots = 0;
    const gates: (() => void)[] = [];
    const worker = createWorker(async () => {
      boots++;
      await new Promise<void>((r) => gates.push(r));
      return booted;
    });
    const first = [1, 2, 3].map(() => worker.fetch(new Request('http://w/health'), {} as WorkerEnv, ctx));
    await Promise.resolve();
    expect(boots).toBe(3);
    for (const g of gates) g();
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200, 200]);
    await worker.fetch(new Request('http://w/health'), {} as WorkerEnv, ctx);
    expect(boots).toBe(3);
  });

  it('never keeps a failed boot: the next request boots again; the failure is a bare 503', async () => {
    let boots = 0;
    const worker = createWorker(async () => {
      boots++;
      if (boots === 1) throw new Error('AB_MASTER_KEY is missing');
      return booted;
    });
    const failed = await worker.fetch(new Request('http://w/health'), {} as WorkerEnv, ctx);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe('{"error":"temporarily unavailable"}');
    expect((await worker.fetch(new Request('http://w/health'), {} as WorkerEnv, ctx)).status).toBe(200);
    expect(boots).toBe(2);
  });
});
