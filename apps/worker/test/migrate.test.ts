// SPDX-License-Identifier: Apache-2.0
// Self-hosted → Worker (P3-09): a SQLite deployment with every kind of row, backed up with `storage.backup`, exported
// by scripts/cf-migrate.ts and imported into the Worker's local D1 equals the source row for row, and the Worker then
// serves a migrated device token with the same master key. Refusals happen before anything is written.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { accessServices, generateMasterKey, Keyring, verifyKeyring } from '@agility-bridge/auth';
import { CORE_TOOLS } from '@agility-bridge/core';
import { createD1Driver, type D1Database, openSqlStorage, type Storage } from '@agility-bridge/storage';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../../../packages/storage-sqlite/src/index.ts';
import {
  checkTarget,
  type Export,
  exportBackup,
  MigrationRefused,
  STATE_SQL,
  statementsFor,
  type TargetState,
} from '../../../scripts/cf-migrate.ts';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'dist', 'index.js');
let agility: FixtureAgility;
let dir: string;
const running: Miniflare[] = [];
beforeAll(async () => {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['deploy', '--dry-run', '--outdir', 'dist'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
afterEach(async () => {
  await Promise.all(running.splice(0).map((mf) => mf.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

const tools = new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }]));

/** A self-hosted deployment with every kind of row, backed up; returns the backup path and a device token. */
async function selfHosted(key: string) {
  dir = mkdtempSync(join(tmpdir(), 'ab-migrate-'));
  const storage = await openSqliteStorage({ path: join(dir, 'server.db') });
  const keyring = await Keyring.create(key);
  await verifyKeyring(storage, keyring);
  const svc = accessServices({ storage, keyring, tools, environment: 'test' });
  const owner = await svc.users.create({ email: 'owner@example.test', role: 'owner' });
  const ann = await svc.users.create({
    email: "ann.o'neil@example.test",
    role: 'member',
    displayName: `Ann; "A" O'Neil`,
  });
  const instance = await svc.instances.create({ label: 'Synthetic', baseUrl: agility.url });
  const shared = await svc.credentials.create({
    instanceId: instance.id,
    ownerUserId: null,
    label: 'service',
    token: 'synthetic-token-any-value',
  });
  await storage.credentials.update(shared.id, {
    validationStatus: 'valid',
    reachableScopeIds: ['Scope:1001'],
  });
  const ws = await svc.workspaces.create({
    slug: 'team',
    name: 'Team',
    instanceId: instance.id,
    allowedScopeIds: ['Scope:1001'],
    defaultCredentialId: shared.id,
    limits: { maxRows: 50 },
  });
  const grant = await svc.grants.create({ workspaceId: ws.id, userId: ann.id, label: null });
  const issued = await svc.tokens.issue({ grantId: grant.record.id, label: 'laptop' });
  await storage.settings.set('ui', { theme: 'dark' });
  await storage.audit.append({
    id: 'audit-1',
    ts: 1_760_000_000_000,
    kind: 'admin',
    action: 'workspace.create',
    status: 'ok',
    userId: owner.id,
    targetType: 'workspace',
    targetId: ws.id,
    details: { via: 'cli' },
  });
  await storage.kv.set('rl:transient', '3');
  const backup = join(dir, 'backup.db');
  await storage.backup(backup);
  return { storage, backup, token: issued.token };
}

/** The Worker on a fresh local D1, booted once (migrated, key-check value written), and Node's view of it. */
async function worker(key: string) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: SCRIPT,
      compatibilityDate: '2026-09-26',
      d1Databases: ['DB'],
      bindings: { AB_ENVIRONMENT: 'test', AB_MASTER_KEY: key, AB_ALLOW_HTTP_INSTANCES: 'on' },
    }),
  );
  running.push(mf);
  expect((await mf.dispatchFetch('http://127.0.0.1/health')).status).toBe(200);
  const d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
  return { mf, d1 };
}

/** What `readTarget` learns through wrangler, read here through the binding. */
async function targetState(d1: D1Database): Promise<TargetState> {
  const [v, n, kcv] = await Promise.all(STATE_SQL.map((sql) => d1.prepare(sql).raw()));
  const keyChecks: Record<number, string> = {};
  for (const [key, value] of (kcv ?? []) as [string, string][]) keyChecks[Number(key.slice(12))] = value;
  return { schemaVersion: Number(v?.[0]?.[0]) || null, rows: Number(n?.[0]?.[0] ?? 0), keyChecks };
}

async function dump(s: Storage) {
  const grants = await s.grants.list();
  return {
    users: await s.users.list(),
    instances: await s.instances.list(),
    credentials: await s.credentials.list(),
    workspaces: await s.workspaces.list(),
    grants,
    tokens: (await Promise.all(grants.map((g) => s.accessTokens.list({ grantId: g.id })))).flat(),
    settings: await s.settings.get('ui'),
    audit: await s.audit.query({ limit: 100 }),
  };
}

function exported(backup: string): Export {
  const db = new DatabaseSync(backup, { readOnly: true });
  try {
    return exportBackup(db);
  } finally {
    db.close();
  }
}

describe('self-hosted to Worker', () => {
  it('round trip: the Worker holds the same rows and serves a migrated device token', async () => {
    const key = generateMasterKey(1);
    const source = await selfHosted(key);
    const exp = exported(source.backup);
    expect(exp.counts).toMatchObject({ users: 2, credentials: 1, access_tokens: 1, audit_log: 1, kv: 1 });
    const target = await worker(key);
    // An internet-facing Worker is probed before anyone migrates into it: the refusal's audit row must not block.
    await target.mf.dispatchFetch('http://127.0.0.1/w/team/mcp', { method: 'POST', body: '{}' });
    const migrated = await openSqlStorage(createD1Driver(target.d1));
    for (let i = 0; i < 40 && (await migrated.audit.query({ limit: 5 })).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await migrated.audit.query({ limit: 5 })).length).toBe(1);
    const state = await targetState(target.d1);
    checkTarget(exp, state);
    const statements = statementsFor(exp, state);
    // The key-check value is already there (same key), and transient kv state never moves.
    expect(statements.some((s) => s.includes('crypto:kcv'))).toBe(false);
    expect(statements.some((s) => s.includes('rl:transient'))).toBe(false);
    await target.d1.batch(statements.map((s) => target.d1.prepare(s)));

    const [after, before] = [await dump(migrated), await dump(source.storage)];
    // The probe's row stays; the server's rows are added.
    expect({ ...after, audit: after.audit.filter((r) => r.kind !== 'auth') }).toEqual(before);
    expect(after.audit).toHaveLength(before.audit.length + 1);
    const res = await target.mf.dispatchFetch('http://127.0.0.1/w/team/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        authorization: `Bearer ${source.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('"isError":true');

    // Now the target is not empty: a second migration is refused.
    expect(() => checkTarget(exp, { ...state, rows: 7 })).toThrow(MigrationRefused);
    await source.storage.close();
  });

  it('refuses a Worker on another master key, another schema version, or an unmigrated database', async () => {
    const source = await selfHosted(generateMasterKey(1));
    const exp = exported(source.backup);
    const other = await worker(generateMasterKey(1));
    const state = await targetState(other.d1);
    expect(() => checkTarget(exp, state)).toThrow(/master key version 1/);
    expect(() => checkTarget(exp, { ...state, keyChecks: exp.keyChecks, schemaVersion: 99 })).toThrow(
      /schema 99/,
    );
    expect(() => checkTarget(exp, { schemaVersion: null, rows: 0, keyChecks: {} })).toThrow(/not migrated/);
    await source.storage.close();
  });
});
