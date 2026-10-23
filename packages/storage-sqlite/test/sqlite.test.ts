// SPDX-License-Identifier: Apache-2.0
// What only an SQL engine can show: the migration runner, the DDL matching the Drizzle schema, triggers that guard
// every writer, and atomicity across two connections to one file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  appliedMigrations,
  MIGRATIONS,
  type Migration,
  MigrationError,
  migrate,
  migrationChecksum,
  openSqlStorage,
  type SqlDriver,
  schema,
} from '@agility-bridge/storage';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteDriver } from '../src/index.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-sqlite-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const memory = () => createSqliteDriver(new DatabaseSync(':memory:'));

describe('createSqliteDriver', () => {
  it('turns foreign keys on for the connection', async () => {
    const db = new DatabaseSync(':memory:');
    createSqliteDriver(db);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('binds values instead of splicing them, and rolls a failed batch back completely', async () => {
    const driver = memory();
    await driver.query({
      sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
      params: [],
      method: 'run',
    });
    const hostile = "O'Brien; DROP TABLE t; --";
    await driver.query({
      sql: 'INSERT INTO t (id, name) VALUES (?, ?)',
      params: [1, hostile],
      method: 'run',
    });
    await expect(
      driver.batch([
        { sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [2, 'two'], method: 'run' },
        { sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [1, 'duplicate'], method: 'run' },
      ]),
    ).rejects.toThrow(/UNIQUE/);
    const { rows } = await driver.query({
      sql: 'SELECT id, name FROM t ORDER BY id',
      params: [],
      method: 'all',
    });
    expect(rows).toEqual([[1, hostile]]);
    expect(
      (await driver.query({ sql: 'SELECT name FROM t WHERE id = ?', params: [9], method: 'get' })).rows,
    ).toBe(undefined);
  });
});

describe('migrations', () => {
  it('applies the embedded history once and records checksums', async () => {
    const driver = memory();
    expect(await migrate(driver, { now: () => 42 })).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await migrate(driver)).toEqual([]);
    const applied = await appliedMigrations(driver);
    expect(applied).toEqual(
      await Promise.all(
        MIGRATIONS.map(async (m) => ({
          version: m.version,
          name: m.name,
          checksum: await migrationChecksum(m),
          appliedAt: 42,
        })),
      ),
    );
  });

  it('refuses a database that is newer than the binary', async () => {
    const driver = memory();
    await migrate(driver);
    const next = MIGRATIONS.length + 1;
    await driver.query({
      sql: 'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      params: [next, 'future', 'x', 1],
      method: 'run',
    });
    await expect(migrate(driver)).rejects.toThrow(MigrationError);
    await expect(migrate(driver)).rejects.toThrow(/newer than this agility-bridge/);
    await expect(openSqlStorage(driver)).rejects.toThrow(MigrationError);
  });

  it('refuses a database whose applied migration differs from the embedded one', async () => {
    const driver = memory();
    await migrate(driver);
    await driver.query({
      sql: "UPDATE schema_migrations SET checksum = 'tampered'",
      params: [],
      method: 'run',
    });
    await expect(migrate(driver)).rejects.toThrow(/differs/);
  });

  it('applies a later migration atomically: a failing one leaves no trace', async () => {
    const driver = memory();
    await migrate(driver);
    const broken: Migration = {
      version: MIGRATIONS.length + 1,
      name: 'broken',
      statements: ['CREATE TABLE extra (id TEXT PRIMARY KEY) STRICT', 'INSERT INTO nowhere VALUES (1)'],
    };
    await expect(migrate(driver, { migrations: [...MIGRATIONS, broken] })).rejects.toThrow(/nowhere/);
    const { rows } = await driver.query({
      sql: "SELECT name FROM sqlite_schema WHERE name = 'extra'",
      params: [],
      method: 'all',
    });
    expect(rows).toEqual([]);
    expect((await appliedMigrations(driver)).map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('two processes migrating one file at once both end up on the same history', async () => {
    const file = join(dir, 'race.db');
    const a = createSqliteDriver(new DatabaseSync(file));
    const b = createSqliteDriver(new DatabaseSync(file));
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    expect([...ra, ...rb].sort()).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await appliedMigrations(b)).toHaveLength(MIGRATIONS.length);
    await a.close();
    await b.close();
  });
});

describe('schema', () => {
  async function tableInfo(name: string) {
    const db = new DatabaseSync(':memory:');
    await migrate(createSqliteDriver(db));
    return db.prepare(`PRAGMA table_info(${name})`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
  }

  it('the migrated DDL has exactly the columns of the Drizzle schema', async () => {
    const db = new DatabaseSync(':memory:');
    await migrate(createSqliteDriver(db));
    const tables = (
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(Object.keys(schema.TABLES).sort());
    for (const [name, table] of Object.entries(schema.TABLES)) {
      const config = getTableConfig(table as SQLiteTable);
      const expected = config.columns
        .map((c) => ({
          name: c.name,
          type: c.getSQLType().toUpperCase(),
          notnull: c.notNull || c.primary ? 1 : 0,
          pk: c.primary ? 1 : 0,
        }))
        .sort((x, y) => x.name.localeCompare(y.name));
      const actual = (await tableInfo(name))
        .map(({ name: n, type, notnull, pk }) => ({ name: n, type, notnull, pk }))
        .sort((x, y) => x.name.localeCompare(y.name));
      expect(actual, name).toEqual(expected);
    }
  });

  it('every table is STRICT (P0-09)', async () => {
    const db = new DatabaseSync(':memory:');
    await migrate(createSqliteDriver(db));
    const rows = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'").all() as {
      name: string;
      sql: string;
    }[];
    for (const row of rows) expect(row.sql.trimEnd().endsWith('STRICT'), row.name).toBe(true);
  });

  it('the triggers guard raw SQL writers too (audit append-only, credential rules, instance origin)', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = await openSqlStorage(createSqliteDriver(db));
    await storage.audit.append({ id: 'a1', ts: 1, kind: 'admin', action: 'x', status: 'ok' });
    expect(() => db.exec("UPDATE audit_log SET status = 'error'")).toThrow(/ab_conflict: audit_log/);
    await storage.instances.create({ id: 'i', label: 'i', baseUrl: 'https://a.example.test' });
    await storage.users.create({ id: 'u', email: 'u@example.test', role: 'member' });
    await storage.credentials.create({
      id: 'c',
      instanceId: 'i',
      ownerUserId: 'u',
      label: 'c',
      tokenCiphertext: 'x',
      tokenIv: 'y',
      keyVersion: 1,
      tokenHint: 'abcd',
    });
    expect(() =>
      db.exec(
        "INSERT INTO workspaces (id, slug, name, instance_id, allowed_scope_ids, include_child_scopes, limits, write_policy, default_credential_id, created_at, updated_at) VALUES ('w', 'w', 'w', 'i', '[]', 0, '{}', '{}', 'c', 1, 1)",
      ),
    ).toThrow(/ab_invalid: workspaces.default_credential_id/);
    expect(() => db.exec("UPDATE instances SET base_url = 'https://evil.example.test'")).toThrow(
      /ab_conflict/,
    );
    expect(() => db.exec("UPDATE credentials SET token_hint = 'toolong'")).toThrow(/CHECK constraint failed/);
  });
});

describe('atomic single-use state across connections (L-073)', () => {
  it('only one of two connections takes a value, and counters add up', async () => {
    const file = join(dir, 'kv.db');
    const a = await openSqlStorage(createSqliteDriver(new DatabaseSync(file)));
    const b = await openSqlStorage(createSqliteDriver(new DatabaseSync(file)));
    await a.kv.set('code', 'v');
    const taken = await Promise.all([
      a.kv.take('code'),
      b.kv.take('code'),
      a.kv.take('code'),
      b.kv.take('code'),
    ]);
    expect(taken.filter((t) => t === 'v')).toHaveLength(1);
    const counts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).kv.increment('n', { max: 15 })),
    );
    expect(counts.filter((c) => c !== null)).toHaveLength(15);
    expect(await a.kv.get('n')).toBe('15');
    await a.close();
    await b.close();
  });
});

describe('clearing an identity across connections (P4-12, L-220)', () => {
  it('lets exactly one of four unbinds from two connections win, and a stale one never clears a new binding', async () => {
    const file = join(dir, 'unbind.db');
    const a = await openSqlStorage(createSqliteDriver(new DatabaseSync(file)));
    const b = await openSqlStorage(createSqliteDriver(new DatabaseSync(file)));
    await a.users.create({ id: 'u1', email: 'u1@example.test', role: 'member' });
    await a.users.bind('u1', 'google', 'sub-1');
    const expected = { idp: 'google', idpSubject: 'sub-1' };
    const results = await Promise.all([
      a.users.unbind('u1', expected),
      b.users.unbind('u1', expected),
      a.users.unbind('u1', expected),
      b.users.unbind('u1', expected),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    // A first sign-in on one connection, a stale unbind on the other: the new binding stays.
    await b.users.bind('u1', 'github', 'gh-1');
    expect(await a.users.unbind('u1', expected)).toBeNull();
    expect(await a.users.get('u1')).toMatchObject({ idp: 'github', idpSubject: 'gh-1' });
    await a.close();
    await b.close();
  });
});

describe('access bundle (P3-02)', () => {
  it('reads a token and its access records in one driver call (one D1 round trip)', async () => {
    const inner = createSqliteDriver(new DatabaseSync(':memory:'));
    const calls: string[] = [];
    const counting: SqlDriver = {
      query: (st) => {
        calls.push('query');
        return inner.query(st);
      },
      batch: (sts) => {
        calls.push(`batch:${sts.length}`);
        return inner.batch(sts);
      },
      close: () => inner.close(),
    };
    const storage = await openSqlStorage(counting);
    calls.length = 0;
    const bundle = await storage.accessTokens.bundleByHash('a'.repeat(64));
    expect(bundle.token).toBeNull();
    expect(calls).toEqual(['batch:6']);
    await storage.close();
  });
});
