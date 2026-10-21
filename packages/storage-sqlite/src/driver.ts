// SPDX-License-Identifier: Apache-2.0
// The SqlDriver over one node:sqlite connection. node:sqlite is synchronous, so each statement and each batch runs
// to completion without interleaving with other requests of this process; BEGIN IMMEDIATE serialises batches against
// other processes (with the busy timeout set when the file is opened, P2-02).
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { SqlDriver, SqlResult, SqlStatement } from '@agility-bridge/storage';

const MAX_CACHED_STATEMENTS = 256;

function bindable(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value as SQLInputValue;
}

/**
 * Wraps an open connection. Turns foreign keys on (node:sqlite connections start with them off, P0-09) and refuses
 * a connection where that did not take effect.
 */
export function createSqliteDriver(db: DatabaseSync): SqlDriver {
  db.exec('PRAGMA foreign_keys = ON');
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
  if (fk?.foreign_keys !== 1) throw new Error('SQLite foreign keys could not be enabled.');

  const cache = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let stmt = cache.get(sql);
    if (stmt === undefined) {
      if (cache.size >= MAX_CACHED_STATEMENTS) cache.clear();
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };

  const execute = (s: SqlStatement): SqlResult => {
    const stmt = prepare(s.sql);
    const params = s.params.map(bindable);
    if (s.method === 'run') {
      stmt.run(...params);
      return { rows: [] };
    }
    stmt.setReturnArrays(true);
    if (s.method === 'get') return { rows: stmt.get(...params) as unknown as unknown[] };
    return { rows: stmt.all(...params) as unknown as unknown[] };
  };

  return {
    query: async (statement) => execute(statement),
    batch: async (statements) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(execute);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: async () => {
      cache.clear();
      if (db.isOpen) db.close();
    },
  };
}
