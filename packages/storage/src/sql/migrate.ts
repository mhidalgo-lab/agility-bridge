// SPDX-License-Identifier: Apache-2.0
// One migration runner for node:sqlite and D1 (ADR-0006, L-071): forward-only, checksummed, each migration atomic with
// its `schema_migrations` row, and a database that is newer than this binary, or whose history differs, is refused.
import { MigrationError } from '../errors.ts';
import { MIGRATIONS, type Migration } from '../migrations/index.ts';
import type { Now } from '../types.ts';
import type { SqlDriver, SqlStatement } from './driver.ts';

const CREATE_HISTORY = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT`;

/** SHA-256 (hex) over the version, the name and every statement. */
export async function migrationChecksum(migration: Migration): Promise<string> {
  const text = [String(migration.version), migration.name, ...migration.statements].join('\n--\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: number;
}

export async function appliedMigrations(driver: SqlDriver): Promise<AppliedMigration[]> {
  await driver.query({ sql: CREATE_HISTORY, params: [], method: 'run' });
  const { rows } = await driver.query({
    sql: 'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
    params: [],
    method: 'all',
  });
  return (rows as [number, string, string, number][]).map(([version, name, checksum, appliedAt]) => ({
    version,
    name,
    checksum,
    appliedAt,
  }));
}

function checkHistory(applied: AppliedMigration[], known: readonly Migration[], sums: string[]): void {
  const latest = known.length;
  for (const [i, row] of applied.entries()) {
    if (row.version > latest) {
      throw new MigrationError(
        `The database schema (version ${applied.at(-1)?.version}) is newer than this agility-bridge (version ${latest}). ` +
          'Upgrade agility-bridge, or restore a backup made by this version.',
      );
    }
    if (row.version !== i + 1) {
      throw new MigrationError(`The database migration history has a gap before version ${row.version}.`);
    }
    if (row.checksum !== sums[i]) {
      throw new MigrationError(
        `Migration ${row.version} (${row.name}) in the database differs from this agility-bridge's. ` +
          'The database was changed by another build; restore a backup or use the matching release.',
      );
    }
  }
}

export interface MigrateOptions {
  now?: Now;
  /** For tests; defaults to the embedded history. */
  migrations?: readonly Migration[];
}

/** Applies pending migrations; returns the versions it applied. Safe to run concurrently from several processes. */
export async function migrate(driver: SqlDriver, options: MigrateOptions = {}): Promise<number[]> {
  const known = options.migrations ?? MIGRATIONS;
  const now = options.now ?? Date.now;
  for (const [i, m] of known.entries()) {
    if (m.version !== i + 1)
      throw new MigrationError(`Embedded migration ${m.name} has version ${m.version}.`);
  }
  const sums = await Promise.all(known.map(migrationChecksum));
  let applied = await appliedMigrations(driver);
  checkHistory(applied, known, sums);
  const done: number[] = [];
  for (let i = applied.length; i < known.length; i++) {
    const m = known[i] as Migration;
    const statements: SqlStatement[] = [
      ...m.statements.map((sql) => ({ sql, params: [], method: 'run' as const })),
      {
        sql: 'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        params: [m.version, m.name, sums[i], now()],
        method: 'run',
      },
    ];
    try {
      await driver.batch(statements);
      done.push(m.version);
    } catch (error) {
      // Another process may have applied it first: accept that only if the history now matches.
      applied = await appliedMigrations(driver);
      checkHistory(applied, known, sums);
      if (applied.length <= i) throw error;
    }
  }
  return done;
}
