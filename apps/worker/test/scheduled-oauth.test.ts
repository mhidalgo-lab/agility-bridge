// SPDX-License-Identifier: Apache-2.0
// The OAuth part of the Worker's cron run (P5-09, T11, T20, L-097): unused dynamic registrations are swept in a bounded
// slice per run that resumes where the last one stopped, and the existing kv purge removes expired counters. The run is
// driven directly over a memory storage (the D1 path of the sweep's queries is the shared OAuth suites').
import { createMemoryStorage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import type { JobContext } from '../src/boot.ts';
import { runScheduled, SLICES } from '../src/scheduled.ts';

const DAY = 86_400_000;

describe('scheduled OAuth housekeeping', () => {
  const context = (storage: JobContext['storage'], oauth: object | undefined): JobContext =>
    ({
      storage,
      keyring: { versions: [1] },
      services: {},
      settings: { auditRetentionDays: 0, revalidationHours: 0, oauth },
      logger: { info: () => undefined, error: () => undefined, warn: () => undefined },
    }) as unknown as JobContext;
  const register = async (storage: JobContext['storage'], id: string, created: number) => {
    const record = {
      clientId: id,
      redirectUris: ['http://127.0.0.1:1/cb'],
      registrationDate: Math.floor(created / 1000),
      registrationExpiresAt: Math.floor(created / 1000) + 5 * 86_400,
    };
    await storage.kv.set(`oauth:client:${id}`, JSON.stringify(record), { expiresAt: created + 5 * DAY });
  };

  it('sweeps a bounded slice of unused registrations per run and finishes over several runs', async () => {
    const t0 = Date.now();
    const storage = createMemoryStorage();
    const total = SLICES.registrations + 5;
    for (let i = 0; i < total; i++)
      await register(storage, `client-${String(i).padStart(3, '0')}`, t0 - 2 * DAY);
    // A young one and a stored document client must survive.
    await register(storage, 'client-young', t0);
    await storage.kv.set('oauth:client:https://doc.example.org/m.json', JSON.stringify({ clientId: 'x' }), {
      expiresAt: t0 + DAY,
    });
    const jobs = context(storage, { registrationUnusedTtlSeconds: 86_400 });
    const first = await runScheduled(jobs, t0, 'run-1');
    expect(first.registrationsSwept).toBe(SLICES.registrations);
    expect(first.failed).toEqual([]);
    const second = await runScheduled(jobs, t0, 'run-2');
    expect(second.registrationsSwept).toBe(5);
    const third = await runScheduled(jobs, t0, 'run-3');
    expect(third.registrationsSwept).toBe(0);
    expect(await storage.kv.list('oauth:client:', { limit: 1000 })).toEqual([
      'oauth:client:client-young',
      'oauth:client:https://doc.example.org/m.json',
    ]);
  });

  it('does nothing for OAuth when it is off, and purges expired counters either way', async () => {
    const t0 = Date.now();
    const storage = createMemoryStorage();
    await register(storage, 'client-old', t0 - 2 * DAY);
    await storage.kv.set('oauth-abuse:authorize:all:1', '3', { expiresAt: t0 - 1 });
    const result = await runScheduled(context(storage, undefined), t0, 'run-1');
    expect(result.registrationsSwept).toBe(0);
    expect(result.kvPurged).toBeGreaterThanOrEqual(1);
    expect(await storage.kv.list('oauth:client:', { limit: 10 })).toEqual(['oauth:client:client-old']);
  });
});
