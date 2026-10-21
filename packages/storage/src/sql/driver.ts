// SPDX-License-Identifier: Apache-2.0
// The only thing an SQL adapter implements: run one statement, or several atomically. `node:sqlite`
// (packages/storage-sqlite) and D1 (P3-02) provide it; everything above it is shared.
import { ConflictError, InvalidInputError } from '../errors.ts';

export type SqlMethod = 'run' | 'all' | 'values' | 'get';

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly method: SqlMethod;
}

/**
 * The Drizzle `sqlite-proxy` contract. Rows are arrays of column values in select order; for `get`, `rows` is the
 * first row itself (or `undefined`); for `run`, rows are ignored.
 */
export interface SqlResult {
  rows: unknown[];
}

export interface SqlDriver {
  query(statement: SqlStatement): Promise<SqlResult>;
  /** All statements in one transaction (node:sqlite) or one `batch()` (D1): every one applies, or none. */
  batch(statements: readonly SqlStatement[]): Promise<SqlResult[]>;
  close(): Promise<void>;
}

export type SqlFailure = 'unique' | 'foreign_key' | 'check' | 'invalid' | 'conflict';

/** Classifies a driver error by its message (node:sqlite and D1 both carry SQLite's text), following `cause`. */
export function classifySqlError(error: unknown): SqlFailure | null {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const m = e.message;
    if (m.includes('ab_invalid:')) return 'invalid';
    if (m.includes('ab_conflict:')) return 'conflict';
    if (m.includes('UNIQUE constraint failed') || m.includes('PRIMARY KEY constraint failed'))
      return 'unique';
    if (m.includes('FOREIGN KEY constraint failed')) return 'foreign_key';
    if (m.includes('CHECK constraint failed') || m.includes('NOT NULL constraint failed')) return 'check';
    if (m.includes('cannot store') && m.includes('STRICT')) return 'check';
  }
  return null;
}

/** The message SQLite raised from a trigger, without its marker, or a generic one. */
function raisedMessage(error: unknown, marker: string): string {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const at = e.message.indexOf(marker);
    if (at >= 0) {
      // Linear cuts, no regular expression: the first line, without D1's ": SQLITE_CONSTRAINT" suffix.
      let text = e.message.slice(at + marker.length);
      const newline = text.indexOf('\n');
      if (newline >= 0) text = text.slice(0, newline);
      const suffix = text.indexOf(': SQLITE_');
      if (suffix >= 0) text = text.slice(0, suffix);
      text = text.trim();
      if (text.endsWith('.')) text = text.slice(0, -1);
      return `${text.slice(0, 300)}.`;
    }
  }
  return 'A storage rule was violated.';
}

/**
 * Maps a constraint failure to the repository error semantics. `operation` decides what a foreign-key failure
 * means: a missing parent on write, a row still referenced on delete.
 */
export function mapSqlError(error: unknown, table: string, operation: 'write' | 'delete'): unknown {
  switch (classifySqlError(error)) {
    case 'invalid':
      return new InvalidInputError(raisedMessage(error, 'ab_invalid:'), { cause: error });
    case 'conflict':
      return new ConflictError(raisedMessage(error, 'ab_conflict:'), { cause: error });
    case 'unique':
      return new ConflictError(`A ${table} row with the same id or unique value already exists.`, {
        cause: error,
      });
    case 'foreign_key':
      return operation === 'delete'
        ? new ConflictError(`The ${table} row is still referenced; revoke or disable it instead.`, {
            cause: error,
          })
        : new InvalidInputError(`A row that ${table} refers to does not exist.`, { cause: error });
    case 'check':
      return new InvalidInputError(`The ${table} row breaks a column rule.`, { cause: error });
    default:
      return error;
  }
}
