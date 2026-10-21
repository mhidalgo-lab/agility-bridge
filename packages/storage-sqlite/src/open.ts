// SPDX-License-Identifier: Apache-2.0
// `agility-bridge serve` storage: one node:sqlite file, opened safely, in WAL mode, migrated on open (ADR-0006).
import { closeSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createSqlStorage,
  MIGRATIONS,
  MigrationError,
  migrate,
  type Now,
  type Storage,
} from '@agility-bridge/storage';
import { createSqliteDriver } from './driver.ts';
import { copyPrivateFile, ensurePrivateDir, openPrivateFile, sameFile, UnsafeFileError } from './files.ts';

export interface SqliteStorageOptions {
  /** Database file, or `:memory:` for tests. */
  path: string;
  now?: Now;
  /** How long a write waits for another process's lock (default 5 s). */
  busyTimeoutMs?: number;
  /** Non-fatal findings, such as a data directory writable by others. */
  onWarning?: (message: string) => void;
}

export interface SqliteStorage extends Storage {
  /** Absolute path of the database file (`:memory:` for an in-memory database). */
  readonly path: string;
  /**
   * Writes a consistent copy of the database (`VACUUM INTO`, readers and writers keep going) to a new file created
   * with mode 0600. Refuses a target that exists or is a symbolic link.
   */
  backup(target: string): Promise<void>;
}

function openDatabase(path: string, busyTimeoutMs: number): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: busyTimeoutMs });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    if (path !== ':memory:') {
      const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
      if (mode?.journal_mode !== 'wal') throw new Error('SQLite could not switch the database to WAL mode.');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Opens (creating if needed) and migrates the database. */
export async function openSqliteStorage(options: SqliteStorageOptions): Promise<SqliteStorage> {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  const memory = options.path === ':memory:';
  const path = memory ? options.path : resolve(options.path);
  let db: DatabaseSync;
  if (memory) {
    db = openDatabase(path, busyTimeoutMs);
  } else {
    ensurePrivateDir(dirname(path), options.onWarning);
    const file = openPrivateFile(path);
    try {
      db = openDatabase(path, busyTimeoutMs);
      // node:sqlite has no O_NOFOLLOW: make sure SQLite opened the file we checked, not one swapped in meanwhile.
      if (!sameFile(path, file.stats)) {
        db.close();
        throw new UnsafeFileError(
          `${path} changed while it was being opened; check who else can write to its directory.`,
        );
      }
    } finally {
      closeSync(file.fd);
    }
  }
  const driver = createSqliteDriver(db);
  try {
    await migrate(driver, options.now ? { now: options.now } : {});
  } catch (error) {
    await driver.close();
    throw error;
  }
  const storage = createSqlStorage(driver, options.now ? { now: options.now } : {});
  return Object.freeze({
    ...storage,
    path,
    async backup(target: string) {
      if (memory) throw new Error('An in-memory database cannot be backed up.');
      const out = resolve(target);
      ensurePrivateDir(dirname(out), options.onWarning);
      const file = openPrivateFile(out, 'create');
      closeSync(file.fd);
      try {
        db.prepare('VACUUM INTO ?').run(out);
      } catch (error) {
        rmSync(out, { force: true });
        throw new Error('The backup failed.', { cause: error });
      }
    },
  });
}

/**
 * Restores a backup into a new database file: the backup must pass SQLite's integrity check and must not come from a
 * newer agility-bridge; the copy is created with mode 0600 and never overwrites an existing file. The next
 * `openSqliteStorage` migrates it. Stop the server first.
 */
export async function restoreSqliteBackup(source: string, target: string): Promise<void> {
  const from = resolve(source);
  const to = resolve(target);
  if (existsSync(to)) throw new UnsafeFileError(`${to} exists; move it aside before restoring over it.`);
  const check = new DatabaseSync(from, { readOnly: true });
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    if (integrity?.integrity_check !== 'ok')
      throw new MigrationError(`${from} is damaged (integrity check failed).`);
    const row = check
      .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as { n: number };
    if (row.n !== 1) throw new MigrationError(`${from} is not an agility-bridge database.`);
    const versions = (
      check.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    ).map((r) => r.version);
    if (versions.some((v) => v > MIGRATIONS.length)) {
      throw new MigrationError(`${from} was written by a newer agility-bridge; upgrade before restoring it.`);
    }
  } finally {
    check.close();
  }
  ensurePrivateDir(dirname(to));
  copyPrivateFile(from, to);
}
