// SPDX-License-Identifier: Apache-2.0
// Scheduled housekeeping on workerd (P3-08): bounded slices per cron run, resumable key rotation that never rotates a
// row twice, a lease that skips overlapping runs, retention and kv purges, at most one revalidation per run.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessServices, generateAdminToken, generateMasterKey, Keyring } from '@agility-bridge/auth';
import { CORE_TOOLS } from '@agility-bridge/core';
import { createD1Driver, type D1Database, openSqlStorage, type Storage } from '@agility-bridge/storage';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { ROTATION_LEASE, SLICES } from '../src/scheduled.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'dist', 'index.js');
const DAY = 86_400_000;

let agility: FixtureAgility;
const running: Miniflare[] = [];
beforeAll(async () => {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['deploy', '--dry-run', '--outdir', 'dist'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
afterEach(async () => {
  await Promise.all(running.splice(0).map((mf) => mf.dispose()));
});

/** A Worker on the new key with the old one as previous, and Node's view of its database. */
async function setUp(bindings: Record<string, string> = {}) {
  const k1 = generateMasterKey(1);
  const k2 = generateMasterKey(2);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: SCRIPT,
      compatibilityDate: '2026-09-26',
      d1Databases: ['DB'],
      bindings: {
        AB_ENVIRONMENT: 'test',
        AB_ALLOW_HTTP_INSTANCES: 'on',
        AB_MASTER_KEY: k2,
        AB_MASTER_KEY_PREVIOUS: k1,
        AB_CREDENTIAL_REVALIDATION_HOURS: '0',
        ...bindings,
      },
    }),
  );
  running.push(mf);
  const storage = await openSqlStorage(
    createD1Driver((await mf.getD1Database('DB')) as unknown as D1Database),
  );
  const tools = new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }]));
  // Credentials sealed with the old key, as before a rotation.
  const old = accessServices({ storage, keyring: await Keyring.create(k1), tools, environment: 'test' });
  const instance = await old.instances.create({ label: 'Synthetic', baseUrl: agility.url });
  const credentials: string[] = [];
  for (let i = 0; i < 25; i++) {
    const c = await old.credentials.create({
      instanceId: instance.id,
      ownerUserId: null,
      label: `svc-${i}`,
      token: `synthetic-token-${i}`,
    });
    credentials.push(c.id);
  }
  // Miniflare's Fetcher type omits scheduled(); the runtime has it.
  const worker = (await mf.getWorker()) as unknown as {
    scheduled(options: { scheduledTime: Date; cron: string }): Promise<unknown>;
  };
  const run = async (scheduledTime: number) => {
    await worker.scheduled({ scheduledTime: new Date(scheduledTime), cron: '*/15 * * * *' });
  };
  return { mf, storage, credentials, run, keyring: await Keyring.create(k2, k1) };
}

/** Waits for the work the scheduled handler left to waitUntil. */
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 25));
}

const onVersion = async (storage: Storage, v: number) =>
  (await storage.credentials.list()).filter((c) => c.keyVersion === v).length;

describe('scheduled housekeeping on workerd', () => {
  it('rotates the old key one batch per run until done, never twice per row, tokens still readable', async () => {
    const w = await setUp();
    const now = Date.now();
    for (let run = 1; run <= 3; run++) {
      await w.run(now + run * 900_000);
      const expected = Math.min(25, run * SLICES.rotationBatch);
      await until(async () => (await onVersion(w.storage, 2)) >= expected);
      expect(await onVersion(w.storage, 2)).toBe(expected);
    }
    await w.run(now + 4 * 900_000);
    const rekeys = await w.storage.audit.query({ kind: 'admin', limit: 1_000 });
    const rotated = rekeys.filter((r) => r.action === 'credential.rekey' && r.status === 'ok');
    expect(rotated).toHaveLength(25);
    expect(new Set(rotated.map((r) => r.targetId)).size).toBe(25);
    expect(rotated.every((r) => (r.details as { via?: string }).via === 'cron')).toBe(true);
    // The re-encrypted tokens open with the new key.
    const { openCredentialToken } = await import('@agility-bridge/auth');
    const c = await w.storage.credentials.get(w.credentials[7] as string);
    expect(await openCredentialToken(w.keyring, c as never)).toBe('synthetic-token-7');
    expect(await w.storage.kv.get(ROTATION_LEASE)).toBeNull();
  });

  it('skips the rotation while another run holds the lease', async () => {
    const w = await setUp();
    const now = Date.now();
    await w.storage.kv.set(ROTATION_LEASE, 'another-run', { expiresAt: now + 600_000 });
    await w.run(now);
    await new Promise((r) => setTimeout(r, 300));
    expect(await onVersion(w.storage, 2)).toBe(0);
    expect(await w.storage.kv.get(ROTATION_LEASE)).toBe('another-run');
  });

  it('purges audit rows past the retention and expired kv entries, keeping the rest', async () => {
    const w = await setUp({ AB_AUDIT_RETENTION_DAYS: '30', AB_MASTER_KEY_PREVIOUS: '' });
    const now = Date.now();
    const row = (id: string, ts: number) =>
      w.storage.audit.append({ id, ts, kind: 'admin', action: 'test.row', status: 'ok' });
    await row('old-1', now - 40 * DAY);
    await row('old-2', now - 31 * DAY);
    await row('new-1', now - 29 * DAY);
    await w.storage.kv.set('expired', 'x', { expiresAt: now - 1 });
    await w.storage.kv.set('live', 'y', { expiresAt: now + DAY });
    await w.run(now);
    await until(async () =>
      (await w.storage.audit.query({ limit: 100 })).every((r) => !r.id.startsWith('old-')),
    );
    const ids = (await w.storage.audit.query({ limit: 100 })).map((r) => r.id);
    expect(ids).toContain('new-1');
    expect(ids.filter((id) => id.startsWith('old-'))).toEqual([]);
    const keys = await w.storage.kv.list('');
    expect(keys).toContain('live');
    expect(keys).not.toContain('expired');
  });

  it('revalidates at most one credential per run, the stalest first', async () => {
    // The previous key stays loaded: the credentials were sealed with it.
    const w = await setUp({ AB_CREDENTIAL_REVALIDATION_HOURS: '1' });
    const now = Date.now();
    const upstream = agility.requests();
    await w.run(now);
    await until(async () => (await w.storage.credentials.list()).some((c) => c.validatedAt !== null));
    await new Promise((r) => setTimeout(r, 200));
    const validated = (await w.storage.credentials.list()).filter((c) => c.validatedAt !== null);
    expect(validated).toHaveLength(1);
    expect(agility.requests()).toBeGreaterThan(upstream);
  });

  it('a rotation finishes on workerd: the cron until nothing remains, then the old version is retired via the API', async () => {
    const admin = generateAdminToken();
    const w = await setUp({ AB_ADMIN_TOKEN: admin });
    const api = async (method: string, path: string, body?: unknown) => {
      const res = (await w.mf.dispatchFetch(`http://127.0.0.1/api/admin/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })) as unknown as Response;
      return { status: res.status, body: (await res.json()) as unknown };
    };
    // Too early: credentials still use version 1.
    expect((await api('POST', '/keys/1/retire', { reason: 'rotation done' })).status).toBe(409);
    const now = Date.now();
    for (let run = 1; run <= 3; run++) await w.run(now + run * 900_000);
    await until(async () => (await onVersion(w.storage, 1)) === 0);
    const status = await api('GET', '/keys');
    expect(status.body).toEqual([
      { version: 1, credentials: 0, loaded: true, current: false, retired: false },
      { version: 2, credentials: 25, loaded: true, current: true, retired: false },
    ]);
    const retired = await api('POST', '/keys/1/retire', { reason: 'rotation done' });
    expect(retired.status).toBe(200);
    expect((retired.body as { version: number; retired: boolean }[])[0]).toMatchObject({
      version: 1,
      retired: true,
    });
    await until(async () =>
      (await w.storage.audit.query({ kind: 'admin', limit: 200 })).some(
        (r) => r.action === 'crypto.retire_key',
      ),
    );
    const row = (await w.storage.audit.query({ kind: 'admin', limit: 200 })).find(
      (r) => r.action === 'crypto.retire_key' && r.status === 'ok',
    );
    expect(row).toMatchObject({ targetType: 'key_version', targetId: '1' });
  });
});
