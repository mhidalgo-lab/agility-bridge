// SPDX-License-Identifier: Apache-2.0
// The Workers rate limiter (P3-04): local buckets first, the binding as a backstop, fail open when it throws (L-080).
import { createLogger } from '@agility-bridge/core';
import { MemoryRateLimiter } from '@agility-bridge/http-app';
import { describe, expect, it } from 'vitest';
import { BackstopRateLimiter, type RateLimitBinding } from '../src/rate-limit.ts';

const rate = { limit: 3, windowMs: 60_000 };

function binding(answers: (key: string) => boolean | Error): RateLimitBinding & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const a = answers(key);
      if (a instanceof Error) throw a;
      return { success: a };
    },
  };
}

function limiter(bindings: ConstructorParameters<typeof BackstopRateLimiter>[1], logs: string[] = []) {
  return new BackstopRateLimiter(
    new MemoryRateLimiter(),
    bindings,
    createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
  );
}

describe('BackstopRateLimiter', () => {
  it('lets the local bucket decide first: no binding call once it refuses', async () => {
    const ip = binding(() => true);
    const l = limiter({ ip });
    for (let i = 0; i < 3; i++) expect((await l.take('ip:1.2.3.4', rate, 0)).ok).toBe(true);
    expect((await l.take('ip:1.2.3.4', rate, 0)).ok).toBe(false);
    expect(ip.keys).toHaveLength(3);
  });

  it('refuses what the binding refuses, and keeps refusing that key here for the period', async () => {
    const ip = binding(() => false);
    const l = limiter({ ip });
    expect(await l.take('ip:9.9.9.9', rate, 0)).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect((await l.take('ip:9.9.9.9', rate, 1_000)).ok).toBe(false);
    expect(ip.keys).toHaveLength(1);
    expect((await l.take('ip:9.9.9.9', rate, 61_000)).ok).toBe(false); // the binding still refuses
    expect((await l.take('ip:8.8.8.8', { limit: 100, windowMs: 60_000 }, 0)).ok).toBe(false);
  });

  it('marks an address out of failed attempts when RL_AUTH refuses a failure (peek sees it)', async () => {
    let failures = 0;
    const auth = binding(() => ++failures <= 2);
    const l = limiter({ authFailures: auth });
    const big = { limit: 100, windowMs: 300_000 };
    expect((await l.take('authfail:5.5.5.5', big, 0)).ok).toBe(true);
    expect((await l.take('authfail:5.5.5.5', big, 0)).ok).toBe(true);
    expect(await l.peek('authfail:5.5.5.5', big, 0)).toBe(true);
    expect((await l.take('authfail:5.5.5.5', big, 0)).ok).toBe(false);
    expect(await l.peek('authfail:5.5.5.5', big, 0)).toBe(false);
    expect(await l.peek('authfail:6.6.6.6', big, 0)).toBe(true);
    expect(await l.peek('authfail:5.5.5.5', big, 61_000)).toBe(true);
  });

  it('fails open when the binding throws, logging at most once a minute', async () => {
    const logs: string[] = [];
    const l = limiter({ ip: binding(() => new Error('binding down')) }, logs);
    for (let i = 0; i < 3; i++) expect((await l.take('ip:1.1.1.1', rate, i)).ok).toBe(true);
    expect(logs.filter((x) => x.includes('rate limit binding failed'))).toHaveLength(1);
    expect((await l.take('ip:1.1.1.1', rate, 3)).ok).toBe(false); // local buckets still apply
  });

  it('without bindings it is the per-isolate limiter, and other keys never reach a binding', async () => {
    const ip = binding(() => false);
    const l = limiter({ ip });
    expect((await l.take('token:t1', rate, 0)).ok).toBe(true);
    expect((await l.take('grant:g1', rate, 0)).ok).toBe(true);
    expect(ip.keys).toEqual([]);
    const none = limiter({});
    expect((await none.take('ip:1.1.1.1', rate, 0)).ok).toBe(true);
  });
});
