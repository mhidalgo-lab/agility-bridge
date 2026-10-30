// SPDX-License-Identifier: Apache-2.0
// Per-grant quotas over days and months (P8-09, ADR-0010, THREAT_MODEL T5/A10, L-116, L-080): the Agility tenant's own
// request quota is shared by everyone behind it, so a deployment can cap how many Agility requests one grant may cause
// per UTC day and per UTC month. A request is counted once per logical upstream call (a retry is not a second one, a
// cache hit is none). To stay inside the Workers Free D1 row budget the shared counters are touched at most three times
// per MCP request: one read when the first upstream call is about to happen, and one increment per period when the
// request is over. Counters are in the storage `kv` table, so every isolate and replica sees them. The control fails
// OPEN: a counter outage is logged and never blocks work (the write limiter, which fails closed, is a different
// control, L-080). Web-standard only; a meter belongs to one request and is never shared (T21).
import type { Clock } from '../context.ts';
import { AbError, ErrorCode } from '../errors.ts';
import type { Logger } from '../logger.ts';

/** The part of the storage `kv` table the quota needs (`KvStore` satisfies it structurally). */
export interface QuotaCounters {
  getMany(keys: readonly string[]): Promise<Map<string, string>>;
  increment(key: string, options: { by: number; expiresAt: number }): Promise<number | null>;
}

/** Requests per grant and period; `null` leaves that period unlimited. */
export interface QuotaLimits {
  readonly daily: number | null;
  readonly monthly: number | null;
}

export type QuotaPeriod = 'daily' | 'monthly';

/** The share of a quota after which a warning is raised (L-116). */
export const QUOTA_WARN_AT = 0.8;

export interface QuotaPeriodUsage {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  /** When the counter restarts (epoch ms): the next UTC midnight, or the first instant of the next UTC month. */
  readonly resetsAt: number;
  /** At or above 80% of the limit. */
  readonly warn: boolean;
}

/** What a grant has used. `unknown` when the counters cannot be read: never shown as "unlimited". */
export type QuotaUsage =
  | {
      readonly status: 'ok';
      readonly daily?: QuotaPeriodUsage;
      readonly monthly?: QuotaPeriodUsage;
    }
  | { readonly status: 'unknown' };

/** The per-request side of a quota: gates upstream calls, counts them and writes the total once. */
export interface QuotaMeter {
  /**
   * Before one logical upstream call. Refuses a read with `AB_LIMIT_QUOTA` when a period is used up; a write is
   * counted but never refused here (it has its own hourly limit and approval, ADR-0013). Fails open on a counter outage.
   */
  beforeCall(options: { readonly write: boolean }): Promise<void>;
  /** Adds this request's calls to the shared counters (once; later calls start over). Never throws. */
  flush(): Promise<void>;
  /** The grant's usage including this request's calls so far (`whoami`). */
  usage(): Promise<QuotaUsage>;
}

export interface QuotaGate {
  readonly limits: QuotaLimits;
  /** A meter for one request of one grant. */
  meterFor(grantId: string): QuotaMeter;
  /** The stored usage of a grant (admin panel); nothing is taken. */
  usageOf(grantId: string): Promise<QuotaUsage>;
}

export interface QuotaGateOptions {
  readonly counters: QuotaCounters;
  readonly clock: Clock;
  readonly limits: QuotaLimits;
  readonly logger?: Logger;
}

interface Window {
  readonly period: QuotaPeriod;
  readonly key: string;
  readonly limit: number;
  readonly resetsAt: number;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** The windows of the configured periods at `now` (UTC), with their counter keys. */
function windows(grantId: string, limits: QuotaLimits, now: number): Window[] {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const subject = encodeURIComponent(grantId);
  const out: Window[] = [];
  if (limits.daily !== null) {
    out.push({
      period: 'daily',
      key: `qt:d:${subject}:${y}${pad(mo + 1, 2)}${pad(d.getUTCDate(), 2)}`,
      limit: limits.daily,
      resetsAt: Date.UTC(y, mo, d.getUTCDate() + 1),
    });
  }
  if (limits.monthly !== null) {
    out.push({
      period: 'monthly',
      key: `qt:m:${subject}:${y}${pad(mo + 1, 2)}`,
      limit: limits.monthly,
      resetsAt: Date.UTC(y, mo + 1, 1),
    });
  }
  return out;
}

/** A counter's value; throws for anything that is not a whole number, so it is never trusted (L-080). */
function countOf(values: Map<string, string>, key: string): number {
  const seen = values.get(key);
  if (seen === undefined) return 0;
  if (!/^\d{1,15}$/.test(seen)) throw new Error('quota: unexpected counter value');
  return Number(seen);
}

function periodUsage(w: Window, used: number): QuotaPeriodUsage {
  return {
    limit: w.limit,
    used,
    remaining: Math.max(0, w.limit - used),
    resetsAt: w.resetsAt,
    warn: used >= Math.ceil(w.limit * QUOTA_WARN_AT),
  };
}

function usageOf(ws: readonly Window[], used: ReadonlyMap<string, number>): QuotaUsage {
  const out: { daily?: QuotaPeriodUsage; monthly?: QuotaPeriodUsage } = {};
  for (const w of ws) out[w.period] = periodUsage(w, used.get(w.key) ?? 0);
  return { status: 'ok', ...out };
}

function exceeded(w: Window, used: number, now: number): AbError {
  const retryAfterSeconds = Math.max(1, Math.ceil((w.resetsAt - now) / 1000));
  return new AbError(
    ErrorCode.LimitQuota,
    w.period === 'daily'
      ? 'This connection has used its Agility request quota for today (UTC). Nothing was asked of Agility.'
      : 'This connection has used its Agility request quota for this month (UTC). Nothing was asked of Agility.',
    {
      hint: `The quota restarts at ${new Date(w.resetsAt).toISOString()}. Use fewer requests (narrower questions, fewer fields) or ask an administrator to raise the quota; do not retry before then.`,
      details: {
        scope: w.period,
        limit: w.limit,
        used,
        resetsAt: new Date(w.resetsAt).toISOString(),
        retryAfterSeconds,
      },
      localDetails: true,
    },
  );
}

/** A quota gate over shared counters. Built per host; holds no request data. */
export function createQuotaGate(options: QuotaGateOptions): QuotaGate {
  const { counters, clock, limits, logger } = options;
  const none = limits.daily === null && limits.monthly === null;

  const read = async (ws: readonly Window[]): Promise<Map<string, number>> => {
    const values = ws.length === 0 ? new Map<string, string>() : await counters.getMany(ws.map((w) => w.key));
    return new Map(ws.map((w) => [w.key, countOf(values, w.key)]));
  };

  return {
    limits,
    usageOf: async (grantId) => {
      if (none) return { status: 'ok' };
      const ws = windows(grantId, limits, clock.now());
      try {
        return usageOf(ws, await read(ws));
      } catch (error) {
        logger?.warn('quota counters could not be read', { error: (error as Error).name });
        return { status: 'unknown' };
      }
    },
    meterFor(grantId) {
      const ws = windows(grantId, limits, clock.now());
      /** Calls of this request not yet written. */
      let calls = 0;
      let stored: Map<string, number> | null = null;
      let loading: Promise<void> | undefined;
      let failed = false;
      const load = (): Promise<void> => {
        loading ??= read(ws).then(
          (m) => {
            stored = m;
          },
          (error: unknown) => {
            // Fail open (D-249): work goes on, the outage is logged, and `usage()` says unknown.
            failed = true;
            logger?.warn('quota counters could not be read', { error: (error as Error).name });
          },
        );
        return loading;
      };
      return {
        async beforeCall({ write }) {
          if (ws.length === 0) return;
          await load();
          if (!failed && !write && stored !== null) {
            for (const w of ws) {
              const used = (stored.get(w.key) ?? 0) + calls;
              if (used >= w.limit) throw exceeded(w, used, clock.now());
            }
          }
          calls++;
        },
        async flush() {
          if (calls === 0 || ws.length === 0) return;
          const n = calls;
          calls = 0;
          try {
            const totals = await Promise.all(
              ws.map(
                async (w) => [w, await counters.increment(w.key, { by: n, expiresAt: w.resetsAt })] as const,
              ),
            );
            for (const [w, total] of totals) {
              stored?.set(w.key, (stored.get(w.key) ?? 0) + n);
              const before = (total ?? n) - n;
              // The first request to reach 80% of a period raises the warning, once per period.
              if (
                before < Math.ceil(w.limit * QUOTA_WARN_AT) &&
                (total ?? 0) >= Math.ceil(w.limit * QUOTA_WARN_AT)
              ) {
                logger?.warn('grant quota reached 80%', { grant: grantId, period: w.period, limit: w.limit });
              }
            }
          } catch (error) {
            logger?.warn('quota counters could not be updated', { error: (error as Error).name });
          }
        },
        async usage() {
          if (ws.length === 0) return { status: 'ok' };
          await load();
          if (failed || stored === null) return { status: 'unknown' };
          const used = new Map<string, number>();
          for (const w of ws) used.set(w.key, (stored.get(w.key) ?? 0) + calls);
          return usageOf(ws, used);
        },
      };
    },
  };
}
