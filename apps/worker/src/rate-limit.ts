// SPDX-License-Identifier: Apache-2.0
// Rate limits on Workers (P3-04). The exact per-isolate token buckets of `serve` decide first; Cloudflare's Rate
// Limiting binding is a backstop across isolates for the address and failed-authentication limits (L-081, L-099). The
// binding is per location and eventually consistent, has no "peek", and fixed limits per namespace (wrangler.jsonc).
import type { Logger } from '@agility-bridge/core';
import type { LimitDecision, Rate, RateLimiter } from '@agility-bridge/http-app';

/** Cloudflare's `RateLimit` binding. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface BackstopBindings {
  /** Requests per client address before authentication (T20). */
  readonly ip?: RateLimitBinding;
  /** Failed authentications per address (T1). */
  readonly authFailures?: RateLimitBinding;
  /** Requests per address to the OAuth routes that reach D1 (T20, P5-19). */
  readonly oauth?: RateLimitBinding;
  /**
   * The exact Durable Object limiter (P3-12, opt-in through `RL_SHARED`): decides `sharedPrefixes` keys instead of the
   * bindings. Its failure is logged and the bindings and local buckets decide, like a failing binding (L-080).
   */
  readonly shared?: RateLimiter;
  readonly sharedPrefixes?: readonly string[];
}

/** The binding's period; a refused key stays refused here for that long. */
const PERIOD_MS = 60_000;
const MAX_BLOCKED = 10_000;
const LOG_EVERY_MS = 60_000;

export class BackstopRateLimiter implements RateLimiter {
  readonly #local: RateLimiter;
  readonly #bindings: BackstopBindings;
  readonly #logger: Logger;
  /** Keys the binding refused, until when (completed values only, L-096). */
  readonly #blocked = new Map<string, number>();
  #lastFailureLog = Number.NEGATIVE_INFINITY;

  constructor(local: RateLimiter, bindings: BackstopBindings, logger: Logger) {
    this.#local = local;
    this.#bindings = bindings;
    this.#logger = logger;
  }

  #bindingFor(key: string): RateLimitBinding | undefined {
    if (key.startsWith('ip:')) return this.#bindings.ip;
    if (key.startsWith('authfail:')) return this.#bindings.authFailures;
    if (key.startsWith('oauth:')) return this.#bindings.oauth;
    return undefined;
  }

  #sharedFor(key: string): RateLimiter | undefined {
    const { shared, sharedPrefixes } = this.#bindings;
    return shared !== undefined && (sharedPrefixes ?? []).some((p) => key.startsWith(p)) ? shared : undefined;
  }

  /** Logs a limiter failure at most once a minute (shared by the binding and the Durable Object). */
  #logFailure(message: string, error: unknown, now: number): void {
    if (now - this.#lastFailureLog < LOG_EVERY_MS) return;
    this.#lastFailureLog = now;
    this.#logger.warn(message, { error: (error as Error).name });
  }

  #isBlocked(key: string, now: number): boolean {
    const until = this.#blocked.get(key);
    if (until === undefined) return false;
    if (until > now) return true;
    this.#blocked.delete(key);
    return false;
  }

  #block(key: string, now: number, forMs: number = PERIOD_MS): void {
    if (this.#blocked.size >= MAX_BLOCKED) {
      for (const [k, until] of this.#blocked) if (until <= now) this.#blocked.delete(k);
      while (this.#blocked.size >= MAX_BLOCKED) {
        const oldest = this.#blocked.keys().next();
        if (oldest.done === true) break;
        this.#blocked.delete(oldest.value);
      }
    }
    this.#blocked.set(key, now + forMs);
  }

  async take(key: string, rate: Rate, now: number): Promise<LimitDecision> {
    if (this.#isBlocked(key, now)) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil(((this.#blocked.get(key) ?? now) - now) / 1000)),
      };
    }
    const local = await this.#local.take(key, rate, now);
    if (!local.ok) return local;
    const shared = this.#sharedFor(key);
    if (shared !== undefined) {
      try {
        const exact = await shared.take(key, rate, now);
        if (exact.ok) return local;
        // Exact and deployment-wide: remember the refusal here for as long as it lasts, so a flood costs no more calls.
        this.#block(key, now, exact.retryAfterSeconds * 1000);
        return exact;
      } catch (error) {
        this.#logFailure('shared rate limiter failed; using the backstop and per-isolate limits', error, now);
      }
    }
    const binding = this.#bindingFor(key);
    if (binding === undefined) return local;
    try {
      if ((await binding.limit({ key })).success) return local;
    } catch (error) {
      // Fail open (L-080): the local buckets still apply, and authorization never depends on rate limits.
      this.#logFailure('rate limit binding failed; using per-isolate limits', error, now);
      return local;
    }
    this.#block(key, now);
    return { ok: false, retryAfterSeconds: PERIOD_MS / 1000 };
  }

  async peek(key: string, rate: Rate, now: number): Promise<boolean> {
    if (this.#isBlocked(key, now)) return false;
    if (!(await this.#local.peek(key, rate, now))) return false;
    const shared = this.#sharedFor(key);
    if (shared === undefined) return true;
    try {
      return await shared.peek(key, rate, now);
    } catch (error) {
      this.#logFailure('shared rate limiter failed; using the backstop and per-isolate limits', error, now);
      return true;
    }
  }
}
