// SPDX-License-Identifier: Apache-2.0
// Rate limiting per surface (P2-07, L-079, THREAT_MODEL T1, T5, T20): per client IP before authentication,
// authentication failures per IP (charged only on failure, so a valid token is never locked out by someone else's
// failures), per device token and per grant after authentication. Limiter errors fail open with a log line (L-080);
// write limits will fail closed (P7-03). Counters are per process (L-081): Workers and replicas each keep their own.
import type { EffectiveAccess } from '@agility-bridge/auth';
import type { Logger } from '@agility-bridge/core';
import type { LimitDecision, RequestLimits } from './app.ts';
import type { ClassifiedRequest } from './mcp-request.ts';

export interface Rate {
  /** Requests allowed per window (also the burst). */
  readonly limit: number;
  readonly windowMs: number;
}

/** The pluggable store behind the limits (in-memory on Node; a shared one for writes later, P7-03). */
export interface RateLimiter {
  /** Takes one unit from `key`'s bucket; refused when empty, with the wait until the next unit. */
  take(key: string, rate: Rate, now: number): LimitDecision | Promise<LimitDecision>;
  /** Whether `key` still has a unit, without taking one. */
  peek(key: string, rate: Rate, now: number): boolean | Promise<boolean>;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** Token buckets in memory, at most `maxKeys` (the least recently used go first), so memory stays bounded. */
export class MemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxKeys: number;

  constructor(maxKeys = 50_000) {
    this.#maxKeys = maxKeys;
  }

  #refill(key: string, rate: Rate, now: number): Bucket {
    let b = this.#buckets.get(key);
    if (b === undefined) {
      b = { tokens: rate.limit, at: now };
    } else {
      this.#buckets.delete(key);
      const elapsed = Math.max(0, now - b.at);
      b = { tokens: Math.min(rate.limit, b.tokens + (elapsed * rate.limit) / rate.windowMs), at: now };
    }
    this.#buckets.set(key, b);
    while (this.#buckets.size > this.#maxKeys) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest === undefined) break;
      this.#buckets.delete(oldest);
    }
    return b;
  }

  take(key: string, rate: Rate, now: number): LimitDecision {
    const b = this.#refill(key, rate, now);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: ((1 - b.tokens) * rate.windowMs) / rate.limit / 1000 };
  }

  peek(key: string, rate: Rate, now: number): boolean {
    return this.#refill(key, rate, now).tokens >= 1;
  }

  get size(): number {
    return this.#buckets.size;
  }
}

export interface RateLimitConfig {
  /** `AB_RATE_LIMIT=off` turns every limit off. */
  readonly enabled: boolean;
  /** Requests per minute per client IP, before authentication (default 600). */
  readonly ipPerMinute: number;
  /** Failed authentications per IP per 5 minutes (default 10). */
  readonly authFailuresPer5Minutes: number;
  /** Requests per minute per device token (default 120). */
  readonly tokenPerMinute: number;
  /** Requests per minute per grant, all its devices together (default 300; a grant's `rateLimit.perMinute` lowers it). */
  readonly grantPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = Object.freeze({
  enabled: true,
  ipPerMinute: 600,
  authFailuresPer5Minutes: 10,
  tokenPerMinute: 120,
  grantPerMinute: 300,
});

const MINUTE = 60_000;

/** The request hooks of the HTTP app over a limiter. */
export function createRequestLimits(
  limiter: RateLimiter,
  config: RateLimitConfig,
  logger: Logger,
): RequestLimits & {
  /** Whether this IP has used up its authentication failures (then a failed attempt answers 429, not 401). */
  failuresExhausted(ip: string, now: number): Promise<boolean>;
} {
  const failures: Rate = { limit: config.authFailuresPer5Minutes, windowMs: 5 * MINUTE };
  /** Fail open: a broken limiter must not take the server down (L-080). */
  const safely = async (
    what: string,
    run: () => LimitDecision | Promise<LimitDecision>,
  ): Promise<LimitDecision> => {
    try {
      return await run();
    } catch (error) {
      logger.warn('rate limiter failed; allowing the request', { limit: what, error: (error as Error).name });
      return { ok: true };
    }
  };
  return {
    beforeAuth(ip, now) {
      if (!config.enabled) return { ok: true };
      return safely('ip', () =>
        limiter.take(`ip:${ip}`, { limit: config.ipPerMinute, windowMs: MINUTE }, now),
      );
    },
    async onAuthFailure(ip, now) {
      if (!config.enabled) return;
      await safely('auth_failures', () => limiter.take(`authfail:${ip}`, failures, now));
    },
    async failuresExhausted(ip, now) {
      if (!config.enabled) return false;
      try {
        return !(await limiter.peek(`authfail:${ip}`, failures, now));
      } catch {
        return false;
      }
    },
    async afterAuth(access: EffectiveAccess, mcp: ClassifiedRequest, now) {
      // A long-lived listen stream is not a call (L-015).
      if (!config.enabled || mcp.kind === 'listen') return { ok: true };
      if (access.tokenId !== null) {
        const t = await safely('token', () =>
          limiter.take(`token:${access.tokenId}`, { limit: config.tokenPerMinute, windowMs: MINUTE }, now),
        );
        if (!t.ok) return t;
      }
      const perMinute = Math.min(
        config.grantPerMinute,
        access.rateLimit?.perMinute ?? Number.POSITIVE_INFINITY,
      );
      return safely('grant', () =>
        limiter.take(`grant:${access.grant.id}`, { limit: perMinute, windowMs: MINUTE }, now),
      );
    },
  };
}

/**
 * The client address: the socket peer, or with `trustedHops` proxies in front, the address that many entries from
 * the right of `X-Forwarded-For` (the left part is client-controlled). Too few entries → the socket peer.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | null | undefined,
  trustedHops: number,
): string {
  const socket = peer ?? 'unknown';
  if (trustedHops <= 0 || typeof forwardedFor !== 'string') return socket;
  const hops = forwardedFor
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const candidate = hops[hops.length - trustedHops];
  return candidate !== undefined && /^[0-9A-Fa-f:.[\]]{2,45}$/.test(candidate) ? candidate : socket;
}
