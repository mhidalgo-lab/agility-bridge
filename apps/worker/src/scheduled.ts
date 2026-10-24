// SPDX-License-Identifier: Apache-2.0
// Housekeeping on Workers (P3-08): one cron trigger runs bounded slices of each job, sized for the Free plan's 50 D1
// queries and 50 subrequests per invocation (L-097). A failing job is logged and the others still run.
import { rotateCredentialKeys } from '@agility-bridge/auth';
import { purgeAudit, SWEEP_SLICE, sweepRegistrations } from '@agility-bridge/http-app';
import type { JobContext } from './boot.ts';

/** Per run: audit batches of 1,000 rows, expired kv entries, credentials re-encrypted, credentials revalidated. */
export const SLICES = Object.freeze({
  auditBatches: 3,
  kvEntries: 1_000,
  rotationBatch: 10,
  revalidations: 1,
  registrations: SWEEP_SLICE,
});
export const ROTATION_LEASE = 'lock:key-rotation';
const LEASE_MS = 10 * 60_000;

export interface JobsResult {
  auditDeleted: number;
  kvPurged: number;
  registrationsSwept: number;
  rotated: number | null;
  revalidated: number;
  failed: string[];
}

export async function runScheduled(jobs: JobContext, now: number, runId: string): Promise<JobsResult> {
  const { storage, keyring, services, settings, logger } = jobs;
  const result: JobsResult = {
    auditDeleted: 0,
    kvPurged: 0,
    registrationsSwept: 0,
    rotated: null,
    revalidated: 0,
    failed: [],
  };
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      result.failed.push(name);
      logger.error('scheduled job failed', { job: name, error: (error as Error).name });
    }
  };
  await step('audit_retention', async () => {
    result.auditDeleted = await purgeAudit(storage, settings.auditRetentionDays, now, SLICES.auditBatches);
  });
  await step('kv_purge', async () => {
    result.kvPurged = await storage.kv.purgeExpired(SLICES.kvEntries);
  });
  // Unused dynamic registrations (P5-09): a bounded slice per run, resuming where the last one stopped.
  if (settings.oauth !== undefined) {
    await step('oauth_sweep', async () => {
      result.registrationsSwept = (
        await sweepRegistrations(storage, {
          now: () => now,
          unusedTtlSeconds: settings.oauth?.registrationUnusedTtlSeconds ?? 86_400,
          limit: SLICES.registrations,
        })
      ).removed;
    });
  }
  // Re-encrypt what is still on an older key, one batch per run; the lease keeps overlapping runs apart (the
  // compare-and-swap per row keeps them correct anyway, L-075).
  if (keyring.versions.length > 1) {
    await step('key_rotation', async () => {
      if (!(await storage.kv.setIfAbsent(ROTATION_LEASE, runId, { expiresAt: now + LEASE_MS }))) return;
      try {
        const r = await rotateCredentialKeys(storage, keyring, {
          reason: 'scheduled',
          batchSize: SLICES.rotationBatch,
          maxBatches: 1,
          actor: { via: 'cron' },
        });
        result.rotated = r.rotated;
        if (r.remaining > 0 || r.failed.length > 0) {
          logger.info('key rotation continues', {
            rotated: r.rotated,
            remaining: r.remaining,
            failed: r.failed.length,
          });
        }
      } finally {
        if ((await storage.kv.get(ROTATION_LEASE)) === runId) await storage.kv.delete(ROTATION_LEASE);
      }
    });
  }
  if (settings.revalidationHours > 0) {
    await step('revalidation', async () => {
      result.revalidated = await services.credentials.revalidate(
        now - settings.revalidationHours * 3_600_000,
        SLICES.revalidations,
      );
    });
  }
  logger.info('scheduled jobs', { ...result, failed: result.failed.join(',') || null });
  return result;
}
