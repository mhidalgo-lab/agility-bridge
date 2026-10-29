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

    it("a grant's own cap lowers the configured limit and can never raise it (P7-15)", async () => {
      const w = await make();
      const l = build(w, { perGrant: 3, deployment: null });
      const own = (id: string, grantLimit: number) => ({ ...grant(id), grantLimit });
      expect(await outcome(l.check(own('low', 1)))).toBe('ok');
      expect(await outcome(l.check(own('low', 1)))).toBe(`${ErrorCode.LimitRate}:grant`);
      // Above the configured value: the configured value still applies.
      for (let i = 0; i < 3; i++) expect(await outcome(l.check(own('high', 50)))).toBe('ok');
      expect(await outcome(l.check(own('high', 50)))).toBe(`${ErrorCode.LimitRate}:grant`);
      // Nonsense is ignored, not trusted.
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        const fresh = `bad${String(bad)}`;
        for (let i = 0; i < 3; i++) expect(await outcome(l.check(own(fresh, bad)))).toBe('ok');
        expect(await outcome(l.check(own(fresh, bad)))).toBe(`${ErrorCode.LimitRate}:grant`);
      }
    });

    it('reads the budget without taking a unit, on every store (P7-16)', async () => {
      const w = await make();
      const l = build(w, { perGrant: 3, deployment: 5 });
      const read = async (id: string) =>
        (l.budget as NonNullable<WriteLimiter['budget']>)({ actor: grant(id).actor });
      expect(await read('g1')).toMatchObject({
        status: 'ok',
        grant: { limit: 3, used: 0, remaining: 3 },
        deployment: { limit: 5, used: 0, remaining: 5 },
      });
      expect(await outcome(l.check(grant('g1')))).toBe('ok');
      expect(await outcome(l.check(grant('g1')))).toBe('ok');
      for (let i = 0; i < 4; i++) await read('g1');
      expect(await read('g1')).toMatchObject({
        grant: { used: 2, remaining: 1 },
        deployment: { used: 2, remaining: 3 },
      });
      // Reading took nothing: the third write is admitted, the fourth is refused.
      expect(await outcome(l.check(grant('g1')))).toBe('ok');
      expect(await outcome(l.check(grant('g1')))).toBe(`${ErrorCode.LimitRate}:grant`);
      expect(await read('g2')).toMatchObject({ grant: { used: 0 }, deployment: { used: 3 } });
      w.advance(WRITE_LIMIT_WINDOW_MS);
      expect(await read('g1')).toMatchObject({ grant: { used: 0, remaining: 3 }, deployment: { used: 0 } });
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

    it('counts approval requests apart from writes, admits exactly the limit under concurrency, and resets in the next window (P7-27)', async () => {
      const w = await make();
      const isolates = [1, 2, 3].map(() => build(w, { perGrant: 5, deployment: 1, approvalRequests: 4 }));
      const ask = { ...grant('asker'), purpose: 'approval_request' as const };
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, i) => outcome((isolates[i % 3] as WriteLimiter).check(ask))),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(4);
      expect(results.filter((r) => r === 'AB_LIMIT_RATE:approval_requests')).toHaveLength(20);
      // The write budget of the same grant, and the deployment's, are untouched.
      expect(await outcome((isolates[0] as WriteLimiter).check(grant('asker')))).toBe('ok');
      w.advance(WRITE_LIMIT_WINDOW_MS);
      expect(await outcome((isolates[0] as WriteLimiter).check(ask))).toBe('ok');
    });
  });
}
