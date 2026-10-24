// SPDX-License-Identifier: Apache-2.0
// Housekeeping of the OAuth server's storage (P5-09, T11, T20): the sweep of dynamic registrations that were never used,
// callable by a host with nothing but the storage (the Worker's cron, Node's timer), and bounded per call so a run fits
// the Free plan's 50 D1 queries (L-097). Web-standard only.
import type { Clock, Logger } from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import { OAUTH_KV_PREFIX, oauthKvNamespace } from './kv-namespace.ts';

/** Where the provider keeps its client records in the `kv` table; stored document clients start `https://`. */
export const CLIENT_RECORD_PREFIX = `${OAUTH_KV_PREFIX}client:`;
export const DOCUMENT_CLIENT_PREFIX = `${CLIENT_RECORD_PREFIX}https://`;
/** Most keys one `kv.list` returns (the store's own cap). */
const KV_LIST_MAX = 1000;
/** Where a bounded sweep resumes (a key name; the registrations stay ordered by key). */
export const SWEEP_CURSOR_KEY = 'oauth-sweep-cursor';
/** A registration whose expiry stamp is within this many seconds of its creation never exchanged a code. */
const UNUSED_STAMP_MAX_S = 7 * 86_400;

export interface SweepOptions {
  readonly now: () => number;
  /** The unused-registration lifetime in force (`AB_OAUTH_DCR_UNUSED_TTL`). */
  readonly unusedTtlSeconds: number;
  /** Registrations to look at in this call; absent = all (at most 1,000). A bounded call resumes where the last stopped. */
  readonly limit?: number;
}

/**
 * Deletes dynamic registrations nobody used within the unused lifetime. Stored metadata documents are skipped: their
 * own expiry removes them (and the store's purge reclaims the row). Never reads or returns a secret.
 */
export async function sweepRegistrations(
  storage: Storage,
  options: SweepOptions,
): Promise<{ readonly removed: number; readonly examined: number }> {
  const kv = storage.kv;
  const namespace = oauthKvNamespace(kv, options.now);
  const bounded = options.limit !== undefined;
  const budget = Math.min(KV_LIST_MAX, Math.max(1, options.limit ?? KV_LIST_MAX));
  const after = bounded ? ((await kv.get(SWEEP_CURSOR_KEY)) ?? undefined) : undefined;
  const names = await kv.list(CLIENT_RECORD_PREFIX, {
    limit: KV_LIST_MAX,
    ...(after === undefined ? {} : { after }),
  });
  const nowSeconds = Math.floor(options.now() / 1000);
  let removed = 0;
  let examined = 0;
  let last: string | undefined;
  for (const name of names) {
    if (name.startsWith(DOCUMENT_CLIENT_PREFIX)) continue;
    if (examined >= budget) break;
    examined += 1;
    last = name;
    const key = name.slice(OAUTH_KV_PREFIX.length);
    const record = (await namespace.get(key, { type: 'json' })) as {
      readonly registrationDate?: unknown;
      readonly registrationExpiresAt?: unknown;
    } | null;
    if (record === null || typeof record.registrationDate !== 'number') continue;
    if (typeof record.registrationExpiresAt !== 'number') continue;
    // Unused: the expiry stamp is still the short one the registration was given (a token exchange renews it to the long
    // registration lifetime), and the unused lifetime configured now has run out.
    const unused = record.registrationExpiresAt - record.registrationDate <= UNUSED_STAMP_MAX_S;
    if (unused && record.registrationDate + options.unusedTtlSeconds <= nowSeconds) {
      await namespace.delete(key);
      removed += 1;
    }
  }
  if (bounded) {
    // Resume after the last one looked at; past the end of the list, start over next time.
    if (examined < budget || last === undefined) await kv.delete(SWEEP_CURSOR_KEY);
    else await kv.set(SWEEP_CURSOR_KEY, last, { expiresAt: options.now() + 7 * 86_400_000 });
  }
  return { removed, examined };
}

/** Registrations looked at per scheduled run (a Workers cron run has 50 D1 queries on the Free plan, L-097). */
export const SWEEP_SLICE = 20;
/** The default unused-registration lifetime (kept equal to `OAUTH_DEFAULT_UNUSED_REGISTRATION_TTL_S`). */
const DEFAULT_UNUSED_TTL_S = 86_400;

export interface StorageHousekeepingOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Set when OAuth is on: the unused-registration lifetime (default 24 h) to sweep with. */
  readonly oauth?: { readonly registrationUnusedTtlSeconds?: number | undefined } | undefined;
  readonly everyMs?: number;
}

/**
 * Node's housekeeping of the `kv` table (P5-09): expired rows (counters, markers, sessions, provider records) are only
 * ever removed by a job, so one runs at start and then hourly, in bounded batches, plus the registration sweep when OAuth
 * is on. The timer does not keep the process alive. Returns a stop function.
 */
export function scheduleStorageHousekeeping(
  storage: Storage,
  options: StorageHousekeepingOptions,
): () => void {
  const { clock, logger } = options;
  const run = async (): Promise<void> => {
    try {
      let purged = 0;
      for (let i = 0; i < 20; i++) {
        const n = await storage.kv.purgeExpired(1_000);
        purged += n;
        if (n < 1_000) break;
      }
      let swept = 0;
      if (options.oauth !== undefined) {
        const ttl = options.oauth.registrationUnusedTtlSeconds ?? DEFAULT_UNUSED_TTL_S;
        swept = (await sweepRegistrations(storage, { now: () => clock.now(), unusedTtlSeconds: ttl }))
          .removed;
      }
      if (purged > 0 || swept > 0)
        logger.info('storage housekeeping', { expiredRows: purged, registrationsSwept: swept });
    } catch (error) {
      logger.error('storage housekeeping failed', { error: (error as Error).name });
    }
  };
  void run();
  const timer = setInterval(() => void run(), options.everyMs ?? 3_600_000);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
