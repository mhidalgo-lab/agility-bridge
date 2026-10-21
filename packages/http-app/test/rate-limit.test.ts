// SPDX-License-Identifier: Apache-2.0
// Rate limits per surface (P2-07, L-079, L-080): each limit and its error, failures never locking out a valid token,
// proxy hops, fail-open.
import { silentLogger } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import {
  clientAddress,
  createRequestLimits,
  DEFAULT_RATE_LIMITS,
  MemoryRateLimiter,
  type RateLimitConfig,
  type RateLimiter,
} from '../src/index.ts';
import { post, world } from './helpers/world.ts';

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const LISTEN = { jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params: {} };

async function limited(
  config: Partial<RateLimitConfig> = {},
  limiter: RateLimiter = new MemoryRateLimiter(),
) {
  const cfg = { ...DEFAULT_RATE_LIMITS, ...config };
  return world({
    limits: createRequestLimits(limiter, cfg, silentLogger),
    clientIp: (c) => c.req.header('x-test-ip') ?? 'unknown',
  });
}

const from = (ip: string) => ({ 'x-test-ip': ip });

describe('MemoryRateLimiter', () => {
  it('refills continuously and reports the wait for the next unit', () => {
    const l = new MemoryRateLimiter();
    const rate = { limit: 2, windowMs: 60_000 };
    expect(l.take('k', rate, 0)).toEqual({ ok: true });
    expect(l.take('k', rate, 0)).toEqual({ ok: true });
    expect(l.take('k', rate, 0)).toEqual({ ok: false, retryAfterSeconds: 30 });
    expect(l.take('k', rate, 30_000)).toEqual({ ok: true });
    expect(l.take('other', rate, 0)).toEqual({ ok: true });
  });

  it('stays bounded in memory', () => {
    const l = new MemoryRateLimiter(100);
    for (let i = 0; i < 1_000; i++) l.take(`k${i}`, { limit: 1, windowMs: 1_000 }, 0);
    expect(l.size).toBe(100);
  });
});

describe('limits over HTTP', () => {
  it('per IP before authentication: 429 with Retry-After, other IPs unaffected', async () => {
    const w = await limited({ ipPerMinute: 2 });
    expect((await post(w, 'team-a', w.tokens.alice, LIST, from('1.1.1.1'))).status).toBe(200);
    expect((await post(w, 'team-a', w.tokens.alice, LIST, from('1.1.1.1'))).status).toBe(200);
    const res = await post(w, 'team-a', w.tokens.alice, LIST, from('1.1.1.1'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect((await post(w, 'team-a', w.tokens.alice, LIST, from('2.2.2.2'))).status).toBe(200);
  });

  it("authentication failures lock out only failed attempts: a valid token is never locked out by others' failures", async () => {
    const w = await limited({ authFailuresPer5Minutes: 3 });
    const shared = from('10.0.0.1'); // e.g. one office NAT
    for (let i = 0; i < 3; i++) expect((await post(w, 'team-a', null, LIST, shared)).status).toBe(401);
    // Failures exhausted: further failed attempts answer 429 …
    expect((await post(w, 'team-a', `${w.tokens.alice.slice(0, -1)}x`, LIST, shared)).status).toBe(429);
    expect((await post(w, 'team-b', w.tokens.alice, LIST, shared)).status).toBe(429);
    // … but a valid token from the same address still works.
    expect((await post(w, 'team-a', w.tokens.alice, LIST, shared)).status).toBe(200);
    expect((await post(w, 'team-b', w.tokens.bob, LIST, shared)).status).toBe(200);
    // Successes are never charged as failures.
    const fresh = await limited({ authFailuresPer5Minutes: 2 });
    for (let i = 0; i < 10; i++)
      expect((await post(fresh, 'team-a', fresh.tokens.alice, LIST, from('3.3.3.3'))).status).toBe(200);
    expect((await post(fresh, 'team-a', null, LIST, from('3.3.3.3'))).status).toBe(401);
  });

  it('per device token and per grant after authentication; listen streams do not count', async () => {
    const w = await limited({ tokenPerMinute: 2, grantPerMinute: 1_000 });
    for (let i = 0; i < 5; i++)
      expect((await post(w, 'team-a', w.tokens.alice, LISTEN, from('4.4.4.4'))).status).not.toBe(429);
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(200);
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(200);
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(429);
    expect((await post(w, 'team-b', w.tokens.bob, LIST)).status).toBe(200);
    expect(w.requests.at(-2)?.refusal).toBe('rate_limited');

    const g = await limited({ tokenPerMinute: 1_000, grantPerMinute: 1 });
    expect((await post(g, 'team-a', g.tokens.alice, LIST)).status).toBe(200);
    expect((await post(g, 'team-a', g.tokens.alice, LIST)).status).toBe(429);
  });

  it("a grant's own rate limit lowers the deployment's", async () => {
    const w = await limited({ grantPerMinute: 1_000 });
    await w.storage.grants.update(w.ids.aliceGrant, { rateLimit: { perMinute: 1 } });
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(200);
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(429);
  });

  it('AB_RATE_LIMIT=off turns every limit off', async () => {
    const w = await limited({
      enabled: false,
      ipPerMinute: 1,
      tokenPerMinute: 1,
      authFailuresPer5Minutes: 1,
    });
    for (let i = 0; i < 3; i++) expect((await post(w, 'team-a', null, LIST)).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(200);
  });

  it('a failing limiter fails open, never closed (L-080)', async () => {
    const broken: RateLimiter = {
      take: () => {
        throw new Error('backend down');
      },
      peek: () => Promise.reject(new Error('backend down')),
    };
    const w = await limited({}, broken);
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(200);
    expect((await post(w, 'team-a', null, LIST)).status).toBe(401);
  });
});

describe('clientAddress (trusted proxy hops)', () => {
  it('uses the socket peer unless proxies are trusted, then counts from the right', () => {
    expect(clientAddress('10.0.0.9', '6.6.6.6', 0)).toBe('10.0.0.9');
    expect(clientAddress('10.0.0.9', '6.6.6.6, 1.2.3.4', 1)).toBe('1.2.3.4');
    expect(clientAddress('10.0.0.9', '6.6.6.6, 1.2.3.4, 10.0.0.5', 2)).toBe('1.2.3.4');
    // A client cannot pick its address by prepending entries.
    expect(clientAddress('10.0.0.9', 'spoofed, 9.9.9.9, 1.2.3.4', 1)).toBe('1.2.3.4');
    expect(clientAddress('10.0.0.9', '1.2.3.4', 2)).toBe('10.0.0.9');
    expect(clientAddress('10.0.0.9', null, 1)).toBe('10.0.0.9');
    expect(clientAddress('10.0.0.9', 'not an ip!', 1)).toBe('10.0.0.9');
    expect(clientAddress(undefined, undefined, 0)).toBe('unknown');
    expect(clientAddress('::1', '2001:db8::1', 1)).toBe('2001:db8::1');
  });
});
