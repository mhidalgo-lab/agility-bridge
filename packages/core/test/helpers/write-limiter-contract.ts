// SPDX-License-Identifier: Apache-2.0
// The write limiter contract (P7-03): the same suite runs over every counter store a host can use (process memory,
// storage `kv` on memory, SQLite and workerd/D1). "Isolates" are separate limiter instances over one store.
import { describe, expect, it } from 'vitest';
import {
  AbError,
  type CounterStore,
  createWriteLimiter,
  ErrorCode,
  WRITE_LIMIT_WINDOW_MS,
  type WriteLimiter,
  type WriteRateLimits,
} from '../../src/index.ts';

export interface LimiterWorld {
  readonly counters: CounterStore;
  /** Moves the clock the store and the limiter share. */
  advance(ms: number): void;
  now(): number;
}

const grant = (id: string) => ({ tool: 't', requestId: 'r', actor: { id: `user-${id}`, grantId: id } });

async function outcome(p: Promise<void>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof AbError
      ? `${e.code}${e.details?.['scope'] ? `:${e.details['scope']}` : ''}`
      : 'other';
  }
}

export function writeLimiterContract(name: string, make: () => Promise<LimiterWorld>): void {
  const build = (w: LimiterWorld, limits: WriteRateLimits): WriteLimiter =>
    createWriteLimiter({ counters: w.counters, clock: { now: w.now }, limits });

  describe(`write limiter on ${name}`, () => {
    it('refuses the write after the grant limit with AB_LIMIT_RATE and allows again in the next window', async () => {
      const w = await make();
      const l = build(w, { perGrant: 3, deployment: null });
      for (let i = 0; i < 3; i++) expect(await outcome(l.check(grant('g1')))).toBe('ok');
      expect(await outcome(l.check(grant('g1')))).toBe(`${ErrorCode.LimitRate}:grant`);
      expect(await outcome(l.check(grant('g2')))).toBe('ok');
      w.advance(WRITE_LIMIT_WINDOW_MS);
      expect(await outcome(l.check(grant('g1')))).toBe('ok');
    });

    it('refuses at the deployment limit, across grants, and a grant over its limit does not spend it', async () => {
      const w = await make();
      const l = build(w, { perGrant: 2, deployment: 4 });
      expect(await outcome(l.check(grant('a')))).toBe('ok');
      expect(await outcome(l.check(grant('a')))).toBe('ok');
      for (let i = 0; i < 5; i++)
        expect(await outcome(l.check(grant('a')))).toBe(`${ErrorCode.LimitRate}:grant`);
      expect(await outcome(l.check(grant('b')))).toBe('ok');
      expect(await outcome(l.check(grant('b')))).toBe('ok');
      expect(await outcome(l.check(grant('c')))).toBe(`${ErrorCode.LimitRate}:deployment`);
    });

    it('never admits more than the limit under concurrency across isolates', async () => {
      const w = await make();
      const isolates = [1, 2, 3, 4].map(() => build(w, { perGrant: 10, deployment: 12 }));
      const results = await Promise.all(
        Array.from({ length: 48 }, (_, i) =>
          outcome((isolates[i % 4] as WriteLimiter).check(grant(`g${i % 3}`))),
        ),
      );
      const admitted = results.filter((r) => r === 'ok').length;
      expect(admitted).toBeLessThanOrEqual(12);
      expect(admitted).toBeGreaterThanOrEqual(10);
      expect(results.filter((r) => r !== 'ok').every((r) => r.startsWith(ErrorCode.LimitRate))).toBe(true);
    });

    it('admits exactly the limit when one grant is hit in parallel', async () => {
      const w = await make();
      const isolates = [1, 2, 3].map(() => build(w, { perGrant: 5, deployment: null }));
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => outcome((isolates[i % 3] as WriteLimiter).check(grant('solo')))),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    });
  });
}
