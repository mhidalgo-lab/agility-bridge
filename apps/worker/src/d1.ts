// SPDX-License-Identifier: Apache-2.0
// The SqlDriver over a D1 binding (P3-01; the full storage contract on D1 is P3-02). D1 enforces foreign keys and runs
// a `batch()` atomically; rows come back as arrays (`raw()`), like node:sqlite's `setReturnArrays`.

import type { SqlDriver, SqlResult, SqlStatement } from '@agility-bridge/storage';

/** The part of the D1 binding the driver uses (Cloudflare's `D1Database`). */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<{ results?: unknown[] }[]>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  raw(): Promise<unknown[][]>;
}

function bindable(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export function createD1Driver(db: D1Database): SqlDriver {
  const prepare = (s: SqlStatement) => db.prepare(s.sql).bind(...s.params.map(bindable));
  return {
    async query(s): Promise<SqlResult> {
      const stmt = prepare(s);
      if (s.method === 'run') {
        await stmt.run();
        return { rows: [] };
      }
      const rows = await stmt.raw();
      if (s.method === 'get') return { rows: rows[0] as unknown[] };
      return { rows };
    },
    async batch(statements) {
      // Storage batches only `run` statements (migrations); rows read in a batch come back as objects, see P3-02.
      const results = await db.batch(statements.map(prepare));
      return results.map((r, i) =>
        (statements[i] as SqlStatement).method === 'run'
          ? { rows: [] }
          : { rows: (r.results ?? []).map((row) => Object.values(row as object)) },
      );
    },
    async close() {
      // The binding belongs to the runtime.
    },
  };
}
