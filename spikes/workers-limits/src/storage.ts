// SPDX-License-Identifier: Apache-2.0
// P0-09 storage portability prototype (ADR-0006): the same schema and conditional statements on node:sqlite and D1.
// Each step returns a JSON-comparable outcome; an error is recorded as `error` with a normalised kind, not its text.

export const SCHEMA = [
  'CREATE TABLE workspaces (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT',
  'CREATE TABLE credentials (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE, sealed TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, revoked_at INTEGER) STRICT',
  'CREATE TABLE usage (grant_id TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (grant_id, day)) STRICT',
];

export interface Step {
  name: string;
  sql: string;
  params: Array<string | number | null>;
  /** `all` returns rows; `run` returns the number of changed rows. */
  mode: 'all' | 'run';
}

const QUOTA =
  'INSERT INTO usage (grant_id, day, calls) VALUES (?, ?, 1) ON CONFLICT (grant_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < ? RETURNING calls';

export const STEPS: Step[] = [
  {
    name: 'insert workspace',
    sql: 'INSERT INTO workspaces (id, slug, created_at) VALUES (?, ?, ?)',
    params: ['w1', 'team', 1760000000],
    mode: 'run',
  },
  {
    name: 'unique violation',
    sql: 'INSERT INTO workspaces (id, slug, created_at) VALUES (?, ?, ?)',
    params: ['w2', 'team', 1760000000],
    mode: 'run',
  },
  {
    name: 'STRICT type check',
    sql: 'INSERT INTO workspaces (id, slug, created_at) VALUES (?, ?, ?)',
    params: ['w3', 'ops', 'not a number'],
    mode: 'run',
  },
  {
    name: 'foreign key enforced',
    sql: 'INSERT INTO credentials (id, workspace_id, sealed) VALUES (?, ?, ?)',
    params: ['c0', 'missing', 'v1.x.y'],
    mode: 'run',
  },
  {
    name: 'insert credential',
    sql: 'INSERT INTO credentials (id, workspace_id, sealed) VALUES (?, ?, ?)',
    params: ['c1', 'w1', 'v1.a.b'],
    mode: 'run',
  },
  {
    name: 'optimistic update (current version)',
    sql: 'UPDATE credentials SET sealed = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING version',
    params: ['v1.c.d', 'c1', 1],
    mode: 'all',
  },
  {
    name: 'optimistic update (stale version)',
    sql: 'UPDATE credentials SET sealed = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING version',
    params: ['v1.e.f', 'c1', 1],
    mode: 'all',
  },
  { name: 'quota upsert 1', sql: QUOTA, params: ['g1', '2026-10-20', 2], mode: 'all' },
  { name: 'quota upsert 2', sql: QUOTA, params: ['g1', '2026-10-20', 2], mode: 'all' },
  { name: 'quota upsert 3 (at cap)', sql: QUOTA, params: ['g1', '2026-10-20', 2], mode: 'all' },
  {
    name: 'json_extract',
    sql: "SELECT json_extract(?, '$.scope.ids[1]') AS v",
    params: ['{"scope":{"ids":["Scope:1","Scope:2"]}}'],
    mode: 'all',
  },
  {
    name: 'unixepoch arithmetic',
    sql: "SELECT unixepoch('2026-10-20T00:00:00Z') - unixepoch('2026-10-19T00:00:00Z') AS seconds",
    params: [],
    mode: 'all',
  },
  { name: 'cascade delete', sql: 'DELETE FROM workspaces WHERE id = ?', params: ['w1'], mode: 'run' },
  { name: 'cascade result', sql: 'SELECT COUNT(*) AS n FROM credentials', params: [], mode: 'all' },
];

/** Error kinds that both drivers can be compared on (messages differ between node:sqlite and D1). */
export function errorKind(message: string): string {
  if (/UNIQUE constraint failed/i.test(message)) return 'unique';
  if (/FOREIGN KEY constraint failed/i.test(message)) return 'foreign-key';
  if (/cannot store TEXT value in INTEGER column/i.test(message)) return 'strict-type';
  return `other: ${message.slice(0, 80)}`;
}
