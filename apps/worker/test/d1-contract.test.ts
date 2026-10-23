// SPDX-License-Identifier: Apache-2.0
// The storage contract on local D1 (P3-02): Miniflare's D1 binding driven from Node, one Miniflare per file and an
// empty database per test. Same suite as memory and SQLite, nothing weakened (L-071).
import {
  appliedMigrations,
  createD1Driver,
  type D1Database,
  MIGRATIONS,
  openSqlStorage,
} from '@agility-bridge/storage';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginRace } from '../../../packages/auth/test/login-race.ts';
import { storageContract } from '../../../packages/storage/test/contract.ts';

let mf: Miniflare;
let db: D1Database;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null, { status: 404 }); } }',
      compatibilityDate: '2026-09-26',
      d1Databases: ['DB'],
    }),
  );
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
});
afterAll(() => mf.dispose());

/** Drops every trigger, index and table, so each test migrates an empty database. */
async function emptyD1(d: D1Database): Promise<void> {
  const objects = (await d
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' " +
        // Triggers first, then tables newest first: a child table goes before the parent it references.
        "AND type IN ('trigger', 'table') ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END, rowid DESC",
    )
    .raw()) as [string, string][];
  if (objects.length === 0) return;
  await d.batch([
    d.prepare('PRAGMA defer_foreign_keys = ON'),
    ...objects.map(([type, name]) => d.prepare(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`)),
  ]);
}

storageContract('d1 (local)', async (clock) => {
  await emptyD1(db);
  return openSqlStorage(createD1Driver(db), { now: clock.now });
});

describe('migrations on D1', () => {
  it('concurrent first boots of one database end with one history and no error', async () => {
    await emptyD1(db);
    const opened = await Promise.allSettled(
      Array.from({ length: 6 }, () => openSqlStorage(createD1Driver(db))),
    );
    expect(opened.map((r) => r.status)).toEqual(Array(6).fill('fulfilled'));
    const history = await appliedMigrations(createD1Driver(db));
    expect(history.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('refuses a database written by a newer version', async () => {
    await emptyD1(db);
    await openSqlStorage(createD1Driver(db));
    await db
      .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .bind(999, 'from-the-future', 'x'.repeat(64), 0)
      .run();
    await expect(openSqlStorage(createD1Driver(db))).rejects.toThrow(/newer/i);
  });
});

describe('sign-in binding on D1 (P4-01, L-185)', () => {
  it('lets exactly one of three concurrent first sign-ins bind the user', async () => {
    await emptyD1(db);
    const storage = await openSqlStorage(createD1Driver(db));
    expect(await loginRace(storage)).toEqual({ ok: 1, conflict: 2, bound: expect.any(String) });
  });
});
