// SPDX-License-Identifier: Apache-2.0
// The storage contract on local D1 (P3-02): Miniflare's D1 binding driven from Node, one Miniflare per file and an
// empty database per test. Same suite as memory and SQLite, nothing weakened (L-071).
import {
  appliedMigrations,
  createD1Driver,
  type D1Database,
  type D1PreparedStatement,
  MIGRATIONS,
  openSqlStorage,
} from '@agility-bridge/storage';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginRace, unbindRace } from '../../../packages/auth/test/login-race.ts';
import { writeLimiterContract } from '../../../packages/core/test/helpers/write-limiter-contract.ts';
import {
  countingDriver,
  quotaStatementContract,
  storageContract,
} from '../../../packages/storage/test/contract.ts';

let mf: Miniflare;
let db: D1Database;

/**
 * Runs each D1 call inside workerd and answers with its result. Miniflare's Node-side binding proxy sometimes drops
 * its socket in the middle of a response under concurrent calls ("other side closed"), which made the concurrency
 * tests flaky; a plain fetch to a Worker that holds the binding does not.
 */
const D1_RPC = `export default {
  async fetch(request, env) {
    const body = await request.json();
    const prep = (s) => env.DB.prepare(s.sql).bind(...s.params);
    try {
      if (body.op === 'batch') return Response.json({ ok: await env.DB.batch(body.statements.map(prep)) });
      const stmt = prep(body.statement);
      return Response.json({ ok: body.op === 'run' ? await stmt.run() : await stmt.raw() });
    } catch (error) {
      return Response.json({ error: String(error && error.message ? error.message : error) });
    }
  },
};`;

interface Sent {
  readonly sql: string;
  readonly params: unknown[];
}

/** A `D1Database` whose calls run in workerd through `D1_RPC`. Errors come back with D1's message. */
function remoteD1(m: Miniflare): D1Database {
  const call = async (body: unknown): Promise<unknown> => {
    const res = await m.dispatchFetch('http://d1.local/', { method: 'POST', body: JSON.stringify(body) });
    const out = (await res.json()) as { ok?: unknown; error?: string };
    if (out.error !== undefined) throw new Error(out.error);
    return out.ok;
  };
  const sent = new WeakMap<D1PreparedStatement, Sent>();
  const statement = (s: Sent): D1PreparedStatement => {
    const stmt: D1PreparedStatement = {
      bind: (...params) => statement({ sql: s.sql, params }),
      run: () => call({ op: 'run', statement: s }),
      raw: () => call({ op: 'raw', statement: s }) as Promise<unknown[][]>,
    };
    sent.set(stmt, s);
    return stmt;
  };
  return {
    prepare: (sql) => statement({ sql, params: [] }),
    batch: (statements) =>
      call({ op: 'batch', statements: statements.map((s) => sent.get(s)) }) as Promise<
        { results?: unknown[] }[]
      >,
  };
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: D1_RPC,
      compatibilityDate: '2026-09-26',
      d1Databases: ['DB'],
    }),
  );
  db = remoteD1(mf);
});
afterAll(() => mf.dispose());

/** Drops every trigger, index and table, so each test migrates an empty database. */
async function emptyD1(d: D1Database): Promise<void> {
  const objects = (await d
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' " +
        // Triggers first, then tables newest first: a child table goes before the parent it references.
        "AND type IN ('trigger', 'table') ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END, rowid DESC",
    )
    .raw()) as [string, string][];
  if (objects.length === 0) return;
  await d.batch([
    d.prepare('PRAGMA defer_foreign_keys = ON'),
    ...objects.map(([type, name]) => d.prepare(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`)),
  ]);
}

storageContract('d1 (local)', async (clock) => {
  await emptyD1(db);
  return openSqlStorage(createD1Driver(db), { now: clock.now });
});

// The quota's statement budget on D1: one read and one write for both periods (P8-39).
quotaStatementContract('d1 (local)', async (clock) => {
  await emptyD1(db);
  const counting = countingDriver(createD1Driver(db));
  const storage = await openSqlStorage(counting.driver, { now: clock.now });
  return { storage, statements: counting.statements, reset: counting.reset };
});

// The write limiter's counters (P7-03) on D1 inside workerd: parallel checks from several "isolates" share one count.
writeLimiterContract('storage kv (D1, workerd)', async () => {
  await emptyD1(db);
  let t = 1_760_000_000_000;
  const storage = await openSqlStorage(createD1Driver(db), { now: () => t });
  return {
    counters: storage.kv,
    advance: (ms) => {
      t += ms;
    },
    now: () => t,
  };
});

describe('migrations on D1', () => {
  it('concurrent first boots of one database end with one history and no error', async () => {
    await emptyD1(db);
    const opened = await Promise.allSettled(
      Array.from({ length: 6 }, () => openSqlStorage(createD1Driver(db))),
    );
    expect(opened.map((r) => r.status)).toEqual(Array(6).fill('fulfilled'));
    const history = await appliedMigrations(createD1Driver(db));
    expect(history.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('refuses a database written by a newer version', async () => {
    await emptyD1(db);
    await openSqlStorage(createD1Driver(db));
    await db
      .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .bind(999, 'from-the-future', 'x'.repeat(64), 0)
      .run();
    await expect(openSqlStorage(createD1Driver(db))).rejects.toThrow(/newer/i);
  });
});

describe('sign-in binding on D1 (P4-01, L-185)', () => {
  it('lets exactly one of three concurrent first sign-ins bind the user', async () => {
    await emptyD1(db);
    const storage = await openSqlStorage(createD1Driver(db));
    expect(await loginRace(storage)).toEqual({ ok: 1, conflict: 2, bound: expect.any(String) });
  });

  it('lets exactly one of four concurrent owner unbinds clear the binding (P4-12, L-220)', async () => {
    await emptyD1(db);
    const storage = await openSqlStorage(createD1Driver(db));
    await storage.users.create({ id: 'u-un', email: 'un@example.test', role: 'member' });
    await storage.users.bind('u-un', 'google', 'g-un');
    expect(await unbindRace(storage, 'u-un', 'un@example.test')).toEqual({
      ok: 1,
      conflict: 3,
      later: 'conflict',
    });
  });
});
