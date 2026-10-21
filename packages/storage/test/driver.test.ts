// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ConflictError, InvalidInputError, mapSqlError } from '../src/index.ts';

describe('mapSqlError', () => {
  it('maps trigger messages from node:sqlite and D1 to repository errors', () => {
    const node = new Error('ab_invalid: grants.credential_id must be shared');
    const d1 = new Error('D1_ERROR: ab_conflict: audit_log rows cannot be changed: SQLITE_CONSTRAINT');
    const a = mapSqlError(node, 'grants', 'write');
    expect(a).toBeInstanceOf(InvalidInputError);
    expect((a as Error).message).toBe('grants.credential_id must be shared.');
    const b = mapSqlError(new Error('wrapped', { cause: d1 }), 'audit_log', 'write');
    expect(b).toBeInstanceOf(ConflictError);
    expect((b as Error).message).toBe('audit_log rows cannot be changed.');
  });

  it('maps constraint failures by operation and passes other errors through', () => {
    expect(mapSqlError(new Error('UNIQUE constraint failed: users.email'), 'users', 'write')).toBeInstanceOf(
      ConflictError,
    );
    expect(mapSqlError(new Error('FOREIGN KEY constraint failed'), 'grants', 'write')).toBeInstanceOf(
      InvalidInputError,
    );
    expect(mapSqlError(new Error('FOREIGN KEY constraint failed'), 'users', 'delete')).toBeInstanceOf(
      ConflictError,
    );
    const other = new Error('disk I/O error');
    expect(mapSqlError(other, 'users', 'write')).toBe(other);
  });

  it('stays linear on hostile messages', () => {
    const hostile = new Error(`ab_invalid: ${'\n'.repeat(200_000)}x`);
    const started = performance.now();
    expect((mapSqlError(hostile, 't', 'write') as Error).message).toBe('.');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
