// SPDX-License-Identifier: Apache-2.0
// The write rate limit (P7-03, ADR-0013, THREAT_MODEL T31/A2, L-080/L-081/L-111): every write takes one unit from the
// grant's counter and from the deployment's counter, both fixed hourly windows in a shared store (the storage `kv` table
// remotely, so every isolate and replica sees the same count). It fails closed: a store that errors or answers
// something other than a count refuses the write, because a limiter that opens on failure is not a limit. Web-standard
// only; the counters are the only state and they carry the window in their key (T21).
import type { Clock } from '../context.ts';
import { AbError, ErrorCode } from '../errors.ts';
import type { WriteLimiter } from './runtime.ts';

/** The part of the storage `kv` table the limiter needs (`KvStore` satisfies it structurally). */
export interface CounterStore {
  /** Atomically adds one and returns the new count, or `null` when `max` would be exceeded. */
  increment(key: string, options: { expiresAt: number; max: number }): Promise<number | null>;
}

export interface WriteRateLimits {
  /** Writes per grant (stdio: per process) in each window. Default 20. */
  readonly perGrant: number;
  /** Writes of the whole deployment in each window; `null` = no deployment limit (stdio). Default 200. */
  readonly deployment: number | null;
}

export const DEFAULT_WRITE_RATE_LIMITS: WriteRateLimits = Object.freeze({ perGrant: 20, deployment: 200 });

export const WRITE_LIMIT_WINDOW_MS = 3_600_000;

export interface WriteLimiterOptions {
  readonly counters: CounterStore;
  readonly clock: Clock;
  readonly limits?: WriteRateLimits;
  /** Told when the store failed (the write is refused either way); log line only, never a value. */
  readonly onError?: (error: unknown) => void;
}

function unavailable(cause: unknown): AbError {
  return new AbError(
    ErrorCode.WriteLimitUnavailable,
    'The write limiter is not available, so no change was made.',
    {
      hint: 'Try again later and tell the administrator if it keeps happening. Nothing was changed in Agility.',
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/** A limiter over shared counters. Built per host, holds no request data. */
export function createWriteLimiter(options: WriteLimiterOptions): WriteLimiter {
  const limits = options.limits ?? DEFAULT_WRITE_RATE_LIMITS;
  const { counters, clock } = options;
  return {
    async check({ actor }) {
      const now = clock.now();
      const window = Math.floor(now / WRITE_LIMIT_WINDOW_MS);
      const expiresAt = (window + 1) * WRITE_LIMIT_WINDOW_MS;
      const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
      // The grant first: a caller over its own limit must not spend the deployment's budget.
      const subject = encodeURIComponent(actor.grantId ?? actor.id);
      const scopes: Array<{ scope: 'grant' | 'deployment'; key: string; max: number }> = [
        { scope: 'grant', key: `wl:g:${subject}:${window}`, max: limits.perGrant },
      ];
      if (limits.deployment !== null) {
        scopes.push({ scope: 'deployment', key: `wl:all:${window}`, max: limits.deployment });
      }
      for (const s of scopes) {
        let count: number | null;
        try {
          count = await counters.increment(s.key, { expiresAt, max: s.max });
        } catch (error) {
          options.onError?.(error);
          throw unavailable(error);
        }
        if (count === null) {
          throw new AbError(
            ErrorCode.LimitRate,
            s.scope === 'grant'
              ? 'This connection has used its write limit for this hour. Nothing was changed.'
              : 'This deployment has used its write limit for this hour. Nothing was changed.',
            {
              hint: `Wait about ${retryAfterSeconds} seconds before asking for another change; do not retry in a loop.`,
              details: { scope: s.scope, limit: s.max, retryAfterSeconds },
              localDetails: true,
            },
          );
        }
        if (!Number.isInteger(count) || count < 1 || count > s.max) {
          // Not a count we can trust: refuse (L-080).
          options.onError?.(new Error('write limiter: unexpected counter value'));
          throw unavailable(undefined);
        }
      }
    },
  };
}

/** Counters in process memory, for stdio (one process, nothing to share). Bounded; expired windows go first. */
export function memoryCounterStore(clock: Clock, maxKeys = 1_000): CounterStore {
  const data = new Map<string, { n: number; expiresAt: number }>();
  return {
    async increment(key, { expiresAt, max }) {
      const now = clock.now();
      const cur = data.get(key);
      if (cur === undefined || cur.expiresAt <= now) {
        if (data.size >= maxKeys) for (const [k, v] of data) if (v.expiresAt <= now) data.delete(k);
        if (max < 1) return null;
        data.set(key, { n: 1, expiresAt });
        return 1;
      }
      if (cur.n + 1 > max) return null;
      cur.n += 1;
      return cur.n;
    },
  };
}
