// SPDX-License-Identifier: Apache-2.0
// Upgrade tests (L-071): every released minor's database fixture migrates to this build and stays usable.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { appliedMigrations, MIGRATIONS, openSqlStorage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import { createSqliteDriver } from '../src/index.ts';

const DIR = new URL('./fixtures/databases/', import.meta.url);
const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

describe('database fixtures', () => {
  it('include the first schema release (0.2)', () => {
    expect(fixtures).toContain('0.2.sql');
  });

  for (const file of fixtures) {
    it(`upgrades ${file} and keeps its rows usable`, async () => {
      const db = new DatabaseSync(':memory:');
      db.exec(readFileSync(new URL(file, DIR), 'utf8'));
      const driver = createSqliteDriver(db);
      const storage = await openSqlStorage(driver, { now: () => Date.UTC(2027, 0, 1) });
      expect((await appliedMigrations(driver)).map((m) => m.version)).toEqual(
        MIGRATIONS.map((m) => m.version),
      );
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      const ws = await storage.workspaces.getBySlug('team');
      expect(ws).toMatchObject({ includeChildScopes: true, allowedScopeIds: ['Scope:1001'] });
      const token = await storage.accessTokens.getByHash('0'.repeat(64));
      expect(token?.grantId).toBe('g-member');
      expect((await storage.credentials.get('c-member'))?.reachableScopeIds).toEqual(['Scope:1001']);
      expect((await storage.audit.query()).map((a) => a.id)).toEqual(['a-1']);
      // The rules still hold on upgraded data.
      await expect(storage.credentials.delete('c-shared')).rejects.toThrow(/still referenced/);
      await storage.workspaces.delete('w-team');
      expect(await storage.accessTokens.getByHash('0'.repeat(64))).toBeNull();
      await storage.close();
    });
  }
});
