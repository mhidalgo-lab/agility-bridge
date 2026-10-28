// SPDX-License-Identifier: Apache-2.0
// The migration script's wrangler steps against a fake wrangler (P3-09): refusals happen before any write, the SQL file
// is deleted afterwards, and the row counts are checked. The round trip on workerd is apps/worker/test/migrate.test.ts.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateMasterKey, Keyring, verifyKeyring } from '../../packages/auth/src/index.ts';
import { MIGRATIONS } from '../../packages/storage/src/index.ts';
import { openSqliteStorage } from '../../packages/storage-sqlite/src/index.ts';
import { migrate, sqlLiteral } from '../cf-migrate.ts';
import type { Wrangler } from '../cf-setup.ts';

async function backup(): Promise<{ path: string; kcv: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cfm-'));
  const storage = await openSqliteStorage({ path: join(dir, 'server.db') });
  const keyring = await Keyring.create(generateMasterKey(1));
  await verifyKeyring(storage, keyring);
  await storage.users.create({ id: 'u1', email: 'owner@example.test', role: 'owner' });
  await storage.instances.create({ id: 'i1', label: 'X', baseUrl: 'https://agility.example.test/X' });
  await storage.credentials.create({
    id: 'c1',
    instanceId: 'i1',
    ownerUserId: null,
    label: 's',
    tokenCiphertext: 'AAAA',
    tokenIv: 'AAAAAAAAAAAAAAAA',
    keyVersion: 1,
    tokenHint: 'wxyz',
  });
  const kcv = (await storage.kv.get('crypto:kcv:v1')) as string;
  const path = join(dir, 'backup.db');
  await storage.backup(path);
  await storage.close();
  return { path, kcv };
}

/** A D1 seen through `wrangler d1 execute`: schema version, row count and key-check values; a `--file` import. */
function fakeD1(state: { version: number | null; rows: number; kcv: Record<string, string> }, imported = 3) {
  const files: { path: string; sql: string }[] = [];
  const calls: string[] = [];
  const wrangler: Wrangler = (args) => {
    calls.push(args.join(' '));
    const json = (results: unknown[]) => ({ code: 0, stdout: JSON.stringify([{ results }]), stderr: '' });
    const i = args.indexOf('--command');
    if (i >= 0) {
      const sql = args[i + 1] as string;
      if (state.version === null) return { code: 1, stdout: '', stderr: 'no such table: schema_migrations' };
      if (sql.startsWith('SELECT max(version)')) return json([{ v: state.version }]);
      if (sql.includes('count(*)')) return json([{ n: state.rows }]);
      return json(Object.entries(state.kcv).map(([key, value]) => ({ key, value })));
    }
    const f = args.indexOf('--file');
    if (f >= 0) {
      const path = args[f + 1] as string;
      files.push({ path, sql: readFileSync(path, 'utf8') });
      state.rows += imported; // users, instances, credentials when the import is complete
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { wrangler, files, calls };
}

/** A worker directory with the staging deployment's local config, as cf:setup writes it. */
function workerDir(name = 'agility-bridge-staging'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cfm-worker-'));
  writeFileSync(
    join(dir, `wrangler.${name}.local.jsonc`),
    JSON.stringify({ name, d1_databases: [{ binding: 'DB', database_name: name, database_id: 'x' }] }),
  );
  return dir;
}

const run = (from: string, wrangler: Wrangler, dir = workerDir()) =>
  migrate({ name: 'agility-bridge-staging', from, workerDir: dir, wrangler, log: () => {} });

describe('cf:migrate', () => {
  it('imports into an empty, migrated target with the same key, then deletes the SQL file', async () => {
    const b = await backup();
    const d1 = fakeD1({ version: MIGRATIONS.length, rows: 0, kcv: { 'crypto:kcv:v1': b.kcv } });
    expect(await run(b.path, d1.wrangler)).toMatchObject({ users: 1, instances: 1, credentials: 1 });
    expect(d1.files).toHaveLength(1);
    expect(d1.files[0]?.sql).toContain('INSERT INTO "credentials"');
    expect(d1.files[0]?.sql).not.toContain('crypto:kcv'); // already on the target
    expect(existsSync(d1.files[0]?.path as string)).toBe(false);
    expect(d1.calls.every((c) => c.includes('--remote'))).toBe(true);
  });

  it('refuses before writing: not empty, not migrated, another schema, another key', async () => {
    const b = await backup();
    const cases = [
      [{ version: MIGRATIONS.length, rows: 4, kcv: { 'crypto:kcv:v1': b.kcv } }, /not empty/],
      [{ version: null, rows: 0, kcv: {} }, /not migrated/],
      [{ version: MIGRATIONS.length + 1, rows: 0, kcv: { 'crypto:kcv:v1': b.kcv } }, /schema \d+/],
      [{ version: MIGRATIONS.length, rows: 0, kcv: { 'crypto:kcv:v1': 'different' } }, /master key/],
    ] as const;
    for (const [state, error] of cases) {
      const d1 = fakeD1({ ...state, kcv: { ...state.kcv } });
      await expect(run(b.path, d1.wrangler)).rejects.toThrow(error);
      expect(d1.files).toEqual([]);
    }
  });

  it('refuses a failed count or key-check read, a bad name, and a config of another deployment (P3-11 review)', async () => {
    const b = await backup();
    const d1 = fakeD1({ version: MIGRATIONS.length, rows: 0, kcv: { 'crypto:kcv:v1': b.kcv } });
    const flaky: Wrangler = (args, o) => {
      const sql = args[args.indexOf('--command') + 1] ?? '';
      if (args.includes('--command') && sql.includes('count(*)'))
        return { code: 1, stdout: '', stderr: 'boom' };
      return d1.wrangler(args, o);
    };
    await expect(run(b.path, flaky)).rejects.toThrow(/Could not read the target/);
    expect(d1.files).toEqual([]);
    await expect(
      migrate({
        name: '../../tmp/evil',
        from: b.path,
        workerDir: workerDir(),
        wrangler: d1.wrangler,
        log: () => {},
      }),
    ).rejects.toThrow(/--name/);
    const other = workerDir();
    writeFileSync(
      join(other, 'wrangler.agility-bridge-staging.local.jsonc'),
      JSON.stringify({
        name: 'agility-bridge',
        d1_databases: [{ binding: 'DB', database_name: 'agility-bridge' }],
      }),
    );
    await expect(run(b.path, d1.wrangler, other)).rejects.toThrow(/another deployment/);
    expect(d1.calls.filter((c) => c.includes('--file'))).toEqual([]);
  });

  it('reports an import that landed fewer rows than it exported', async () => {
    const b = await backup();
    const d1 = fakeD1({ version: MIGRATIONS.length, rows: 0, kcv: { 'crypto:kcv:v1': b.kcv } }, 1);
    await expect(run(b.path, d1.wrangler)).rejects.toThrow(/Imported 1 rows, expected 3/);
  });

  it('writes SQL literals that keep quotes, numbers, nulls and blobs', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(42)).toBe('42');
    expect(sqlLiteral("O'Neil; DROP")).toBe("'O''Neil; DROP'");
    expect(sqlLiteral(new Uint8Array([1, 255]))).toBe("X'01ff'");
  });
});
