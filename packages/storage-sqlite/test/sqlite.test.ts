// SPDX-License-Identifier: Apache-2.0
// Placeholder (P0-03, L-104): proves node:sqlite loads and round-trips on every OS in the CI matrix. The real adapter
// and its contract tests arrive with P2-02.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

describe('node:sqlite', () => {
  it('creates a table and reads a row back with bound parameters', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      db.prepare('INSERT INTO t (name) VALUES (?)').run("O'Brien; DROP TABLE t");
      expect(db.prepare('SELECT name FROM t WHERE id = ?').get(1)).toEqual({ name: "O'Brien; DROP TABLE t" });
    } finally {
      db.close();
    }
  });
});
