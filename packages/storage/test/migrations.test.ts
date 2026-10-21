// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrationChecksum } from '../src/index.ts';

// Every database records these checksums, and the runner refuses a database whose history differs (L-071). A
// migration is frozen once a release ships it: fix mistakes with a new migration. Until v0.2.0 ships, 0001 may still
// change, together with this value and the database fixture (packages/storage-sqlite/test/fixtures/databases).
const FROZEN: Record<number, string> = {
  1: '71637fb1bfc1f81752a7934559ddc6ba24481f9b0b15cd3c67ff700f0b86a125',
};

describe('embedded migrations', () => {
  it('are numbered 1..n with unique names', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(new Set(MIGRATIONS.map((m) => m.name)).size).toBe(MIGRATIONS.length);
  });

  it('never change once recorded', async () => {
    for (const m of MIGRATIONS) {
      if (FROZEN[m.version] !== undefined) expect(await migrationChecksum(m), m.name).toBe(FROZEN[m.version]);
    }
    expect(Object.keys(FROZEN).length).toBe(MIGRATIONS.length);
  });

  it('one statement per entry, never a script', () => {
    for (const m of MIGRATIONS) {
      for (const sql of m.statements) {
        const outside = sql.replace(/BEGIN[\s\S]*END$/, '').replace(/'(?:[^']|'')*'/g, '');
        expect(outside.includes(';'), sql.slice(0, 60)).toBe(false);
      }
    }
  });
});
